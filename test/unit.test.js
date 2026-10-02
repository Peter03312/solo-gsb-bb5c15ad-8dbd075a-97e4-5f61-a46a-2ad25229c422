'use strict';
// 纯文本算子单元测试（码点偏移、合版、引用映射、续提换算）
const assert = require('assert');
const crypto = require('crypto');
const { codeLength, sliceCP, validateRange, applyEdits, transformRange, transformRangeRebase, editTouchesAnchor, replayProvenance, diffLineage } = require('../src/text');
const { parseTranscript } = require('../src/store');
const { sniffMediaType, sha256, MEDIA_TYPES, formatBytes } = require('../src/attachments');

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ✓', m); };

// 码点计数：emoji 占 1 码点但 2 UTF-16 单元
const s = 'a😀b';
ok(codeLength(s) === 3, '😀 按 1 个码点计数');
ok(sliceCP(s, 1, 2) === '😀', '按码点切出 emoji');

// 范围校验以码点为准
const vr = validateRange(s, 1, 2);
ok(vr.excerpt === '😀', '非法范围判定基于码点而非 UTF-16');
assert.throws(() => validateRange(s, 0, 4), /非法范围/, '越界范围抛错');

// 同段多修订互不重叠：右起合并、彼此不影响
const text = '甲乙丙丁戊';
const merged = applyEdits(text, [
  { start: 0, end: 1, replace: 'X' },     // 甲 -> X
  { start: 2, end: 3, replace: 'YY' },    // 丙 -> YY
  { start: 4, end: 5, replace: '' },      // 删除戊
]);
ok(merged === 'X乙YY丁', `多处不重叠修订合并为“${merged}”`);

// 引用映射：修订在引用之前 → 平移且仍有效
let t = transformRange({ start: 3, end: 4 }, [{ start: 0, end: 1, replace: 'XYZ' }]);
ok(t.start === 5 && t.end === 6 && t.affected === false, '引用在修订之后：平移 +2，不受影响');

// 引用与修订相交 → affected，须重新定位
t = transformRange({ start: 2, end: 5 }, [{ start: 3, end: 4, replace: 'Q' }]);
ok(t.affected === true, '引用与修订相交：标记需重新定位');

// 修订在引用之后 → 坐标不变
t = transformRange({ start: 0, end: 2 }, [{ start: 3, end: 4, replace: 'QQQQ' }]);
ok(t.start === 0 && t.end === 2 && t.affected === false, '引用在修订之前：坐标不变');

// ---------- 续提换算（transformRangeRebase） ----------
// 非零选区：前方相邻修订长度有增有减，位移应累积计算
let rb = transformRangeRebase({ start: 5, end: 7 }, [
  { start: 0, end: 4, replace: 'X' },   // Δ = -3
  { start: 4, end: 5, replace: 'YY' },  // Δ = +1
]);
ok(rb.start === 3 && rb.end === 5 && rb.affected === false, '续提换算：相邻修订累积平移 [5,7)→[3,5)');

// 修订与选区相交 → 受影响，拒绝换算
rb = transformRangeRebase({ start: 2, end: 5 }, [{ start: 4, end: 6, replace: 'Q' }]);
ok(rb.affected === true, '续提换算：修订与选区相交即受影响');

// 边界相接不算触及（半开区间，可无缝相接）
rb = transformRangeRebase({ start: 2, end: 5 }, [{ start: 0, end: 2, replace: 'XYZ' }]);
ok(rb.start === 3 && rb.end === 6 && rb.affected === false, '续提换算：修订终点与选区起点相接不算触及');

// 零长度插入点：严格在前方的修订 → 平移
rb = transformRangeRebase({ start: 4, end: 4 }, [{ start: 0, end: 2, replace: 'XYZW' }]);
ok(rb.start === 6 && rb.end === 6 && rb.affected === false, '插入点：前方修订使其平移 +2');

// 插入点被修订区间覆盖 → 受影响
rb = transformRangeRebase({ start: 4, end: 4 }, [{ start: 3, end: 6, replace: 'Q' }]);
ok(rb.affected === true, '插入点被修订区间覆盖：受影响');

// 插入点恰在修订起点 / 终点 → 均视为触及
rb = transformRangeRebase({ start: 4, end: 4 }, [{ start: 4, end: 6, replace: 'Q' }]);
ok(rb.affected === true, '插入点恰在修订起点：触及');
rb = transformRangeRebase({ start: 4, end: 4 }, [{ start: 2, end: 4, replace: 'Q' }]);
ok(rb.affected === true, '插入点恰在修订终点：触及');

// 插入点之后的修订 → 不变
rb = transformRangeRebase({ start: 4, end: 4 }, [{ start: 5, end: 8, replace: 'Q' }]);
ok(rb.start === 4 && rb.end === 4 && rb.affected === false, '插入点之后的修订不影响');

// 解析：段号与自动编号
const segs = parseTranscript('1. 第一段\n2、第二段\n无段号正文\n4 第四段\n');
ok(segs.length === 4, `解析 4 段（段号、顿号、空格分隔、自动编号），实际 ${segs.length}`);
ok(segs[0].seg === 1 && segs[1].seg === 2 && segs[2].seg === 3 && segs[3].seg === 4,
  '无段号行自动顺延编号为 3，后续显式段号 4 正常');

assert.throws(() => parseTranscript('1. 甲\n1. 乙'), /重复/, '重复段号报错');
assert.throws(() => parseTranscript('   \n\n'), /空|未解析/, '空稿报错');

// ---------- 发布前回应门槛：暂存修订是否触及异议锚点（editTouchesAnchor） ----------
// 非零长度修订：半开区间相交即触及，端点相接不算
ok(editTouchesAnchor({ start: 2, end: 5 }, { start: 5, end: 8 }) === false, '门槛：修订起点等于引用终点（相接）不算触及');
ok(editTouchesAnchor({ start: 5, end: 7 }, { start: 2, end: 5 }) === false, '门槛：修订终点等于引用起点（相接）不算触及');
ok(editTouchesAnchor({ start: 3, end: 6 }, { start: 2, end: 5 }) === true, '门槛：区间相交算触及');
ok(editTouchesAnchor({ start: 0, end: 2 }, { start: 1, end: 3 }) === true, '门槛：部分相交算触及');
ok(editTouchesAnchor({ start: 3, end: 4 }, { start: 9, end: 12 }) === false, '门槛：完全不相交不算触及');
// 零长度修订（纯插入）：插入点落在引用范围 [a,b) 内（a ≤ 点 < b）算触及
ok(editTouchesAnchor({ start: 5, end: 5 }, { start: 2, end: 8 }) === true, '门槛：零长度插入点在引用范围内算触及');
ok(editTouchesAnchor({ start: 2, end: 2 }, { start: 2, end: 8 }) === true, '门槛：插入点恰在引用起点算触及');
ok(editTouchesAnchor({ start: 8, end: 8 }, { start: 2, end: 8 }) === false, '门槛：插入点恰在引用终点不算触及');
ok(editTouchesAnchor({ start: 9, end: 9 }, { start: 2, end: 8 }) === false, '门槛：插入点在引用范围外不算触及');

// ---------- 正文来源重放（replayProvenance） ----------
function tagOf(tokens, i) { return tokens[i].tag; }
// v1 初始：无任何发布步骤 → 全部归初始导入
let tk = replayProvenance('甲乙丙丁', []);
ok(tk.map((t) => t.ch).join('') === '甲乙丙丁' && tk.every((t) => t.tag === null),
  '来源重放：v1 原文全部标记为初始导入');

// 单版多处修订（替换、插入、删除混合）：触及文字归本次提议，未触及保留原来源，删除不占结果
tk = replayProvenance('甲乙丙丁戊', [
  { version: 2, edits: [
    { id: 7, start: 0, end: 1, replace: 'X' },    // 甲 -> X
    { id: 8, start: 2, end: 3, replace: 'Y' },    // 丙 -> Y
    { id: 9, start: 4, end: 5, replace: '' },     // 删除戊
  ] },
]);
ok(tk.map((t) => t.ch).join('') === 'X乙Y丁', '来源重放：多修订合版文本与 applyEdits 一致');
ok(tk[0].tag && tk[0].tag.proposalId === 7 && tk[0].tag.version === 2, '替换文字归提议 #7@v2');
ok(tagOf(tk, 1) === null, '未触及文字“乙”保留初始导入来源');
ok(tk[2].tag && tk[2].tag.proposalId === 8, '替换文字归提议 #8');
ok(tagOf(tk, 3) === null && tk.length === 4, '删除不占结果，后续“丁”仍为初始来源');

// 相邻边界：[0,1) 与 [1,2) 无缝相接，来源各自正确、不串行
tk = replayProvenance('甲乙丙', [
  { version: 3, edits: [
    { id: 1, start: 0, end: 1, replace: 'P' },
    { id: 2, start: 1, end: 2, replace: 'Q' },
  ] },
]);
ok(tk.map((t) => t.ch).join('') === 'PQ丙', '来源重放：相邻修订合并正确');
ok(tk[0].tag.proposalId === 1 && tk[1].tag.proposalId === 2 && tagOf(tk, 2) === null,
  '相邻边界处来源按几何区间归属，不按同文搜索');

// 纯插入（零长度修订）：插入码点归提议，原文字保留
tk = replayProvenance('甲乙', [
  { version: 4, edits: [{ id: 3, start: 1, end: 1, replace: '插' }] },
]);
ok(tk.map((t) => t.ch).join('') === '甲插乙', '来源重放：零长度插入合版正确');
ok(tagOf(tk, 0) === null && tk[1].tag.proposalId === 3 && tagOf(tk, 2) === null,
  '纯插入码点归提议，两侧原文字保留初始来源');

// 后续再次改写：最后写入该片段的提议才是来源；换成相同文字也算重写
tk = replayProvenance('甲乙丙', [
  { version: 2, edits: [{ id: 1, start: 0, end: 3, replace: 'XYZ' }] },
  { version: 3, edits: [{ id: 2, start: 0, end: 3, replace: '甲乙丙' }] }, // 同文重写
]);
ok(tk.map((t) => t.ch).join('') === '甲乙丙', '来源重放：同文重写后文本不变');
ok(tk.every((t) => t.tag && t.tag.proposalId === 2 && t.tag.version === 3),
  '同文搜索不可猜来源：同文重写后全部归最后写入的提议 #2@v3');

// 后续部分改写：只覆盖其中一段，其余保留上一版提议来源
tk = replayProvenance('ABC', [
  { version: 2, edits: [{ id: 1, start: 0, end: 3, replace: 'XYZ' }] },
  { version: 3, edits: [{ id: 2, start: 1, end: 2, replace: 'Q' }] },
]);
ok(tk.map((t) => t.ch).join('') === 'XQZ', '来源重放：再次部分改写合版正确');
ok(tk[0].tag.proposalId === 1 && tk[1].tag.proposalId === 2 && tk[2].tag.proposalId === 1,
  '再次改写只改被触及片段，其余来源沿修订历史保留');

// 码点口径：emoji 作为 1 个码点被整段替换
tk = replayProvenance('a😀b', [
  { version: 2, edits: [{ id: 5, start: 1, end: 2, replace: '🙂' }] },
]);
ok(tk.map((t) => t.ch).join('') === 'a🙂b' && tk[1].tag.proposalId === 5,
  '来源重放：增补平面字符按 1 码点处理');

// 同点两个零长度插入：与发布合版相同的稳定次序（id 小的先应用，后续应用的同点插入在其左侧）
tk = replayProvenance('甲乙', [
  { version: 2, edits: [
    { id: 1, start: 1, end: 1, replace: 'L' },
    { id: 2, start: 1, end: 1, replace: 'R' },
  ] },
]);
ok(tk.map((t) => t.ch).join('') === '甲RL乙' && tk[1].tag.proposalId === 2 && tk[2].tag.proposalId === 1,
  '来源重放：同点零长度插入按合版实际顺序归属（后应用的 #2 文本在左、#1 在右）');

// ---------- 跨版净变化（diffLineage） ----------
function diffHunks(initial, steps, a, b) {
  return diffLineage(initial, steps, a, b).hunks;
}
function contribIds(hunks) {
  return hunks.map((h) => h.contributors.map((c) => `#${c.proposalId}@v${c.versionId}`).join(','));
}

// 单步替换：旧/新区间、文字与促成提议
let dh = diffHunks('甲乙丙丁', [{ version: 2, edits: [{ id: 1, start: 0, end: 1, replace: 'X' }] }], 1, 2);
ok(dh.length === 1 && dh[0].kind === 'replace' &&
   dh[0].old.text === '甲' && dh[0].now.text === 'X' &&
   dh[0].old.start === 0 && dh[0].now.start === 0 &&
   contribIds(dh)[0] === '#1@v2', '净变化：单步替换给出旧/新半开区间、文字与促成提议');

// 纯插入：旧为空区间（插入点），新区间为插入码点；归因正确
dh = diffHunks('甲乙', [{ version: 2, edits: [{ id: 3, start: 1, end: 1, replace: '插' }] }], 1, 2);
ok(dh.length === 1 && dh[0].kind === 'insert' &&
   dh[0].old.start === 1 && dh[0].old.end === 1 && dh[0].old.text === '' &&
   dh[0].now.start === 1 && dh[0].now.end === 2 && dh[0].now.text === '插' &&
   contribIds(dh)[0] === '#3@v2', '净变化：纯插入旧区间为空、新区间为插入码点');

// 纯删除：新区间为空（删除点），旧区间为被删码点
dh = diffHunks('甲乙丙', [{ version: 2, edits: [{ id: 4, start: 1, end: 2, replace: '' }] }], 1, 2);
ok(dh.length === 1 && dh[0].kind === 'delete' &&
   dh[0].old.text === '乙' && dh[0].now.text === '' &&
   dh[0].old.start === 1 && dh[0].old.end === 2 &&
   dh[0].now.start === 1 && dh[0].now.end === 1 &&
   contribIds(dh)[0] === '#4@v2', '净变化：纯删除新区间为空、旧区间为被删码点');

// 中途改动最终撤销、两端文字相同（同位置整块替换）：不算变化
dh = diffHunks('甲', [
  { version: 2, edits: [{ id: 1, start: 0, end: 1, replace: 'X' }] },
  { version: 3, edits: [{ id: 2, start: 0, end: 1, replace: '甲' }] },
], 1, 3);
ok(dh.length === 0, '净变化：甲→X→甲 中途撤销且两端相同，不计变化');
// 同版单步把文字换成完全相同文字（重写）：两端相同，不算净变化
dh = diffHunks('甲乙', [{ version: 2, edits: [{ id: 9, start: 0, end: 2, replace: '甲乙' }] }], 1, 2);
ok(dh.length === 0, '净变化：同位置同文重写不算净变化');
// 插入后又删除该插入（两端相同）：不算变化，不泄露曾插入的内容
dh = diffHunks('甲乙', [
  { version: 2, edits: [{ id: 1, start: 1, end: 1, replace: 'X' }] },
  { version: 3, edits: [{ id: 2, start: 1, end: 2, replace: '' }] },
], 1, 3);
ok(dh.length === 0, '净变化：插入 X 后又删除 X，两端相同不计变化');

// 但中途区间仍可查：1→2 只见第一次改动（归因不含区间外 v3 的提议）
dh = diffHunks('甲', [
  { version: 2, edits: [{ id: 1, start: 0, end: 1, replace: 'X' }] },
  { version: 3, edits: [{ id: 2, start: 0, end: 1, replace: '甲' }] },
], 1, 2);
ok(dh.length === 1 && dh[0].now.text === 'X' && contribIds(dh)[0] === '#1@v2',
  '净变化：1→2 对照只归因区间内 v2 的提议，不含区间外 v3');
// 2→3
dh = diffHunks('甲', [
  { version: 2, edits: [{ id: 1, start: 0, end: 1, replace: 'X' }] },
  { version: 3, edits: [{ id: 2, start: 0, end: 1, replace: '甲' }] },
], 2, 3);
ok(dh.length === 1 && dh[0].old.text === 'X' && dh[0].now.text === '甲' && contribIds(dh)[0] === '#2@v3',
  '净变化：2→3 对照给出撤销改动');

// 重复文字不得靠搜索配对：删旧 b 又在段尾另插新 b（两处位置不同的独立修订，结果 acb），
// 必须报为两处净变化，不能配成“移动”或无变化。
dh = diffHunks('abc', [{ version: 2, edits: [
  { id: 1, start: 1, end: 2, replace: '' },   // 删位置1的 b
  { id: 2, start: 3, end: 3, replace: 'b' },  // 段尾另插新 b
] }], 1, 2);
ok(dh.length === 2,
  `净变化：删旧 b + 段尾插新 b（结果 acb）报为两处变化（实际 ${dh.length}），不按同文配对`);
ok(dh.some((h) => h.kind === 'delete' && h.old.text === 'b' && h.old.start === 1) &&
   dh.some((h) => h.kind === 'insert' && h.now.text === 'b' && h.now.start === 2),
  '净变化：两处分别为删除旧 b 与插入新 b，归因各属其提议');
// 开头插入重复 a：新 a 不顶替旧 a，只报一处插入
dh = diffHunks('ab', [{ version: 2, edits: [{ id: 3, start: 0, end: 0, replace: 'a' }] }], 1, 2);
ok(dh.length === 1 && dh[0].kind === 'insert' && dh[0].now.start === 0 && dh[0].now.end === 1,
  '净变化：开头插入重复 a 不顶替旧 a（几何对齐，不按同文搜索）');

// 链式跨版：ABC →(v2 #1) XYZ →(v3 #2) XQZ；对照 1→3 为一块，归因含两个跨版提议
dh = diffHunks('ABC', [
  { version: 2, edits: [{ id: 1, start: 0, end: 3, replace: 'XYZ' }] },
  { version: 3, edits: [{ id: 2, start: 1, end: 2, replace: 'Q' }] },
], 1, 3);
ok(dh.length === 1 && dh[0].old.text === 'ABC' && dh[0].now.text === 'XQZ' &&
   contribIds(dh)[0] === '#1@v2,#2@v3',
  '净变化：链式改写 1→3 为一块，促成提议含跨版 #1@v2 与 #2@v3');
// 2→3 只见第二步
dh = diffHunks('ABC', [
  { version: 2, edits: [{ id: 1, start: 0, end: 3, replace: 'XYZ' }] },
  { version: 3, edits: [{ id: 2, start: 1, end: 2, replace: 'Q' }] },
], 2, 3);
ok(dh.length === 1 && dh[0].old.text === 'Y' && dh[0].now.text === 'Q' && contribIds(dh)[0] === '#2@v3',
  '净变化：2→3 只报并归因第二步修订');

// 两处不相邻修订（删除 + 段尾插入）产生两块，半开区间坐标各自正确
dh = diffHunks('甲乙丙丁', [{ version: 2, edits: [
  { id: 1, start: 0, end: 1, replace: '' },
  { id: 2, start: 3, end: 3, replace: '尾' },
] }], 1, 2);
ok(dh.length === 2 && dh[0].kind === 'delete' && dh[0].old.start === 0 &&
   dh[1].kind === 'insert' && dh[1].now.text === '尾',
  '净变化：删除首字与段尾插入分属两块');

// 未变段（版本发布了其他段的修订，但该段在 a→b 区间无任何步骤）：不产生变化块
dh = diffHunks('无改动段落', [], 1, 2);
ok(dh.length === 0 && diffLineage('无改动段落', [], 1, 2).versions[2] === '无改动段落',
  '净变化：区间内该段无修订不产生变化块，快照文本不变');

// emoji 按 1 码点：替换 😀 区间为 [1,2)
{
  const r = diffLineage('a😀b', [{ version: 2, edits: [{ id: 7, start: 1, end: 2, replace: '🙂' }] }], 1, 2);
  ok(r.hunks.length === 1 && r.hunks[0].old.start === 1 && r.hunks[0].old.end === 2 &&
     r.hunks[0].old.text === '😀' && r.hunks[0].now.text === '🙂',
    '净变化：增补平面字符按 1 码点计区间');
  // 各版本快照文本正确
  ok(r.versions[1] === 'a😀b' && r.versions[2] === 'a🙂b', '净变化：版本快照文本正确（含 emoji）');
}

// ---------- 附件内容嗅探：只认文件内容，不认后缀/客户端声明类型 ----------
const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64'
);
ok(sniffMediaType(png1x1) === MEDIA_TYPES.png, '按 PNG 签名识别图片');

const jpegMin = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('JFIF', 'latin1'),
  Buffer.from([0, 0, 0]),
  Buffer.from([0xff, 0xd9]),
]);
ok(sniffMediaType(jpegMin) === MEDIA_TYPES.jpeg, '按 JPEG SOI/EOI 识别图片（中间内容不检查）');

const wavMin = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WAVE', 'latin1'),
  Buffer.from('fmt ', 'latin1'),
]);
ok(sniffMediaType(wavMin) === MEDIA_TYPES.wav, '按 RIFF....WAVE 识别 WAV');

const mp3Id3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([0x03, 0, 0, 0, 0, 0, 0])]);
ok(sniffMediaType(mp3Id3) === MEDIA_TYPES.mp3, '带 ID3v2 标签的 MP3 可识别');
ok(sniffMediaType(Buffer.from([0xff, 0xfb, 0x90])) === MEDIA_TYPES.mp3, '按 MPEG 帧同步字识别裸 MP3');
ok(sniffMediaType(Buffer.from([0xff, 0xf3, 0x90])) === MEDIA_TYPES.mp3, '0xFFF3 同步字识别 MP3');
ok(sniffMediaType(Buffer.from('%PDF-1.7\nhello')) === MEDIA_TYPES.pdf, '按 %PDF- 识别 PDF');

ok(sniffMediaType(Buffer.from('')) === null, '空文件拒绝');
ok(sniffMediaType(Buffer.from('abc')) === null, '过短内容拒绝');
ok(sniffMediaType(Buffer.from('GIF89a...')) === null, 'GIF 不在允许类型内，拒绝');
ok(sniffMediaType(Buffer.from('this is plain text'.repeat(4))) === null, '纯文本即使改名 .pdf 也拒绝');
ok(sniffMediaType(Buffer.concat([Buffer.from('%PDF-1.4'), Buffer.from([0xff, 0xd8, 0xff, 0xd9])])) === MEDIA_TYPES.pdf,
  '文件头优先（PDF 头 + 伪 JPEG 尾识别为 PDF）');
ok(sniffMediaType(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from('Exif'.padEnd(20, 'x')), Buffer.from([0xff, 0xd9])])) === MEDIA_TYPES.jpeg,
  'Exif JPEG（APP1）仍按 SOI/EOI 识别');

// SHA-256 与大小格式化
const known = crypto.createHash('sha-256').update('abc').digest('hex');
ok(sha256(Buffer.from('abc')) === known, 'SHA-256 计算与标准向量一致');
ok(formatBytes(500) === '500 B' && /KB/.test(formatBytes(2048)) && /MB/.test(formatBytes(5 * 1024 * 1024)), '文件大小可读格式化');

console.log(`\n单元测试全部通过：${n} 项 ✅`);
