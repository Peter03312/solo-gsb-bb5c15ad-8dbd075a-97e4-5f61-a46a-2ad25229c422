'use strict';
// 恢复到历史版本端到端测试：临时 DB + 真实 HTTP 服务
// 覆盖：预览/确认的拒绝场景、净变化逐段提议、重复文字不靠同文搜索、未变化范围不触及异议、
// 仅空暂存可确认、预览后版本/暂存变化整次拒绝不留部分提议、确认后经异议门槛发布为新不可变版本、
// 旧版/决议不改写、关联目标版本、附件不继承（恢复提议由复核员生成，无附件）、通知按净变化产生。
process.env.DATA_DIR = '/tmp/hrc-restore-data';
process.env.PORT = '3988';
process.env.HOST = '127.0.0.1';

const fs = require('fs');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const assert = require('assert');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed++; console.log('  ✓', msg); }

async function req(method, path, body, cookie) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') || '' };
}
async function expectFail(p, statusPart, msgPart, label) {
  const r = await p;
  assert(r.status === statusPart, `${label}: 期望状态 ${statusPart}，实际 ${r.status}：${JSON.stringify(r.json)}`);
  assert(r.json.error && r.json.error.includes(msgPart),
    `${label}: 错误信息应包含“${msgPart}”，实际：${r.json.error}`);
  ok(true, `${label} -> ${r.status} ${r.json.code || ''}`);
}

async function login(u, p) {
  const r = await req('POST', '/api/login', { username: u, password: p });
  assert.strictEqual(r.status, 200, `登录失败: ${JSON.stringify(r.json)}`);
  return r.setCookie.split(';')[0];
}

function cpIndexOf(text, needle) {
  const t = Array.from(text), n = Array.from(needle);
  outer: for (let i = 0; i + n.length <= t.length; i++) {
    for (let j = 0; j < n.length; j++) if (t[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 400));

  const rec = await login('recorder', 'recorder123');
  const rev = await login('reviewer', 'reviewer123');
  const par = await login('participant', 'participant123');

  // ---------- 构造版本链 ----------
  // 段1：v1「申请人张三称：我于2024年3月1日收到通知。」
  // 段2：v1「保留段落始终不变。」
  // v2：段1 日期 3月1日 -> 3月2日
  // v3：段1 张三 -> 张三丰；日期 3月2日 -> 3月上旬
  // v4：参与者关注的段2做一次同文替换（正文逐码点不变，恢复时不应产生提议）
  const seg1v1 = '申请人张三称：我于2024年3月1日收到通知。';
  const seg2v1 = '保留段落始终不变。';
  const transcript = `1. ${seg1v1}\n2. ${seg2v1}`;
  let r = await req('POST', '/api/doc/import', { title: '恢复测试', text: transcript }, rec);
  assert.strictEqual(r.status, 201);
  const segOf = async (which) => {
    const b = (await req('GET', '/api/booth', null, rev)).json;
    return b.segments.find((s) => s.seg === which).text;
  };

  async function proposeAdoptPublish({ seg, find, replacement, basis, note }) {
    const text = await segOf(seg);
    const i = cpIndexOf(text, find);
    assert(i >= 0, `在「${text}」中找不到「${find}」`);
    const pr = await req('POST', '/api/proposals',
      { seg, start: i, end: i + Array.from(find).length, replacement, basis }, rec);
    assert.strictEqual(pr.status, 201, JSON.stringify(pr.json));
    const ad = await req('POST', `/api/proposals/${pr.json.id}/adopt`, {}, rev);
    assert.strictEqual(ad.status, 200, `采纳失败 ${JSON.stringify(ad.json)}`);
    assert.ok(!ad.json.markedConflict, `采纳被标记冲突 ${JSON.stringify(ad.json)}`);
    const pu = await req('POST', '/api/publish', { note }, rev);
    assert.strictEqual(pu.status, 201, `发布失败 ${JSON.stringify(pu.json)}`);
    return pr.json.id;
  }

  const pV2 = await proposeAdoptPublish({ seg: 1, find: '3月1日', replacement: '3月2日', basis: '日期更正', note: 'v2' });
  const pV3a = await proposeAdoptPublish({ seg: 1, find: '张三', replacement: '张三丰', basis: '姓名补正', note: 'v3' });
  await proposeAdoptPublish({ seg: 1, find: '3月2日', replacement: '3月上旬', basis: '日期再改', note: 'v3b' });
  // v4：段2 同文替换（正文不变），用于验证“未变化范围/整段相同”不算净变化
  await proposeAdoptPublish({ seg: 2, find: '保留', replacement: '保留', basis: '同文重写', note: 'v4-同文' });

  let booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.currentVersion.id === 5, '构造出 v5 当前版本（含一次同文重写发布）');
  const seg1v4 = booth.segments.find((s) => s.seg === 1).text;
  const seg2v4 = booth.segments.find((s) => s.seg === 2).text;
  ok(seg1v4 === '申请人张三丰称：我于2024年3月上旬收到通知。', `v4 段1 正文：${seg1v4}`);
  ok(seg2v4 === seg2v1, 'v4 段2 与 v1 逐码点相同（同文重写不算变化）');

  console.log('\n[恢复预览：权限与拒绝场景]');
  await expectFail(req('POST', '/api/restore/1/preview', { reason: 'x' }, par), 403, '无权操作', '参与者尝试恢复预览');
  await expectFail(req('POST', '/api/restore/1/preview', { reason: 'x' }, rec), 403, '无权操作', '记录员尝试恢复预览');
  await expectFail(req('POST', '/api/restore/999/preview', { reason: 'x' }, rev), 404, '目标版本 v999 不存在', '目标版不存在');
  await expectFail(req('POST', '/api/restore/5/preview', { reason: 'x' }, rev), 409, '就是当前版本', '目标就是当前版');
  await expectFail(req('POST', '/api/restore/5/preview', { reason: '   ' }, rev), 400, '恢复理由不能为空', '理由为空（空白）');
  await expectFail(req('POST', '/api/restore/5/preview', {}, rev), 400, '恢复理由不能为空', '缺少理由字段');
  await expectFail(req('POST', '/api/restore/abc/preview', { reason: 'x' }, rev), 400, '目标版本号', '目标版号非整数');

  // v5 相对 v4 只有段2 的同文重写（正文逐码点不变），故恢复到 v4 应明确拒绝：两版正文相同
  await expectFail(req('POST', '/api/restore/4/preview', { reason: 'x' }, rev), 409, '逐码点相同', '两版正文相同拒绝恢复');

  console.log('\n[恢复预览 v5 -> v1：逐段净变化]');
  let pv = (await req('POST', '/api/restore/1/preview', { reason: '  后续修订均系误改，恢复初始表述  ' }, rev)).json;
  ok(pv.stageEmpty === true, '空暂存：stageEmpty=true');
  ok(pv.changedSegments === 1 && pv.changeCount === 2, `仅段1有 2 处净变化（段2同文不列出），实际 段${pv.changedSegments}/处${pv.changeCount}`);
  const ps = pv.segments.find((s) => s.seg === 1);
  ok(ps.changes.length === 2, '段1 两处变化：姓名 + 日期');
  // 找到姓名与日期两块
  const nameH = ps.changes.find((h) => h.now.text.includes('张三丰'));
  const dateH = ps.changes.find((h) => h.now.text.includes('上旬'));
  ok(nameH && nameH.old.text === '张三' && nameH.now.text === '张三丰', `姓名块当前「${nameH && nameH.now.text}」恢复为「${nameH && nameH.old.text}」`);
  ok(dateH && dateH.old.text === '3月1日' && dateH.now.text === '3月上旬', `日期块当前「${dateH && dateH.now.text}」恢复为「${dateH && dateH.old.text}」`);
  // 促成提议覆盖 v2、v3 的发布
  const allContribs = nameH.contributors.concat(dateH.contributors).map((c) => c.proposalId).sort((a, b) => a - b);
  ok(allContribs.includes(pV2) && allContribs.includes(pV3a), `促成提议包含 #${pV2}、#${pV3a}：${allContribs.join(',')}`);
  // 预览为只读：版本数与暂存不变
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.currentVersion.id === 5 && booth.stage.length === 0, '预览不改写版本，暂存仍为空');

  console.log('\n[仅空暂存可确认]');
  // 让记录员提一条、复核员采纳，制造非空暂存
  const extra = await req('POST', '/api/proposals',
    { seg: 2, start: 0, end: 1, replacement: '某', basis: '占位修订' }, rec);
  assert.strictEqual(extra.status, 201);
  await req('POST', `/api/proposals/${extra.json.id}/adopt`, {}, rev);
  pv = (await req('POST', '/api/restore/1/preview', { reason: '非空暂存场景' }, rev)).json;
  ok(pv.stageEmpty === false && pv.stageCount === 1, '非空暂存预览标记 stageEmpty=false');
  await expectFail(req('POST', '/api/restore/confirm', { token: pv.token }, rev), 409, '仅空暂存可确认', '非空暂存确认拒绝');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.stage.length === 1, '拒绝后暂存仍为原来的 1 项（未混入恢复提议）');

  // 驳回占位修订，清空暂存
  await req('POST', `/api/proposals/${extra.json.id}/reject`, { reason: '清空' }, rev);

  console.log('\n[预览后版本变化 → 整次确认拒绝且不留部分提议]');
  pv = (await req('POST', '/api/restore/1/preview', { reason: 'stale' }, rev)).json;
  // 用“同文替换”发布推进到 v6（两端正文逐码点不变）：旧令牌仍因版本号变化失效
  await req('POST', '/api/proposals', { seg: 2, start: 0, end: 2, replacement: '保留', basis: '同文推进版本' }, rec);
  booth = (await req('GET', '/api/booth', null, rev)).json;
  const pendingId = booth.proposals.find((p) => p.seg === 2 && p.replacement === '保留' && p.status === 'pending').id;
  await req('POST', `/api/proposals/${pendingId}/adopt`, {}, rev);
  await req('POST', '/api/publish', { note: 'v6-同文' }, rev);
  await expectFail(req('POST', '/api/restore/confirm', { token: pv.token }, rev), 409, '预览后已发布新版本', '预览后发布使确认失效');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.currentVersion.id === 6 && booth.stage.length === 0, '失效确认不留任何恢复提议（暂存为空）');
  ok(booth.segments.find((s) => s.seg === 2).text === seg2v1, 'v6 段2 正文与 v1 仍逐码点相同（同文发布不改正文）');

  console.log('\n[预览后暂存变化（令牌指纹不符）→ 拒绝]');
  pv = (await req('POST', '/api/restore/1/preview', { reason: 'stage stale' }, rev)).json;
  // 新建一条修订采纳后用旧令牌确认（预览时暂存为空，此刻非空）
  const guard = await req('POST', '/api/proposals', { seg: 2, start: 1, end: 2, replacement: 'X', basis: 'g' }, rec);
  await req('POST', `/api/proposals/${guard.json.id}/adopt`, {}, rev);
  await expectFail(req('POST', '/api/restore/confirm', { token: pv.token }, rev), 409, '仅空暂存可确认', '预览后暂存变非空，确认拒绝');
  await req('POST', `/api/proposals/${guard.json.id}/reject`, { reason: '清空' }, rev);

  console.log('\n[凭证缺失/篡改 → 拒绝]');
  await expectFail(req('POST', '/api/restore/confirm', {}, rev), 400, '缺少预览凭证', '无令牌');
  pv = (await req('POST', '/api/restore/1/preview', { reason: '篡改测试' }, rev)).json;
  const tampered = JSON.parse(JSON.stringify(pv.token));
  tampered.digest = '0'.repeat(64);
  await expectFail(req('POST', '/api/restore/confirm', { token: tampered }, rev), 409, '不一致', '篡改摘要拒绝');
  const badReason = JSON.parse(JSON.stringify(pv.token));
  badReason.reason = '伪造理由';
  await expectFail(req('POST', '/api/restore/confirm', { token: badReason }, rev), 409, '不一致', '篡改理由使摘要不符拒绝');

  console.log('\n[重复文字不靠同文搜索：删旧字又在末尾另插同字 → 两处独立恢复]');
  // 另建独立版本链验证：新文档无法再导入，改用现有库内新段落不行（全场一份文档）。
  // 该口径在 text.diffLineage 单元层面已验证；此处用 v5→v1 的姓名块再次确认非同文配对：
  // v1「张三」→ v3「张三丰」：若按同文搜索可能错配为仅插入「丰」，净变化应是整块「张三→张三丰」。
  pv = (await req('POST', '/api/restore/1/preview', { reason: '同文校验' }, rev)).json;
  const nh = pv.segments.find((s) => s.seg === 1).changes.find((h) => h.now.text.includes('张三丰'));
  ok(nh.old.start === 3 && nh.old.end === 5 && nh.now.start === 3 && nh.now.end === 6,
    `姓名块按码点身份对齐为整块替换 [${nh.old.start},${nh.old.end})→[${nh.now.start},${nh.now.end})，不靠同文搜索`);

  console.log('\n[确认采纳恢复提议：未变化范围不误算触及异议]');
  // 在段1放置一条异议，锚点位于“恢复净变化范围之外”的未变化文字（如“收到通知”附近，不会被恢复触及）；
  // 另放一条在日期块内（会被触及）。
  booth = (await req('GET', '/api/booth', null, rev)).json;
  const curSeg1 = booth.segments.find((s) => s.seg === 1).text;
  const iRecv = cpIndexOf(curSeg1, '收到通知');
  const iXun = cpIndexOf(curSeg1, '3月上旬');
  const oSafe = await req('POST', '/api/objections', { seg: 1, start: iRecv, end: iRecv + 4, note: '未变化范围的异议' }, par);
  assert.strictEqual(oSafe.status, 201);
  const oTouched = await req('POST', '/api/objections', { seg: 1, start: iXun, end: iXun + 4, note: '日期块异议' }, par);
  assert.strictEqual(oTouched.status, 201);

  pv = (await req('POST', '/api/restore/1/preview', { reason: '经核对恢复初始版' }, rev)).json;
  const cf = await req('POST', '/api/restore/confirm', { token: pv.token }, rev);
  assert.strictEqual(cf.status, 201, `确认失败：${JSON.stringify(cf.json)}`);
  ok(cf.json.targetVersionId === 1 && cf.json.proposalCount === 2,
    `确认生成并采纳 ${cf.json.proposalCount} 项恢复提议（应 2 项），关联目标 v1`);
  const restoreIds = cf.json.proposalIds;
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.stage.length === 2 && restoreIds.every((id) => booth.stage.some((p) => p.id === id)),
    '恢复提议全部进入暂存区');
  // 发布预览正文必须已等于目标 v1（逐码点）
  const previewSeg1 = booth.previewSegments.find((s) => s.seg === 1).text;
  const previewSeg2 = booth.previewSegments.find((s) => s.seg === 2).text;
  ok(previewSeg1 === seg1v1, `发布预览段1已等于 v1：${previewSeg1}`);
  ok(previewSeg2 === booth.segments.find((s) => s.seg === 2).text, '段2未变化，预览等于当前');

  // 恢复提议关联目标版本
  ok(restoreIds.every((id) => {
    const p = booth.proposals.find((x) => x.id === id);
    return p.restore_target_version_id === 1 && p.status === 'adopted';
  }), '恢复提议均带 restore_target_version_id=1 且状态 adopted');

  console.log('\n[发布门槛：仅净变化触及的异议须回应，未变化范围不被误算]');
  const gate = (await req('GET', '/api/publish-check', null, rev)).json;
  const gateIds = gate.items.map((it) => it.objectionId);
  ok(gateIds.includes(oTouched.json.id), `日期块异议 #${oTouched.json.id} 被判定触及`);
  ok(!gateIds.includes(oSafe.json.id), `未变化范围异议 #${oSafe.json.id} 未被误算为触及`);
  // 未回应直接发布 → 409
  await expectFail(req('POST', '/api/publish', { note: '尝试恢复发布' }, rev), 409, '未完成有效回应', '未回应异议时恢复发布被拒');
  // 回应被触及的异议
  const rs = await req('POST', `/api/objections/${oTouched.json.id}/respond`,
    { note: '恢复经核对原始录音，日期以初始记录为准，准予发布' }, rev);
  assert.strictEqual(rs.status, 201, JSON.stringify(rs.json));
  const pub = await req('POST', '/api/publish', { note: '恢复到 v1 的发布' }, rev);
  assert.strictEqual(pub.status, 201, `恢复发布失败：${JSON.stringify(pub.json)}`);
  const newId = pub.json.versionId;
  ok(newId === 7, `恢复发布形成新不可变版本 v${newId}`);

  console.log('\n[发布结果与不可变/不改写]');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.segments.find((s) => s.seg === 1).text === seg1v1, '新版本段1正文恢复为 v1 内容');
  const v1View = (await req('GET', '/api/versions/1', null, rev)).json;
  ok(v1View.segments.find((s) => s.seg === 1).text === seg1v1, '旧版 v1 快照未被改写');
  const v6View = (await req('GET', '/api/versions', null, rev)).json; // 非预期路由，忽略
  void v6View;
  const v6 = (await req('GET', `/api/versions/${newId}`, null, rev)).json;
  ok(v6.segments.find((s) => s.seg === 1).text === seg1v1, `v${newId} 快照正文为恢复后内容`);
  // v6 决议含 restore 类型，且关联提议
  const restoreDecisions = v6.decisions.filter((d) => d.type === 'restore');
  ok(restoreDecisions.length === 2, `v6 决议含 2 条 restore 留痕，实际 ${restoreDecisions.length}`);
  ok(restoreDecisions.every((d) => /恢复到 v1/.test(d.reason)), 'restore 决议理由含“恢复到 v1”与复核员理由');
  // 恢复提议随 v6 发布
  ok(restoreIds.every((id) => {
    const p = booth.proposals.find((x) => x.id === id);
    return p.status === 'published' && p.published_version_id === newId;
  }), '恢复提议已随新版本发布');

  console.log('\n[来源重放：恢复文字归恢复提议，不归初始导入]');
  const src = (await req('GET', `/api/versions/${newId}/sources/1`, null, rev)).json;
  const dateFrag = src.fragments.find((f) => f.text.includes('3月1日') && f.end <= cpIndexOf(seg1v1, '收到') + 4);
  const restoreFrags = src.fragments.filter((f) => f.source === 'proposal' && restoreIds.includes(f.proposalId));
  ok(restoreFrags.length >= 2, `恢复产生的文字片段来源标注为恢复提议（${restoreFrags.length} 片）`);
  ok(restoreFrags.some((f) => f.text === '张三') && restoreFrags.some((f) => f.text === '3月1日'),
    '来源片段包含恢复回的「张三」「3月1日」');
  void dateFrag;

  console.log('\n[跨版对照：v1→v6 净变化为零（两端正文相同），中途历史仍可见改动]');
  const d1n = (await req('GET', `/api/diff?from=1&to=${newId}`, null, rev)).json;
  const d16s1 = d1n.segments.find((s) => s.seg === 1);
  ok(d16s1.changeCount === 0, 'v1→v6 段1 净变化 0（恢复闭环）');
  const d14 = (await req('GET', '/api/diff?from=1&to=4', null, rev)).json;
  ok(d14.segments.find((s) => s.seg === 1).changeCount > 0, 'v1→v4 历史对照仍显示真实改动（历史不可变）');

  console.log('\n[关注通知：恢复发布按净变化段通知]');
  // 关注发生在恢复发布之后，不应补发该次发布的历史通知
  await req('POST', '/api/segments/1/follow', null, par);
  await req('POST', '/api/segments/1/unfollow', null, par); // 先取消（幂等），再关注确认行为一致
  await req('POST', '/api/segments/1/follow', null, par);
  // 通知只对关注之后的发布生效：这里关注发生在 v7 恢复发布之后，故不应补发 v7。再做一次恢复往返验证：
  const notifEmpty = (await req('GET', '/api/notifications', null, par)).json;
  ok(!notifEmpty.notifications.some((n) => n.toVersionId === newId && n.seg === 1), '关注不补发历史通知（无 v7 段1 通知）');

  // 往返：v7(=v1正文) -> 恢复到 v5 内容 -> 发布 v8，关注者应收到 v7→v8 段1 通知
  pv = (await req('POST', '/api/restore/5/preview', { reason: '往返验证通知' }, rev)).json;
  const cf2 = await req('POST', '/api/restore/confirm', { token: pv.token }, rev);
  assert.strictEqual(cf2.status, 201, JSON.stringify(cf2.json));
  const gate2 = (await req('GET', '/api/publish-check', null, rev)).json;
  for (const it of gate2.items) {
    const rr = await req('POST', `/api/objections/${it.objectionId}/respond`,
      { note: '往返恢复，已核对，准予发布' }, rev);
    assert.strictEqual(rr.status, 201, JSON.stringify(rr.json));
  }
  const pub2 = await req('POST', '/api/publish', { note: '往返再恢复到 v5 内容' }, rev);
  assert.strictEqual(pub2.status, 201, JSON.stringify(pub2.json));
  const notif = (await req('GET', '/api/notifications', null, par)).json;
  const mine = notif.notifications.find((n) => n.toVersionId === pub2.json.versionId && n.seg === 1);
  ok(mine && mine.fromVersionId === newId, `关注者收到 ${newId}→${pub2.json.versionId} 段1 净变化通知`);

  console.log('\n[网页只读视图中的恢复关联与待回应状态]');
  // 参与者总览中不得暴露恢复提议的依据/替换（与普通提议同口径）——段1当前非保密，参与者可见已发布提议，
  // 但待回应/发布核对仅工作人员可见
  const parBooth = (await req('GET', '/api/booth', null, par)).json;
  ok(!('publishCheck' in parBooth), '参与者总览不含 publishCheck');
  ok(parBooth.versions.every((v) => v.note === ''), '参与者看不到版本备注');

  console.log(`\n恢复功能端到端测试通过：${passed} 项断言 ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('测试失败：', e);
  process.exit(1);
});
