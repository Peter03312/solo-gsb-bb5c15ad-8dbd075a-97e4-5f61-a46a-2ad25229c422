'use strict';
// 文本工具：全程以 Unicode 码点（character）为偏移单位，前端用 Array.from 保持一致。

function codeLength(s) {
  let n = 0;
  // eslint-disable-next-line no-unused-vars
  for (const _ of s) n++;
  return n;
}

function sliceCP(s, start, end) {
  return Array.from(s).slice(start, end).join('');
}

// 校验并归一化范围：返回 {start,end,length,excerpt}，非法范围抛出带 reason 的错误
function validateRange(text, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw Object.assign(new Error('范围端点必须为整数'), { status: 400 });
  }
  const length = codeLength(text);
  if (start < 0 || end < 0 || start > end || end > length) {
    throw Object.assign(
      new Error(`非法范围 [${start},${end})：当前段共 ${length} 个字符，须满足 0 ≤ start ≤ end ≤ ${length}`),
      { status: 400, code: 'BAD_RANGE' }
    );
  }
  return { start, end, length, excerpt: sliceCP(text, start, end) };
}

// 两处范围是否重叠（半开区间；[0,2) 与 [2,4) 不重叠，可无缝相接）
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

// 将一组同段内互不重叠的替换应用到原文（右起应用，避免偏移漂移）
function applyEdits(text, edits) {
  let result = text;
  for (const e of edits.slice().sort((a, b) => b.start - a.start)) {
    result = sliceCP(result, 0, e.start) + e.replace + sliceCP(result, e.end);
  }
  return result;
}

// 发布时把旧引用范围经一组互不重叠的修订映射到新文本坐标。
// 返回 {start,end,affected}。affected=true 表示引用与某次修订相交，
// 被引文字可能已不存在；此时坐标只是粗略几何记录，调用方必须把异议标记为
// needs_relocation 并保留原文快照，UI 不得据此悄悄指向新文字。
function transformRange(range, edits) {
  let { start, end } = range;
  let affected = false;
  for (const e of edits.slice().sort((a, b) => a.start - b.start)) {
    const d = codeLength(e.replace) - (e.end - e.start);
    if (e.end <= start) {
      start += d;
      end += d;
    } else if (e.start >= end) {
      // 修订完全在引用之后，不变
    } else {
      affected = true;
      start = Math.min(start, e.start);
      end = Math.max(start, e.start + codeLength(e.replace));
    }
  }
  return { start, end, affected };
}

// 续提换算：把基版坐标下的半开选区映射过一组同段互不重叠的修订（同一版本步内）。
// 与 transformRange 的差异：比较始终在原坐标系进行、位移累积计算（相邻修订互不干扰）；
// 零长度选区（插入点）被任何修订区间触及（start <= k <= end）即视为受影响——
// 此时插入点相对新旧文字的位置无法可靠推断，调用方必须拒绝自动换算，
// 不得凭同文搜索猜测位置。
function transformRangeRebase(range, edits) {
  const { start, end } = range;
  const point = start === end;
  let delta = 0;
  for (const e of edits.slice().sort((a, b) => a.start - b.start)) {
    const d = codeLength(e.replace) - (e.end - e.start);
    if (point) {
      if (e.start <= start && start <= e.end) return { start, end, affected: true };
      if (e.end < start) delta += d;
    } else if (e.end <= start) {
      delta += d;
    } else if (e.start < end) {
      return { start, end, affected: true };
    }
  }
  return { start: start + delta, end: end + delta, affected: false };
}

// 发布前回应门槛：暂存修订（edit）是否触及异议当前锚点（anchor）。
// - 非零长度修订：两个半开区间相交即触及（[0,2) 与 [2,4) 相接不算）；
// - 零长度修订（纯插入）：插入点落在引用范围 [anchor.start, anchor.end) 内即触及
//   （点等于引用起点算触及，等于引用终点不算，与半开区间口径一致）。
function editTouchesAnchor(edit, anchor) {
  if (edit.start === edit.end) {
    return anchor.start <= edit.start && edit.start < anchor.end;
  }
  return edit.start < anchor.end && anchor.start < edit.end;
}

// ---------- 正文来源重放 ----------
// 按逐次发布的修订逐码点重放正文来源。
// initialText：查询版本所在段的 v1 原文（码点数组，每个码点初始来源标签 tag(null)）；
// steps：[{ version, edits:[{id,start,end,replace}] }, ...]，edits 即该版发布时
//   实际合入该段的已采纳提议（坐标为该版基版坐标）。store 按 start、id 升序取出，
//   发布合版 applyEdits 以 start 降序稳定排序（同起点保持原 id 升序）右起应用；
//   此处使用相同迭代次序（start 降序、并列 id 升序），包括零长度插入与空串删除。
// 规则（纯几何重放，绝不按同文搜索猜测）：
// - 未被任何修订触及的码点保留原来源标签；
// - 被替换/插入的码点（含把原文换成相同文字的情形）标签改为本次提议 {proposalId,version}；
// - 删除（end>start、replace 为空）不产出码点，不占结果；
// - 零长度修订（纯插入）产出的码点同样归本次提议。
// 返回与 applyEdits 等价的 token 数组：[{ch, tag}]；相邻同标签的合并由调用方完成。
function replayProvenance(initialText, steps) {
  let tokens = Array.from(initialText).map((ch) => ({ ch, tag: null }));
  for (const step of steps) {
    for (const e of step.edits.slice().sort((a, b) =>
      b.start - a.start || a.id - b.id
    )) {
      const inserted = Array.from(e.replace).map((ch) => ({
        ch,
        tag: { proposalId: e.id, version: step.version },
      }));
      // 与 applyEdits 的右起切片完全一致：删除 [start,end)，再在同点放入替换码点
      tokens = tokens.slice(0, e.start).concat(inserted, tokens.slice(e.end));
    }
  }
  return tokens;
}

// ---------- 跨版净变化（版本对照） ----------
// 修订链沿“逐次发布”的坐标映射逐码点追踪每个码点的稳定身份：
// - v1 每个初始码点身份 i:N；每次修订插入的码点身份 e:{editId}:{发布版本}:j。
// - 修订只做几何切片（与 replayProvenance/applyEdits 完全一致），从不按同文搜索配对；
//   因此重复文字不会被错配。
// 再以两个版本的“身份序列”做 LCS 对齐，得到旧版独有（删除/被替换）与新版独有（插入/替换）
// 的半开区间及文字。中途改动最终撤销、两端文字相同的部分：其身份虽不同，但按“净变化”口径
// 对“旧串与新串逐字相同”的整块删除+插入予以剔除（剔除只依赖几何对齐后的整段文字逐位比较，
// 不是跨位置按同文配对）。未变段不产生任何变化块。
// 促成每处变化的跨版提议：以并查集把每次修订“删除的身份 ∪ 插入的身份”合并，
// 变化块端点身份所在分量关联到的全部已发布修订（提议编号 + 发布版本）即为促成链条，去重升序。
function alignTokenOps(idsA, idsB) {
  // LCS 对齐：O(n·m) 时间、O(n·m) 紧凑回溯表（逐字稿段长量级，单行 Uint16 表足够）。
  // 逆序长度表 dp[i][j] = seqA[i:] 与 seqB[j:] 的 LCS 长度，再正向回溯出逐条操作。
  const n = idsA.length;
  const m = idsB.length;
  const dp = new Array(n + 1);
  dp[n] = new Uint16Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    const row = new Uint16Array(m + 1);
    const below = dp[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      if (idsA[i] === idsB[j]) row[j] = below[j + 1] + 1;
      else row[j] = Math.max(below[j], row[j + 1]);
    }
    dp[i] = row;
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && idsA[i] === idsB[j]) {
      ops.push({ op: 'eq', ai: i, bj: j });
      i++; j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ op: 'ins', bj: j });
      j++;
    } else {
      ops.push({ op: 'del', ai: i });
      i++;
    }
  }
  return ops;
}

// 并查集：按修订事件合并“被删除身份 ∪ 新插入身份”，实现变化块向跨版提议的归因
function makeUnionFind() {
  const parent = new Map();
  const ensure = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    return x;
  };
  const find = (x) => {
    ensure(x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let y = x;
    while (parent.get(y) !== root) { const z = parent.get(y); parent.set(y, root); y = z; }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union };
}

// initialText：v1 该段原文；steps：[{version, edits:[{id,start,end,replace}]}]（含全部已发布步骤，
// 与 replayProvenance 相同的切片次序）。aVersion/bVersion 为要对照的两个版本（a < b，均 ≥ 1）。
// 返回 { versions, hunks }：versions 为各版本正文快照；hunks 为 a→b 的净变化块（坐标分别属于两版）。
function diffLineage(initialText, steps, aVersion, bVersion) {
  if (!Number.isInteger(aVersion) || !Number.isInteger(bVersion) || aVersion >= bVersion || aVersion < 1) {
    throw new Error('diffLineage：非法版本对照参数（须为 1 ≤ a < b 的已发布版本）');
  }
  const chOf = new Map(); // 身份 -> 码点（身份不可变：插入后码点不变）
  let tokens = Array.from(initialText).map((ch, idx) => {
    const id = `i:${idx}`;
    chOf.set(id, ch);
    return id;
  });
  const events = []; // {version, editId, removed:[id], inserted:[id]}
  const snapshots = new Map();
  const takeSnapshot = (ver) => { snapshots.set(ver, tokens.slice()); };
  takeSnapshot(1);

  // 按版本号 2…bVersion 逐版重放（即使某版本在该段无修订，也要拍下该版快照——
  // 版本可能仅由其他段的修订发布，而对照端点正落在该版本）。
  const stepsByVersion = new Map();
  for (const step of steps) {
    if (step.version >= 2 && step.version <= bVersion) stepsByVersion.set(step.version, step.edits);
  }
  for (let ver = 2; ver <= bVersion; ver++) {
    for (const e of (stepsByVersion.get(ver) || []).slice().sort((x, y) => y.start - x.start || x.id - y.id)) {
      const removed = tokens.slice(e.start, e.end);
      const inserted = Array.from(e.replace).map((ch, j) => {
        const id = `e:${e.id}:${ver}:${j}`;
        chOf.set(id, ch);
        return id;
      });
      tokens = tokens.slice(0, e.start).concat(inserted, tokens.slice(e.end));
      events.push({ version: ver, editId: e.id, removed, inserted });
    }
    takeSnapshot(ver);
  }

  const seqA = snapshots.get(aVersion);
  const seqB = snapshots.get(bVersion);
  if (!seqA || !seqB) throw new Error('diffLineage：对照版本缺少重放快照（版本不可达）');

  // 身份序列 LCS 对齐 → 逐条操作，并给出统一几何坐标：
  // aPos/bPos 为操作码点在旧/新版的码点下标；gap 为“对齐间隙”——该操作位于第几个恒等码点之后
  // （两版恒等码点之间的同一处位置）。原位替换的删除与插入共享同一 gap；位置不同的删除与插入
  // （如删旧 b、又在末尾另插新 b）gap 不同，不能合并/抵消。
  const ops = alignTokenOps(seqA, seqB);
  let pa = 0;
  let pb = 0;
  let gap = 0;
  for (const o of ops) {
    if (o.op === 'eq') { o.aPos = pa; o.bPos = pb; o.gap = gap; pa++; pb++; gap++; }
    else if (o.op === 'del') { o.aPos = pa; o.bPos = pb; o.gap = gap; pa++; }
    else { o.bPos = pb; o.aPos = pa; o.gap = gap; pb++; }
  }

  // 相邻 del/ins 合并为变化块：按“连续非 eq 段”严格分组（夹着 eq 的不相连）。
  // 同一块内可能是删除+插入（替换）、纯删除或纯插入。
  const rawHunks = [];
  let run = null;
  for (const o of ops) {
    if (o.op === 'eq') { run = null; continue; }
    if (!run) { run = { ops: [] }; rawHunks.push(run); }
    run.ops.push(o);
  }

  // 并查集归因：仅 (aVersion, bVersion] 区间内发布的修订参与归因。
  // (1, aVersion] 的修订只是把码点身份重放到旧版状态，不算“促成 a→b 净变化”的跨版提议。
  const uf = makeUnionFind();
  for (const ev of events) {
    if (ev.version <= aVersion || ev.version > bVersion) continue;
    const members = ev.removed.concat(ev.inserted);
    for (let k = 1; k < members.length; k++) uf.union(members[0], members[k]);
  }
  const contributorsByRoot = new Map();
  for (const ev of events) {
    if (ev.version <= aVersion || ev.version > bVersion) continue;
    const anchor = ev.removed[0] || ev.inserted[0];
    if (!anchor) continue;
    const root = uf.find(anchor);
    if (!contributorsByRoot.has(root)) contributorsByRoot.set(root, []);
    contributorsByRoot.get(root).push({ proposalId: ev.editId, versionId: ev.version });
  }

  const hunks = [];
  for (const h of rawHunks) {
    const dels = h.ops.filter((o) => o.op === 'del');
    const inss = h.ops.filter((o) => o.op === 'ins');
    // 半开区间按各自版本码点下标；纯插入/纯删除的空区间落在共同的对齐间隙处
    const oldStart = dels.length ? dels[0].aPos : inss[0].gap;
    const oldEnd = dels.length ? dels[dels.length - 1].aPos + 1 : oldStart;
    const newStart = inss.length ? inss[0].bPos : dels[0].gap;
    const newEnd = inss.length ? inss[inss.length - 1].bPos + 1 : newStart;
    const oldIds = dels.map((o) => seqA[o.ai]);
    const newIds = inss.map((o) => seqB[o.bj]);
    const oldText = oldIds.map((x) => chOf.get(x)).join('');
    const newText = newIds.map((x) => chOf.get(x)).join('');
    // 净变化口径：仅剔除“同一对齐间隙上的整块原位替换且新旧文字逐位相同”的块——
    // 即中途改动最终撤销、两端文字相同。删除与插入必须共享同一 gap（同处一个位置）。
    // 位置不同的删除与插入即便文字相同（如删旧 b、又在末尾另插新 b，gap 分别为 1 和 2），
    // 以及纯删除块、纯插入块，永不据此抵消——绝不靠同文配对成“移动”或无变化。
    const sameGap = dels.length && inss.length && dels[0].gap === inss[0].gap;
    if (sameGap && oldText === newText) continue;

    const roots = new Set();
    for (const id of oldIds.concat(newIds)) roots.add(uf.find(id));
    const contributors = [];
    const seen = new Set();
    for (const root of roots) {
      for (const c of contributorsByRoot.get(root) || []) {
        const key = `${c.proposalId}@${c.versionId}`;
        if (!seen.has(key)) { seen.add(key); contributors.push(c); }
      }
    }
    contributors.sort((x, y) => x.versionId - y.versionId || x.proposalId - y.proposalId);

    let kind = 'replace';
    if (!dels.length) kind = 'insert';
    else if (!inss.length) kind = 'delete';
    hunks.push({
      kind,
      old: { start: oldStart, end: oldEnd, text: oldText },
      now: { start: newStart, end: newEnd, text: newText },
      contributors,
    });
  }
  hunks.sort((x, y) => x.old.start - y.old.start || x.now.start - y.now.start);

  const versions = {};
  for (const [ver, ids] of snapshots) {
    if (ver <= bVersion) versions[ver] = ids.map((x) => chOf.get(x)).join('');
  }
  return { versions, hunks };
}

module.exports = {
  codeLength,
  sliceCP,
  validateRange,
  overlaps,
  applyEdits,
  transformRange,
  transformRangeRebase,
  editTouchesAnchor,
  replayProvenance,
  diffLineage,
};
