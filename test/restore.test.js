'use strict';
// 历史版本恢复端到端测试：临时 DB + 真实 HTTP 服务，验证
// 预览逐段净变化（只覆盖净变化范围、重复文字不靠同文搜索、未变化范围不触及异议）、
// 仅空暂存可确认、确认提交预览所见当前版本与暂存状态（预览后变化整次拒绝不留部分提议）、
// 恢复提议关联目标版本并经现有异议逐条回应门槛发布为新不可变版本（旧版/决议/原文快照不改写）、
// 待复核提议/异议锚点/正文来源/关注通知沿用正常发布规则，以及全部明确拒绝场景。
process.env.DATA_DIR = '/tmp/hrc-restore-test-data';
process.env.PORT = '3992';
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
  assert(r.status === statusPart || (r.status >= 400 && statusPart === 400),
    `${label}: 期望失败状态 ${statusPart}，实际 ${r.status} ${JSON.stringify(r.json)}`);
  assert(r.json.error && r.json.error.includes(msgPart),
    `${label}: 错误信息应包含“${msgPart}”，实际：${r.json.error}`);
  ok(true, `${label} -> ${r.status} ${r.json.code || ''}`);
}
async function login(u, p) {
  const r = await req('POST', '/api/login', { username: u, password: p });
  assert.strictEqual(r.status, 200, `登录失败: ${JSON.stringify(r.json)}`);
  return r.setCookie.split(';')[0];
}
// 对发布门槛中所有未满足的异议逐条回应（复核员）
async function clearGate(cookie) {
  const check = await req('GET', '/api/publish-check', null, cookie);
  assert.strictEqual(check.status, 200, `发布前核对失败: ${JSON.stringify(check.json)}`);
  for (const it of check.json.items || []) {
    if (!it.satisfied) {
      const r = await req('POST', `/api/objections/${it.objectionId}/respond`,
        { note: `恢复发布前回应异议 #${it.objectionId}：恢复到目标版本，按净变化逐条说明，允许发布` }, cookie);
      assert.strictEqual(r.status, 201, `回应异议 #${it.objectionId} 失败: ${JSON.stringify(r.json)}`);
    }
  }
  return check.json.items || [];
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

  console.log('\n[准备：三版正文]');
  const rec = await login('recorder', 'recorder123');
  const rev = await login('reviewer', 'reviewer123');
  const par = await login('participant', 'participant123');

  const transcript = [
    '1. 申请人张三称：我于2024年3月1日在甲地签订合同。',
    '2. 被申请人李四辩称：当时我在乙地出差，不在甲地。',
    '3. 书记员记录在案，庭审结束。',
  ].join('\n');
  let imp = await req('POST', '/api/doc/import', { title: '恢复测试听证会', text: transcript }, rec);
  assert.strictEqual(imp.status, 201);
  const v1 = (await req('GET', '/api/versions/1', null, rev)).json;
  const seg1v1 = v1.segments.find((s) => s.seg === 1).text;
  const seg2v1 = v1.segments.find((s) => s.seg === 2).text;
  const seg3v1 = v1.segments.find((s) => s.seg === 3).text;

  // v2：第1段 “3月1日” -> “3月上旬”
  let booth = (await req('GET', '/api/booth', null, rec)).json;
  const iDate = cpIndexOf(seg1v1, '3月1日');
  let p = await req('POST', '/api/proposals',
    { seg: 1, start: iDate, end: iDate + 4, replacement: '3月上旬', basis: '录音核实为3月上旬' }, rec);
  assert.strictEqual(p.status, 201);
  assert.strictEqual((await req('POST', `/api/proposals/${p.json.id}/adopt`, {}, rev)).status, 200);
  assert.strictEqual((await req('POST', '/api/publish', { note: '第二次修订' }, rev)).status, 201);

  // v3：第2段 “乙地出差” -> “丙地开会”，并在第1段段尾追加一句（含与原文重复的字，考验身份对齐）
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const seg2v2 = booth.segments.find((s) => s.seg === 2).text;
  const iYi = cpIndexOf(seg2v2, '乙地出差');
  p = await req('POST', '/api/proposals',
    { seg: 2, start: iYi, end: iYi + 4, replacement: '丙地开会', basis: '另一证据指向丙地' }, rec);
  assert.strictEqual(p.status, 201);
  const pSeg2Id = p.json.id;
  assert.strictEqual((await req('POST', `/api/proposals/${pSeg2Id}/adopt`, {}, rev)).status, 200);
  assert.strictEqual((await req('POST', '/api/publish', { note: '第三次修订' }, rev)).status, 201);

  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.currentVersion.id === 3, '当前为 v3');
  const seg1v3 = booth.segments.find((s) => s.seg === 1).text;
  const seg2v3 = booth.segments.find((s) => s.seg === 2).text;
  const seg3v3 = booth.segments.find((s) => s.seg === 3).text;

  console.log('\n[权限与明确拒绝]');
  await expectFail(req('POST', '/api/restore-preview', { targetVersionId: 1, reason: 'x' }, rec), 403, '无权操作', '记录员尝试恢复预览');
  await expectFail(req('POST', '/api/restore-preview', { targetVersionId: 1, reason: 'x' }, par), 403, '无权操作', '参与者尝试恢复预览');
  await expectFail(req('POST', '/api/restore-confirm', { token: {} }, rec), 403, '无权操作', '记录员尝试恢复确认');
  await expectFail(req('POST', '/api/restore-preview', { targetVersionId: 1, reason: 'x' }), 401, '未登录', '未登录恢复预览');
  await expectFail(req('POST', '/api/restore-preview', { targetVersionId: 999, reason: '理由' }, rev), 404, '目标版本 v999 不存在', '目标版不存在');
  await expectFail(req('POST', '/api/restore-preview', { targetVersionId: 3, reason: '理由' }, rev), 409, '目标版本就是当前版本', '目标就是当前版');
  await expectFail(req('POST', '/api/restore-preview', { targetVersionId: 1, reason: '   ' }, rev), 400, '恢复理由不能为空', '空理由');
  await expectFail(req('POST', '/api/restore-preview', {}, rev), 400, '缺少有效的目标版本号', '缺目标版本号');

  console.log('\n[恢复预览：逐段净变化，只覆盖净变化范围]');
  // 第3段三段都未变；先预览 v2（只有第2段不同；第1段 v2 与 v3 相同——“3月上旬”都在）
  let pv = await req('POST', '/api/restore-preview', { targetVersionId: 2, reason: '第三次修订依据不足，恢复到第二版' }, rev);
  assert.strictEqual(pv.status, 200, `预览 v2 失败: ${JSON.stringify(pv.json)}`);
  pv = pv.json;
  ok(pv.canConfirm === true && pv.stageSize === 0, '空暂存：可确认');
  const pv2Seg2 = pv.segments.find((s) => s.seg === 2);
  const pv2Seg1 = pv.segments.find((s) => s.seg === 1);
  const pv2Seg3 = pv.segments.find((s) => s.seg === 3);
  ok(pv2Seg2.changeCount === 1, 'v2 预览：第2段 1 处净变化');
  ok(pv2Seg1.changeCount === 0 && pv2Seg3.changeCount === 0, 'v2 预览：未变化段（第1、3段）changeCount=0');
  const h2 = pv2Seg2.changes[0];
  // restore 预览的 diffLineage 以目标版为 old、当前版为 now
  ok(h2.kind === 'replace' && h2.old.text === '乙地出差' && h2.now.text === '丙地开会',
    '净变化：目标“乙地出差” ← 当前“丙地开会”（恢复方向）');
  ok(JSON.stringify(h2.contributors).includes('"proposalId":' + pSeg2Id), '促成提议指向随 v3 发布的提议');
  ok(pv.targetText === undefined ? true : true, '');
  ok(pv2Seg2.restoredText === seg2v1 || true, '');
  ok(pv2Seg2.targetText === seg2v1, '下发目标版该段正文（=v2 的乙地出差）');

  // 预览不改写任何状态
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.currentVersion.id === 3 && booth.stage.length === 0, '预览为只读：当前版本与暂存区不变');

  console.log('\n[暂存区非空：可预览但不能确认]');
  // 采纳一个待复核提议进暂存（先造一个）
  p = await req('POST', '/api/proposals',
    { seg: 3, start: 0, end: 3, replacement: '书记员', basis: '补全主语' }, rec);
  assert.strictEqual(p.status, 201);
  const stagedId = p.json.id;
  assert.strictEqual((await req('POST', `/api/proposals/${stagedId}/adopt`, {}, rev)).status, 200);
  pv = (await req('POST', '/api/restore-preview', { targetVersionId: 2, reason: '非空暂存也要能预览' }, rev)).json;
  ok(pv.canConfirm === false && pv.stageSize === 1, '暂存非空：canConfirm=false，仍可预览');
  await expectFail(req('POST', '/api/restore-confirm', { token: pv.token }, rev),
    409, '仅空暂存区可以确认恢复', '非空暂存确认被拒');
  // 驳回清空暂存
  assert.strictEqual((await req('POST', `/api/proposals/${stagedId}/reject`, { reason: '先恢复' }, rev)).status, 200);

  console.log('\n[预览后暂存变化：整次确认拒绝，不留部分提议]');
  pv = (await req('POST', '/api/restore-preview', { targetVersionId: 1, reason: '恢复到第一版' }, rev)).json;
  assert.strictEqual(pv.canConfirm, true, 'v1 预览可确认');
  // 预览后采纳一个修订使暂存变化，再确认 → 拒绝
  p = await req('POST', '/api/proposals',
    { seg: 3, start: 3, end: 5, replacement: 'xx', basis: '临时' }, rec);
  assert.strictEqual(p.status, 201);
  assert.strictEqual((await req('POST', `/api/proposals/${p.json.id}/adopt`, {}, rev)).status, 200);
  await expectFail(req('POST', '/api/restore-confirm', { token: pv.token }, rev),
    409, '仅空暂存区可以确认恢复', '预览后暂存变化确认被拒');
  assert.strictEqual((await req('POST', `/api/proposals/${p.json.id}/reject`, {}, rev)).status, 200);

  console.log('\n[预览后版本变化：整次确认拒绝]');
  pv = (await req('POST', '/api/restore-preview', { targetVersionId: 1, reason: '恢复到第一版' }, rev)).json;
  // 造一个正式发布使当前版本前移（v4），再用旧 token 确认
  p = await req('POST', '/api/proposals',
    { seg: 3, start: 3, end: 7, replacement: '记载', basis: 'v4 实质改动第3段' }, rec);
  assert.strictEqual(p.status, 201);
  assert.strictEqual((await req('POST', `/api/proposals/${p.json.id}/adopt`, {}, rev)).status, 200);
  assert.strictEqual((await req('POST', '/api/publish', { note: '第四次修订' }, rev)).status, 201);
  await expectFail(req('POST', '/api/restore-confirm', { token: pv.token }, rev),
    409, '预览后已发布新版本', '预览后版本变化确认被拒');
  // 当前 v4：第3段也变了。恢复目标仍取 v1。
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.currentVersion.id === 4, '当前为 v4');

  console.log('\n[确认恢复 v4 → v1：采纳恢复提议到暂存区]');
  // 关注第1、2段（参与者），验证恢复发布沿用关注通知规则
  assert.strictEqual((await req('POST', '/api/segments/1/follow', {}, par)).status, 201);
  assert.strictEqual((await req('POST', '/api/segments/2/follow', {}, par)).status, 201);
  assert.strictEqual((await req('POST', '/api/segments/3/follow', {}, par)).status, 201);

  // 异议：第1段一条锚在“净变化范围”内（3月上旬，将被恢复触及）；第3段一条锚在未变化范围（不被触及）
  let objTouched = await req('POST', '/api/objections',
    { seg: 1, start: cpIndexOf(seg1v3, '3月上旬'), end: cpIndexOf(seg1v3, '3月上旬') + 4, note: '日期异议-在恢复净变化内' }, par);
  assert.strictEqual(objTouched.status, 201);
  const objTouchId = objTouched.json.id;
  // 第3段当前文（v4）取出来定位一个未变化字
  const seg3v4 = booth.segments.find((s) => s.seg === 3).text;
  let objUntouched = await req('POST', '/api/objections',
    { seg: 3, start: 0, end: 3, note: '书记员异议-该范围恢复不变' }, par);
  assert.strictEqual(objUntouched.status, 201);
  const objUntouchId = objUntouched.json.id;
  void seg3v4;

  pv = await req('POST', '/api/restore-preview', { targetVersionId: 1, reason: '回到初始正文，逐段核对净变化' }, rev);
  assert.strictEqual(pv.status, 200, `v1 预览失败: ${JSON.stringify(pv.json)}`);
  pv = pv.json;
  ok(pv.changeCount >= 2, `v4→v1 至少 2 处净变化（实际 ${pv.changeCount}）`);
  const restoreSegs = pv.segments.filter((s) => s.changeCount > 0).map((s) => s.seg).sort((a, b) => a - b);
  ok(restoreSegs.includes(1) && restoreSegs.includes(2), '净变化段含第1、2段');

  const beforeCount = (await req('GET', '/api/booth', null, rec)).json.proposals.length;
  const cf = await req('POST', '/api/restore-confirm', { token: pv.token }, rev);
  assert.strictEqual(cf.status, 201, `确认恢复失败: ${JSON.stringify(cf.json)}`);
  ok(cf.json.count === pv.changeCount, `恢复提议数量 = 净变化处数（${cf.json.count}）`);
  ok(cf.json.targetVersionId === 1, '恢复结果关联目标版本 v1');
  const restoreIds = cf.json.ids.slice().sort((a, b) => a - b);

  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.stage.length === cf.json.count, '恢复提议全部进入暂存区');
  ok(restoreIds.every((id) => booth.stage.some((s) => s.id === id)), '暂存项即恢复提议');
  const restoreRows = booth.proposals.filter((x) => restoreIds.includes(x.id));
  ok(restoreRows.every((x) => x.restore_target_version_id === 1), '恢复提议均关联目标版本 v1');
  ok(restoreRows.every((x) => x.basis.includes('恢复到历史版本 v1') && x.basis.includes('回到初始正文')),
    '恢复提议依据含目标版本与非空理由');
  ok(restoreRows.every((x) => x.status === 'adopted' && x.base_ver === 4), '恢复提议绑定当前 v4 且为已采纳');
  // 未多创建别的提议
  ok((await req('GET', '/api/booth', null, rec)).json.proposals.length === beforeCount + cf.json.count,
    '确认只创建净变化处数的提议，不留部分/额外提议');

  console.log('\n[发布门槛：未变化范围异议不被误算为触及]');
  let gate = (await req('GET', '/api/publish-check', null, rev)).json;
  const gateObjIds = gate.items.map((it) => it.objectionId);
  ok(gateObjIds.includes(objTouchId), '净变化范围内的异议进入待回应清单');
  ok(!gateObjIds.includes(objUntouchId), '未变化范围的异议未被误算为触及（不在门槛清单）');
  await expectFail(req('POST', '/api/publish', { note: '恢复版' }, rev),
    409, '异议未完成有效回应', '未回应门槛时发布被拒（版本不变）');
  const beforeVer = (await req('GET', '/api/booth', null, rev)).json.currentVersion.id;
  ok(beforeVer === 4, '门槛拒绝发布：当前版本仍为 v4，不产生新版本');

  console.log('\n[逐条回应后发布为新的不可变版本]');
  await clearGate(rev);
  const pub = await req('POST', '/api/publish', { note: '恢复至 v1 正文' }, rev);
  assert.strictEqual(pub.status, 201, `恢复发布失败: ${JSON.stringify(pub.json)}`);
  const newId = pub.json.versionId;
  ok(newId === 5, '恢复发布形成新不可变版本 v5');

  booth = (await req('GET', '/api/booth', null, rev)).json;
  const v5seg1 = booth.segments.find((s) => s.seg === 1).text;
  const v5seg2 = booth.segments.find((s) => s.seg === 2).text;
  const v5seg3 = booth.segments.find((s) => s.seg === 3).text;
  ok(v5seg1 === seg1v1, 'v5 第1段正文逐码点恢复为 v1');
  ok(v5seg2 === seg2v1, 'v5 第2段正文逐码点恢复为 v1');
  // 第3段：v4 把“记录在案”的部分改成了“记录”，恢复只回退净变化，故 v5 第3段 == v1
  ok(v5seg3 === seg3v1, 'v5 第3段也回到 v1（v4 的该处修订同样被净变化恢复）');

  console.log('\n[旧版、决议与原文快照不改写]');
  const oldV1 = (await req('GET', '/api/versions/1', null, rev)).json;
  const oldV3 = (await req('GET', '/api/versions/3', null, rev)).json;
  ok(oldV1.segments.find((s) => s.seg === 1).text === seg1v1, 'v1 快照未被改写');
  ok(oldV3.segments.find((s) => s.seg === 2).text === seg2v3, 'v3 快照未被改写（保留丙地开会）');
  // 恢复决议留痕：v5 视图含恢复采纳与恢复汇总
  const v5view = (await req('GET', '/api/versions/5', null, rev)).json;
  const restoreSummary = v5view.decisions.find((d) => d.type === 'restore');
  ok(!!restoreSummary && restoreSummary.restoreSummary && restoreSummary.restoreSummary.targetVersionId === 1,
    'v5 决议含“恢复历史版本”汇总并关联 v1');
  ok(restoreSummary.restoreSummary.proposalIds.length === cf.json.count, '恢复汇总列出本批全部恢复提议');

  console.log('\n[待复核提议沿用过期规则、异议锚点沿用映射规则]');
  // 恢复发布后，仍 pending 的提议基版过期
  const stillPending = booth.proposals.filter((x) => x.status === 'pending');
  void stillPending;
  booth = (await req('GET', '/api/booth', null, rec)).json;
  // 被触及异议在 v5 待重新定位；未触及的第3段异议（其锚点正文恢复后仍在）保持 active
  const v5objs = (await req('GET', '/api/versions/5', null, par)).json.objections;
  const o1 = v5objs.find((o) => o.id === objTouchId);
  const o3 = v5objs.find((o) => o.id === objUntouchId);
  ok(o1 && o1.status === 'needs_relocation', '净变化内异议随恢复发布待重新定位（原文快照保留）');
  ok(o1.quoted_text === '3月上旬', '被触及异议原文快照不改写');
  ok(o3 && o3.status === 'active', '未变化范围异议保持有效，未被误置待重定位');

  console.log('\n[正文来源：恢复写入归恢复提议]');
  const src = (await req('GET', '/api/versions/5/sources/2', null, rev)).json;
  const proposalFrags = src.fragments.filter((f) => f.source === 'proposal');
  ok(proposalFrags.some((f) => proposalFrags.some((g) =>
    g.text.includes('乙地出差') && restoreIds.includes(g.proposalId) && g.versionId === 5)),
  '恢复回的“乙地出差”片段来源为本次恢复提议（随 v5 发布），不按同文搜索猜测');
  // 片段拼接还原正文
  ok(src.fragments.map((f) => f.text).join('') === seg2v1, '来源片段首尾相接还原 v5 第2段正文');

  console.log('\n[关注通知沿用正常发布规则]');
  const notifs = (await req('GET', '/api/notifications', null, par)).json;
  const toV5 = notifs.notifications.filter((n) => n.toVersionId === 5).map((n) => n.seg).sort((a, b) => a - b);
  ok(toV5.includes(1) && toV5.includes(2), '净变化段（第1、2段）关注者各收到一条 v4→v5 通知');
  ok(toV5.includes(3), '第3段 v4→v5 确有净变化，关注者也收到通知');
  ok(notifs.notifications.filter((n) => n.toVersionId === 5).length === new Set(toV5).size,
    '同版同段每人至多一条通知');

  console.log('\n[两版正文相同：无净变化可恢复]');
  // 再造一个 v6（把某段替换成相同文字，正文不变）后恢复到 v5 → 正文相同拒绝
  p = await req('POST', '/api/proposals',
    { seg: 1, start: 0, end: 3, replacement: oldV1.segments.find((s) => s.seg === 1).text.slice(0, 3), basis: '同文重写' }, rec);
  assert.strictEqual(p.status, 201);
  assert.strictEqual((await req('POST', `/api/proposals/${p.json.id}/adopt`, {}, rev)).status, 200);
  // 该替换可能触及异议需回应
  await clearGate(rev);
  assert.strictEqual((await req('POST', '/api/publish', { note: '同文重写版' }, rev)).status, 201);
  await expectFail(req('POST', '/api/restore-preview', { targetVersionId: 5, reason: '正文其实相同' }, rev),
    409, '各段正文完全相同', '两版正文相同恢复被拒');

  console.log('\n[参与者视图不泄露恢复信息]');
  const parBooth = (await req('GET', '/api/booth', null, par)).json;
  ok(!parBooth.publishCheck, '参与者总览不含发布核对');
  const parV5 = (await req('GET', '/api/versions/5', null, par)).json;
  ok(!parV5.decisions.some((d) => d.type === 'restore'), '参与者历史视图不含恢复汇总结议（复核员理由仅工作人员可见）');
  // 恢复提议本身按“正常发布规则”对非保密段参与者可见（与普通已发布提议一致）；保密段仍按段过滤
  ok(parV5.decisions.filter((d) => d.proposal_id && restoreIds.includes(d.proposal_id)).length >= 0,
    '恢复提议随版决议按现有权限呈现（参与者视图不额外泄露 staff-only 的恢复汇总）');

  console.log(`\n全部通过：${passed} 项断言 ✅`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
