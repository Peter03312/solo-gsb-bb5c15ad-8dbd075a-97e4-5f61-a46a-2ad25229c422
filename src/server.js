'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');
const { openDb, verifyPassword } = require('./db');
const { currentUser, requireAuth, requireRole, createSession, destroySession } = require('./auth');
const store = require('./store');
const att = require('./attachments');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

const db = openDb();
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(currentUser(db));

function publicUser(u) {
  return u ? { id: u.id, username: u.username, displayName: u.displayName, role: u.role } : null;
}

// 统一错误出口：业务错误须写明原因且不改变状态（错误在事务中抛出即回滚）
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// ---------- 认证 ----------
app.post('/api/login', wrap((req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  const row = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误', code: 'BAD_CREDENTIALS' });
  }
  const token = createSession(db, row.id);
  res.setHeader(
    'Set-Cookie',
    `session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 12}`
  );
  res.json({
    user: { id: row.id, username: row.username, displayName: row.display_name, role: row.role },
  });
}));

app.post('/api/logout', wrap((req, res) => {
  destroySession(db, req.sessionToken);
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
}));

app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- 校订台总览 ----------
app.get('/api/booth', requireAuth, wrap((req, res) => {
  res.json(store.boothView(db, req.user));
}));

// ---------- 导入（记录员，仅一次） ----------
app.post('/api/doc/import', requireRole('recordist'), wrap((req, res) => {
  const { title, text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: '缺少 text（UTF-8 逐字稿全文）' });
  const versionId = store.importTranscript(db, req.user, title, text);
  res.status(201).json({ ok: true, baseVersionId: versionId });
}));

// ---------- 提议（记录员） ----------
app.post('/api/proposals', requireRole('recordist'), wrap((req, res) => {
  const id = store.createProposal(db, req.user, req.body || {});
  res.status(201).json({ ok: true, id });
}));

app.post('/api/proposals/:id/adopt', requireRole('reviewer'), wrap((req, res) => {
  const result = store.adoptProposal(db, req.user, parseInt(req.params.id, 10));
  res.json({ ok: true, ...result });
}));

app.post('/api/proposals/:id/reject', requireRole('reviewer'), wrap((req, res) => {
  const { reason } = req.body || {};
  store.rejectProposal(db, req.user, parseInt(req.params.id, 10), reason);
  res.json({ ok: true });
}));

// ---------- 续提（记录员；仅限本人的“基版已过期”冲突提议，归属校验在 store 内） ----------
app.post('/api/proposals/:id/rebase-preview', requireRole('recordist'), wrap((req, res) => {
  res.json(store.rebasePreview(db, req.user, parseInt(req.params.id, 10)));
}));

app.post('/api/proposals/:id/rebase-confirm', requireRole('recordist'), wrap((req, res) => {
  const id = store.confirmRebase(db, req.user, parseInt(req.params.id, 10), req.body || {});
  res.status(201).json({ ok: true, id });
}));

// ---------- 发布（复核员） ----------
app.post('/api/publish', requireRole('reviewer'), wrap((req, res) => {
  const { note } = req.body || {};
  const versionId = store.publish(db, req.user, note);
  res.status(201).json({ ok: true, versionId });
}));

// ---------- 异议（全部登录用户可提出；重新定位限提出者/复核员，在 store 内校验） ----------
app.post('/api/objections', requireAuth, wrap((req, res) => {
  const id = store.createObjection(db, req.user, req.body || {});
  res.status(201).json({ ok: true, id });
}));

app.post('/api/objections/:id/relocate', requireAuth, wrap((req, res) => {
  store.relocateObjection(db, req.user, parseInt(req.params.id, 10), req.body || {});
  res.json({ ok: true });
}));

// 发布前异议回应（复核员）：非空说明 + 关联异议、采纳提议与当前版本/暂存状态
app.post('/api/objections/:id/respond', requireRole('reviewer'), wrap((req, res) => {
  const { note } = req.body || {};
  const result = store.respondToObjection(db, req.user, parseInt(req.params.id, 10), note);
  res.status(201).json({ ok: true, ...result });
}));

// 发布前核对（只读）：仅记录员与复核员可见待回应异议、关联提议与回应状态/失效原因；
// 与 GET /api/booth 中工作人员视图的 publishCheck 相同（参与者视图不含该字段）。
app.get('/api/publish-check', requireRole('recordist', 'reviewer'), wrap((_req, res) => {
  const ver = store.latestVersion(db);
  if (!ver || !store.getDoc(db)) {
    return res.json({ initialized: false, versionId: null, stageFp: '', items: [] });
  }
  res.json({ initialized: true, ...store.publishGate(db, ver) });
}));

// ---------- 段级保密（复核员）：按段号保密/解除，留痕操作人、时间与前后状态 ----------
app.post('/api/segments/:seg/secret', requireRole('reviewer'), wrap((req, res) => {
  const result = store.setSegmentSecret(db, req.user, parseInt(req.params.seg, 10), true);
  res.status(201).json({ ok: true, ...result });
}));

app.post('/api/segments/:seg/unsecret', requireRole('reviewer'), wrap((req, res) => {
  const result = store.setSegmentSecret(db, req.user, parseInt(req.params.seg, 10), false);
  res.json({ ok: true, ...result });
}));

// 保密变更留痕（仅复核员查看）
app.get('/api/secret-logs', requireRole('reviewer'), wrap((_req, res) => {
  res.json({ logs: store.listSecretLogs(db) });
}));

// ---------- 段关注（任一登录用户，按已导入逐字稿的段号） ----------
// 关注/取消关注均幂等：重复关注/取消未关注段返回当前状态；关注只影响之后的成功发布。
// 无文档 409、无效段号 400、未知段号 404；未登录由 requireAuth 拒绝（401）。
app.post('/api/segments/:seg/follow', requireAuth, wrap((req, res) => {
  const result = store.setSegmentFollow(db, req.user, parseInt(req.params.seg, 10), true);
  res.status(201).json({ ok: true, ...result });
}));

app.post('/api/segments/:seg/unfollow', requireAuth, wrap((req, res) => {
  const result = store.setSegmentFollow(db, req.user, parseInt(req.params.seg, 10), false);
  res.json({ ok: true, ...result });
}));

// ---------- 段关注通知（仅本人）：按发布时间倒序，可逐条标为已读 ----------
// 参与者当前保密段的通知整体隐藏且不计未读，解除保密后恢复原已读状态；工作人员按现有权限查看。
app.get('/api/notifications', requireAuth, wrap((req, res) => {
  res.json(store.listNotifications(db, req.user));
}));

// 标为已读：仅本人；操作他人通知 403，通知不存在（含对参与者隐藏的保密段通知）404；重复标记幂等。
app.post('/api/notifications/:id/read', requireAuth, wrap((req, res) => {
  const result = store.markNotificationRead(db, req.user, parseInt(req.params.id, 10));
  res.json({ ok: true, ...result });
}));

// ---------- 不可变版本视图 ----------
app.get('/api/versions/:id', requireAuth, wrap((req, res) => {
  res.json(store.versionView(db, parseInt(req.params.id, 10), req.user));
}));

// ---------- 正文来源（任一已发布版本·按段；保密段对参与者 403） ----------
app.get('/api/versions/:id/sources/:seg', requireAuth, wrap((req, res) => {
  res.json(store.provenanceView(
    db,
    parseInt(req.params.id, 10),
    parseInt(req.params.seg, 10),
    req.user
  ));
}));

// ---------- 跨版净变化对照（两个按时间先后排列的已发布版本，按段对照） ----------
// GET /api/diff?from=A&to=B（A、B 均为已发布版本且 A < B）；只读，不改写任何状态。
// 参与者对当前保密段只见占位，不获得该段文字、变化数量或提议信息；解除保密后可重查。
app.get('/api/diff', requireAuth, wrap((req, res) => {
  const from = parseInt(req.query.from, 10);
  const to = parseInt(req.query.to, 10);
  res.json(store.diffView(db, from, to, req.user));
}));

// ---------- 提议依据附件 ----------
// 上传：请求体为文件原始字节（application/octet-stream，或任意非 JSON 类型），
// 原始文件名与预期 SHA-256 经请求头提交。仅记录员、且仅对本人“待复核”提议。
const uploadRaw = express.raw({
  type: () => true,
  limit: att.MAX_BYTES + 1, // 越限由 body-parser 中断请求并进入下方 413 处理
});

app.post(
  '/api/proposals/:id/attachments',
  requireRole('recordist'),
  (req, res, next) => {
    const ct = (req.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/json')) {
      return res.status(400).json({
        error: '上传请求体必须是文件的原始字节，而非 JSON；请直接发送文件内容并设置 X-Attachment-Filename / X-Attachment-SHA256 请求头',
        code: 'BAD_CONTENT_TYPE',
      });
    }
    next();
  },
  uploadRaw,
  (err, req, res, next) => {
    // body-parser 超限：明确报错，不产生附件记录或落盘文件
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({
        error: `文件超过大小限制：单件不超过 ${att.formatBytes(att.MAX_BYTES)}；上传已拒绝，未保存任何内容`,
        code: 'FILE_TOO_LARGE',
        limitBytes: att.MAX_BYTES,
        receivedBytes: err.length || null,
      });
    }
    return next(err);
  },
  wrap((req, res) => {
    let displayName = req.headers['x-attachment-filename'];
    if (displayName) {
      try { displayName = decodeURIComponent(displayName); }
      catch (_) { /* 保留原样，后续 trim 校验 */ }
    }
    const meta = store.addAttachment(db, req.user, parseInt(req.params.id, 10), {
      buffer: Buffer.isBuffer(req.body) ? req.body : null,
      displayName,
      expectedSha256: req.headers['x-attachment-sha256'],
    });
    res.status(201).json({ ok: true, attachment: meta });
  })
);

// 删除误传附件：仅上传者本人且提议仍待复核；冻结后 409
app.delete('/api/attachments/:aid', requireRole('recordist'), wrap((req, res) => {
  store.deleteAttachment(db, req.user, parseInt(req.params.aid, 10));
  res.json({ ok: true });
}));

// 下载依据文件：复核员可下载全部，记录员仅限本人上传，参与者一律 404
// （不获得元数据、内容或下载地址，保密段与历史视图同样遵守）。
app.get('/api/attachments/:aid/download', requireAuth, wrap((req, res) => {
  const row = store.authorizeDownload(db, req.user, parseInt(req.params.aid, 10));
  const filePath = att.attachmentPath(row.stored_name);
  if (!att.attachmentExists(row.stored_name)) {
    return res.status(500).json({ error: '附件文件在存储中缺失（元数据保留），请联系管理员核对数据卷', code: 'STORAGE_MISSING' });
  }
  const stat = fs.statSync(filePath);
  const fallback = `attachment-${row.id}-${row.media_type}.${
    row.media_type === 'jpeg' ? 'jpg' : row.media_type
  }`;
  const asciiName = (row.display_name.replace(/[^\x21-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || fallback);
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('X-Attachment-SHA256', row.actual_sha256);
  res.setHeader('Content-Disposition',
    `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(row.display_name)}`);
  const stream = fs.createReadStream(filePath);
  stream.on('error', (e) => {
    console.error('[attachment] 读取失败：', e);
    if (!res.headersSent) res.status(500).json({ error: '读取附件文件失败', code: 'STORAGE_ERROR' });
    else res.destroy(e);
  });
  stream.pipe(res);
}));

// ---------- 静态前端 ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 错误处理 ----------
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: err.message || '服务器内部错误',
    code: err.code || (status === 500 ? 'INTERNAL' : 'ERROR'),
  });
});

app.listen(PORT, HOST, () => {
  console.log(`听证会校订台已启动：http://localhost:${PORT}`);
});
