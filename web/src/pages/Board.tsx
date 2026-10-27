import { useState } from 'react';
import { get, post, type Task, type TaskStatus } from '../api';
import { Modal, dueInfo, timeAgo, useData, useHub } from '../ui';
import { Graph } from './Graph';
import { Suggest, useRecommend } from '../suggest';

type Drop = { verb: string; body?: Record<string, unknown>; done: string } | { dialog: 'assign' | 'reject' | 'cancel' };

const LIVE: TaskStatus[] = ['open', 'assigned', 'working', 'input_required'];

/** 把卡片拖到某一列意味着什么；null 表示不能放在这里。 */
function dropAction(t: Task, to: TaskStatus): Drop | null {
  if (t.status === to) return null;
  switch (to) {
    case 'open':
      if (t.status === 'draft') return { verb: 'publish', done: '已发布' };
      return LIVE.includes(t.status) ? { verb: 'assign', body: { agent: null }, done: '已放回任务池' } : null;
    case 'assigned':
      return LIVE.includes(t.status) ? { dialog: 'assign' } : null;
    case 'working':
      if (t.status === 'input_required') return { verb: 'unblock', done: '已解除阻塞' };
      return t.status === 'review' ? { dialog: 'reject' } : null;
    case 'completed':
      return t.status === 'review' ? { verb: 'approve', done: '已验收通过' } : null;
    case 'canceled':
      return ['completed', 'canceled'].includes(t.status) ? null : { dialog: 'cancel' };
    default:
      return null;
  }
}

const DIALOG_TITLE = {
  assign: '指派给',
  reject: '退回修改',
  cancel: '取消任务',
};

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
  const { project, agents, openTask, go, toast, refresh } = useHub();
  const [showClosed, setShowClosed] = useState(false);
  const [view, setView] = useState<'board' | 'graph'>(() => {
    try {
      return localStorage.getItem('ahub.board-view') === 'graph' ? 'graph' : 'board';
    } catch {
      return 'board';
    }
  });
  const switchView = (v: 'board' | 'graph') => {
    setView(v);
    try {
      localStorage.setItem('ahub.board-view', v);
    } catch {
      // 无痕模式下忽略
    }
  };
  const [dragging, setDragging] = useState<Task | null>(null);
  const [over, setOver] = useState<TaskStatus | null>(null);
  const [pending, setPending] = useState<{
    task: Task;
    dialog: 'assign' | 'reject' | 'cancel';
  } | null>(null);
  const [text, setText] = useState('');
  const [assignee, setAssignee] = useState('');
  const [query, setQuery] = useState('');
  const { data: tasks, reload } = useData(() => get<Task[]>(`/tasks${project ? `?project=${project}` : ''}`), [project]);

  const filtered = (tasks ?? []).filter(
    (t) =>
      (!assignee || (assignee === '-' ? !t.assignee : t.assignee === assignee)) &&
      (!query || t.title.includes(query) || t.id.toLowerCase().includes(query.toLowerCase())),
  );
  const act = async (t: Task, verb: string, body: Record<string, unknown> = {}, done?: string) => {
    try {
      await post(`/tasks/${t.id}/${verb}`, body);
      if (done) toast(`${t.id} ${done}`);
      reload();
      refresh();
      return true;
    } catch (err) {
      toast((err as Error).message, true);
      return false;
    }
  };

  const drop = (to: TaskStatus) => {
    const t = dragging;
    setDragging(null);
    setOver(null);
    const a = t && dropAction(t, to);
    if (!t || !a) return;
    if ('dialog' in a) {
      setText(a.dialog === 'assign' ? (t.assignee ?? '') : '');
      setPending({ task: t, dialog: a.dialog });
    } else void act(t, a.verb, a.body, a.done);
  };

  const recs = useRecommend({ task: pending?.task.id }, pending?.dialog === 'assign');
  const members = pending ? agents.filter((a) => a.status === 'active' && a.projects.some((p) => p.id === pending.task.project)) : [];

  const columns = COLUMNS.filter((c) => showClosed || c.status !== 'canceled' || dragging).filter(
    (c) => c.status !== 'draft' || filtered.some((t) => t.status === 'draft'),
  );

  return (
    <div>
      <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h1 className="page-title">任务看板</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            {view === 'board'
              ? '点击卡片查看详情；把卡片拖到其他列可以指派、放回任务池、验收、退回或取消'
              : '任务之间的前置关系和父子关系，点击任务查看详情'}
          </p>
        </div>
        <div className="btn-row">
          <div className="seg" role="tablist" aria-label="视图">
            <button
              role="tab"
              aria-selected={view === 'board'}
              className={view === 'board' ? 'active' : ''}
              onClick={() => switchView('board')}
            >
              看板
            </button>
            <button
              role="tab"
              aria-selected={view === 'graph'}
              className={view === 'graph' ? 'active' : ''}
              onClick={() => switchView('graph')}
            >
              关系图
            </button>
          </div>
          <input
            className="input"
            style={{ width: 180 }}
            placeholder="搜索标题或编号"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            className="select"
            style={{ width: 160 }}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            aria-label="按负责人筛选"
          >
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
      {view === 'graph' ? (
        <Graph tasks={filtered.filter((t) => showClosed || t.status !== 'canceled')} />
      ) : (
        <div className="board">
          {columns.map((col) => {
            const items = filtered
              .filter((t) => t.status === col.status)
              .sort((a, b) => a.priority.localeCompare(b.priority) || b.updated_at.localeCompare(a.updated_at));
            return (
              <section
                key={col.status}
                className={`column ${dragging ? (dropAction(dragging, col.status) ? 'droppable' : dragging.status === col.status ? '' : 'no-drop') : ''} ${over === col.status ? 'over' : ''}`}
                aria-label={col.label}
                onDragOver={(e) => {
                  if (!dragging || !dropAction(dragging, col.status)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (over !== col.status) setOver(col.status);
                }}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  drop(col.status);
                }}
              >
                <div className="column-head">
                  <span>{col.label}</span>
                  <span className="badge">{items.length}</span>
                </div>
                {items.map((t) => (
                  <article
                    key={t.id}
                    className={`task-card ${dragging?.id === t.id ? 'dragging' : ''}`}
                    draggable={!['completed', 'canceled'].includes(t.status)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', t.id);
                      setDragging(t);
                    }}
                    onDragEnd={() => (setDragging(null), setOver(null))}
                    onClick={() => openTask(t.id)}
                  >
                    <div className="meta">
                      <span>
                        {t.id}
                        {t.parent && ` · 子任务`}
                      </span>
                      <span className={`badge ${t.priority}`}>{t.priority}</span>
                    </div>
                    <div className="title">{t.title}</div>
                    {(() => {
                      const d = dueInfo(t);
                      return (
                        d && (
                          <div className={`due ${d.cls}`} title={d.title}>
                            ⏰ {d.text}
                          </div>
                        )
                      );
                    })()}
                    {t.stalled && (
                      <div className="due warn" title="一直在报进度，但百分比 2 小时以上没变">
                        ↻ 疑似原地打转
                      </div>
                    )}
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
      )}
      {pending && (
        <Modal title={`${DIALOG_TITLE[pending.dialog]} · ${pending.task.id}`} onClose={() => setPending(null)}>
          {pending.dialog === 'assign' ? (
            <div className="field">
              <label htmlFor="dnd-agent">项目成员</label>
              <select id="dnd-agent" className="select" value={text} onChange={(e) => setText(e.target.value)} autoFocus>
                <option value="">选择 agent</option>
                {members.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}（{a.id}）{a.online ? '' : ' · 不在线'}
                  </option>
                ))}
              </select>
              <Suggest list={recs} selected={text} onPick={setText} />
            </div>
          ) : (
            <div className="field">
              <label htmlFor="dnd-text">{pending.dialog === 'reject' ? '修改意见' : '原因（可选）'}</label>
              <textarea id="dnd-text" className="textarea" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            </div>
          )}
          <div className="btn-row">
            <button
              className={`btn ${pending.dialog === 'cancel' ? 'danger' : 'primary'}`}
              disabled={
                (pending.dialog !== 'cancel' && !text.trim()) ||
                (pending.dialog === 'assign' && text === pending.task.assignee && pending.task.status === 'assigned')
              }
              onClick={async () => {
                const t = pending.task;
                const ok =
                  pending.dialog === 'assign'
                    ? await act(t, 'assign', { agent: text }, '已指派')
                    : pending.dialog === 'reject'
                      ? await act(t, 'reject', { reason: text }, '已退回')
                      : await act(t, 'cancel', { reason: text || undefined }, '已取消');
                if (ok) setPending(null);
              }}
            >
              {pending.dialog === 'assign' ? '指派' : pending.dialog === 'reject' ? '退回' : '确认取消'}
            </button>
            <button className="btn" onClick={() => setPending(null)}>
              算了
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
