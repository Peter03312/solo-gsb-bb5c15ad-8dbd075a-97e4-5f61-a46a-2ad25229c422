'use strict';
// 段关注与发布通知端到端测试：临时 DB + 真实 HTTP 服务，验证
// 关注/取消关注（幂等、非法段号/无文档拒绝、未登录拒绝）、关注只影响之后的成功发布、
// 成功发布仅对“正文有净变化”的关注段每人每版每段生成至多一条通知、
// 通知倒序展示、逐条标为已读（幂等、他人通知 403、不存在 404）、取消关注不删既有通知、
// 参与者当前保密段通知整体隐藏且不计未读、解除保密恢复原已读状态、失败发布不留通知。
process.env.DATA_DIR = '/tmp/hrc-follow-test-data';
process.env.PORT = '3991';
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
    `${label}: 期望失败状态 ${statusPart}，实际 ${r.status}（${JSON.stringify(r.json)}）`);
  assert(r.json.error && r.json.error.includes(msgPart),
    `${label}: 错误信息应包含“${msgPart}”，实际：${r.json.error}`);
  ok(true, `${label} -> ${r.status} ${r.json.error}`);
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
// 记录员提交并由复核员采纳一条修订（不触及异议）
async function proposeAdoptPublish(rec, rev, { seg, start, end, replacement, note }) {
  const p = await req('POST', '/api/proposals', { seg, start, end, replacement, basis: `测试依据 ${replacement}` }, rec);
  assert.strictEqual(p.status, 201, `提议失败: ${JSON.stringify(p.json)}`);
  const ad = await req('POST', `/api/proposals/${p.json.id}/adopt`, {}, rev);
  assert.strictEqual(ad.status, 200, `采纳失败: ${JSON.stringify(ad.json)}`);
  assert.ok(!ad.json.markedConflict, `提议被标记冲突: ${JSON.stringify(ad.json)}`);
  const pub = await req('POST', '/api/publish', { note: note || `v 发布 seg${seg}` }, rev);
  assert.strictEqual(pub.status, 201, `发布失败: ${JSON.stringify(pub.json)}`);
  return pub.json.versionId;
}

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 400));

  const rec = await login('recorder', 'recorder123');
  const rev = await login('reviewer', 'reviewer123');
  const par = await login('participant', 'participant123');
  ok(rec && rev && par, '三类用户登录成功');

  console.log('\n[无文档/未登录/非法段号明确拒绝]');
  let lst = (await req('GET', '/api/notifications', null, par)).json;
  ok(lst.notifications.length === 0 && lst.unreadCount === 0, '未导入时通知列表为空');
  await expectFail(req('POST', '/api/segments/2/follow', {}), 401, '未登录', '未登录关注');
  await expectFail(req('GET', '/api/notifications'), 401, '未登录', '未登录查看通知');
  await expectFail(req('POST', '/api/segments/2/follow', {}, rec), 409, '尚未导入', '无文档时关注');

  const transcript = fs.readFileSync(require('path').join(__dirname, '..', 'sample-transcript.txt'), 'utf8');
  const imp = await req('POST', '/api/doc/import', { title: '关注测试', text: transcript }, rec);
  assert.strictEqual(imp.status, 201);
  let booth = (await req('GET', '/api/booth', null, par)).json;
  const seg2 = booth.segments.find((s) => s.seg === 2).text;
  const seg3 = booth.segments.find((s) => s.seg === 3).text;

  await expectFail(req('POST', '/api/segments/abc/follow', {}, par), 400, '段号', '非法段号关注');
  await expectFail(req('POST', '/api/segments/999/follow', {}, par), 404, '未知段号', '未知段号关注');
  await expectFail(req('POST', '/api/segments/999/unfollow', {}, par), 404, '未知段号', '未知段号取消关注');

  console.log('\n[关注/取消关注幂等，booth 下发关注集合]');
  let f = await req('POST', '/api/segments/2/follow', {}, par);
  ok(f.status === 201 && f.json.following === true, '参与者关注第 2 段');
  f = await req('POST', '/api/segments/2/follow', {}, par);
  ok(f.status === 201 && f.json.following === true, '重复关注幂等（不报错、不重复）');
  booth = (await req('GET', '/api/booth', null, par)).json;
  ok(JSON.stringify(booth.followedSegs) === '[2]', '总览返回本人关注段号集合 [2]');
  // 工作人员各自关注第 3 段
  assert.strictEqual((await req('POST', '/api/segments/3/follow', {}, rec)).status, 201);
  assert.strictEqual((await req('POST', '/api/segments/3/follow', {}, rev)).status, 201);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(JSON.stringify(booth.followedSegs) === '[3]', '关注关系按用户隔离（记录员只见自己的 [3]）');

  console.log('\n[成功发布：净变化段为关注者生成通知，含段号与两端版本号]');
  const i2 = cpIndexOf(seg2, '3月1日');
  const i3 = cpIndexOf(seg3, '2024年3月2日');
  // 同一发布内合入两处不相交修订（第 2、3 段）
  const pa = await req('POST', '/api/proposals',
    { seg: 2, start: i2, end: i2 + 4, replacement: '3月2日', basis: '通知日期更正' }, rec);
  const pb = await req('POST', '/api/proposals',
    { seg: 3, start: i3, end: i3 + 9, replacement: '2024年3月3日', basis: '被申请人更正' }, rec);
  assert.strictEqual((await req('POST', `/api/proposals/${pa.json.id}/adopt`, {}, rev)).status, 200);
  assert.strictEqual((await req('POST', `/api/proposals/${pb.json.id}/adopt`, {}, rev)).status, 200);
  let pub = await req('POST', '/api/publish', { note: '日期更正发布' }, rev);
  assert.strictEqual(pub.status, 201, `v2 发布成功: ${JSON.stringify(pub.json)}`);
  const v2 = pub.json.versionId;
  ok(v2 === 2, '形成 v2');

  let parN = (await req('GET', '/api/notifications', null, par)).json;
  ok(parN.notifications.length === 1 && parN.unreadCount === 1, '参与者：1 条未读通知（关注第 2 段）');
  const nPar = parN.notifications[0];
  ok(nPar.seg === 2 && nPar.fromVersionId === 1 && nPar.toVersionId === 2 && nPar.read === false,
    '通知含段号与两端版本号 v1→v2，初始未读');
  let recN = (await req('GET', '/api/notifications', null, rec)).json;
  let revN = (await req('GET', '/api/notifications', null, rev)).json;
  ok(recN.notifications.length === 1 && recN.notifications[0].seg === 3, '记录员：收到关注的第 3 段通知');
  ok(revN.notifications.length === 1 && revN.notifications[0].seg === 3, '复核员：收到关注的第 3 段通知');
  ok(!recN.notifications.some((x) => x.seg === 2), '未关注第 2 段的用户不收到该段通知');

  // 同版同段每人至多一条：直接验证 UNIQUE 约束（重复插入被拒绝）
  const { openDb } = require('../src/db');
  const direct = openDb();
  const parId = direct.prepare('SELECT id FROM users WHERE username=?').get('participant').id;
  assert.throws(() => {
    direct.prepare(
      `INSERT INTO segment_notifications (user_id, seg, from_version_id, to_version_id, is_read)
       VALUES (?,?,?,?,0)`
    ).run(parId, 2, 1, 2);
  }, /UNIQUE/, '同版同段同用户重复通知被唯一索引拒绝');
  direct.close();

  console.log('\n[逐条标为已读：幂等；他人通知 403；不存在 404]');
  let r = await req('POST', `/api/notifications/${nPar.id}/read`, {}, par);
  ok(r.status === 200 && r.json.read === true, '本人通知标为已读');
  parN = (await req('GET', '/api/notifications', null, par)).json;
  ok(parN.notifications[0].read === true && parN.unreadCount === 0, '标记后未读数归 0');
  const readAtFirst = parN.notifications[0].readAt;
  ok(!!readAtFirst, '已读通知返回首次标记时间');
  r = await req('POST', `/api/notifications/${nPar.id}/read`, {}, par);
  ok(r.status === 200, '重复标记已读不报错（幂等）');
  parN = (await req('GET', '/api/notifications', null, par)).json;
  ok(parN.notifications[0].readAt === readAtFirst, '重复标记不改变首次已读时间（重复标记不改变结果）');
  await expectFail(req('POST', `/api/notifications/${nPar.id}/read`, {}, rec),
    403, '他人的通知', '记录员操作参与者的通知');
  await expectFail(req('POST', '/api/notifications/99999/read', {}, par),
    404, '不存在', '标记不存在的通知');

  console.log('\n[取消关注不删除既有通知；关注只影响之后的发布]');
  r = await req('POST', '/api/segments/2/unfollow', {}, par);
  ok(r.status === 200 && r.json.following === false, '取消关注成功');
  r = await req('POST', '/api/segments/2/unfollow', {}, par);
  ok(r.status === 200, '取消未关注的段幂等');
  parN = (await req('GET', '/api/notifications', null, par)).json;
  ok(parN.notifications.length === 1, '取消关注不删除既有通知');
  booth = (await req('GET', '/api/booth', null, par)).json;
  ok(!booth.followedSegs.includes(2), '取消后关注集合不再含第 2 段');
  // 重新关注：发生在 v2 之后，之后的发布才通知，不补发 v1→v2 的历史通知（该条已存在，计数仍只随新发布增加）
  assert.strictEqual((await req('POST', '/api/segments/2/follow', {}, par)).status, 201);

  console.log('\n[即使发布了提议，合版后正文未变的段不通知]');
  // 参与者再关注第 1 段；本批发布在第 1 段做“替换成相同文字”的修订（正文净变化为空）
  assert.strictEqual((await req('POST', '/api/segments/1/follow', {}, par)).status, 201);
  const booth2 = (await req('GET', '/api/booth', null, rec)).json;
  const seg2now = booth2.segments.find((s) => s.seg === 2).text;
  const seg1 = booth2.segments.find((s) => s.seg === 1).text;
  const j2 = cpIndexOf(seg2now, '3月2日');
  const sameP = await req('POST', '/api/proposals',
    { seg: 1, start: 0, end: 1, replacement: Array.from(seg1)[0], basis: '同文重写（净变化为空）' }, rec);
  const chgP = await req('POST', '/api/proposals',
    { seg: 2, start: j2, end: j2 + 4, replacement: '3月4日', basis: '再次更正' }, rec);
  assert.strictEqual(sameP.status, 201);
  assert.strictEqual(chgP.status, 201);
  assert.strictEqual((await req('POST', `/api/proposals/${sameP.json.id}/adopt`, {}, rev)).status, 200);
  assert.strictEqual((await req('POST', `/api/proposals/${chgP.json.id}/adopt`, {}, rev)).status, 200);
  pub = await req('POST', '/api/publish', { note: '同文重写+日期再更正' }, rev);
  assert.strictEqual(pub.status, 201, `v3 发布成功: ${JSON.stringify(pub.json)}`);
  const v3 = pub.json.versionId;
  parN = (await req('GET', '/api/notifications', null, par)).json;
  const segsCovered = parN.notifications.map((x) => `${x.toVersionId}:${x.seg}`);
  ok(segsCovered.includes(`${v3}:2`), '第 2 段再次净变化 → 新通知 v2→v3');
  ok(!segsCovered.includes(`${v3}:1`), '第 1 段发布了同文替换但合版后正文未变 → 不通知');
  const nV3 = parN.notifications.find((x) => x.toVersionId === v3);
  ok(nV3.fromVersionId === v2, '新通知的旧端版本为上一已发布版本 v2（关注只影响之后的发布）');
  recN = (await req('GET', '/api/notifications', null, rec)).json;
  ok(!recN.notifications.some((x) => x.toVersionId === v3), '第 3 段本次未变 → 关注者无 v3 通知');

  console.log('\n[通知按发布时间倒序展示]');
  // 再发布一次仅第 3 段变化，使第 3 段关注者产生 v3→v4；参与者关注 2、1，第 2 段本版不变
  const booth3 = (await req('GET', '/api/booth', null, rec)).json;
  const seg3now = booth3.segments.find((s) => s.seg === 3).text;
  const k3 = cpIndexOf(seg3now, '2024年3月3日');
  const v4 = await proposeAdoptPublish(rec, rev,
    { seg: 3, start: k3, end: k3 + 9, replacement: '2024年3月5日', note: '第3段再更正' });
  revN = (await req('GET', '/api/notifications', null, rev)).json;
  const revOrder = revN.notifications.map((x) => x.toVersionId);
  ok(JSON.stringify(revOrder) === JSON.stringify([...revOrder].sort((a, b) => b - a)),
    `复核员通知按发布时间倒序：${JSON.stringify(revOrder)}`);
  ok(revN.notifications[0].toVersionId === v4 && revN.notifications[0].seg === 3,
    '最新发布 v4 的第 3 段通知排在最前');

  console.log('\n[保密：参与者当前保密段通知整体隐藏、不计未读；解除后恢复原已读状态]');
  // 参与者关注第 4 段，发布变化产生未读通知
  assert.strictEqual((await req('POST', '/api/segments/4/follow', {}, par)).status, 201);
  assert.strictEqual((await req('POST', '/api/segments/4/follow', {}, rev)).status, 201);
  const before4 = (await req('GET', '/api/notifications', null, par)).json;
  const before4Unread = before4.unreadCount;
  const seg4 = (await req('GET', '/api/booth', null, rec)).json.segments.find((s) => s.seg === 4).text;
  const i4 = cpIndexOf(seg4, '王五');
  const v5 = await proposeAdoptPublish(rec, rev,
    { seg: 4, start: i4, end: i4 + 2, replacement: '赵六', note: '第4段证人更正' });
  let parN5 = (await req('GET', '/api/notifications', null, par)).json;
  const n4 = parN5.notifications.find((x) => x.seg === 4 && x.toVersionId === v5);
  ok(n4 && n4.read === false, '第 4 段净变化 → 参与者收到未读通知');
  ok(parN5.unreadCount === before4Unread + 1, '未读数含该通知');
  // 工作人员保密期间按现有权限仍可见本人通知
  revN = (await req('GET', '/api/notifications', null, rev)).json;
  ok(revN.notifications.some((x) => x.seg === 4 && x.toVersionId === v5),
    '工作人员保密期间仍看到本人第 4 段通知（按现有权限查看）');
  // 设为保密：参与者通知整体隐藏、不计未读，且不能操作（按不存在处理）
  assert.strictEqual((await req('POST', '/api/segments/4/secret', {}, rev)).status, 201);
  parN5 = (await req('GET', '/api/notifications', null, par)).json;
  ok(!parN5.notifications.some((x) => x.seg === 4), '保密后第 4 段通知整体隐藏');
  ok(parN5.unreadCount === before4Unread, '保密段通知不计入未读数');
  await expectFail(req('POST', `/api/notifications/${n4.id}/read`, {}, par),
    404, '不存在', '保密期间参与者操作该段通知按不存在拒绝');
  // 解除保密：恢复原“未读”状态
  assert.strictEqual((await req('POST', '/api/segments/4/unsecret', {}, rev)).status, 200);
  parN5 = (await req('GET', '/api/notifications', null, par)).json;
  const back4 = parN5.notifications.find((x) => x.id === n4.id);
  ok(back4 && back4.read === false, '解除保密后通知恢复且保留原未读状态');
  ok(parN5.unreadCount === before4Unread + 1, '解除后未读数重新计入');
  // 标为已读后再保密/解除：恢复的是“已读”状态
  assert.strictEqual((await req('POST', `/api/notifications/${n4.id}/read`, {}, par)).status, 200);
  assert.strictEqual((await req('POST', '/api/segments/4/secret', {}, rev)).status, 201);
  parN5 = (await req('GET', '/api/notifications', null, par)).json;
  ok(!parN5.notifications.some((x) => x.seg === 4) && parN5.unreadCount === before4Unread,
    '再次保密：第 4 段通知再次隐藏且不计未读');
  assert.strictEqual((await req('POST', '/api/segments/4/unsecret', {}, rev)).status, 200);
  parN5 = (await req('GET', '/api/notifications', null, par)).json;
  const back4b = parN5.notifications.find((x) => x.id === n4.id);
  ok(back4b && back4b.read === true, '解除保密后恢复原已读状态');

  console.log('\n[失败发布不得留下通知]');
  // 参与者在第 5 段先提异议，记录员提交触及该异议的修订并采纳；未回应时发布被 409 拒绝
  assert.strictEqual((await req('POST', '/api/segments/5/follow', {}, par)).status, 201);
  const seg5 = (await req('GET', '/api/booth', null, par)).json.segments.find((s) => s.seg === 5).text;
  const i5q = cpIndexOf(seg5, '录音');
  const obj = await req('POST', '/api/objections',
    { seg: 5, start: i5q, end: i5q + 2, note: '对“录音”表述有异议' }, par);
  assert.strictEqual(obj.status, 201, `异议创建失败: ${JSON.stringify(obj.json)}`);
  const beforeFail = (await req('GET', '/api/notifications', null, par)).json.notifications.length;
  const failP = await req('POST', '/api/proposals',
    { seg: 5, start: i5q, end: i5q + 2, replacement: '录像', basis: '改为录像' }, rec);
  assert.strictEqual(failP.status, 201);
  assert.strictEqual((await req('POST', `/api/proposals/${failP.json.id}/adopt`, {}, rev)).status, 200);
  await expectFail(req('POST', '/api/publish', { note: '应被拒绝的发布' }, rev),
    409, '未完成有效回应', '异议未回应时发布');
  const afterFailList = (await req('GET', '/api/notifications', null, par)).json;
  ok(afterFailList.notifications.length === beforeFail, '失败发布没有留下任何通知');
  const curVer = (await req('GET', '/api/booth', null, rev)).json.currentVersion.id;
  ok(curVer === v5, '失败发布未产生新版本');
  // 回应后成功发布 → 通知产生
  const check = await req('GET', '/api/publish-check', null, rev);
  for (const it of check.json.items || []) {
    if (!it.satisfied) {
      const rr = await req('POST', `/api/objections/${it.objectionId}/respond`,
        { note: '经核对，“录像”表述准确，异议不影响发布' }, rev);
      assert.strictEqual(rr.status, 201, `回应失败: ${JSON.stringify(rr.json)}`);
    }
  }
  pub = await req('POST', '/api/publish', { note: '第5段更正（已回应）' }, rev);
  assert.strictEqual(pub.status, 201, `回应后发布成功: ${JSON.stringify(pub.json)}`);
  const okList = (await req('GET', '/api/notifications', null, par)).json;
  ok(okList.notifications.some((x) => x.seg === 5 && x.toVersionId === pub.json.versionId),
    '成功发布后第 5 段关注通知产生');
  ok(okList.notifications.length === beforeFail + 1, '仅成功发布新增一条通知');

  console.log(`\n全部通过：${passed} 项断言 ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n测试失败：', e.message);
  console.error(e.stack);
  process.exit(1);
});
