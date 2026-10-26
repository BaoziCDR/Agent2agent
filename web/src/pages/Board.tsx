import { useState } from 'react';
import { get, type Task, type TaskStatus } from '../api';
import { timeAgo, useData, useHub } from '../ui';

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'draft', label: '草稿' },
  { status: 'open', label: '待领取' },
  { status: 'assigned', label: '已指派' },
  { status: 'working', label: '进行中' },
  { status: 'input_required', label: '阻塞' },
  { status: 'review', label: '待验收' },
  { status: 'completed', label: '已完成' },
  { status: 'canceled', label: '已取消' },
];

export function Board() {
  const { project, agents, openTask, go } = useHub();
  const [showClosed, setShowClosed] = useState(false);
  const [assignee, setAssignee] = useState('');
  const [query, setQuery] = useState('');
  const { data: tasks } = useData(() => get<Task[]>(`/tasks${project ? `?project=${project}` : ''}`), [project]);

  const filtered = (tasks ?? []).filter(
    (t) =>
      (!assignee || (assignee === '-' ? !t.assignee : t.assignee === assignee)) &&
      (!query || t.title.includes(query) || t.id.toLowerCase().includes(query.toLowerCase())),
  );
  const columns = COLUMNS.filter((c) => showClosed || c.status !== 'canceled').filter(
    (c) => c.status !== 'draft' || filtered.some((t) => t.status === 'draft'),
  );

  return (
    <div>
      <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h1 className="page-title">任务看板</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            点击卡片查看详情、指派、验收
          </p>
        </div>
        <div className="btn-row">
          <input className="input" style={{ width: 180 }} placeholder="搜索标题或编号" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="select" style={{ width: 160 }} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="按负责人筛选">
            <option value="">全部负责人</option>
            <option value="-">未指派</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <label className="faint" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> 显示已取消
          </label>
          <button className="btn primary" onClick={() => go('new')}>
            发布任务
          </button>
        </div>
      </div>
      <div className="board">
        {columns.map((col) => {
          const items = filtered
            .filter((t) => t.status === col.status)
            .sort((a, b) => a.priority.localeCompare(b.priority) || b.updated_at.localeCompare(a.updated_at));
          return (
            <section key={col.status} className="column" aria-label={col.label}>
              <div className="column-head">
                <span>{col.label}</span>
                <span className="badge">{items.length}</span>
              </div>
              {items.map((t) => (
                <article key={t.id} className="task-card" onClick={() => openTask(t.id)}>
                  <div className="meta">
                    <span>
                      {t.id}
                      {t.parent && ` · 子任务`}
                    </span>
                    <span className={`badge ${t.priority}`}>{t.priority}</span>
                  </div>
                  <div className="title">{t.title}</div>
                  {['working', 'input_required', 'review'].includes(t.status) && (
                    <div className="progress" title={`${t.progress}%`}>
                      <div style={{ width: `${t.progress}%` }} />
                    </div>
                  )}
                  <div className="meta" style={{ marginTop: 7 }}>
                    <span>{t.assignee_name ?? (t.required_tags.length ? `需要：${t.required_tags.join('、')}` : '未指派')}</span>
                    <span>{timeAgo(t.updated_at)}</span>
                  </div>
                  {t.status === 'input_required' && t.block_reason && (
                    <div className="faint" style={{ color: 'var(--bad)', marginTop: 4 }}>
                      {t.block_reason}
                    </div>
                  )}
                  {t.status === 'working' && t.progress_note && (
                    <div className="faint" style={{ marginTop: 4 }}>
                      {t.progress_note}
                    </div>
                  )}
                </article>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
