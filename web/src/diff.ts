// 逐行对比：最长公共子序列，够用于交付物这种几百行的文本。
export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string; a?: number; b?: number };

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n?/g, '\n').split('\n');
  const b = after.replace(/\r\n?/g, '\n').split('\n');
  // 先去掉相同的头尾，表格只需要算中间改动的部分
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) [endA, endB] = [endA - 1, endB - 1];
  const out: DiffLine[] = a.slice(0, start).map((text, i) => ({ kind: 'same', text, a: i + 1, b: i + 1 }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  if (n * m > 4_000_000) {
    // 太大就不细算：整段删掉再整段加上
    midA.forEach((text, i) => out.push({ kind: 'del', text, a: start + i + 1 }));
    midB.forEach((text, j) => out.push({ kind: 'add', text, b: start + j + 1 }));
  } else {
    const len = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--) len[i][j] = midA[i] === midB[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) out.push({ kind: 'same', text: midA[i++], a: start + i, b: start + ++j });
      // 先删后加，和常见的 diff 显示顺序一致
      else if (i < n && (j >= m || len[i + 1][j] >= len[i][j + 1])) out.push({ kind: 'del', text: midA[i++], a: start + i });
      else out.push({ kind: 'add', text: midB[j++], b: start + j });
    }
  }
  for (let k = 0; endA + k < a.length; k++) out.push({ kind: 'same', text: a[endA + k], a: endA + k + 1, b: endB + k + 1 });
  return out;
}

/** 只保留改动附近 context 行，其余折叠成「N 行未改动」。 */
export type DiffHunk = DiffLine | { kind: 'skip'; count: number };

export function foldDiff(lines: DiffLine[], context = 3): DiffHunk[] {
  const keep = lines.map(() => false);
  lines.forEach((l, i) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: DiffHunk[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped) out.push({ kind: 'skip', count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped) out.push({ kind: 'skip', count: skipped });
  return out;
}
