'use strict';
// 附件端到端测试：临时 DB + 真实 HTTP 服务，验证类型/大小/摘要校验、权限、
// 冻结/删除规则、续提不继承、历史视图、持久化（重启）与无孤儿文件。
process.env.DATA_DIR = '/tmp/hrc-att-test-data';
process.env.ATTACHMENT_DIR = '/tmp/hrc-att-test-data/attachments';
process.env.ATTACHMENT_MAX_BYTES = String(1024 * 1024); // 1MB，便于构造超限用例
process.env.PORT = '3988';
process.env.HOST = '127.0.0.1';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const assert = require('assert');
const { openDb, hashPassword } = require('../src/db');
const att = require('../src/attachments');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed++; console.log('  ✓', msg); }

function sha(buf) { return crypto.createHash('sha-256').update(buf).digest('hex'); }

// 合法 1x1 PNG（用于真实上传/下载校验）
const PNG_BUF = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
);
const PDF_BUF = Buffer.from('%PDF-1.7\n%附件测试PDF\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const WAV_BUF = Buffer.concat([
  Buffer.from('RIFF', 'latin1'), Buffer.from([0x30, 0, 0, 0]),
  Buffer.from('WAVE', 'latin1'), Buffer.from('fmt '.padEnd(32, 'x')),
]);
const MP3_BUF = Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0, 0, 0, 0, 0]), Buffer.alloc(32, 0x55)]);
const JPEG_BUF = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF', 'latin1'),
  Buffer.alloc(20, 0x41), Buffer.from([0xff, 0xd9]),
]);

async function reqJson(method, url, body, cookie) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers, setCookie: res.headers.get('set-cookie') || '' };
}

async function upload(proposalId, buf, cookie, { filename = '证据.pdf', hash: h, headers: extra } = {}) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    'X-Attachment-Filename': encodeURIComponent(filename),
    'X-Attachment-SHA256': h === undefined ? sha(buf) : h,
    Cookie: cookie,
    ...(extra || {}),
  };
  const res = await fetch(`${BASE}/api/proposals/${proposalId}/attachments`, {
    method: 'POST',
    headers,
    body: buf,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, headers: res.headers };
}

async function expectFail(p, statusPart, msgPart, label) {
  const r = await p;
  assert(r.status === statusPart || (r.status >= 400 && statusPart === 400),
    `${label}: 期望失败状态 ${statusPart}，实际 ${r.status}（${JSON.stringify(r.json)}）`);
  assert(r.json.error && r.json.error.includes(msgPart),
    `${label}: 错误信息应包含“${msgPart}”，实际：${r.json.error}`);
  ok(true, `${label} -> ${r.status} ${r.json.error}`);
}

async function login(u, p) {
  const r = await reqJson('POST', '/api/login', { username: u, password: p });
  assert.strictEqual(r.status, 200, `登录失败: ${JSON.stringify(r.json)}`);
  return r.setCookie.split(';')[0];
}

function countStoredFiles() {
  let n = 0;
  if (!fs.existsSync(att.ATTACHMENT_DIR)) return 0;
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      if (fs.statSync(fp).isDirectory()) walk(fp);
      else if (!name.startsWith('.')) n++;
    }
  })(att.ATTACHMENT_DIR);
  return n;
}
function countTmpFiles() {
  let n = 0;
  if (!fs.existsSync(att.ATTACHMENT_DIR)) return 0;
  (function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const fp = path.join(dir, name);
      if (fs.statSync(fp).isDirectory()) walk(fp);
      else if (name.includes('.tmp-')) n++;
    }
  })(att.ATTACHMENT_DIR);
  return n;
}

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 400));

  // 第二个记录员（直接建库）：验证记录员只能看/删本人附件
  const db = openDb();
  db.prepare('INSERT INTO users (username, display_name, role, password_hash) VALUES (?,?,?,?)')
    .run('recorder2', '记录员乙', 'recordist', hashPassword('recorder123'));
  db.close();

  console.log('\n[附件：前置——导入与提议]');
  const rec = await login('recorder', 'recorder123');
  const rec2 = await login('recorder2', 'recorder123');
  const rev = await login('reviewer', 'reviewer123');
  const par = await login('participant', 'participant123');
  ok(rec && rec2 && rev && par, '四类用户登录成功');

  await reqJson('POST', '/api/doc/import', {
    title: '附件测试',
    text: '1. 现在开庭。\n2. 申请人张三陈述。\n3. 证人李四发言。\n4. 休庭核对。\n5. 确认第3段发言人无误。',
  }, rec);

  const pr1 = await reqJson('POST', '/api/proposals',
    { seg: 2, start: 3, end: 5, replacement: '张三丰', basis: '身份证姓名为张三丰' }, rec);
  assert.strictEqual(pr1.status, 201);
  const pid1 = pr1.json.id;
  const pr2 = await reqJson('POST', '/api/proposals',
    { seg: 4, start: 0, end: 2, replacement: '复庭', basis: '另一处修订' }, rec);
  const pid2 = pr2.json.id;

  console.log('\n[附件：上传校验]');
  // 未登录 / 参与者不能上传
  await expectFail(upload(pid1, PNG_BUF, ''), 401, '未登录', '未登录上传');
  await expectFail(upload(pid1, PNG_BUF, par), 403, '无权操作', '参与者上传');
  // 只能为本人提议上传
  await expectFail(upload(pid1, PNG_BUF, rec2), 403, '无权操作', '记录员为他人提议上传');
  // 复核员不能上传（路由层即拒绝）
  await expectFail(upload(pid1, PNG_BUF, rev), 403, '无权操作', '复核员尝试上传');
  // 不存在的提议
  await expectFail(upload(9999, PNG_BUF, rec), 404, '不存在', '为不存在的提议上传');

  // 缺头
  const noName = await fetch(`${BASE}/api/proposals/${pid1}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Attachment-SHA256': sha(PNG_BUF), Cookie: rec },
    body: PNG_BUF,
  }).then((r) => r.json().then((j) => ({ status: r.status, json: j })));
  assert.strictEqual(noName.status, 400, '缺文件名头应 400');
  ok(noName.json.error.includes('原始文件名'), '缺 X-Attachment-Filename 明确报错');
  const noHash = await fetch(`${BASE}/api/proposals/${pid1}/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-Attachment-Filename': 'a.png', Cookie: rec },
    body: PNG_BUF,
  }).then((r) => r.json().then((j) => ({ status: r.status, json: j })));
  assert.strictEqual(noHash.status, 400);
  ok(noHash.json.error.includes('SHA-256'), '缺 X-Attachment-SHA256 明确报错');

  // JSON 请求体被拒绝（防止与全局 JSON API 混淆）
  const asJson = await reqJson('POST', `/api/proposals/${pid1}/attachments`, { x: 1 }, rec);
  assert.strictEqual(asJson.status, 400);
  ok(asJson.json.error.includes('原始字节'), 'JSON 请求体明确拒绝');

  // 空文件
  await expectFail(upload(pid1, Buffer.alloc(0), rec, { filename: '空.png' }), 400, '为空', '空文件');
  // 不支持类型
  await expectFail(upload(pid1, Buffer.from('plain text'.repeat(10)), rec, { filename: 'note.txt' }),
    400, '无法识别', '纯文本改名也拒绝');
  await expectFail(upload(pid1, Buffer.from('GIF89a' + Buffer.alloc(16, 0)), rec, { filename: 'x.gif' }),
    400, '无法识别', 'GIF 不支持');
  // 伪造：声明 .pdf 但内容是 PNG → 按内容识别为 PNG，仍成功（文件名仅展示，类型以内容为准）
  const forged = await upload(pid1, PNG_BUF, rec, { filename: '伪造.pdf' });
  assert.strictEqual(forged.status, 201, `伪造扩展名上传实际结果: ${JSON.stringify(forged.json)}`);
  ok(forged.json.attachment.mediaType === 'png', '文件名伪造为 .pdf 但按内容记录为 png');
  const forgedId = forged.json.attachment.id;

  // 摘要不符
  await expectFail(upload(pid1, PDF_BUF, rec, {
    filename: '依据.pdf',
    hash: 'a'.repeat(64),
  }), 422, '摘要不符', 'SHA-256 不符（错误状态 422）');
  // 摘要格式非法
  await expectFail(upload(pid1, PDF_BUF, rec, { filename: '依据.pdf', hash: 'not-a-hash' }),
    400, 'SHA-256', '非法摘要格式');

  // 超限：>1MB（小一点，避免测试过慢）
  const big = Buffer.alloc(1024 * 1024 + 10, 0x55);
  big[0] = 0x25; big.write('PDF-1.4', 1, 'latin1'); // 内容看起来像 PDF，但先撞大小限制
  await expectFail(upload(pid1, big, rec, { filename: '大.pdf' }), 413, '大小限制', '超限文件 413 且不留盘');

  // 合法上传：PDF / WAV / MP3 / JPEG，含中文文件名
  const upPdf = await upload(pid1, PDF_BUF, rec, { filename: '现场笔录 03-01.pdf' });
  assert.strictEqual(upPdf.status, 201, `PDF 上传: ${JSON.stringify(upPdf.json)}`);
  const aPdf = upPdf.json.attachment;
  ok(aPdf.mediaType === 'pdf' && aPdf.size === PDF_BUF.length, 'PDF 元数据正确');
  ok(aPdf.expectedSha256 === aPdf.actualSha256 && aPdf.sha256Matched, '返回校验信息：预期与实际一致');
  ok(aPdf.uploadedBy.username === 'recorder' && aPdf.url.includes(`/api/attachments/${aPdf.id}/download`),
    '记录上传者与下载地址');
  ok(!aPdf.frozen, '提议待复核时附件未冻结');

  const upWav = await upload(pid1, WAV_BUF, rec, { filename: '录音 00-12.wav' });
  assert.strictEqual(upWav.status, 201);
  const upMp3 = await upload(pid1, MP3_BUF, rec, { filename: '录音.mp3' });
  assert.strictEqual(upMp3.status, 201);
  const upJpg = await upload(pid1, JPEG_BUF, rec, { filename: '照片.jpg' });
  assert.strictEqual(upJpg.status, 201);
  const aWav = upWav.json.attachment, aMp3 = upMp3.json.attachment, aJpg = upJpg.json.attachment;
  ok(aWav.mediaType === 'wav' && aMp3.mediaType === 'mp3' && aJpg.mediaType === 'jpeg',
    'WAV/MP3/JPEG 均按内容识别');
  // 再传一个 PNG（之前伪造名那次已成功，共 5 个）
  const upPng = await upload(pid1, PNG_BUF, rec, { filename: '图.png' });
  assert.strictEqual(upPng.status, 201);
  const aPng = upPng.json.attachment;

  let booth = (await reqJson('GET', '/api/booth', null, rec)).json;
  let p1view = booth.proposals.find((x) => x.id === pid1);
  ok(p1view.attachments.length === 6, `booth 中提议 #${pid1} 含 6 件附件（含伪扩展名 PNG），实际 ${p1view.attachments.length}`);
  ok(p1view.attachments.every((a) => a.displayName && a.actualSha256 && a.url), '附件元数据完整');
  ok(p1view.attachments.some((a) => a.displayName === '现场笔录 03-01.pdf'), '中文原名仅作展示且正确回传');

  // 落盘文件数与 DB 一致，且无临时文件
  ok(countStoredFiles() === 6, `磁盘有 6 个正式附件文件，实际 ${countStoredFiles()}`);
  ok(countTmpFiles() === 0, '无 .tmp 半成品文件');

  console.log('\n[附件：权限——参与者与其他记录员不可见]');
  // 参与者：booth 提议不携带 attachments 字段；保密段/历史视图同样
  const boothPar = (await reqJson('GET', '/api/booth', null, par)).json;
  const p1par = boothPar.proposals.find((x) => x.id === pid1);
  ok(!('attachments' in p1par), '参与者的 booth 提议不含 attachments 字段');
  // 参与者不得下载（404，不暴露存在性）
  await expectFail(reqJson('GET', `/api/attachments/${aPdf.id}/download`, null, par),
    404, '不存在', '参与者下载被拒（404 不暴露）');
  // 未登录 401
  await expectFail(reqJson('GET', `/api/attachments/${aPdf.id}/download`),
    401, '未登录', '未登录下载被拒');
  // 其他记录员：booth 中本人提议(无附件)字段为空数组；他人附件不可见
  const boothRec2 = (await reqJson('GET', '/api/booth', null, rec2)).json;
  const p1r2 = boothRec2.proposals.find((x) => x.id === pid1);
  ok(p1r2.attachments.length === 0, `记录员乙看不到记录员甲的 ${p1r2.attachments.length} 件附件（空数组）`);
  await expectFail(reqJson('GET', `/api/attachments/${aPdf.id}/download`, null, rec2),
    404, '不存在', '记录员乙下载他人附件被拒（404）');
  // 删除他人附件：404
  await expectFail(reqJson('DELETE', `/api/attachments/${aPdf.id}`, null, rec2),
    404, '不存在', '记录员乙删除他人附件被拒（404）');
  // 不存在附件 id：参与者 404、本人 404
  await expectFail(reqJson('GET', '/api/attachments/987654/download', null, rec),
    404, '不存在', '不存在附件 404');

  // 复核员：可见全部
  const boothRev = (await reqJson('GET', '/api/booth', null, rev)).json;
  const p1rev = boothRev.proposals.find((x) => x.id === pid1);
  ok(p1rev.attachments.length === 6, `复核员可见全部 6 件附件，实际 ${p1rev.attachments.length}`);

  console.log('\n[附件：下载内容与校验头]');
  const dlRes = await fetch(`${BASE}/api/attachments/${aPdf.id}/download`, { headers: { Cookie: rec } });
  assert.strictEqual(dlRes.status, 200);
  ok(dlRes.headers.get('content-type') === 'application/pdf', 'Content-Type 按嗅探结果');
  ok(dlRes.headers.get('x-attachment-sha256') === sha(PDF_BUF), '响应头给出实际 SHA-256');
  const cd = dlRes.headers.get('content-disposition') || '';
  ok(cd.includes("filename*=UTF-8''") && cd.includes('%E7%8E%B0%E5%9C%BA'), 'Content-Disposition 含 RFC5987 中文文件名');
  const dlBuf = Buffer.from(await dlRes.arrayBuffer());
  ok(dlBuf.equals(PDF_BUF), '下载字节与上传原文件逐字节一致');
  const pngRes = await fetch(`${BASE}/api/attachments/${forgedId}/download`, { headers: { Cookie: rev } });
  ok(pngRes.headers.get('content-type') === 'image/png', '伪造 .pdf 名的附件下载仍标 image/png');

  console.log('\n[附件：删除误传（仅待复核、本人）]');
  // 删除伪造名那件
  const del = await reqJson('DELETE', `/api/attachments/${forgedId}`, null, rec);
  assert.strictEqual(del.status, 200, '本人删除误传附件成功');
  booth = (await reqJson('GET', '/api/booth', null, rec)).json;
  p1view = booth.proposals.find((x) => x.id === pid1);
  ok(p1view.attachments.length === 5 && !p1view.attachments.some((a) => a.id === forgedId),
    '删除后 booth 不再含该附件');
  ok(countStoredFiles() === 5, `磁盘文件同步删除（5），实际 ${countStoredFiles()}`);
  await expectFail(reqJson('DELETE', `/api/attachments/${forgedId}`, null, rec),
    404, '不存在', '重复删除 404');

  console.log('\n[附件：冻结——采纳/驳回/标记冲突/发布后不可增删，仍可下载]');
  // 采纳 pid1 → 冻结
  let ad = await reqJson('POST', `/api/proposals/${pid1}/adopt`, {}, rev);
  assert.strictEqual(ad.status, 200);
  await expectFail(upload(pid1, PNG_BUF, rec, { filename: '冻结后.png' }), 409, '冻结', '采纳后上传 409');
  await expectFail(reqJson('DELETE', `/api/attachments/${aPdf.id}`, null, rec), 409, '冻结', '采纳后删除 409');
  booth = (await reqJson('GET', '/api/booth', null, rec)).json;
  p1view = booth.proposals.find((x) => x.id === pid1);
  ok(p1view.attachments.length === 5 && p1view.attachments.every((a) => a.frozen),
    '采纳后 5 件附件保留且标记 frozen');
  // 已冻结附件仍可由复核员/上传记录员下载
  const dlAfter = await fetch(`${BASE}/api/attachments/${aWav.id}/download`, { headers: { Cookie: rev } });
  ok(dlAfter.status === 200, '冻结后复核员仍可下载');

  // pid2：上传后驳回 → 冻结（驳回在上传之后，避免在已冻结提议上上传）
  const upBeforeReject = await upload(pid2, PNG_BUF, rec, { filename: '先传一张.png' });
  assert.strictEqual(upBeforeReject.status, 201);
  const aP2 = upBeforeReject.json.attachment;
  const rj = await reqJson('POST', `/api/proposals/${pid2}/reject`, { reason: '证据不足' }, rev);
  assert.strictEqual(rj.status, 200, '复核员驳回 pid2');
  await expectFail(upload(pid2, PNG_BUF, rec, { filename: '驳回后.png' }), 409, '冻结', '驳回后上传 409');
  await expectFail(reqJson('DELETE', `/api/attachments/${aP2.id}`, null, rec), 409, '冻结', '驳回后删除 409');

  console.log('\n[附件：发布落版、历史视图保留、续提不继承]');
  // 为 pid1 已采纳修订扫清异议门槛并发布
  const check = await reqJson('GET', '/api/publish-check', null, rev);
  for (const it of check.json.items || []) {
    if (!it.satisfied) {
      const r = await reqJson('POST', `/api/objections/${it.objectionId}/respond`,
        { note: '附件测试：回应异议' }, rev);
      assert.strictEqual(r.status, 201, `回应失败: ${JSON.stringify(r.json)}`);
    }
  }
  const pub = await reqJson('POST', '/api/publish', { note: '附件测试发布' }, rev);
  assert.strictEqual(pub.status, 201, `发布失败: ${JSON.stringify(pub.json)}`);
  const v2 = pub.json.versionId;
  booth = (await reqJson('GET', '/api/booth', null, rec)).json;
  p1view = booth.proposals.find((x) => x.id === pid1);
  ok(p1view.status === 'published' && p1view.attachments.length === 5, '发布后提议为 published，附件仍 5 件');

  // 历史版本视图：工作人员在相关决议上看到冻结附件；参与者看不到任何附件字段
  const v2rev = (await reqJson('GET', `/api/versions/${v2}`, null, rev)).json;
  const decWithP1 = v2rev.decisions.filter((d) => d.proposal_id === pid1);
  ok(decWithP1.length >= 1, `v2 决议中包含提议 #${pid1}`);
  const pubDec = decWithP1.find((d) => d.type === 'publish');
  ok(pubDec && pubDec.attachments.length === 5, '历史视图发布决议带 5 件冻结附件');
  ok(pubDec.attachments.some((a) => a.id === aPdf.id && a.frozen), '历史视图附件含 PDF 且冻结');
  const v2par = (await reqJson('GET', `/api/versions/${v2}`, null, par)).json;
  ok(v2par.decisions.every((d) => !('attachments' in d)), '参与者历史决议不含 attachments 字段');
  // 历史版本视图中的附件随提议保留：同一条发布决议在 v2 视图中，记录员本人与复核员均可见；
  // 其他记录员看不到他人附件（v1 为初始导入、决议水位线为 0，不含任何决议）。
  const v2rec = (await reqJson('GET', `/api/versions/${v2}`, null, rec)).json;
  const v2p1 = v2rec.decisions.filter((d) => d.proposal_id === pid1);
  ok(v2p1.length >= 1 && v2p1.every((d) => (d.attachments || []).length === 5),
    `v2 历史视图中提议 #${pid1} 的决议附带保留的 5 件附件（记录员本人可见）`);
  const v2r2 = (await reqJson('GET', `/api/versions/${v2}`, null, rec2)).json;
  const v2r2p1 = v2r2.decisions.filter((d) => d.proposal_id === pid1);
  ok(v2r2p1.length >= 1 && v2r2p1.every((d) => (d.attachments || []).length === 0),
    '记录员乙在历史视图也看不到他人附件（空数组）');

  // 保密段附件：参与者在该段的任何视图都拿不到；工作人员不受影响
  await reqJson('POST', '/api/segments/2/secret', {}, rev);
  const parSec = (await reqJson('GET', '/api/booth', null, par)).json;
  ok(!parSec.proposals.find((x) => x.id === pid1), '保密后参与者看不到第2段提议（连同附件）');
  const parSecV2 = (await reqJson('GET', `/api/versions/${v2}`, null, par)).json;
  ok(parSecV2.decisions.filter((d) => d.seg === 2).length === 0,
    '保密段决议对参与者整条剔除（附件随之不可得）');
  await reqJson('POST', '/api/segments/2/unsecret', {}, rev);

  // 续提：先构造一个因发布而基版过期的 pending 提议（pid2 已驳回，用新提议 p3），
  // 再发布一次使其冲突，续提生成的新提议不得继承旧附件。
  // pid1 已发布；新建对第5段的提议 p3 并上传附件，但不采纳，直接再次发布（先造一个可发布修订）。
  const p4 = await reqJson('POST', '/api/proposals',
    { seg: 5, start: 0, end: 2, replacement: '核明', basis: '为第二次发布造修订' }, rec);
  await reqJson('POST', `/api/proposals/${p4.json.id}/adopt`, {}, rev);
  const p3 = await reqJson('POST', '/api/proposals',
    { seg: 3, start: 0, end: 1, replacement: '本', basis: '待过期提议' }, rec);
  assert.strictEqual(p3.status, 201);
  const up3 = await upload(p3.json.id, PNG_BUF, rec, { filename: '旧附件.png' });
  assert.strictEqual(up3.status, 201);
  const aP3 = up3.json.attachment;
  // 清空门槛（无异议触及即可发布）
  {
    const c = await reqJson('GET', '/api/publish-check', null, rev);
    for (const it of c.json.items || []) {
      await reqJson('POST', `/api/objections/${it.objectionId}/respond`, { note: '回应' }, rev);
    }
  }
  const pub3 = await reqJson('POST', '/api/publish', { note: '第二次发布，使 p3 基版过期' }, rev);
  assert.strictEqual(pub3.status, 201, `第二次发布失败: ${JSON.stringify(pub3.json)}`);
  const v3 = pub3.json.versionId;
  booth = (await reqJson('GET', '/api/booth', null, rec)).json;
  const p3view = booth.proposals.find((x) => x.id === p3.json.id);
  ok(p3view.status === 'conflicted' && p3view.attachments.length === 1 && p3view.attachments[0].frozen,
    '发布使 p3 冲突（基版过期），其 1 件附件冻结保留');
  // 冲突后旧附件不能增删
  await expectFail(upload(p3.json.id, PNG_BUF, rec, { filename: '冲突后.png' }), 409, '冻结', '冲突提议上传 409');

  // 续提 p3
  const prev = await reqJson('POST', `/api/proposals/${p3.json.id}/rebase-preview`, {}, rec);
  assert.strictEqual(prev.status, 200, `续提预览失败: ${JSON.stringify(prev.json)}`);
  const conf = await reqJson('POST', `/api/proposals/${p3.json.id}/rebase-confirm`, { token: prev.json.token }, rec);
  assert.strictEqual(conf.status, 201, `续提确认失败: ${JSON.stringify(conf.json)}`);
  const p3new = conf.json.id;
  booth = (await reqJson('GET', '/api/booth', null, rec)).json;
  const newView = booth.proposals.find((x) => x.id === p3new);
  ok(newView.status === 'pending' && newView.attachments.length === 0,
    '续提生成的新提议为待复核且不自动继承旧附件（0 件）');
  const oldView = booth.proposals.find((x) => x.id === p3.json.id);
  ok(oldView.attachments.length === 1 && oldView.attachments[0].id === aP3.id,
    '原冲突提议的旧附件仍保留可追溯');
  // 新提议可独立上传
  const upNew = await upload(p3new, MP3_BUF, rec, { filename: '新依据.mp3' });
  assert.strictEqual(upNew.status, 201, '新提议可独立上传自己的附件');
  // 两份附件均在磁盘，DB/磁盘数量核对
  const expectFiles = 5 /* pid1 */ + 1 /* pid2 */ + 1 /* p3 */ + 1 /* p3new */;
  ok(countStoredFiles() === expectFiles, `磁盘正式文件数 ${expectFiles}，实际 ${countStoredFiles()}`);

  console.log('\n[附件：并发复核与上传——以最终提议状态为准]');
  // 对一个新 pending 提议：复核员采纳与记录员上传“同时”进行，两种合法结局二选一，
  // 但都不得产生孤儿文件（附件落库则文件存在，附件被拒则无文件）。
  const p5 = await reqJson('POST', '/api/proposals',
    { seg: 5, start: 2, end: 3, replacement: '实', basis: '并发测试' }, rec);
  const pid5 = p5.json.id;
  const [upRace, adRace] = await Promise.all([
    upload(pid5, PDF_BUF, rec, { filename: '并发.pdf' }),
    reqJson('POST', `/api/proposals/${pid5}/adopt`, {}, rev),
  ]);
  booth = (await reqJson('GET', '/api/booth', null, rec)).json;
  const p5view = booth.proposals.find((x) => x.id === pid5);
  ok(p5view.status === 'adopted', '并发后提议最终状态为已采纳');
  if (upRace.status === 201) {
    ok(p5view.attachments.length === 1, '上传先于采纳落库：附件保留 1 件');
    ok(countTmpFiles() === 0, '并发路径无临时文件');
  } else {
    ok(upRace.status === 409 && upRace.json.error.includes('冻结'),
      `采纳先生效：上传以 409 拒绝（实际 ${upRace.status} ${upRace.json.error}）`);
    ok(p5view.attachments.length === 0, '上传被拒：无附件记录');
  }
  const { DB_PATH } = require('../src/db');
  const Database = require('better-sqlite3');
  const dbRows = new Database(DB_PATH, { readonly: true })
    .prepare('SELECT COUNT(*) AS n FROM proposal_attachments').get().n;
  ok(dbRows === countStoredFiles(), `无孤儿：DB 附件数 ${dbRows} === 磁盘文件数 ${countStoredFiles()}`);

  console.log('\n[附件：重启后仍可查阅]');
  const dlBefore = await fetch(`${BASE}/api/attachments/${aPdf.id}/download`, { headers: { Cookie: rec } });
  const etagBefore = dlBefore.headers.get('x-attachment-sha256');
  ok(dlBefore.status === 200 && etagBefore === sha(PDF_BUF), '重启前 PDF 可下载');
  console.log('  · 附件落于数据目录，随数据卷持久；重启校验见 test/attachments-restart.test.js');

  console.log(`\n附件端到端测试通过：${passed} 项断言 ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n附件测试失败：', e.message);
  console.error(e.stack);
  process.exit(1);
});
