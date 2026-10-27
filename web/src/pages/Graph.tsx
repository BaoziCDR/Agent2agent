import { useMemo } from 'react';
import type { Task } from '../api';
import { useHub } from '../ui';

const NODE_W = 196;
const NODE_H = 58;
const GAP_X = 64;
const GAP_Y = 16;

const STATUS_CLASS: Partial<Record<Task['status'], string>> = {
  completed: 'done',
  working: 'accent',
  review: 'warn',
  input_required: 'bad',
  canceled: 'muted',
};

/** 按前置任务分层，从左到右排：没有前置的在最左边，每个任务排在它所有前置任务的右边。 */
function layout(tasks: Task[]) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (t: Task): number => {
    const known = level.get(t.id);
    if (known !== undefined) return known;
    if (visiting.has(t.id)) return 0; // 防御：数据里有环时不至于死循环
    visiting.add(t.id);
    const deps = t.depends_on.map((d) => byId.get(d)).filter((d): d is Task => !!d);
    const v = deps.length ? Math.max(...deps.map(depth)) + 1 : 0;
    visiting.delete(t.id);
    level.set(t.id, v);
    return v;
  };
  tasks.forEach(depth);
  const cols: Task[][] = [];
  for (const t of tasks) (cols[level.get(t.id)!] ??= []).push(t);
  // 每列按前置任务的平均行号排序，减少连线交叉
  const row = new Map<string, number>();
  cols.forEach((col, ci) => {
    if (ci > 0) {
      const key = (t: Task) => {
        const rs = [...t.depends_on, ...(t.parent ? [t.parent] : [])].map((d) => row.get(d)).filter((r): r is number => r !== undefined);
        return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : Infinity;
      };
      col.sort((a, b) => key(a) - key(b) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    } else col.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    col.forEach((t, i) => row.set(t.id, i));
  });
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, ci) => col.forEach((t, i) => pos.set(t.id, { x: ci * (NODE_W + GAP_X), y: i * (NODE_H + GAP_Y) })));
  const rows = Math.max(1, ...cols.map((c) => c.length));
  return { pos, width: cols.length * (NODE_W + GAP_X) - GAP_X, height: rows * (NODE_H + GAP_Y) - GAP_Y };
}

export function Graph({ tasks }: { tasks: Task[] }) {
  const { openTask } = useHub();
  const projects = useMemo(() => [...new Set(tasks.map((t) => t.project))].sort(), [tasks]);
  if (tasks.length === 0) return <div className="card empty">没有任务</div>;
  return (
    <div className="grid" style={{ gap: 12 }}>
      <p className="faint graph-legend">
        <span>
          <span className="legend-line" /> 前置任务（完成后才能开始，未完成时为蓝色）
        </span>
        <span>
          <span className="legend-line dashed" /> 父任务与子任务
        </span>
      </p>
      {projects.map((p) => (
        <ProjectGraph key={p} tasks={tasks.filter((t) => t.project === p)} title={projects.length > 1 ? p : null} onOpen={openTask} />
      ))}
    </div>
  );
}

function ProjectGraph({ tasks, title, onOpen }: { tasks: Task[]; title: string | null; onOpen: (id: string) => void }) {
  const { pos, width, height } = useMemo(() => layout(tasks), [tasks]);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const edges: { from: string; to: string; kind: 'dep' | 'sub'; live: boolean }[] = [];
  for (const t of tasks) {
    for (const d of t.depends_on)
      if (byId.has(d)) edges.push({ from: d, to: t.id, kind: 'dep', live: byId.get(d)!.status !== 'completed' });
    if (t.parent && byId.has(t.parent)) edges.push({ from: t.parent, to: t.id, kind: 'sub', live: false });
  }
  const padX = 32;
  const padY = 8;
  const path = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    if (x2 > x1) {
      const mx = (x1 + x2) / 2;
      return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`;
    }
    // 同一列（父子任务常见）：紧挨着就竖直连，否则从左侧绕
    if (b.x === a.x && Math.abs(b.y - a.y) === NODE_H + GAP_Y) {
      const x = a.x + 28;
      return b.y > a.y ? `M${x},${a.y + NODE_H} V${b.y}` : `M${x},${a.y} V${b.y + NODE_H}`;
    }
    const ys = a.y + NODE_H / 2;
    const ye = b.y + NODE_H / 2;
    return `M${a.x},${ys} C${a.x - 28},${ys} ${b.x - 28},${ye} ${b.x},${ye}`;
  };
  return (
    <div className="card graph-card">
      {title && <h3>{title}</h3>}
      <div className="graph-scroll">
        <svg width={width + padX * 2} height={height + padY * 2} role="img" aria-label={`${title ?? ''}任务关系图`}>
          <defs>
            <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="graph-arrow" />
            </marker>
            <marker id="arrow-live" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="graph-arrow live" />
            </marker>
          </defs>
          <g transform={`translate(${padX},${padY})`}>
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
                      <span>{t.id}</span>
                      <span>{t.status_label}</span>
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
