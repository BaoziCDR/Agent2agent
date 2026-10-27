import { useEffect, useMemo, useState } from 'react';
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
    case 'archived':
      return ['completed', 'archived'].includes(t.status) ? null : { dialog: 'cancel' };
    default:
      return null;
  }
}

const DIALOG_TITLE = {
  assign: '指派给',
  reject: '退回修改',
  cancel: '归档任务',
};

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'draft', label: '草稿' },
  { status: 'open', label: '待领取' },
  { status: 'assigned', label: '已指派' },
  { status: 'working', label: '进行中' },
  { status: 'input_required', label: '阻塞' },
  { status: 'review', label: '待验收' },
  { status: 'completed', label: '已完成' },
  { status: 'archived', label: '已归档' },
];

const PRIORITIES: Task['priority'][] = ['P0', 'P1', 'P2', 'P3'];

type DateRange = '' | 'today' | '7d' | '30d' | 'custom';

interface Filters {
  query: string;
  assignee: string;
  /** 选中的优先级；空表示全部 */
  priorities: Task['priority'][];
  /** 只看主任务（不含子任务） */
  topOnly: boolean;
  /** 日期范围按创建时间还是最后更新时间 */
  dateField: 'created' | 'updated';
  range: DateRange;
  from: string;
  to: string;
  showArchived: boolean;
  /** 归档里只看手动或自动归档；空表示都看 */
  archiveKind: '' | 'manual' | 'auto';
}

const EMPTY: Filters = {
  query: '',
  assignee: '',
  priorities: [],
  topOnly: false,
  dateField: 'created',
  range: '',
  from: '',
  to: '',
  showArchived: false,
  archiveKind: '',
};

const FILTER_KEY = 'ahub.board-filters';

function loadFilters(): Filters {
  try {
    const saved = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null') as Partial<Filters> | null;
    // 搜索词不记，其余筛选下次打开还在
    return saved ? { ...EMPTY, ...saved, query: '' } : EMPTY;
  } catch {
    return EMPTY;
  }
}

/** 本地时区的日期 YYYY-MM-DD */
function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 日期范围换成起止日期（含两端）；不限时返回 null */
function dayRange(f: Filters): { from: string; to: string } | null {
  const today = new Date();
  const ago = (n: number) => localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
  switch (f.range) {
    case 'today':
      return { from: ago(0), to: ago(0) };
    case '7d':
      return { from: ago(6), to: ago(0) };
    case '30d':
      return { from: ago(29), to: ago(0) };
    case 'custom':
      return f.from || f.to ? { from: f.from, to: f.to } : null;
    default:
      return null;
  }
}

/** 归档以外的筛选条件：关系图和看板共用 */
function matches(t: Task, f: Filters, range: { from: string; to: string } | null) {
  if (f.assignee && (f.assignee === '-' ? t.assignee : t.assignee !== f.assignee)) return false;
  const q = f.query.trim();
  if (q && !t.title.includes(q) && !t.id.toLowerCase().includes(q.toLowerCase())) return false;
  if (f.priorities.length && !f.priorities.includes(t.priority)) return false;
  if (f.topOnly && t.parent) return false;
  if (range) {
    const day = localDay(new Date(f.dateField === 'created' ? t.created_at : t.updated_at));
    if (range.from && day < range.from) return false;
    if (range.to && day > range.to) return false;
  }
  if (t.status === 'archived') {
    if (!f.showArchived) return false;
    if (f.archiveKind && t.archive_kind !== f.archiveKind) return false;
  }
  return true;
}

export function Board() {
  const { project, agents, openTask, go, toast, refresh } = useHub();
  const [f, setF] = useState<Filters>(loadFilters);
  const set = (patch: Partial<Filters>) => setF((old) => ({ ...old, ...patch }));
  useEffect(() => {
    try {
      localStorage.setItem(FILTER_KEY, JSON.stringify({ ...f, query: '' }));
    } catch {
      // 无痕模式下忽略
    }
  }, [f]);
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
  const { data: tasks, reload } = useData(() => get<Task[]>(`/tasks${project ? `?project=${project}` : ''}`), [project]);

  const range = dayRange(f);
  const filtered = useMemo(() => (tasks ?? []).filter((t) => matches(t, f, range)), [tasks, f, range?.from, range?.to]);
  // 主任务卡片上显示有几个子任务（只看主任务时也能知道下面还有子任务）
  const children = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks ?? []) if (t.parent) m.set(t.parent, (m.get(t.parent) ?? 0) + 1);
    return m;
  }, [tasks]);
  // 生效的筛选条数：手机上筛选栏折叠时显示在「筛选」按钮上
  const activeCount = [
    !!f.query.trim(),
    !!f.assignee,
    f.priorities.length > 0,
    f.topOnly,
    !!range,
    f.showArchived && !!f.archiveKind,
  ].filter(Boolean).length;
  const active = activeCount > 0;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const total = (tasks ?? []).filter((t) => f.showArchived || t.status !== 'archived').length;
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

  const columns = COLUMNS.filter((c) => f.showArchived || c.status !== 'archived' || dragging).filter(
    (c) => c.status !== 'draft' || filtered.some((t) => t.status === 'draft'),
  );

  return (
    <div>
      <div className="btn-row" style={{ justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h1 className="page-title">任务看板</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            {view === 'board'
              ? '点击卡片查看详情；把卡片拖到其他列可以指派、放回任务池、验收、退回或归档'
              : '任务之间的前置关系和父子关系，点击任务查看详情；上面的筛选同样生效'}
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
          <button
            className={`btn filter-toggle ${filtersOpen ? 'on' : ''}`}
            aria-expanded={filtersOpen}
            aria-controls="board-filters"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            筛选{activeCount + (f.showArchived ? 1 : 0) > 0 && <span className="badge accent">{activeCount + (f.showArchived ? 1 : 0)}</span>}
          </button>
          <button className="btn primary" onClick={() => go('new')}>
            发布任务
          </button>
        </div>
      </div>
      <div id="board-filters" className={`filter-bar ${filtersOpen ? '' : 'collapsed'}`} role="search" aria-label="筛选任务">
        <input
          className="input"
          style={{ width: 170 }}
          placeholder="搜索标题或编号"
          value={f.query}
          onChange={(e) => set({ query: e.target.value })}
        />
        <select
          className="select"
          style={{ width: 140 }}
          value={f.assignee}
          onChange={(e) => set({ assignee: e.target.value })}
          aria-label="按负责人筛选"
        >
          <option value="">全部负责人</option>
          <option value="-">未指派</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}{a.status === 'deleted' ? '（已删除）' : ''}
            </option>
          ))}
        </select>
        <div className="chip-group" role="group" aria-label="按优先级筛选">
          {PRIORITIES.map((p) => {
            const on = f.priorities.includes(p);
            return (
              <button
                key={p}
                className={`filter-chip ${on ? 'on' : ''}`}
                aria-pressed={on}
                title={on ? `不再只看 ${p}` : `只看 ${p}（可多选）`}
                onClick={() => set({ priorities: on ? f.priorities.filter((x) => x !== p) : [...f.priorities, p].sort() })}
              >
                {p}
              </button>
            );
          })}
        </div>
        <div className="date-filter">
          <select
            className="select"
            style={{ width: 92 }}
            value={f.dateField}
            onChange={(e) => set({ dateField: e.target.value as Filters['dateField'] })}
            aria-label="按哪个日期筛选"
          >
            <option value="created">创建于</option>
            <option value="updated">更新于</option>
          </select>
          <select
            className="select"
            style={{ width: 104 }}
            value={f.range}
            onChange={(e) => set({ range: e.target.value as DateRange })}
            aria-label="日期范围"
          >
            <option value="">不限日期</option>
            <option value="today">今天</option>
            <option value="7d">近 7 天</option>
            <option value="30d">近 30 天</option>
            <option value="custom">自定义…</option>
          </select>
          {f.range === 'custom' && (
            <>
              <input
                type="date"
                className="input"
                style={{ width: 140 }}
                value={f.from}
                max={f.to || undefined}
                onChange={(e) => set({ from: e.target.value })}
                aria-label="开始日期"
              />
              <span className="faint">至</span>
              <input
                type="date"
                className="input"
                style={{ width: 140 }}
                value={f.to}
                min={f.from || undefined}
                onChange={(e) => set({ to: e.target.value })}
                aria-label="结束日期"
              />
            </>
          )}
        </div>
        <label className="filter-check">
          <input type="checkbox" checked={f.topOnly} onChange={(e) => set({ topOnly: e.target.checked })} /> 只看主任务
        </label>
        <label className="filter-check">
          <input type="checkbox" checked={f.showArchived} onChange={(e) => set({ showArchived: e.target.checked })} /> 显示已归档
        </label>
        {f.showArchived && (
          <select
            className="select"
            style={{ width: 112 }}
            value={f.archiveKind}
            onChange={(e) => set({ archiveKind: e.target.value as Filters['archiveKind'] })}
            aria-label="归档方式"
          >
            <option value="">全部归档</option>
            <option value="manual">手动归档</option>
            <option value="auto">自动归档</option>
          </select>
        )}
        <span className="filter-count faint">
          {active ? `${filtered.length} / ${total} 个任务` : `${filtered.length} 个任务`}
        </span>
        {active && (
          <button className="btn small" onClick={() => setF({ ...EMPTY, showArchived: f.showArchived })}>
            清除筛选
          </button>
        )}
      </div>
      {view === 'graph' ? (
        <Graph tasks={filtered} />
      ) : (
        <div className="board">
          {columns.map((col) => {
            const items = filtered
              .filter((t) => t.status === col.status)
              .sort((a, b) => a.priority.localeCompare(b.priority) || b.updated_at.localeCompare(a.updated_at));
            return (
              <section
                key={col.status}
                className={`column ${items.length ? '' : 'col-empty'} ${dragging ? (dropAction(dragging, col.status) ? 'droppable' : dragging.status === col.status ? '' : 'no-drop') : ''} ${over === col.status ? 'over' : ''}`}
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
                    draggable={!['completed', 'archived'].includes(t.status)}
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
                        {t.parent ? ` · 子任务` : children.get(t.id) ? ` · ${children.get(t.id)} 个子任务` : ''}
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
                      {t.archive_kind ? (
                        <span className={`badge archive-${t.archive_kind}`} title={t.archived_at ? `归档于 ${timeAgo(t.archived_at)}` : undefined}>
                          {t.archive_kind === 'auto' ? '自动归档' : '手动归档'}
                        </span>
                      ) : (
                        <span>{timeAgo(t.updated_at)}</span>
                      )}
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
                      : await act(t, 'cancel', { reason: text || undefined }, '已归档');
                if (ok) setPending(null);
              }}
            >
              {pending.dialog === 'assign' ? '指派' : pending.dialog === 'reject' ? '退回' : '确认归档'}
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
