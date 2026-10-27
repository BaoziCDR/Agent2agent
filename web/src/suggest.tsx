// 指派推荐：根据能力标签、在线与值守情况、手上任务量、历史表现和相似任务给出建议人选。
import { useEffect, useState } from 'react';
import { get, type Recommendation } from './api';

export function useRecommend(q: { project?: string | null; task?: string; tags?: string; title?: string }, enabled = true) {
  const [list, setList] = useState<Recommendation[] | null>(null);
  const key = new URLSearchParams(
    Object.entries({ project: q.project ?? '', task: q.task ?? '', tags: q.tags ?? '', title: q.title ?? '' }).filter(([, v]) => v),
  ).toString();
  useEffect(() => {
    if (!enabled || (!q.project && !q.task)) return setList(null);
    let alive = true;
    // 输入标题时稍等一下再查
    const timer = window.setTimeout(() => {
      get<Recommendation[]>(`/recommend?${key}`)
        .then((r) => alive && setList(r))
        .catch(() => alive && setList(null));
    }, 300);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [key, enabled]);
  return list;
}

/** 推荐人选：最多显示 3 个，点一下就选中；鼠标悬停看完整理由。 */
export function Suggest({
  list,
  selected,
  onPick,
  label = '推荐',
}: {
  list: Recommendation[] | null;
  selected?: string;
  onPick: (id: string) => void;
  label?: string;
}) {
  const top = (list ?? []).filter((r) => r.score >= 40).slice(0, 3);
  if (!top.length) return null;
  return (
    <div className="suggest">
      <span className="faint">{label}</span>
      {top.map((r) => (
        <button
          key={r.id}
          type="button"
          className={`suggest-item ${selected === r.id ? 'active' : ''}`}
          title={[...r.reasons, ...r.warnings.map((w) => `⚠ ${w}`)].join('\n')}
          onClick={() => onPick(r.id)}
        >
          <span className={`dot ${r.presence}`} />
          <b>{r.name}</b>
          <span className={`suggest-why ${r.warnings.length ? 'warn' : ''}`}>{r.warnings[0] ?? r.reasons[0] ?? ''}</span>
        </button>
      ))}
    </div>
  );
}
