'use strict';
// 附件持久化：在 attachments.test.js 建好的同一数据目录上另起服务进程，
// 验证重启后附件元数据、下载内容与 SHA-256 校验仍然可用（原文件随提议保留）。
process.env.DATA_DIR = '/tmp/hrc-att-test-data';
process.env.ATTACHMENT_DIR = '/tmp/hrc-att-test-data/attachments';
process.env.ATTACHMENT_MAX_BYTES = String(1024 * 1024);
process.env.PORT = '3989';
process.env.HOST = '127.0.0.1';

const { spawn } = require('child_process');
const assert = require('assert');
const { DB_PATH } = require('../src/db');
const Database = require('better-sqlite3');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed++; console.log('  ✓', msg); }

async function login() {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'reviewer', password: 'reviewer123' }),
  });
  const j = await r.json();
  assert.strictEqual(r.status, 200, `复核员登录失败: ${JSON.stringify(j)}`);
  return r.headers.get('set-cookie').split(';')[0];
}

async function waitForServer(timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/me`);
      if (r.ok || r.status === 200) return;
    } catch (_) { /* 尚未监听 */ }
    if (Date.now() - start > timeoutMs) throw new Error('服务重启后未在超时内就绪');
    await new Promise((r) => setTimeout(r, 150));
  }
}

async function main() {
  // 重启前：从持久化 DB 取一个仍冻结的附件（提议 #1 的 PDF，应名为“现场笔录 03-01.pdf”）
  const before = new Database(DB_PATH, { readonly: true });
  const row = before.prepare(
    `SELECT a.id, a.display_name, a.actual_sha256, a.size_bytes, p.status
     FROM proposal_attachments a JOIN proposals p ON p.id = a.proposal_id
     WHERE a.display_name = ? ORDER BY a.id LIMIT 1`
  ).get('现场笔录 03-01.pdf');
  before.close();
  assert(row, '前置数据缺失：请先运行 test/attachments.test.js');
  assert.strictEqual(row.status, 'published', '该附件所属提议应已发布（冻结）');
  console.log(`[重启持久化] 取已发布提议附件 #${row.id}（${row.display_name}），重启服务…`);

  const child = spawn(process.execPath, [require('path').join(__dirname, '..', 'src', 'server.js')], {
    env: process.env,
    stdio: 'ignore',
    detached: true,
  });
  child.unref();

  await waitForServer();
  console.log('  ✓ 服务已在同一数据目录上重新启动');

  try {
    const cookie = await login();
    // 重启后元数据仍在 booth/版本视图
    const booth = await (await fetch(`${BASE}/api/booth`, { headers: { Cookie: cookie } })).json();
    const found = booth.proposals.flatMap((p) => p.attachments || []).find((a) => a.id === row.id);
    ok(found && found.frozen && found.actualSha256 === row.actual_sha256 && found.size === row.size_bytes,
      '重启后 booth 仍返回该附件元数据（冻结、实际 SHA-256、大小不变）');

    // 下载内容与摘要仍可校验
    const dl = await fetch(`${BASE}/api/attachments/${row.id}/download`, { headers: { Cookie: cookie } });
    ok(dl.status === 200, '重启后仍可下载');
    const buf = Buffer.from(await dl.arrayBuffer());
    const crypto = require('crypto');
    const digest = crypto.createHash('sha-256').update(buf).digest('hex');
    ok(digest === row.actual_sha256, `重启后下载内容 SHA-256 与记录一致（${digest.slice(0, 16)}…）`);
    ok(buf.length === row.size_bytes, '下载字节数与记录大小一致');
    ok((dl.headers.get('content-disposition') || '').includes('%E7%8E%B0%E5%9C%BA'),
      '重启后 Content-Disposition 仍带中文原始文件名');

    // 参与者重启后依旧无权
    const parLogin = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'participant', password: 'participant123' }),
    });
    const parCookie = parLogin.headers.get('set-cookie').split(';')[0];
    const parDl = await fetch(`${BASE}/api/attachments/${row.id}/download`, { headers: { Cookie: parCookie } });
    ok(parDl.status === 404, '重启后参与者仍无法取得附件（404）');

    // 重启后冻结仍生效：尝试删除/上传应 409
    const recLogin = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'recorder', password: 'recorder123' }),
    });
    const recCookie = recLogin.headers.get('set-cookie').split(';')[0];
    const delRes = await fetch(`${BASE}/api/attachments/${row.id}`, { method: 'DELETE', headers: { Cookie: recCookie } });
    ok(delRes.status === 409, '重启后已发布提议附件仍冻结，删除 409');
  } finally {
    process.kill(child.pid, 'SIGTERM');
  }

  console.log(`\n重启持久化测试通过：${passed} 项断言 ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('重启持久化测试失败：', e.message);
  console.error(e.stack);
  process.exit(1);
});
