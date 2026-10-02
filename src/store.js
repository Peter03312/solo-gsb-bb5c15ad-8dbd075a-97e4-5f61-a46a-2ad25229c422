'use strict';
// 业务核心：导入、提议、采纳/驳回、冲突标记、发布合版、版本视图、异议引用、基版过期提议的续提
const { codeLength, sliceCP, validateRange, overlaps, applyEdits, transformRange, transformRangeRebase, editTouchesAnchor, replayProvenance, diffLineage, editsFromHunks } = require('./text');
const att = require('./attachments');

// ---------- 解析 ----------
// 行首段号格式： 12. 文字 / 12、文字 / 12 制表符或空格 + 文字；单独一行 "12" 视为空文段。
function parseTranscript(text) {
  if (typeof text !== 'string' || text.length === 0) {
    throw badRequest('逐字稿内容为空（须为 UTF-8 文本）');
  }
  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const segments = [];
  const used = new Set();
  let auto = 1;
  lines.forEach((raw, i) => {
    const lineNo = i + 1;
    let m = raw.match(/^(\d+)[.、．]\s?(.*)$/) || raw.match(/^(\d+)[\t 　]+(.*)$/) || raw.match(/^(\d+)$/);
    if (m) {
      const seg = parseInt(m[1], 10);
      if (used.has(seg)) throw badRequest(`第 ${lineNo} 行：段号 ${seg} 重复，无法导入`);
      used.add(seg);
      segments.push({ seg, text: (m[2] || '').trim() });
    } else {
      const body = raw.trim();
      if (body === '') return; // 无段号空行：跳过
      while (used.has(auto)) auto++;
      used.add(auto);
      segments.push({ seg: auto, text: body });
      auto++;
    }
  });
  if (segments.length === 0) throw badRequest('未解析出任何段落：请使用“段号. 正文”格式或直接粘贴正文');
  return segments;
}

function badRequest(msg, code = 'BAD_REQUEST') {
  return Object.assign(new Error(msg), { status: 400, code });
}
function conflict(msg, code = 'CONFLICT') {
  return Object.assign(new Error(msg), { status: 409, code });
}
function notFound(msg) {
  return Object.assign(new Error(msg), { status: 404, code: 'NOT_FOUND' });
}
function forbidden(msg) {
  return Object.assign(new Error(msg), { status: 403, code: 'FORBIDDEN' });
}

// ---------- 读取辅助 ----------
function getDoc(db) {
  return db.prepare('SELECT * FROM doc_meta WHERE id = 1').get() || null;
}
function latestVersion(db) {
  return db.prepare('SELECT * FROM versions ORDER BY id DESC LIMIT 1').get() || null;
}
function segmentsOf(version) {
  return JSON.parse(version.segments_json);
}
function segIndex(segments, seg) {
  return segments.findIndex((s) => s.seg === seg);
}
function userLabel(u) {
  return u ? `${u.display_name}(${u.username})` : '';
}

function addDecision(db, { type, proposalId = null, versionId = null, actorId, reason = '', detail = {} }) {
  db.prepare(
    `INSERT INTO decisions (type, proposal_id, version_id, actor_id, reason, detail_json)
     VALUES (?,?,?,?,?,?)`
  ).run(type, proposalId, versionId, actorId, reason, JSON.stringify(detail));
}

// ---------- 段级保密 ----------
// 保密以段号为准：段号在各版本间不变（发布只改段内正文），故对当前及全部历史版本立即生效。
const SECRET_PLACEHOLDER = '该段已按段号保密';

function secretSegs(db) {
  return new Set(db.prepare('SELECT seg FROM segment_secrets').all().map((r) => r.seg));
}
function isSecretSeg(db, seg) {
  return !!db.prepare('SELECT 1 FROM segment_secrets WHERE seg=?').get(seg);
}
function isStaff(actor) {
  return actor && (actor.role === 'reviewer' || actor.role === 'recordist');
}

// 复核员按段号保密/解除保密。未知段号 404、重复设置 409、无权由路由层拦截；事务内执行，失败不改状态。
function setSegmentSecret(db, actor, seg, secret) {
  if (!getDoc(db)) throw conflict('尚未导入逐字稿，无段号可保密', 'NO_DOCUMENT');
  if (!Number.isInteger(seg)) throw badRequest('缺少有效的段号 seg');
  const cur = latestVersion(db);
  const segments = segmentsOf(cur);
  if (segIndex(segments, seg) === -1) {
    throw notFound(`未知段号：当前版本 v${cur.id} 中不存在第 ${seg} 段，无法${secret ? '设为保密' : '解除保密'}`);
  }
  return db.transaction(() => {
    const already = isSecretSeg(db, seg);
    if (secret && already) {
      throw conflict(`第 ${seg} 段已是保密状态，请勿重复设置`, 'ALREADY_SECRET');
    }
    if (!secret && !already) {
      throw conflict(`第 ${seg} 段当前未保密，无需解除`, 'ALREADY_PUBLIC');
    }
    if (secret) db.prepare('INSERT INTO segment_secrets (seg) VALUES (?)').run(seg);
    else db.prepare('DELETE FROM segment_secrets WHERE seg=?').run(seg);
    const previous = secret ? 'public' : 'secret';
    const next = secret ? 'secret' : 'public';
    const r = db.prepare(
      `INSERT INTO secret_logs (seg, action, actor_id, previous_state, new_state)
       VALUES (?,?,?,?,?)`
    ).run(seg, secret ? 'classify' : 'declassify', actor.id, previous, next);
    return { seg, secret, logId: r.lastInsertRowid, previousState: previous, newState: next };
  })();
}

function listSecretLogs(db) {
  return db
    .prepare(
      `SELECT l.id, l.seg, l.action, l.previous_state, l.new_state, l.created_at,
              u.display_name AS actor_name, u.username AS actor_user
       FROM secret_logs l JOIN users u ON u.id = l.actor_id
       ORDER BY l.id DESC`
    )
    .all();
}

// ---------- 段关注与发布通知 ----------
// 登录用户可按段号关注/取消关注“已导入逐字稿”的段落。关注只影响之后的成功发布，不补发历史通知。
function followedSegsFor(db, userId) {
  return new Set(
    db.prepare('SELECT seg FROM segment_follows WHERE user_id=?').all(userId).map((r) => r.seg)
  );
}

// 关注/取消关注均为幂等：重复关注不重复建立、取消未关注的段也不报错（非法段号/无文档仍明确拒绝）。
function setSegmentFollow(db, actor, seg, follow) {
  if (!getDoc(db)) throw conflict('尚未导入逐字稿，无段号可关注', 'NO_DOCUMENT');
  if (!Number.isInteger(seg)) throw badRequest('缺少有效的段号 seg');
  const cur = latestVersion(db);
  if (segIndex(segmentsOf(cur), seg) === -1) {
    throw notFound(`未知段号：当前版本 v${cur.id} 中不存在第 ${seg} 段，无法关注或取消关注`);
  }
  return db.transaction(() => {
    if (follow) {
      db.prepare('INSERT OR IGNORE INTO segment_follows (user_id, seg) VALUES (?,?)').run(actor.id, seg);
    } else {
      db.prepare('DELETE FROM segment_follows WHERE user_id=? AND seg=?').run(actor.id, seg);
    }
    return { seg, following: follow };
  })();
}

// 发布事务内调用：为“发布时仍关注该段”的用户生成通知。
// 口径：仅当该段从 fromVersion 到 newVersion 的最终正文存在净变化（逐码点不等）时通知；
// 即使发布了提议，只要合版后该段正文未变（如把文字替换成相同文字）就不通知。
// 同版同段每人至多一条：UNIQUE(user,to_version_id,seg) 兜底；本函数整体在发布事务中，失败随发布回滚。
function emitFollowNotifications(db, oldSegments, newSegments, fromVersionId, toVersionId) {
  const changedSegs = [];
  for (const s of newSegments) {
    const idx = segIndex(oldSegments, s.seg);
    if (idx === -1 || oldSegments[idx].text !== s.text) changedSegs.push(s.seg);
  }
  if (!changedSegs.length) return 0;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO segment_notifications
       (user_id, seg, from_version_id, to_version_id, is_read)
     VALUES (?,?,?,?,0)`
  );
  let created = 0;
  for (const seg of changedSegs) {
    const followers = db.prepare('SELECT user_id FROM segment_follows WHERE seg=?').all(seg);
    for (const f of followers) {
      const r = ins.run(f.user_id, seg, fromVersionId, toVersionId);
      created += r.changes;
    }
  }
  return created;
}

// 通知视图：只返回本人的通知，按发布时间（新版本号）倒序，同发布按段号、通知 id 倒序。
// 参与者对“当前保密段”的通知整体隐藏——不返回、不计入未读数；解除保密后恢复原已读状态（行未被改动）。
// 工作人员（记录员/复核员）按现有权限看到本人全部通知（保密不影响工作人员）。
function listNotifications(db, viewer) {
  if (!getDoc(db)) return { notifications: [], unreadCount: 0 };
  const secrets = secretSegs(db);
  const rows = db
    .prepare(
      `SELECT n.id, n.seg, n.from_version_id, n.to_version_id, n.is_read, n.read_at, n.created_at
       FROM segment_notifications n
       WHERE n.user_id = ?
       ORDER BY n.to_version_id DESC, n.seg DESC, n.id DESC`
    )
    .all(viewer.id);
  const notifications = [];
  let unreadCount = 0;
  for (const n of rows) {
    if (!isStaff(viewer) && secrets.has(n.seg)) continue; // 当前保密段：整体隐藏
    const item = {
      id: n.id,
      seg: n.seg,
      fromVersionId: n.from_version_id,
      toVersionId: n.to_version_id,
      read: !!n.is_read,
      readAt: n.read_at || null,
      createdAt: n.created_at,
    };
    notifications.push(item);
    if (!n.is_read) unreadCount++;
  }
  return { notifications, unreadCount };
}

// 逐条标为已读：仅可操作本人通知；操作他人通知明确 403 拒绝；通知不存在 404；
// 参与者当前保密段的通知已整体隐藏，按不存在处理（解除保密后恢复原已读状态）；
// 重复标记不改变结果（幂等，read_at 保留首次标记时间）。
function markNotificationRead(db, actor, id) {
  if (!Number.isInteger(id)) throw badRequest('缺少有效的通知 id');
  const n = db.prepare('SELECT * FROM segment_notifications WHERE id=?').get(id);
  if (!n) throw notFound(`通知 #${id} 不存在`);
  if (n.user_id !== actor.id) {
    throw forbidden('无权操作：不能将他人的通知标为已读，只能操作自己的通知');
  }
  if (!isStaff(actor) && isSecretSeg(db, n.seg)) {
    // 保密期间对参与者不可见、不可操作；通知与已读状态均保留，解除保密后恢复
    throw notFound(`通知 #${id} 不存在`);
  }
  if (!n.is_read) {
    db.prepare(
      `UPDATE segment_notifications SET is_read=1, read_at=datetime('now') WHERE id=? AND is_read=0`
    ).run(id);
  }
  return { id, read: true };
}

// ---------- 提议依据附件 ----------
function attachmentRow(db, id) {
  return db
    .prepare(
      `SELECT a.*, u.display_name AS uploader_name, u.username AS uploader_user, p.status AS proposal_status
       FROM proposal_attachments a
       JOIN users u ON u.id = a.uploaded_by
       JOIN proposals p ON p.id = a.proposal_id
       WHERE a.id = ?`
    )
    .get(id);
}

// 附件是否对当前查看者可见：参与者在任何视图（含保密段/历史视图）都不得获得
// 附件元数据、内容或下载地址；记录员只能看到本人上传；复核员可查看全部。
function canSeeAttachment(viewer, row) {
  if (!viewer) return false;
  if (viewer.role === 'reviewer') return true;
  if (viewer.role === 'recordist') return row.uploaded_by === viewer.id;
  return false;
}

function attachmentMeta(row) {
  return {
    id: row.id,
    proposalId: row.proposal_id,
    displayName: row.display_name,
    mediaType: row.media_type,
    mime: row.mime_type,
    size: row.size_bytes,
    expectedSha256: row.expected_sha256,
    actualSha256: row.actual_sha256,
    sha256Matched: row.expected_sha256 === row.actual_sha256,
    frozen: row.proposal_status !== 'pending',
    uploadedBy: { id: row.uploaded_by, name: row.uploader_name, username: row.uploader_user },
    uploadedAt: row.uploaded_at,
    url: `/api/attachments/${row.id}/download`,
  };
}

// 取一批提议的可见附件（一次查询，按提议分组）；参与者返回空映射
function attachmentsByProposal(db, viewer, proposalIds) {
  const map = new Map(proposalIds.map((id) => [id, []]));
  if (!viewer || viewer.role === 'participant' || proposalIds.length === 0) return map;
  const placeholders = proposalIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT a.*, u.display_name AS uploader_name, u.username AS uploader_user, p.status AS proposal_status
       FROM proposal_attachments a
       JOIN users u ON u.id = a.uploaded_by
       JOIN proposals p ON p.id = a.proposal_id
       WHERE a.proposal_id IN (${placeholders})
       ORDER BY a.id`
    )
    .all(...proposalIds);
  for (const row of rows) {
    if (!canSeeAttachment(viewer, row)) continue; // 记录员看不到他人附件
    map.get(row.proposal_id).push(attachmentMeta(row));
  }
  return map;
}

// 上传依据文件：全部校验通过后在同一个数据库事务内复查提议状态并落库；
// 任一环节失败都明确报错、不留半成品或孤儿文件。
function addAttachment(db, actor, proposalId, { buffer, displayName, expectedSha256 }) {
  if (!Number.isInteger(proposalId)) throw badRequest('缺少有效的提议 id');
  const name = typeof displayName === 'string' ? displayName.trim() : '';
  if (!name) throw badRequest('缺少原始文件名：请通过 X-Attachment-Filename 头提交（UTF-8，请百分号编码）', 'NO_FILENAME');
  if (name.length > 255) throw badRequest('文件名过长（最多 255 个字符）', 'FILENAME_TOO_LONG');
  if (!Buffer.isBuffer(buffer)) throw badRequest('缺少文件内容（请求体须为文件的原始字节）', 'EMPTY_FILE');

  const p = db.prepare('SELECT * FROM proposals WHERE id=?').get(proposalId);
  if (!p) throw notFound(`提议 #${proposalId} 不存在，无法上传依据文件`);
  // 归属先校验（无权者不获得提议状态以外的任何信息）；最终状态在写事务内复查
  if (p.created_by !== actor.id) {
    throw forbidden(`无权操作：只能为本人提交的待复核提议 #${proposalId} 上传依据文件`);
  }
  if (p.status !== 'pending') {
    throw conflict(`提议 #${proposalId} 已“${p.status}”，附件集合已冻结，不能再上传；仅待复核提议可补充依据`, 'PROPOSAL_FROZEN');
  }

  if (buffer.length === 0) throw badRequest('文件内容为空，拒绝上传（不产生附件记录）', 'EMPTY_FILE');
  if (buffer.length > att.MAX_BYTES) {
    throw Object.assign(
      new Error(`文件超过大小限制：单件不超过 ${att.formatBytes(att.MAX_BYTES)}，本次 ${att.formatBytes(buffer.length)}；已拒绝，未保存任何内容`),
      { status: 413, code: 'FILE_TOO_LARGE' }
    );
  }
  const type = att.sniffMediaType(buffer);
  if (!type) {
    throw badRequest(
      '文件内容无法识别：仅接收内容可识别的 PDF、PNG、JPEG、MP3 或 WAV（按文件头判定，改后缀名无效）；已拒绝，未保存任何内容',
      'UNSUPPORTED_MEDIA_TYPE'
    );
  }
  const digest = att.sha256(buffer);
  const want = String(expectedSha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) {
    throw badRequest('缺少有效的预期 SHA-256：请通过 X-Attachment-SHA256 头提交 64 位十六进制摘要', 'NO_SHA256');
  }
  if (want !== digest) {
    throw Object.assign(
      new Error(`SHA-256 摘要不符：提交的预期摘要与文件实际内容不一致（实际 ${digest}）；已拒绝，未保存任何内容`),
      { status: 422, code: 'SHA256_MISMATCH', expected: want, actual: digest }
    );
  }

  // 事务内最终复查状态（防止“校验期间提议被采纳/驳回/标记冲突/发布”）；
  // 先把整文件写入临时文件并原子改名，INSERT 失败时立即清除，避免孤儿文件。
  let storedName = null;
  const result = db.transaction(() => {
    const cur = db.prepare('SELECT status, created_by FROM proposals WHERE id=?').get(proposalId);
    if (cur.status !== 'pending') {
      throw conflict(`提议 #${proposalId} 状态已变为“${cur.status}”，附件集合冻结，本次上传取消（未保存文件）`, 'PROPOSAL_FROZEN');
    }
    if (cur.created_by !== actor.id) {
      throw forbidden(`无权操作：提议 #${proposalId} 非本人提交`);
    }
    storedName = att.newStoredName(proposalId, type.ext);
    att.writeAttachment(storedName, buffer);
    const r = db.prepare(
      `INSERT INTO proposal_attachments
        (proposal_id, display_name, stored_name, media_type, mime_type, size_bytes,
         expected_sha256, actual_sha256, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(proposalId, name, storedName, type.mediaType, type.mime, buffer.length, want, digest, actor.id);
    return r.lastInsertRowid;
  });

  let id;
  try {
    id = result();
  } catch (e) {
    if (storedName) {
      try { att.removeAttachment(storedName); } catch (_) { /* 已在失败路径尽力清理 */ }
    }
    throw e;
  }
  return attachmentMeta(attachmentRow(db, id));
}

// 删除误传附件：仅待复核提议、上传者本人；冻结后一律拒绝。
function deleteAttachment(db, actor, attachmentId) {
  if (!Number.isInteger(attachmentId)) throw badRequest('缺少有效的附件 id');
  const row = db.prepare('SELECT * FROM proposal_attachments WHERE id=?').get(attachmentId);
  if (!row) throw notFound(`附件 #${attachmentId} 不存在`);
  if (row.uploaded_by !== actor.id) {
    // 对无权者不暴露附件是否存在：统一按不存在处理
    throw notFound(`附件 #${attachmentId} 不存在`);
  }
  const p = db.prepare('SELECT status FROM proposals WHERE id=?').get(row.proposal_id);
  if (p.status !== 'pending') {
    throw conflict(`提议 #${row.proposal_id} 已“${p.status}”，附件集合冻结，不能删除`, 'PROPOSAL_FROZEN');
  }
  db.transaction(() => {
    // 事务内以最终提议状态为准（并发复核可能刚使提议离开 pending）
    const cur = db.prepare('SELECT status FROM proposals WHERE id=?').get(row.proposal_id);
    if (cur.status !== 'pending') {
      throw conflict(`提议 #${row.proposal_id} 状态已变为“${cur.status}”，附件集合冻结，删除取消`, 'PROPOSAL_FROZEN');
    }
    db.prepare('DELETE FROM proposal_attachments WHERE id=?').run(attachmentId);
    try {
      att.removeAttachment(row.stored_name);
    } catch (e) {
      // 文件缺失等存储异常：回滚删除，避免数据库与磁盘不一致
      throw Object.assign(new Error(`删除附件文件失败（附件记录保留）：${e.message}`), { status: 500, code: 'STORAGE_ERROR' });
    }
  })();
}

// 下载授权校验：返回含磁盘路径的附件行；未登录/无权/不存在分别明确报错。
function authorizeDownload(db, viewer, attachmentId) {
  if (!Number.isInteger(attachmentId)) throw badRequest('缺少有效的附件 id');
  const row = attachmentRow(db, attachmentId);
  if (!row) throw notFound(`附件 #${attachmentId} 不存在`);
  if (!canSeeAttachment(viewer, row)) {
    // 参与者及非上传者记录员：不获得附件存在性、元数据或下载地址
    throw notFound(`附件 #${attachmentId} 不存在`);
  }
  return row;
}

// ---------- 导入 ----------
function importTranscript(db, actor, title, text) {
  if (getDoc(db)) throw conflict('逐字稿已导入并已发布初始版本，不能重复导入', 'ALREADY_INITIALIZED');
  const segments = parseTranscript(text);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO doc_meta (id, title, initialized) VALUES (1,?,1)').run(title || '未命名听证会');
    const r = db.prepare(
      'INSERT INTO versions (note, segments_json, created_by, decision_watermark) VALUES (?,?,?,0)'
    ).run('初始导入', JSON.stringify(segments), actor.id);
    return r.lastInsertRowid;
  });
  return tx();
}

// ---------- 提议 ----------
// 替换文字禁止换行/分段符（CR、LF、U+2028、U+2029），段结构只能按既有段号修订
function replacementHasNewline(s) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

// 共用的提议落库逻辑：与同一基版上已采纳（暂存待发布）的修订范围交叠 → 直接标记冲突，绝不覆盖
function insertProposal(db, actor, { seg, start, end, replacement, basis, excerpt, baseVersionId, rebasedFromId = null }) {
  let status = 'pending';
  let conflictReason = '';
  const clash = db
    .prepare(
      `SELECT * FROM proposals
       WHERE status = 'adopted' AND base_version_id = ? AND seg = ?
         AND start_cp < ? AND ? < end_cp`
    )
    .get(baseVersionId, seg, end, start);
  if (clash) {
    status = 'conflicted';
    conflictReason = `与已采纳提议 #${clash.id} 的范围 [${clash.start_cp},${clash.end_cp}) 交叠；不能覆盖其他修订，请改提互不重叠的范围`;
  }
  const r = db.prepare(
    `INSERT INTO proposals
      (seg, start_cp, end_cp, replacement, basis, original_excerpt, base_version_id, status, conflict_reason, conflict_kind, rebased_from_id, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(seg, start, end, replacement, basis, excerpt, baseVersionId, status, conflictReason,
        status === 'conflicted' ? 'overlap' : '', rebasedFromId, actor.id);
  const id = r.lastInsertRowid;
  if (status === 'conflicted') {
    addDecision(db, {
      type: 'conflict',
      proposalId: id,
      versionId: baseVersionId,
      actorId: actor.id,
      reason: conflictReason,
    });
  }
  return id;
}

function createProposal(db, actor, body) {
  const doc = getDoc(db);
  if (!doc) throw conflict('尚未导入逐字稿，无法提交提议', 'NO_DOCUMENT');
  const base = latestVersion(db);
  const segments = segmentsOf(base);

  const seg = parseInt(body.seg, 10);
  const start = parseInt(body.start, 10);
  const end = parseInt(body.end, 10);
  const replacement = typeof body.replacement === 'string' ? body.replacement : null;
  const basis = typeof body.basis === 'string' ? body.basis.trim() : '';
  if (!Number.isInteger(seg)) throw badRequest('缺少有效的段号 seg');
  if (replacement === null) throw badRequest('替换文字必须为字符串（空串表示删除该范围）');
  if (replacementHasNewline(replacement)) throw badRequest('替换文字不能包含换行，段结构只能按既有段号修订');
  if (!basis) throw badRequest('修订依据不能为空');

  const idx = segIndex(segments, seg);
  if (idx === -1) throw badRequest(`非法范围：基版 v${base.id} 中不存在段 ${seg}`);
  const vr = validateRange(segments[idx].text, start, end);

  const insert = db.transaction(() =>
    insertProposal(db, actor, {
      seg, start, end, replacement, basis, excerpt: vr.excerpt, baseVersionId: base.id,
    })
  );
  return insert();
}

// 复核：采纳。基版过期 / 与暂存区交叠 → 不改既有修订，将本提议标记为冲突并写明原因。
function adoptProposal(db, actor, id) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!p) throw notFound(`提议 #${id} 不存在`);
  if (p.status === 'published') throw conflict(`提议 #${id} 已随 v${p.published_version_id} 发布，无需再采纳`, 'ALREADY_PUBLISHED');
  if (p.status === 'rejected') throw conflict(`提议 #${id} 已被驳回，不能采纳；如需修订请重新提交`, 'ALREADY_REJECTED');
  if (p.status === 'conflicted') throw conflict(`提议 #${id} 已标记冲突，不能采纳；请基于最新版本重新提交`, 'ALREADY_CONFLICTED');
  if (p.status === 'adopted') throw conflict(`提议 #${id} 已在暂存区，请勿重复采纳`, 'ALREADY_ADOPTED');

  const cur = latestVersion(db);
  const markConflict = db.transaction((reason, kind) => {
    db.prepare(`UPDATE proposals SET status='conflicted', conflict_reason=?, conflict_kind=? WHERE id=?`).run(reason, kind, id);
    addDecision(db, { type: 'conflict', proposalId: id, versionId: cur.id, actorId: actor.id, reason });
  });

  if (p.base_version_id !== cur.id) {
    const reason = `基版已过期：提议提交时绑定 v${p.base_version_id}，当前已发布版本为 v${cur.id}；请基于 v${cur.id} 重新提交`;
    markConflict(reason, 'base_expired');
    return { markedConflict: true, reason };
  }
  const clash = db
    .prepare(
      `SELECT * FROM proposals
       WHERE status='adopted' AND base_version_id=? AND seg=? AND id<>?
         AND start_cp < ? AND ? < end_cp`
    )
    .get(cur.id, p.seg, id, p.end_cp, p.start_cp);
  if (clash) {
    const reason = `范围交叠：提议 #${id} [${p.start_cp},${p.end_cp}) 与已采纳提议 #${clash.id} [${clash.start_cp},${clash.end_cp}) 冲突；不能覆盖其他修订`;
    markConflict(reason, 'overlap');
    return { markedConflict: true, reason };
  }
  db.transaction(() => {
    db.prepare(
      `UPDATE proposals SET status='adopted', decided_by=?, decided_at=datetime('now'), conflict_reason='' WHERE id=?`
    ).run(actor.id, id);
    addDecision(db, { type: 'adopt', proposalId: id, versionId: cur.id, actorId: actor.id });
  })();
  return { markedConflict: false };
}

function rejectProposal(db, actor, id, reason) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!p) throw notFound(`提议 #${id} 不存在`);
  if (p.status === 'published') throw conflict(`提议 #${id} 已发布，不能驳回`, 'ALREADY_PUBLISHED');
  if (p.status === 'conflicted') throw conflict(`提议 #${id} 已标记冲突，无需驳回`, 'ALREADY_CONFLICTED');
  if (p.status === 'rejected') throw conflict(`提议 #${id} 已被驳回，请勿重复操作`, 'ALREADY_REJECTED');
  const from = p.status; // pending | adopted
  db.transaction(() => {
    db.prepare(
      `UPDATE proposals SET status='rejected', decided_by=?, decided_at=datetime('now'), conflict_reason=? WHERE id=?`
    ).run(actor.id, reason || '', id);
    addDecision(db, {
      type: 'reject',
      proposalId: id,
      versionId: latestVersion(db).id,
      actorId: actor.id,
      reason: reason || '',
      detail: { previousStatus: from },
    });
  })();
}

// ---------- 暂存预览 ----------
function stageProposals(db, versionId) {
  // 显式以 id 作并列次序：合版右起应用时同起点修订（如同点的零长度插入）顺序确定，
  // 来源重放按同一顺序重放，不依赖底层返回顺序。
  return db
    .prepare(`SELECT * FROM proposals WHERE status='adopted' AND base_version_id=? ORDER BY seg, start_cp, id`)
    .all(versionId);
}

function previewSegments(segments, stage) {
  const bySeg = new Map();
  for (const p of stage) {
    if (!bySeg.has(p.seg)) bySeg.set(p.seg, []);
    bySeg.get(p.seg).push({ start: p.start_cp, end: p.end_cp, replace: p.replacement, id: p.id });
  }
  return segments.map((s) => {
    const edits = bySeg.get(s.seg);
    return edits ? { seg: s.seg, text: applyEdits(s.text, edits) } : s;
  });
}

// ---------- 发布 ----------
// 各异议“当前锚点”：取其在当前版本下的锚点记录（与发布映射的基准一致）
function currentAnchors(db, versionId) {
  return db
    .prepare(
      `SELECT a.objection_id, a.seg, a.start_cp, a.end_cp, a.status AS anchor_status,
              o.quoted_text, o.note, o.created_in_version
       FROM objection_anchors a
       JOIN objections o ON o.id = a.objection_id
       WHERE a.version_id = ?
       ORDER BY a.objection_id`
    )
    .all(versionId);
}

// 发布前的异议回应门槛：计算被暂存修订触及的异议，并核对每条异议是否有
// 与“当前版本 + 当前暂存区 + 当前锚点”绑定且仍有效的回应。
// 返回失效原因；null 表示回应仍有效。
function checkResponseBinding(r, curVersionId, stageFp, anchor, touchingIds) {
  if (r.version_id !== curVersionId || r.stage_fingerprint !== stageFp) {
    return {
      code: 'STAGE_CHANGED',
      reason: '回应后暂存区已变化（采纳或驳回使发布修订集合改变，或已发布新版本），回应已失效，请重新回应',
    };
  }
  if (r.seg !== anchor.seg || r.start_cp !== anchor.start_cp || r.end_cp !== anchor.end_cp) {
    return {
      code: 'ANCHOR_MOVED',
      reason: '回应后异议锚点已改变（异议被重新定位或新建锚点），请按当前位置重新回应',
    };
  }
  const ids = JSON.parse(r.proposal_ids_json);
  if (ids.length !== touchingIds.length || touchingIds.some((x) => !ids.includes(x))) {
    return {
      code: 'PROPOSALS_CHANGED',
      reason: '回应关联的提议集合与当前触及本异议的暂存修订不一致，请重新回应',
    };
  }
  return null;
}

function publishGate(db, cur, stage = stageProposals(db, cur.id)) {
  const fp = stageFingerprint(stage);
  const getActive = db.prepare(
    `SELECT * FROM objection_responses
     WHERE objection_id=? AND status='active' AND published_version_id IS NULL
     ORDER BY id DESC LIMIT 1`
  );
  const items = [];
  for (const a of currentAnchors(db, cur.id)) {
    const touching = stage.filter(
      (p) =>
        p.seg === a.seg &&
        editTouchesAnchor({ start: p.start_cp, end: p.end_cp }, { start: a.start_cp, end: a.end_cp })
    );
    if (touching.length === 0) continue;
    const r = getActive.get(a.objection_id);
    let response = null;
    let satisfied = false;
    if (r) {
      const invalid = checkResponseBinding(r, cur.id, fp, a, touching.map((p) => p.id));
      if (invalid) {
        response = { id: r.id, note: r.note, invalidReason: invalid.reason, invalidCode: invalid.code };
      } else {
        response = {
          id: r.id,
          note: r.note,
          proposalIds: JSON.parse(r.proposal_ids_json),
          versionId: r.version_id,
          createdAt: r.created_at,
        };
        satisfied = true;
      }
    }
    items.push({
      objectionId: a.objection_id,
      seg: a.seg,
      start: a.start_cp,
      end: a.end_cp,
      anchorStatus: a.anchor_status,
      quotedText: a.quoted_text,
      note: a.note,
      createdInVersion: a.created_in_version,
      proposalIds: touching.map((p) => p.id),
      response,
      satisfied,
    });
  }
  return { versionId: cur.id, stageFp: fp, items };
}

function publish(db, actor, note) {
  const cur = latestVersion(db);
  if (!cur) throw conflict('尚未导入逐字稿，无可发布内容', 'NO_DOCUMENT');
  const stage = stageProposals(db, cur.id);
  if (stage.length === 0) {
    throw conflict('重复发布被拒绝：暂存区中没有已采纳修订，发布必须包含修订并形成新版本', 'EMPTY_PUBLISH');
  }
  const segments = segmentsOf(cur);

  return db.transaction(() => {
    // 0) 回应门槛：逐条核对被暂存修订触及的异议是否都有有效的发布前回应。
    //    失效或缺失时抛错，事务回滚——版本、提议及决议均不改变。
    const gate = publishGate(db, cur, stage);
    const missing = gate.items.filter((it) => !it.satisfied);
    if (missing.length > 0) {
      const lines = missing.map((it) => {
        const why = !it.response
          ? '尚无回应'
          : `回应 #${it.response.id} 已失效：${it.response.invalidReason}`;
        const relo = it.anchorStatus === 'needs_relocation' ? '（该异议待重新定位）' : '';
        return `· 异议 #${it.objectionId}（第 ${it.seg} 段 [${it.start},${it.end})${relo}，触及提议 ${
          it.proposalIds.map((x) => `#${x}`).join('、') || '（无）'
        }）：${why}`;
      });
      throw conflict(
        `发布被拒绝：有 ${missing.length} 条被暂存修订触及的异议未完成有效回应（回应须非空，并关联异议、采纳提议与当前版本/暂存状态）：\n${lines.join('\n')}`,
        'OBJECTION_RESPONSES_REQUIRED'
      );
    }

    // 1) 合版：同一基版上互不重叠的采纳结果按段合并
    const newSegments = previewSegments(segments, stage);

    const vr = db.prepare(
      'INSERT INTO versions (note, segments_json, created_by, decision_watermark) VALUES (?,?,?,0)'
    ).run((note || '').trim() || '发布修订', JSON.stringify(newSegments), actor.id);
    const newId = vr.lastInsertRowid;

    // 2) 已采纳提议落版
    const markPublished = db.prepare(
      `UPDATE proposals SET status='published', published_version_id=? WHERE id=?`
    );
    for (const p of stage) {
      markPublished.run(newId, p.id);
      addDecision(db, {
        type: 'publish',
        proposalId: p.id,
        versionId: newId,
        actorId: actor.id,
        reason: `随 v${newId} 发布`,
        detail: { seg: p.seg, start: p.start_cp, end: p.end_cp },
      });
    }

    // 3) 新版本形成后，所有仍待复核的提议基版均已过期 → 标记冲突
    //    （不能悄悄失效，也不能覆盖新修订；须由记录员基于新版本重新提交）
    const stale = db.prepare(`SELECT * FROM proposals WHERE status='pending'`).all();
    for (const p of stale) {
      const reason = `基版已过期：提议提交时绑定 v${p.base_version_id}，发布后当前版本为 v${newId}；请基于新版本重新提交`;
      db.prepare(`UPDATE proposals SET status='conflicted', conflict_reason=?, conflict_kind='base_expired' WHERE id=?`).run(reason, p.id);
      addDecision(db, { type: 'conflict', proposalId: p.id, versionId: newId, actorId: null, reason });
    }

    // 4) 异议锚点映射：相交即需重新定位，保留原文快照
    mapObjectionAnchors(db, newId, stage);

    // 4.5) 回应随版归档：门槛已保证每条受影响异议都有有效回应；绑定到本次版本，
    //      此后在该历史版本只读展示回应（异议原文快照与既有重定位规则不变）。
    const bindResponse = db.prepare(
      `UPDATE objection_responses SET published_version_id=?
       WHERE id=? AND status='active' AND published_version_id IS NULL`
    );
    for (const it of gate.items) {
      bindResponse.run(newId, it.response.id);
    }

    // 5) 决议水位线：包含本次发布产生的全部决议
    const watermark = db.prepare('SELECT COALESCE(MAX(id),0) AS m FROM decisions').get().m;
    db.prepare('UPDATE versions SET decision_watermark=? WHERE id=?').run(watermark, newId);

    // 6) 段关注通知：仅对本次合版后“正文有净变化”的关注段，为发布时仍关注的用户各生成一条；
    //    合版后未变的段（即使发布了提议，如替换成相同文字）不通知。与发布同一事务，失败不留通知。
    emitFollowNotifications(db, segments, newSegments, cur.id, newId);

    return newId;
  })();
}

function editsBySegment(stage) {
  const map = new Map();
  for (const p of stage) {
    if (!map.has(p.seg)) map.set(p.seg, []);
    map.get(p.seg).push({ start: p.start_cp, end: p.end_cp, replace: p.replacement, proposalId: p.id });
  }
  return map;
}

function mapObjectionAnchors(db, newVersionId, stage) {
  const editsMap = editsBySegment(stage);
  // 以“当前最新锚点”为映射基准（异议可能已在当前版本被重新定位，旧版本锚点已过时），
  // 并以主表当前状态为准：已手动重新定位（active）的异议不得因复制旧锚点而回退为待重定位。
  const anchors = db
    .prepare(
      `SELECT a.objection_id, a.seg, a.start_cp, a.end_cp, o.status AS master_status
       FROM objection_anchors a
       JOIN objections o ON o.id = a.objection_id
       WHERE a.version_id = (
         SELECT MAX(version_id) FROM objection_anchors WHERE objection_id = a.objection_id
       )`
    )
    .all();
  const newSegments = segmentsOf(db.prepare('SELECT * FROM versions WHERE id=?').get(newVersionId));
  const lenOf = new Map(newSegments.map((s) => [s.seg, codeLength(s.text)]));

  const ins = db.prepare(
    `INSERT INTO objection_anchors (objection_id, version_id, seg, start_cp, end_cp, status)
     VALUES (?,?,?,?,?,?)`
  );
  const updMaster = db.prepare(
    `UPDATE objections SET seg=?, start_cp=?, end_cp=?, status='needs_relocation' WHERE id=?`
  );
  for (const a of anchors) {
    const edits = editsMap.get(a.seg) || [];
    const t = transformRange({ start: a.start_cp, end: a.end_cp }, edits);
    // 主表 active 说明此前已人工确认过位置：只有本次修订再次相交才重新置为待重定位
    let status = a.master_status === 'active' ? 'active' : 'needs_relocation';
    if (t.affected) status = 'needs_relocation';
    const maxEnd = lenOf.get(a.seg) ?? t.end;
    t.start = Math.max(0, Math.min(t.start, maxEnd));
    t.end = Math.max(t.start, Math.min(t.end, maxEnd));
    ins.run(a.objection_id, newVersionId, a.seg, t.start, t.end, status);
    if (t.affected) updMaster.run(a.seg, t.start, t.end, a.objection_id);
  }
}

// ---------- 续提（基版已过期冲突提议的换算重提） ----------
function conflictKindOf(p) {
  if (p.conflict_kind) return p.conflict_kind;
  // 兼容迁移前的旧数据：按冲突原因文本推断
  return (p.conflict_reason || '').startsWith('基版已过期') ? 'base_expired' : 'overlap';
}

// 前置校验：提议存在、本人提交、处于冲突状态、且为“基版已过期”类冲突
function rebaseTarget(db, actor, id) {
  const p = db.prepare('SELECT * FROM proposals WHERE id = ?').get(id);
  if (!p) throw notFound(`提议 #${id} 不存在`);
  if (p.created_by !== actor.id) {
    throw forbidden(`无权操作：只能续提本人提交的提议（#${id} 由他人提交）`);
  }
  if (p.status !== 'conflicted') {
    throw conflict(`提议 #${id} 当前状态为“${p.status}”，只有被标记为冲突的提议才能续提`, 'NOT_CONFLICTED');
  }
  if (conflictKindOf(p) !== 'base_expired') {
    throw conflict(`提议 #${id} 的冲突原因不是“基版已过期”，不能续提；请在当前正文中手工选区重新提交`, 'NOT_BASE_EXPIRED');
  }
  return p;
}

// 把提议的段内选区按从基版到当前版本逐次发布的修订换算。
// 任一中途修订触及选区（或零长度选区的插入点）、目标段缺失、换算结果越界 → 抛出 409；
// 绝不凭同文搜索猜测位置。
function computeRebaseMapping(db, p, cur) {
  const published = db
    .prepare(
      `SELECT published_version_id AS ver, id, start_cp, end_cp, replacement
       FROM proposals
       WHERE status='published' AND published_version_id > ? AND published_version_id <= ? AND seg = ?
       ORDER BY published_version_id, start_cp`
    )
    .all(p.base_version_id, cur.id, p.seg);
  const byVer = new Map();
  for (const r of published) {
    if (!byVer.has(r.ver)) byVer.set(r.ver, []);
    byVer.get(r.ver).push({ start: r.start_cp, end: r.end_cp, replace: r.replacement, proposalId: r.id });
  }
  let range = { start: p.start_cp, end: p.end_cp };
  const point = range.start === range.end;
  const steps = [];
  for (let v = p.base_version_id + 1; v <= cur.id; v++) {
    const edits = byVer.get(v) || [];
    const t = transformRangeRebase(range, edits);
    if (t.affected) {
      const hit = edits.find((e) =>
        point ? e.start <= range.start && range.start <= e.end : e.start < range.end && range.start < e.end
      );
      throw conflict(
        `中途发布的修订触及${point ? '零长度选区的插入点' : '原选区'}：` +
          `v${v} 合并的修订（提议 #${hit ? hit.proposalId : '?'}）改动了该范围，无法可靠换算到当前正文；` +
          `请在当前版本中手工选区重新提交`,
        'REBASE_TOUCHED'
      );
    }
    range = { start: t.start, end: t.end };
    steps.push({ version: v, edits: edits.length });
  }
  const segments = segmentsOf(cur);
  const idx = segIndex(segments, p.seg);
  if (idx === -1) {
    throw conflict(
      `目标段缺失：第 ${p.seg} 段在当前版本 v${cur.id} 中不存在，无法续提；请在当前正文手工选区重新提交`,
      'SEGMENT_MISSING'
    );
  }
  const text = segments[idx].text;
  const len = codeLength(text);
  if (range.start < 0 || range.start > range.end || range.end > len) {
    throw conflict(
      `换算结果越界：[${range.start},${range.end}) 超出第 ${p.seg} 段当前长度 ${len}，无法续提；请在当前正文手工选区重新提交`,
      'REBASE_OUT_OF_RANGE'
    );
  }
  return { seg: p.seg, start: range.start, end: range.end, excerpt: sliceCP(text, range.start, range.end), steps };
}

// 暂存区指纹：预览后任何采纳/驳回导致暂存区变化都会使指纹改变
function stageFingerprint(stage) {
  return JSON.stringify(stage.map((p) => [p.id, p.seg, p.start_cp, p.end_cp, p.replacement]));
}

function stageClash(db, versionId, seg, start, end) {
  return db
    .prepare(
      `SELECT * FROM proposals
       WHERE status='adopted' AND base_version_id=? AND seg=? AND start_cp < ? AND ? < end_cp`
    )
    .get(versionId, seg, end, start);
}

// 续提预览：返回目标选区、摘录、原替换文字与依据，以及确认时须回传的凭证
function rebasePreview(db, actor, id) {
  const p = rebaseTarget(db, actor, id);
  const cur = latestVersion(db);
  const mapped = computeRebaseMapping(db, p, cur);
  const stage = stageProposals(db, cur.id);
  const clash = stageClash(db, cur.id, mapped.seg, mapped.start, mapped.end);
  return {
    proposalId: p.id,
    fromVersion: p.base_version_id,
    toVersion: cur.id,
    seg: mapped.seg,
    start: mapped.start,
    end: mapped.end,
    excerpt: mapped.excerpt,
    originalExcerpt: p.original_excerpt,
    replacement: p.replacement,
    basis: p.basis,
    steps: mapped.steps,
    stageOverlap: clash ? { id: clash.id, start: clash.start_cp, end: clash.end_cp } : null,
    token: {
      p: p.id,
      from: p.base_version_id,
      v: cur.id,
      seg: mapped.seg,
      s: mapped.start,
      e: mapped.end,
      stg: stageFingerprint(stage),
    },
  };
}

// 续提确认：全部校验在事务内完成，任一不满足即回滚、不改变任何状态
function confirmRebase(db, actor, id, body) {
  const p = rebaseTarget(db, actor, id);
  const token = body && body.token;
  if (!token || typeof token !== 'object') {
    throw badRequest('缺少预览凭证：续提前必须先发起预览，确认时需回传预览返回的 token');
  }
  if (token.p !== p.id || token.from !== p.base_version_id) {
    throw conflict('预览凭证与原提议不匹配，请重新预览', 'STALE_PREVIEW');
  }
  const tx = db.transaction(() => {
    const cur = latestVersion(db);
    if (token.v !== cur.id) {
      throw conflict(
        `预览后已发布新版本（当前 v${cur.id}），换算结果已失效，请重新预览或在当前正文手工选区提交`,
        'STALE_PREVIEW'
      );
    }
    const stage = stageProposals(db, cur.id);
    if (token.stg !== stageFingerprint(stage)) {
      throw conflict('预览后暂存区已变化，换算结果可能不再适用，请重新预览', 'STALE_STAGE');
    }
    const mapped = computeRebaseMapping(db, p, cur);
    if (mapped.seg !== token.seg || mapped.start !== token.s || mapped.end !== token.e) {
      throw conflict('换算结果与预览不一致，请重新预览', 'STALE_PREVIEW');
    }
    const clash = stageClash(db, cur.id, mapped.seg, mapped.start, mapped.end);
    if (clash) {
      throw conflict(
        `目标选区 [${mapped.start},${mapped.end}) 与当前已采纳提议 #${clash.id} 的范围 ` +
          `[${clash.start_cp},${clash.end_cp}) 交叠，不能续提；请在当前正文手工选区提交`,
        'STAGE_OVERLAP'
      );
    }
    const newId = insertProposal(db, actor, {
      seg: mapped.seg,
      start: mapped.start,
      end: mapped.end,
      replacement: p.replacement,
      basis: p.basis,
      excerpt: mapped.excerpt,
      baseVersionId: cur.id,
      rebasedFromId: p.id,
    });
    addDecision(db, {
      type: 'rebase',
      proposalId: newId,
      versionId: cur.id,
      actorId: actor.id,
      reason:
        `续提自冲突提议 #${p.id}（基版 v${p.base_version_id} → v${cur.id}，` +
        `原范围 [${p.start_cp},${p.end_cp}) 换算为 [${mapped.start},${mapped.end})）`,
      detail: {
        fromProposalId: p.id,
        fromVersion: p.base_version_id,
        toVersion: cur.id,
        seg: mapped.seg,
        start: mapped.start,
        end: mapped.end,
      },
    });
    return newId;
  });
  return tx();
}

// ---------- 异议 ----------
function createObjection(db, actor, body) {
  const doc = getDoc(db);
  if (!doc) throw conflict('尚未导入逐字稿，无法添加异议', 'NO_DOCUMENT');
  const ver = latestVersion(db);
  const segments = segmentsOf(ver);

  const seg = parseInt(body.seg, 10);
  const start = parseInt(body.start, 10);
  const end = parseInt(body.end, 10);
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (!Number.isInteger(seg)) throw badRequest('缺少有效的段号 seg');
  if (!note) throw badRequest('异议说明不能为空');
  const idx = segIndex(segments, seg);
  if (idx === -1) throw badRequest(`非法范围：当前版本 v${ver.id} 中不存在段 ${seg}`);
  // 参与者不得在保密段新建异议；工作人员的既有校订/发布流程不受影响（已存在的相关异议仍按原规则处理）
  if (!isStaff(actor) && isSecretSeg(db, seg)) {
    throw forbidden(`第 ${seg} 段已保密：参与者不得在保密段新建异议`);
  }
  const vr = validateRange(segments[idx].text, start, end);
  if (vr.start === vr.end) throw badRequest('异议必须引用非空的原文范围');

  return db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO objections (seg, start_cp, end_cp, quoted_text, note, status, created_by, created_in_version)
       VALUES (?,?,?,?,?,'active',?,?)`
    ).run(seg, start, end, vr.excerpt, note, actor.id, ver.id);
    const id = r.lastInsertRowid;
    db.prepare(
      `INSERT INTO objection_anchors (objection_id, version_id, seg, start_cp, end_cp, status)
       VALUES (?,?,?,?,?,'active')`
    ).run(id, ver.id, seg, start, end);
    db.prepare(
      `INSERT INTO objection_logs (objection_id, actor_id, action, detail_json) VALUES (?,?, 'create', '{}')`
    ).run(id, actor.id);
    return id;
  })();
}

function relocateObjection(db, actor, id, body) {
  const o = db.prepare('SELECT * FROM objections WHERE id=?').get(id);
  if (!o) throw notFound(`异议 #${id} 不存在`);
  if (actor.role !== 'reviewer' && o.created_by !== actor.id) {
    const err = new Error('无权操作：只有异议提出者或复核员可以重新定位该异议');
    err.status = 403; err.code = 'FORBIDDEN'; throw err;
  }
  if (o.status !== 'needs_relocation') {
    throw conflict(`异议 #${id} 当前仍有效，无需重新定位`, 'NOT_DANGLING');
  }
  const ver = latestVersion(db);
  const segments = segmentsOf(ver);
  const seg = parseInt(body.seg, 10);
  const start = parseInt(body.start, 10);
  const end = parseInt(body.end, 10);
  if (!Number.isInteger(seg)) throw badRequest('缺少有效的段号 seg');
  // 参与者不得把异议重新定位到保密段；异议当前锚点位于保密段时也不得由参与者重新定位
  if (!isStaff(actor) && (isSecretSeg(db, seg) || isSecretSeg(db, o.seg))) {
    throw forbidden(`第 ${isSecretSeg(db, seg) ? seg : o.seg} 段已保密：参与者不得在保密段重新定位异议`);
  }
  const idx = segIndex(segments, seg);
  if (idx === -1) throw badRequest(`非法范围：当前版本 v${ver.id} 中不存在段 ${seg}`);
  const vr = validateRange(segments[idx].text, start, end);
  if (vr.start === vr.end) throw badRequest('重新定位必须选择非空范围');

  db.transaction(() => {
    db.prepare(
      `UPDATE objections SET seg=?, start_cp=?, end_cp=?, status='active' WHERE id=?`
    ).run(seg, start, end, id);
    db.prepare(
      `INSERT INTO objection_anchors (objection_id, version_id, seg, start_cp, end_cp, status)
       VALUES (?,?,?,?,?,'active')
       ON CONFLICT(objection_id, version_id) DO UPDATE SET
         seg=excluded.seg, start_cp=excluded.start_cp, end_cp=excluded.end_cp, status='active'`
    ).run(id, ver.id, seg, start, end);
    db.prepare(
      `INSERT INTO objection_logs (objection_id, actor_id, action, detail_json)
       VALUES (?,?, 'relocate', ?)`
    ).run(id, actor.id, JSON.stringify({ seg, start, end, version: ver.id, newExcerpt: vr.excerpt }));
  })();
}

// ---------- 发布前异议回应 ----------
// 复核员对“被当前暂存修订触及”的异议逐条填写非空回应；回应关联异议、
// 触及它的采纳提议，以及回应时的版本与暂存区指纹（发布时重新核对）。
function respondToObjection(db, actor, id, note) {
  if (!getDoc(db)) throw conflict('尚未导入逐字稿，无法回应异议', 'NO_DOCUMENT');
  const o = db.prepare('SELECT * FROM objections WHERE id=?').get(id);
  if (!o) throw notFound(`异议 #${id} 不存在`);
  const text = typeof note === 'string' ? note.trim() : '';
  if (!text) throw badRequest('回应说明不能为空：发布前须逐条说明对该异议的处理意见');
  const cur = latestVersion(db);
  const stage = stageProposals(db, cur.id);
  const anchor = db
    .prepare('SELECT * FROM objection_anchors WHERE objection_id=? AND version_id=?')
    .get(id, cur.id);
  if (!anchor) throw conflict(`异议 #${id} 在当前版本 v${cur.id} 中没有锚点，无法回应`, 'NO_ANCHOR');
  const touching = stage.filter(
    (p) =>
      p.seg === anchor.seg &&
      editTouchesAnchor({ start: p.start_cp, end: p.end_cp }, { start: anchor.start_cp, end: anchor.end_cp })
  );
  if (touching.length === 0) {
    throw conflict(
      `异议 #${id} 未被暂存区中任何已采纳修订触及（当前为 v${cur.id}，暂存 ${stage.length} 项），暂不需要回应；` +
        '只有采纳或驳回提议、重新定位异议后确实受影响的异议才需回应',
      'NOT_TOUCHED'
    );
  }
  const tx = db.transaction(() => {
    // 同一异议的未发布回应只保留最新一份；旧回应标记取代（保留留痕）
    db.prepare(
      `UPDATE objection_responses SET status='superseded'
       WHERE objection_id=? AND status='active' AND published_version_id IS NULL`
    ).run(id);
    const r = db.prepare(
      `INSERT INTO objection_responses
        (objection_id, note, proposal_ids_json, version_id, stage_fingerprint,
         seg, start_cp, end_cp, status, created_by)
       VALUES (?,?,?,?,?,?,?,?,'active',?)`
    ).run(
      id,
      text,
      JSON.stringify(touching.map((p) => p.id)),
      cur.id,
      stageFingerprint(stage),
      anchor.seg,
      anchor.start_cp,
      anchor.end_cp,
      actor.id
    );
    return r.lastInsertRowid;
  });
  return { id: tx(), objectionId: id, versionId: cur.id, proposalIds: touching.map((p) => p.id) };
}

// ---------- 视图组装 ----------
function listObjections(db, viewer) {
  const ver = latestVersion(db);
  if (!ver) return [];
  const rows = db
    .prepare(
      `SELECT o.id, o.seg, o.start_cp, o.end_cp, o.quoted_text, o.note, o.status,
              o.created_in_version, o.created_at,
              u.display_name AS creator_name, u.username AS creator_user,
              a.status AS anchor_status
       FROM objections o
       JOIN users u ON u.id = o.created_by
       JOIN objection_anchors a ON a.objection_id = o.id AND a.version_id = ?
       ORDER BY o.id DESC`
    )
    .all(ver.id);
  // 保密段：参与者看不到该段任何异议（正文、原文快照与说明均不获得）
  if (!isStaff(viewer)) {
    const secrets = secretSegs(db);
    return rows.filter((o) => !secrets.has(o.seg));
  }
  return rows;
}

function listProposals(db, viewer) {
  const rows = db
    .prepare(
      `SELECT p.*, u.display_name AS creator_name, u.username AS creator_user,
              b.id AS base_ver,
              (SELECT MIN(r.id) FROM proposals r WHERE r.rebased_from_id = p.id) AS continued_by_id
       FROM proposals p
       JOIN users u ON u.id = p.created_by
       JOIN versions b ON b.id = p.base_version_id
       ORDER BY p.id DESC`
    )
    .all();
  // 保密段：参与者看不到该段提议及依据/原文摘录
  if (!isStaff(viewer)) {
    const secrets = secretSegs(db);
    return rows.filter((p) => !secrets.has(p.seg));
  }
  return rows;
}

function boothView(db, viewer) {
  const doc = getDoc(db);
  if (!doc) return { initialized: false };
  const ver = latestVersion(db);
  const secrets = secretSegs(db);
  const staff = isStaff(viewer);
  const rawSegments = segmentsOf(ver);
  const stage = stageProposals(db, ver.id);
  // 参与者视角：保密段正文替换为占位；该段暂存修订整条剔除（不泄露段内替换文字）
  const maskSeg = (s) => (staff || !secrets.has(s.seg) ? s : { seg: s.seg, text: SECRET_PLACEHOLDER, secret: true });
  const segments = rawSegments.map(maskSeg);
  const proposalRows = listProposals(db, viewer);
  // 附件按权限随提议下发：参与者字段整体缺省；记录员仅含本人上传；复核员全部可见
  const attachmentListByProposal = attachmentsByProposal(db, viewer, proposalRows.map((p) => p.id));
  const view = {
    initialized: true,
    title: doc.title,
    currentVersion: {
      id: ver.id,
      note: staff ? ver.note : '', // 参与者不显示版本备注
      createdAt: ver.created_at,
    },
    segments,
    secretSegs: [...secrets].sort((a, b) => a - b),
    followedSegs: [...followedSegsFor(db, viewer.id)].sort((a, b) => a - b),
    stage: stage
      .filter((p) => staff || !secrets.has(p.seg))
      .map((p) => ({ id: p.id, seg: p.seg, start: p.start_cp, end: p.end_cp, replacement: p.replacement })),
    previewSegments: (staff
      ? previewSegments(rawSegments, stage)
      : previewSegments(rawSegments, stage.filter((p) => !secrets.has(p.seg)))
    ).map(maskSeg),
    proposals: staff
      ? proposalRows.map((p) => ({
          ...p,
          attachments: attachmentListByProposal.get(p.id) || [],
        }))
      : proposalRows, // 参与者：不附带任何附件元数据
    objections: listObjections(db, viewer),
    versions: db
      .prepare(
        `SELECT v.id, v.note, v.created_at, u.display_name AS creator_name
         FROM versions v LEFT JOIN users u ON u.id = v.created_by ORDER BY v.id`
      )
      .all()
      .map((v) => (staff ? v : { id: v.id, note: '', created_at: v.created_at, creator_name: v.creator_name })),
  };
  // 发布核对仅供记录员与复核员查看：参与者响应中不含该字段
  if (staff) view.publishCheck = publishGate(db, ver, stage);
  return view;
}

function versionView(db, id, viewer) {
  const v = db.prepare('SELECT * FROM versions WHERE id=?').get(id);
  if (!v) throw notFound(`版本 v${id} 不存在`);
  const staff = isStaff(viewer);
  const secrets = secretSegs(db); // 以当前保密段号集合为准，立即作用于全部历史版本
  let decisions = db
    .prepare(
      `SELECT d.id, d.type, d.reason, d.created_at, d.proposal_id, d.version_id,
              u.display_name AS actor_name,
              p.seg, p.start_cp, p.end_cp, p.replacement, p.basis, p.original_excerpt,
              p.restore_target_version_id,
              d.detail_json,
              pu.display_name AS proposal_creator
       FROM decisions d
       LEFT JOIN users u ON u.id = d.actor_id
       LEFT JOIN proposals p ON p.id = d.proposal_id
       LEFT JOIN users pu ON pu.id = p.created_by
       WHERE d.id <= ?
       ORDER BY d.id`
    )
    .all(v.decision_watermark);
  let objections = db
    .prepare(
      `SELECT a.objection_id AS id, a.seg, a.start_cp, a.end_cp, a.status,
              o.quoted_text, o.note, o.created_in_version, o.created_at,
              u.display_name AS creator_name
       FROM objection_anchors a
       JOIN objections o ON o.id = a.objection_id
       JOIN users u ON u.id = o.created_by
       WHERE a.version_id = ?
       ORDER BY a.objection_id`
    )
    .all(v.id);
  let responses = db
    .prepare(
      `SELECT r.id, r.objection_id, r.note, r.proposal_ids_json, r.seg,
              r.start_cp, r.end_cp, r.version_id, r.published_version_id, r.created_at,
              u.display_name AS responder_name, u.username AS responder_user
       FROM objection_responses r
       JOIN users u ON u.id = r.created_by
       WHERE r.published_version_id = ?
       ORDER BY r.objection_id, r.id`
    )
    .all(v.id);
  if (!staff) {
    // 参与者查看历史版本：保密段只留占位；不获得该段决议（提议/依据/替换文字）、异议与回应。
    // 恢复汇总结议（无段号、含复核员恢复理由与目标版本关联）仅工作人员可见。
    decisions = decisions.filter(
      (d) => d.type !== 'restore' && (d.seg == null || !secrets.has(d.seg))
    );
    objections = objections.filter((o) => !secrets.has(o.seg));
    responses = responses.filter((r) => !secrets.has(r.seg));
  }
  responses = responses.map((r) => ({ ...r, proposalIds: JSON.parse(r.proposal_ids_json) }));
  // 恢复汇总结议携带目标版本与本批恢复提议 id（存于 detail_json），供网页只读视图展示关联
  decisions = decisions.map((d) =>
    d.type === 'restore'
      ? (() => {
          try {
            const detail = JSON.parse(d.detail_json || '{}');
            return {
              ...d,
              restoreSummary: {
                targetVersionId: detail.targetVersionId,
                proposalIds: detail.proposalIds || [],
                count: detail.count || 0,
              },
            };
          } catch (_) { return d; }
        })()
      : d
  );
  // 历史视图中的附件同样按权限下发：随提议及历史决议保留，参与者不获得任何附件字段
  if (staff) {
    const pids = [...new Set(decisions.map((d) => d.proposal_id).filter((x) => x != null))];
    const attMap = attachmentsByProposal(db, viewer, pids);
    decisions = decisions.map((d) =>
      d.proposal_id == null ? d : { ...d, attachments: attMap.get(d.proposal_id) || [] }
    );
  }
  return {
    id: v.id,
    note: staff ? v.note : '', // 参与者不显示版本备注
    createdAt: v.created_at,
    immutable: true,
    secretSegs: [...secrets].sort((a, b) => a - b),
    segments: segmentsOf(v).map((s) =>
      staff || !secrets.has(s.seg) ? s : { seg: s.seg, text: SECRET_PLACEHOLDER, secret: true }
    ),
    decisions,
    objections,
    responses,
  };
}

// ---------- 正文来源（按段查看某版正文连续片段的来源） ----------
// 来源沿“初始导入 → 逐次发布”的修订几何重放得到，绝不按同文搜索猜测：
// 未被触及的码点保留原来源；替换/插入码点归最后写入它的已发布提议（提议编号 + 发布版本）；
// 删除不占结果。同版多处修订、相邻边界与后续再次改写均由逐码点重放保证正确。
function sameTag(a, b) {
  if (a === b) return true; // 均为 null（初始导入）
  return !!a && !!b && a.proposalId === b.proposalId && a.version === b.version;
}

function provenanceView(db, versionId, seg, viewer) {
  if (!getDoc(db)) throw conflict('尚未导入逐字稿，无版本来源可查', 'NO_DOCUMENT');
  if (!Number.isInteger(versionId) || !Number.isInteger(seg)) throw badRequest('缺少有效的版本号或段号');
  const v = db.prepare('SELECT * FROM versions WHERE id=?').get(versionId);
  if (!v) throw notFound(`版本 v${versionId} 不存在，无法查看来源`);
  const targetSegments = segmentsOf(v);
  if (segIndex(targetSegments, seg) === -1) {
    throw notFound(`未知段号：版本 v${versionId} 中不存在第 ${seg} 段，无法查看来源`);
  }
  // 保密段：参与者在所有版本只见占位，不获得片段、提议编号或来源；解除保密后按现有权限恢复
  if (!isStaff(viewer) && isSecretSeg(db, seg)) {
    throw forbidden(`第 ${seg} 段已保密：参与者不得查看该段正文片段与来源`);
  }

  // v1 原文（段号跨版本不变，段结构不被修订改写）；逐版收集实际合入该段的已发布提议。
  const v1 = db.prepare('SELECT * FROM versions WHERE id=1').get();
  const v1Idx = segIndex(segmentsOf(v1), seg);
  if (v1Idx === -1) {
    throw new Error(`PROVENANCE_INCONSISTENT：第 ${seg} 段在初始版本 v1 中不存在（段结构异常）`);
  }
  const steps = [];
  for (let ver = 2; ver <= versionId; ver++) {
    // 与发布暂存/合版相同的次序（段、起点、id）；published_version_id 即合入版本，
    // base_version_id 必为 ver-1（版本按 id 顺序发布），坐标即该步的原坐标。
    const edits = db
      .prepare(
        `SELECT id, start_cp, end_cp, replacement FROM proposals
         WHERE status='published' AND published_version_id=? AND seg=?
         ORDER BY start_cp, id`
      )
      .all(ver, seg)
      .map((p) => ({ id: p.id, start: p.start_cp, end: p.end_cp, replace: p.replacement }));
    if (edits.length) steps.push({ version: ver, edits });
  }

  const initialText = segmentsOf(v1)[v1Idx].text;
  const tokens = replayProvenance(initialText, steps);
  // 重放结果必须与该版不可变快照逐码点一致；不一致只可能是数据损坏，明确报错而非编造来源。
  const replayText = tokens.map((t) => t.ch).join('');
  const storedText = targetSegments[segIndex(targetSegments, seg)].text;
  if (replayText !== storedText) {
    throw Object.assign(
      new Error(`来源重放与版本 v${versionId} 第 ${seg} 段快照不一致，拒绝输出来源（数据可能已损坏）`),
      { status: 500, code: 'PROVENANCE_MISMATCH' }
    );
  }

  // 相邻同来源码点合并为连续片段；删除不产码点，故不占结果。
  const runs = [];
  for (const tok of tokens) {
    const last = runs[runs.length - 1];
    if (last && sameTag(last.tag, tok.tag)) last.text += tok.ch;
    else runs.push({ text: tok.ch, tag: tok.tag });
  }
  let pos = 0;
  const fragments = runs.map((r) => {
    const start = pos;
    const end = start + codeLength(r.text);
    pos = end;
    return r.tag
      ? { start, end, text: r.text, source: 'proposal', proposalId: r.tag.proposalId, versionId: r.tag.version }
      : { start, end, text: r.text, source: 'initial' };
  });

  return {
    versionId,
    seg,
    secret: false,
    text: storedText,
    length: codeLength(storedText),
    fragments,
  };
}

// ---------- 跨版净变化对照（两个按时间先后排列的已发布版本，按段对照） ----------
// 净变化与促成提议全部沿“初始导入 → 逐次发布”的修订链坐标映射重放得到（见 text.diffLineage）：
// 重复文字只凭码点稳定身份对齐，绝不按同文搜索配对；中途改动最终撤销且两端文字相同的整块
// 不算变化，未变段不产生 changes。只读查询，不改写版本、决议或保密状态。
// 收集截至 maxVersionId 的全部已发布修订，按版本、段分组（坐标为各自发布时的基版坐标）。
// 跨版对照与历史恢复预览共用：身份链必须从 v1 经过所有历史发布才能到达端点版本。
function lineageStepsByVerSeg(db, maxVersionId) {
  const rows = db
    .prepare(
      `SELECT id, seg, start_cp, end_cp, replacement, published_version_id AS ver
       FROM proposals
       WHERE status='published' AND published_version_id >= 2 AND published_version_id <= ?
       ORDER BY published_version_id, seg, start_cp, id`
    )
    .all(maxVersionId);
  const map = new Map(); // key ver:seg -> edits
  for (const p of rows) {
    const key = `${p.ver}:${p.seg}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ id: p.id, start: p.start_cp, end: p.end_cp, replace: p.replacement });
  }
  return map;
}

function stepsForSeg(editsByVerSeg, seg, maxVersionId) {
  const steps = [];
  for (let ver = 2; ver <= maxVersionId; ver++) {
    const edits = editsByVerSeg.get(`${ver}:${seg}`);
    if (edits && edits.length) steps.push({ version: ver, edits });
  }
  return steps;
}

function diffView(db, fromId, toId, viewer) {
  if (!getDoc(db)) throw conflict('尚未导入逐字稿，无版本可对照', 'NO_DOCUMENT');
  if (!Number.isInteger(fromId) || !Number.isInteger(toId)) {
    throw badRequest('缺少有效的版本号：须提供整数 from 与 to（按时间先后排列的两个已发布版本）');
  }
  if (fromId >= toId) {
    throw conflict(
      `版本顺序不合法：旧版 v${fromId} 必须早于新版 v${toId}（要求 from < to，且均为已发布版本）`,
      'BAD_VERSION_ORDER'
    );
  }
  const vFrom = db.prepare('SELECT * FROM versions WHERE id=?').get(fromId);
  if (!vFrom) throw notFound(`旧版 v${fromId} 不存在，无法对照`);
  const vTo = db.prepare('SELECT * FROM versions WHERE id=?').get(toId);
  if (!vTo) throw notFound(`新版 v${toId} 不存在，无法对照`);

  const staff = isStaff(viewer);
  const secrets = secretSegs(db);
  const fromSegments = segmentsOf(vFrom);
  const toSegments = segmentsOf(vTo);
  const v1 = db.prepare('SELECT * FROM versions WHERE id=1').get();
  const v1Segments = segmentsOf(v1);

  // 一次性取截至新版（≤ toId）的全部已发布修订，按版本、段分组；坐标为各自发布时的基版坐标。
  // 重放身份链必须从 v1 经过所有历史发布才能到达两端版本（含 fromId 之前的发布）；
  // 哪些提议算作“促成 from→to 净变化”，由 text.diffLineage 再按 (from, to] 区间过滤。
  const editsByVerSeg = lineageStepsByVerSeg(db, toId);

  const segments = [];
  let changedSegments = 0;
  let changeCount = 0;
  for (const sTo of toSegments) {
    const seg = sTo.seg;
    const fromIdx = segIndex(fromSegments, seg);
    const v1Idx = segIndex(v1Segments, seg);
    // 段号跨版本不变（发布只改段内正文）；异常数据明确报错而非编造对照
    if (fromIdx === -1 || v1Idx === -1) {
      throw Object.assign(
        new Error(`版本对照失败：第 ${seg} 段在 v1/v${fromId} 中缺失（段结构异常，拒绝编造结果）`),
        { status: 500, code: 'DIFF_INCONSISTENT' }
      );
    }

    // 保密段：参与者只见占位，不获得该段文字、变化数量或提议信息；工作人员按现有权限查看
    if (!staff && secrets.has(seg)) {
      segments.push({ seg, secret: true, text: SECRET_PLACEHOLDER, changes: [], changeCount: 0 });
      continue;
    }

    const steps = stepsForSeg(editsByVerSeg, seg, toId);
    const result = diffLineage(v1Segments[v1Idx].text, steps, fromId, toId);

    // 重放结果必须与两个不可变快照逐码点一致；不一致只可能是数据损坏，报错而非编造
    if (result.versions[fromId] !== fromSegments[fromIdx].text || result.versions[toId] !== sTo.text) {
      throw Object.assign(
        new Error(`版本对照重放与第 ${seg} 段版本快照不一致，拒绝输出对照（数据可能已损坏）`),
        { status: 500, code: 'DIFF_MISMATCH' }
      );
    }

    if (result.hunks.length) {
      changedSegments++;
      changeCount += result.hunks.length;
    }
    segments.push({
      seg,
      secret: false,
      oldText: fromSegments[fromIdx].text,
      newText: sTo.text,
      oldLength: codeLength(fromSegments[fromIdx].text),
      newLength: codeLength(sTo.text),
      changeCount: result.hunks.length,
      changes: result.hunks,
    });
  }

  return {
    from: {
      versionId: fromId,
      note: staff ? vFrom.note : '',
      createdAt: vFrom.created_at,
    },
    to: {
      versionId: toId,
      note: staff ? vTo.note : '',
      createdAt: vTo.created_at,
    },
    changedSegments,
    changeCount,
    segments,
  };
}

// ---------- 历史版本恢复（复核员：预览逐段净变化 → 采纳为只覆盖净变化范围的恢复提议） ----------
// 恢复绝不“复制目标版快照覆盖当前版”：旧版、决议与原文快照均不改写。恢复提议与普通提议一样
// 进入暂存区（status='adopted'），仍经现有异议逐条回应门槛后发布为新的不可变版本。
// 恢复编辑沿现有修订链的码点身份对齐得到（diffLineage：from=目标版 → to=当前版），
// 每处净变化一条编辑、只覆盖净变化范围；重复文字绝不靠同文搜索定位，未变化范围不产生编辑。
function restoreBasis(targetId, reason) {
  return `恢复到历史版本 v${targetId}：${reason}`;
}

// 恢复预览的核心计算（不校验身份/理由）：逐段净变化、恢复编辑及其应用结果。
// 重放结果与两端不可变快照、应用结果与目标版快照均逐码点校验，不一致（数据损坏）时报错而非编造。
function computeRestore(db, targetId) {
  const cur = latestVersion(db);
  const target = db.prepare('SELECT * FROM versions WHERE id=?').get(targetId);
  if (!target) throw notFound(`目标版本 v${targetId} 不存在，无法恢复`);
  if (target.id === cur.id) {
    throw conflict('目标版本就是当前版本，正文无需恢复', 'RESTORE_SAME_VERSION');
  }
  const curSegments = segmentsOf(cur);
  const targetSegments = segmentsOf(target);
  const v1Segments = segmentsOf(db.prepare('SELECT * FROM versions WHERE id=1').get());
  const editsByVerSeg = lineageStepsByVerSeg(db, cur.id);

  const segments = [];
  const editsBySeg = new Map();
  let changeCount = 0;
  for (const sCur of curSegments) {
    const seg = sCur.seg;
    const tIdx = segIndex(targetSegments, seg);
    const v1Idx = segIndex(v1Segments, seg);
    if (tIdx === -1 || v1Idx === -1) {
      throw Object.assign(
        new Error(`恢复计算失败：第 ${seg} 段在 v1/v${target.id} 中缺失（段结构异常，拒绝编造结果）`),
        { status: 500, code: 'RESTORE_INCONSISTENT' }
      );
    }
    // 目标版（旧）→ 当前版（新）的净变化；恢复即把每处净变化反向改回目标文字。
    const steps = stepsForSeg(editsByVerSeg, seg, cur.id);
    const result = diffLineage(v1Segments[v1Idx].text, steps, target.id, cur.id);
    if (result.versions[target.id] !== targetSegments[tIdx].text || result.versions[cur.id] !== sCur.text) {
      throw Object.assign(
        new Error(`恢复重放与第 ${seg} 段版本快照不一致，拒绝生成恢复提议（数据可能已损坏）`),
        { status: 500, code: 'RESTORE_MISMATCH' }
      );
    }
    const edits = editsFromHunks(result.hunks);
    if (edits.length) editsBySeg.set(seg, edits);
    changeCount += result.hunks.length;
    // 几何构造保证：应用恢复编辑后必须逐码点等于目标版该段正文；再做一次显式校验。
    const restoredText = edits.length ? applyEdits(sCur.text, edits) : sCur.text;
    if (restoredText !== targetSegments[tIdx].text) {
      throw Object.assign(
        new Error(`恢复编辑应用结果与第 ${seg} 段目标版本快照不一致，拒绝生成恢复提议（数据可能已损坏）`),
        { status: 500, code: 'RESTORE_MISMATCH' }
      );
    }
    segments.push({
      seg,
      currentText: sCur.text,
      currentLength: codeLength(sCur.text),
      targetText: targetSegments[tIdx].text,
      targetLength: codeLength(targetSegments[tIdx].text),
      restoredText,
      changeCount: result.hunks.length,
      changes: result.hunks,
    });
  }
  return { cur, target, segments, editsBySeg, changeCount, stageSize: stageProposals(db, cur.id).length };
}

// 恢复预览（只读）：选择已发布历史版本并给出非空理由，返回逐段净变化与确认凭证。
// 预览不改写任何状态；暂存区非空时仍可预览（canConfirm=false），但确认将被拒绝。
function restorePreview(db, actor, body) {
  if (!getDoc(db)) throw conflict('尚未导入逐字稿，无历史版本可恢复', 'NO_DOCUMENT');
  const targetId = parseInt(body && body.targetVersionId, 10);
  if (!Number.isInteger(targetId)) throw badRequest('缺少有效的目标版本号 targetVersionId（须为已发布历史版本）');
  const reason = typeof (body && body.reason) === 'string' ? body.reason.trim() : '';
  if (!reason) throw badRequest('恢复理由不能为空：请填写非空理由，说明为何把当前正文恢复到该历史版本', 'EMPTY_REASON');

  const computed = computeRestore(db, targetId); // 目标不存在 404、目标即当前版 409
  if (computed.changeCount === 0) {
    throw conflict(
      `目标版本 v${targetId} 与当前版本 v${computed.cur.id} 各段正文完全相同，没有可恢复的净变化`,
      'RESTORE_NO_CHANGES'
    );
  }
  const stage = stageProposals(db, computed.cur.id);
  return {
    currentVersionId: computed.cur.id,
    targetVersionId: targetId,
    reason,
    stageSize: stage.length,
    canConfirm: stage.length === 0,
    changedSegments: computed.segments.filter((s) => s.changeCount > 0).length,
    changeCount: computed.changeCount,
    segments: computed.segments,
    token: {
      tv: targetId,
      v: computed.cur.id,
      stg: stageFingerprint(stage),
      stgN: stage.length,
      r: reason,
      cc: computed.changeCount,
    },
  };
}

// 恢复确认：校验“预览所见的当前版本与暂存状态”，在同一事务内逐段逐处生成并采纳恢复提议；
// 仅空暂存可确认。预览后版本或暂存变化、净变化集合不一致则整次拒绝、回滚，不留下部分提议。
function confirmRestore(db, actor, body) {
  if (!getDoc(db)) throw conflict('尚未导入逐字稿，无历史版本可恢复', 'NO_DOCUMENT');
  const token = body && body.token;
  if (!token || typeof token !== 'object') {
    throw badRequest('缺少预览凭证：恢复前必须先发起预览，确认时需回传预览返回的 token');
  }
  const targetId = parseInt(token.tv, 10);
  if (!Number.isInteger(targetId)) throw badRequest('预览凭证无效：缺少目标版本号', 'STALE_PREVIEW');
  const reason = typeof token.r === 'string' ? token.r.trim() : '';

  return db.transaction(() => {
    const cur = latestVersion(db);
    const target = db.prepare('SELECT * FROM versions WHERE id=?').get(targetId);
    if (!target) throw notFound(`目标版本 v${targetId} 不存在，无法恢复`);
    if (!reason) throw badRequest('恢复理由不能为空：请重新预览并填写非空理由', 'EMPTY_REASON');
    if (target.id === cur.id) {
      throw conflict('目标版本就是当前版本，正文无需恢复', 'RESTORE_SAME_VERSION');
    }
    if (token.v !== cur.id) {
      throw conflict(
        `预览后已发布新版本（当前 v${cur.id}），恢复结果已失效，整次确认拒绝且不留下部分提议；请重新预览`,
        'STALE_PREVIEW'
      );
    }
    const stage = stageProposals(db, cur.id);
    if (stage.length > 0 || token.stgN !== 0 || token.stg !== stageFingerprint(stage)) {
      throw conflict(
        '仅空暂存区可以确认恢复：预览后暂存状态已变化或暂存区中已有已采纳修订；' +
          '整次确认拒绝且不留下部分提议，请清空暂存区后重新预览',
        'STAGE_NOT_EMPTY'
      );
    }
    const computed = computeRestore(db, targetId);
    if (computed.changeCount === 0) {
      throw conflict(
        `目标版本 v${targetId} 与当前版本 v${cur.id} 各段正文完全相同，没有可恢复的净变化`,
        'RESTORE_NO_CHANGES'
      );
    }
    if (token.cc !== computed.changeCount) {
      throw conflict(
        '预览所见的净变化与当前计算不一致（预览后版本或正文状态已变化），整次确认拒绝；请重新预览',
        'STALE_PREVIEW'
      );
    }

    // 逐段、逐处净变化生成恢复提议并立即采纳（只覆盖净变化范围；编辑互不重叠）。
    // 任一步失败随事务回滚——绝不留下部分恢复提议。
    const basis = restoreBasis(targetId, reason);
    const ids = [];
    const insertAdopted = db.prepare(
      `INSERT INTO proposals
        (seg, start_cp, end_cp, replacement, basis, original_excerpt, base_version_id,
         status, decided_by, decided_at, restore_target_version_id, created_by)
       VALUES (?,?,?,?,?,?,?, 'adopted', ?, datetime('now'), ?, ?)`
    );
    for (const segView of computed.segments) {
      if (!segView.changeCount) continue;
      for (const e of computed.editsBySeg.get(segView.seg)) {
        const r = insertAdopted.run(
          segView.seg, e.start, e.end, e.replace, basis,
          sliceCP(segView.currentText, e.start, e.end),
          cur.id, actor.id, targetId, actor.id
        );
        const id = r.lastInsertRowid;
        ids.push(id);
        addDecision(db, {
          type: 'adopt',
          proposalId: id,
          versionId: cur.id,
          actorId: actor.id,
          reason: `采纳恢复提议（恢复到 v${targetId}）`,
          detail: { restore: true, targetVersionId: targetId },
        });
      }
    }
    addDecision(db, {
      type: 'restore',
      proposalId: null,
      versionId: cur.id,
      actorId: actor.id,
      reason: basis,
      detail: { targetVersionId: targetId, proposalIds: ids, count: ids.length },
    });
    return { ids, targetVersionId: targetId, count: ids.length, currentVersionId: cur.id };
  })();
}

module.exports = {
  parseTranscript,
  importTranscript,
  createProposal,
  adoptProposal,
  rejectProposal,
  publish,
  createObjection,
  relocateObjection,
  rebasePreview,
  confirmRebase,
  restorePreview,
  confirmRestore,
  respondToObjection,
  publishGate,
  boothView,
  versionView,
  provenanceView,
  diffView,
  stageProposals,
  previewSegments,
  setSegmentSecret,
  listSecretLogs,
  setSegmentFollow,
  followedSegsFor,
  listNotifications,
  markNotificationRead,
  emitFollowNotifications,
  secretSegs,
  SECRET_PLACEHOLDER,
  getDoc,
  latestVersion,
  segmentsOf,
  addAttachment,
  deleteAttachment,
  authorizeDownload,
  attachmentsByProposal,
  attachmentMeta,
  canSeeAttachment,
};
