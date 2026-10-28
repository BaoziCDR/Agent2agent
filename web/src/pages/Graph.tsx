import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n';
import type { Task } from '../api';
import { statusLabel, useHub } from '../ui';

const NODE_W = 196;
const NODE_H = 58;
const GAP_X = 64;
const GAP_Y = 16;
/** 有关联的任务组之间的间距 */
const GROUP_GAP_X = 56;
const GROUP_GAP_Y = 32;
/** 没有任何关联的任务排成网格，间距小一些 */
const GRID_GAP = 14;
const LABEL_H = 26;

const STATUS_CLASS: Partial<Record<Task['status'], string>> = {
  completed: 'done',
  working: 'accent',
  review: 'warn',
  input_required: 'bad',
  archived: 'muted',
};

const byNum = (a: Task, b: Task) => a.id.localeCompare(b.id, undefined, { numeric: true });

/**
 * 一组互相关联（前置或父子）的任务内部分层，从左到右排：
 * 每个任务排在它所有前置任务和父任务的右边，同一层按上一层的平均行号排序，减少连线交叉。
 */
function layoutGroup(tasks: Task[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const ups = (t: Task) => [...t.depends_on, ...(t.parent ? [t.parent] : [])].map((d) => byId.get(d)).filter((d): d is Task => !!d);
  const depth = (t: Task): number => {
    const known = level.get(t.id);
    if (known !== undefined) return known;
    if (visiting.has(t.id)) return 0; // 防御：数据里有环时不至于死循环
    visiting.add(t.id);
    const up = ups(t);
    const v = up.length ? Math.max(...up.map(depth)) + 1 : 0;
    visiting.delete(t.id);
    level.set(t.id, v);
    return v;
  };
  tasks.forEach(depth);
  const cols: Task[][] = [];
  for (const t of tasks) (cols[level.get(t.id)!] ??= []).push(t);
  const row = new Map<string, number>();
  cols.forEach((col, ci) => {
    if (ci > 0) {
      const key = (t: Task) => {
        const rs = ups(t)
          .map((d) => row.get(d.id))
          .filter((r): r is number => r !== undefined);
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : Infinity;
      };
      col.sort((a, b) => key(a) - key(b) || byNum(a, b));
    } else col.sort(byNum);
    col.forEach((t, i) => row.set(t.id, i));
  });
  const rows = Math.max(1, ...cols.map((c) => c.length));
  const height = rows * (NODE_H + GAP_Y) - GAP_Y;
  const pos = new Map<string, { x: number; y: number }>();
  // 每列在组内竖直居中，层数少的列不会都贴在顶上
  cols.forEach((col, ci) => {
    const offset = (height - (col.length * (NODE_H + GAP_Y) - GAP_Y)) / 2;
    col.forEach((t, i) => pos.set(t.id, { x: ci * (NODE_W + GAP_X), y: offset + i * (NODE_H + GAP_Y) }));
  });
  return { pos, width: cols.length * (NODE_W + GAP_X) - GAP_X, height };
}

/** 按前置和父子关系把任务分成若干组（连通分量） */
function groups(tasks: Task[]) {
  const ids = new Set(tasks.map((t) => t.id));
  const parent = new Map(tasks.map((t) => [t.id, t.id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const t of tasks) for (const d of [...t.depends_on, ...(t.parent ? [t.parent] : [])]) if (ids.has(d)) union(t.id, d);
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const r = find(t.id);
    (map.get(r) ?? map.set(r, []).get(r)!).push(t);
  }
  return [...map.values()].map((g) => g.sort(byNum));
}

/**
 * 整体排版：有关联的任务组按大小从左到右、放不下就换行（货架式排布）；
 * 没有任何关联的任务放在后面排成网格，按容器宽度自动换行，不再全部挤在最左边一列。
 */
function layout(tasks: Task[], avail: number) {
  const all = groups(tasks);
  const linked = all.filter((g) => g.length > 1).sort((a, b) => b.length - a.length || byNum(a[0], b[0]));
  const single = all
    .filter((g) => g.length === 1)
    .map((g) => g[0])
    .sort(byNum);
  const pos = new Map<string, { x: number; y: number }>();
  const labels: { y: number; text: string }[] = [];
  let x = 0;
  let y = 0;
  let shelf = 0;
  let width = 0;
  if (linked.length && single.length) {
    labels.push({ y, text: t('有关联的任务') });
    y += LABEL_H;
  }
  for (const g of linked) {
    const l = layoutGroup(g);
    if (x > 0 && x + l.width > avail) {
      x = 0;
      y += shelf + GROUP_GAP_Y;
      shelf = 0;
    }
    for (const [id, p] of l.pos) pos.set(id, { x: x + p.x, y: y + p.y });
    width = Math.max(width, x + l.width);
    shelf = Math.max(shelf, l.height);
    x += l.width + GROUP_GAP_X;
  }
  if (linked.length) y += shelf + GROUP_GAP_Y;
  if (single.length) {
    if (linked.length) {
      labels.push({ y, text: t('独立任务') });
      y += LABEL_H;
    }
    const perRow = Math.max(1, Math.floor((Math.max(avail, NODE_W) + GRID_GAP) / (NODE_W + GRID_GAP)));
    single.forEach((t, i) => {
      pos.set(t.id, { x: (i % perRow) * (NODE_W + GRID_GAP), y: y + Math.floor(i / perRow) * (NODE_H + GRID_GAP) });
    });
    const cols = Math.min(perRow, single.length);
    width = Math.max(width, cols * (NODE_W + GRID_GAP) - GRID_GAP);
    y += Math.ceil(single.length / perRow) * (NODE_H + GRID_GAP) - GRID_GAP;
  } else y -= GROUP_GAP_Y;
  return { pos, labels, width: Math.max(width, NODE_W), height: Math.max(y, NODE_H) };
}

const PAD_X = 24;
const PAD_Y = 12;

export function Graph({ tasks }: { tasks: Task[] }) {
  const { openTask } = useHub();
  const ref = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(960);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 卡片内边距约 16px × 2，再去掉画布两侧留白
    const measure = () => setAvail(Math.max(NODE_W, el.clientWidth - 32 - PAD_X * 2));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const projects = useMemo(() => [...new Set(tasks.map((t) => t.project))].sort(), [tasks]);
  return (
    <div className="grid" style={{ gap: 12 }} ref={ref}>
      {tasks.length === 0 ? (
        <div className="card empty">{t('没有符合筛选条件的任务')}</div>
      ) : (
        <>
          <p className="faint graph-legend">
            <span>
              <span className="legend-line" /> {t('前置任务（完成后才能开始，未完成时为蓝色）')}
            </span>
            <span>
              <span className="legend-line dashed" /> {t('父任务与子任务')}
            </span>
          </p>
          {projects.map((p) => (
            <ProjectGraph
              key={p}
              tasks={tasks.filter((t) => t.project === p)}
              title={projects.length > 1 ? p : null}
              avail={avail}
              onOpen={openTask}
            />
          ))}
        </>
      )}
    </div>
  );
}

function ProjectGraph({ tasks, title, avail, onOpen }: { tasks: Task[]; title: string | null; avail: number; onOpen: (id: string) => void }) {
  const { pos, labels, width, height } = useMemo(() => layout(tasks, avail), [tasks, avail]);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const edges: { from: string; to: string; kind: 'dep' | 'sub'; live: boolean }[] = [];
  for (const t of tasks) {
    for (const d of t.depends_on)
      if (byId.has(d)) edges.push({ from: d, to: t.id, kind: 'dep', live: !['completed', 'archived'].includes(byId.get(d)!.status) });
    if (t.parent && byId.has(t.parent)) edges.push({ from: t.parent, to: t.id, kind: 'sub', live: false });
  }
  const path = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    if (x2 > x1) {
      const mx = (x1 + x2) / 2;
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`;
    }
    // 防御：数据有环时两端可能在同一列，从左侧绕
    return `M${a.x},${y1} C${a.x - 28},${y1} ${b.x - 28},${y2} ${b.x},${y2}`;
  };
  return (
    <div className="card graph-card">
      {title && <h3>{title}</h3>}
      <div className="graph-scroll">
        <svg width={width + PAD_X * 2} height={height + PAD_Y * 2} role="img" aria-label={title ? t('{title}任务关系图', { title }) : t('任务关系图')}>
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="graph-arrow" />
            </marker>
            <marker id="arrow-live" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="graph-arrow live" />
            </marker>
          </defs>
          <g transform={`translate(${PAD_X},${PAD_Y})`}>
            {labels.map((l) => (
              <text key={l.text} x={0} y={l.y + 14} className="graph-label">
                {l.text}
              </text>
            ))}
            {edges.map((e) => (
              <path
                key={`${e.kind}${e.from}${e.to}`}
                d={path(pos.get(e.from)!, pos.get(e.to)!)}
                className={`graph-edge ${e.kind === 'sub' ? 'dashed' : ''} ${e.live ? 'live' : ''}`}
                markerEnd={e.kind === 'dep' ? `url(#${e.live ? 'arrow-live' : 'arrow'})` : undefined}
              />
            ))}
            {tasks.map((t) => {
              const p = pos.get(t.id)!;
              return (
                <foreignObject key={t.id} x={p.x} y={p.y} width={NODE_W} height={NODE_H}>
                  <button
                    className={`graph-node ${STATUS_CLASS[t.status] ?? ''}`}
                    onClick={() => onOpen(t.id)}
                    title={`${t.id} ${t.title}`}
                  >
                    <span className="graph-meta">
                      <span>
                        {t.id}
                        <span className={`graph-pri ${t.priority}`}>{t.priority}</span>
                      </span>
                      <span>{statusLabel(t.status)}</span>
                    </span>
                    <span className="graph-title">{t.title}</span>
                  </button>
                </foreignObject>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
