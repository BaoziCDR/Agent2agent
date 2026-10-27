import { useEffect, useRef, useState } from 'react';
import { get } from '../api';
import { useData, useHub } from '../ui';

interface StatsData {
  days: { date: string; created: number; completed: number }[];
  totals: { created: number; completed: number; avg_hours: number | null; reject_rate: number | null };
  agents: {
    id: string;
    name: string;
    completed: number;
    submitted: number;
    rejected: number;
    reject_rate: number | null;
    avg_hours: number | null;
    working: number;
    overdue: number;
  }[];
}

const RANGES = [7, 14, 30];

const hours = (h: number | null) => (h === null ? '–' : h < 1 ? `${Math.max(1, Math.round(h * 60))} 分钟` : h < 48 ? `${h} 小时` : `${Math.round(h / 24)} 天`);

export function Stats() {
  const { project, projects } = useHub();
  const [days, setDays] = useState(14);
  const { data } = useData(() => get<StatsData>(`/stats?days=${days}${project ? `&project=${project}` : ''}`), [project, days]);
  const t = data?.totals;
  return (
    <div style={{ maxWidth: 1100 }}>
      <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h1 className="page-title">统计</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            {project ? projects.find((p) => p.id === project)?.name : '全部项目'} · 最近 {days} 天
          </p>
        </div>
        <div className="tabs" style={{ marginBottom: 0, borderBottom: 'none' }}>
          {RANGES.map((d) => (
            <button key={d} className={`tab ${days === d ? 'active' : ''}`} onClick={() => setDays(d)}>
              {d} 天
            </button>
          ))}
        </div>
      </div>

      <div className="grid stats">
        <div className="card stat">
          <div className="stat-label">完成任务</div>
          <div className="stat-value">{t?.completed ?? '–'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">新建任务</div>
          <div className="stat-value">{t?.created ?? '–'}</div>
        </div>
        <div className="card stat">
          <div className="stat-label">平均用时（开工到验收）</div>
          <div className="stat-value">{t ? hours(t.avg_hours) : '–'}</div>
        </div>
        <div className={`card stat ${t?.reject_rate ? 'warn' : ''}`}>
          <div className="stat-label">退回率</div>
          <div className="stat-value">{t?.reject_rate == null ? '–' : `${t.reject_rate}%`}</div>
        </div>
      </div>

      <div className="card" style={{ margin: '12px 0' }}>
        <h3>每天完成的任务</h3>
        {data && <DailyBars days={data.days} />}
      </div>

      <div className="card">
        <h3>各 agent 表现</h3>
        {data && data.agents.length === 0 && <div className="empty">还没有 agent</div>}
        {data && data.agents.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="num">完成</th>
                  <th className="num">平均用时</th>
                  <th className="num">提交 / 被退回</th>
                  <th className="num">退回率</th>
                  <th className="num">进行中</th>
                  <th className="num">逾期</th>
                </tr>
              </thead>
              <tbody>
                {data.agents.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <b>{a.name}</b> <span className="faint">{a.id}</span>
                    </td>
                    <td className="num">{a.completed}</td>
                    <td className="num">{hours(a.avg_hours)}</td>
                    <td className="num">
                      {a.submitted} / {a.rejected}
                    </td>
                    <td className="num">{a.reject_rate === null ? '–' : `${a.reject_rate}%`}</td>
                    <td className="num">{a.working}</td>
                    <td className="num" style={a.overdue ? { color: 'var(--bad)', fontWeight: 600 } : undefined}>
                      {a.overdue}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/** 单序列柱状图：每天完成数，悬停显示当天新建/完成。 */
function DailyBars({ days }: { days: StatsData['days'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(720);
  // 按容器实际宽度绘制，文字不随缩放变大变小
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(280, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = 180;
  const pad = { l: 28, r: 8, t: 10, b: 24 };
  const max = Math.max(4, ...days.map((d) => d.completed));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const slot = (W - pad.l - pad.r) / days.length;
  const bw = Math.max(4, Math.min(28, slot - 4));
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / top);
  const label = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`;
  const every = Math.ceil(days.length / Math.max(2, Math.floor((W - pad.l) / 56)));
  const h = hover === null ? null : days[hover];
  return (
    <div className="chart" ref={box} onMouseLeave={() => setHover(null)}>
      <svg width={W} height={H} role="img" aria-label="每天完成的任务数">
        {[0, 1, 2, 3, 4].map((i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(i * step)} y2={y(i * step)} className="grid-line" />
            <text x={pad.l - 6} y={y(i * step) + 4} textAnchor="end" className="axis">
              {i * step}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = pad.l + slot * i + (slot - bw) / 2;
          const yy = y(d.completed);
          const r = Math.min(4, bw / 2, H - pad.b - yy);
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={H - pad.t - pad.b} fill="transparent" />
              {d.completed > 0 && (
                <path
                  className={`bar ${hover === i ? 'active' : ''}`}
                  d={`M${x},${H - pad.b} V${yy + r} Q${x},${yy} ${x + r},${yy} H${x + bw - r} Q${x + bw},${yy} ${x + bw},${yy + r} V${H - pad.b} Z`}
                />
              )}
              {i % every === 0 && (
                <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="axis">
                  {label(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {h && hover !== null && (
        <div
          className="chart-tip"
          style={{
            left: pad.l + slot * (hover + 0.5),
            transform: `translateX(${hover < days.length / 4 ? '-10%' : hover > (days.length * 3) / 4 ? '-90%' : '-50%'})`,
          }}
        >
          <b>{label(h.date)}</b>
          <div>完成 {h.completed}</div>
          <div className="faint">新建 {h.created}</div>
        </div>
      )}
    </div>
  );
}
