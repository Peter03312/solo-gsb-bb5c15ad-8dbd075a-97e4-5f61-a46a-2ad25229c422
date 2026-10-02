'use strict';
// 提议依据附件：按文件内容识别类型（PDF/PNG/JPEG/MP3/WAV）、SHA-256 校验与落盘存储。
// 文件目录默认位于 DATA_DIR/attachments（随数据卷持久，重启后仍可读取），可用 ATTACHMENT_DIR 覆盖。
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ATTACHMENT_DIR = process.env.ATTACHMENT_DIR || path.join(DATA_DIR, 'attachments');
const MAX_BYTES = parseInt(process.env.ATTACHMENT_MAX_BYTES || String(20 * 1024 * 1024), 10);

// 允许的媒体类型：判定一律以文件内容的魔术字节为准，客户端声明的 Content-Type
// 与原始文件名后缀只作展示，改名或伪造头不能绕过校验。
const MEDIA_TYPES = {
  pdf: { mediaType: 'pdf', ext: 'pdf', mime: 'application/pdf', kind: 'doc', label: 'PDF' },
  png: { mediaType: 'png', ext: 'png', mime: 'image/png', kind: 'image', label: 'PNG 图片' },
  jpeg: { mediaType: 'jpeg', ext: 'jpg', mime: 'image/jpeg', kind: 'image', label: 'JPEG 图片' },
  mp3: { mediaType: 'mp3', ext: 'mp3', mime: 'audio/mpeg', kind: 'audio', label: 'MP3 音频' },
  wav: { mediaType: 'wav', ext: 'wav', mime: 'audio/wav', kind: 'audio', label: 'WAV 音频' },
};

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_EOF = Buffer.from([0xff, 0xd9]);
// MPEG 音频帧同步的常见首字节（MPEG-1/2/2.5，Layer I/II/III）
const MP3_FRAME_SECONDS = new Set([0xfb, 0xf3, 0xf2, 0xfa]);

function ascii(buf, start, end) {
  return buf.toString('latin1', start, end);
}

// 返回 MEDIA_TYPES 中的描述符；内容无法识别时返回 null（空文件同样拒绝）
function sniffMediaType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  if (buf.length >= 5 && ascii(buf, 0, 5) === '%PDF-') return MEDIA_TYPES.pdf;
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return MEDIA_TYPES.png;
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff &&
      buf.subarray(buf.length - 2).equals(JPEG_EOF)) {
    return MEDIA_TYPES.jpeg;
  }
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WAVE') {
    return MEDIA_TYPES.wav;
  }
  if (buf.length >= 3 && ascii(buf, 0, 3) === 'ID3') return MEDIA_TYPES.mp3; // ID3v2 标签头
  if (buf.length >= 2 && buf[0] === 0xff && MP3_FRAME_SECONDS.has(buf[1])) return MEDIA_TYPES.mp3;
  return null;
}

function sha256(buf) {
  return crypto.createHash('sha-256').update(buf).digest('hex');
}

// 存储名只含 提议号/随机名.规范后缀，绝不使用客户端提供的原名拼路径（防目录穿越）
function newStoredName(proposalId, ext) {
  return `${proposalId}/${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

function attachmentPath(storedName) {
  return path.join(ATTACHMENT_DIR, storedName);
}

// 先写临时文件再原子改名：任何失败都不会留下半成品或孤儿附件
function writeAttachment(storedName, buf) {
  const finalPath = attachmentPath(storedName);
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
  );
  try {
    fs.writeFileSync(tmpPath, buf);
    fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    fs.rmSync(tmpPath, { force: true });
    throw e;
  }
  return finalPath;
}

function removeAttachment(storedName) {
  fs.rmSync(attachmentPath(storedName), { force: false });
  // 顺手清理空的提议分片目录（不存在非空子目录时忽略错误）
  try {
    fs.rmdirSync(path.dirname(attachmentPath(storedName)));
  } catch (_) { /* 目录非空等情况无需处理 */ }
}

function attachmentExists(storedName) {
  return fs.existsSync(attachmentPath(storedName));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

module.exports = {
  ATTACHMENT_DIR,
  MAX_BYTES,
  MEDIA_TYPES,
  sniffMediaType,
  sha256,
  newStoredName,
  attachmentPath,
  writeAttachment,
  removeAttachment,
  attachmentExists,
  formatBytes,
};
