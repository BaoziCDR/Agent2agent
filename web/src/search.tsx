import { type ReactNode, useEffect, useRef, useState } from 'react';
import { type Agent, get, type Task } from './api';
import { StatusBadge, clock, useHub } from './ui';

interface Hit {
  id: number;
  task: string | null;
  title: string | null;
  who: string;
  text: string;
  at: string;
}

interface Result {
  query: string;
  tasks: Task[];
  comments: Hit[];
  messages: Hit[];
  agents: Agent[];
}

type Row = { key: string; group: string; go: () => void; body: ReactNode };

/** 关键字高亮 */
function Mark({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** 顶栏的搜索入口：点击或按 Ctrl/⌘+K 打开搜索面板。 */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <>
      <button className="search-trigger" onClick={() => setOpen(true)} aria-label="搜索">
        <span aria-hidden>⌕</span>
        <span className="search-trigger-text">搜索任务、评论、私信</span>
        <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      {open && <SearchPanel onClose={() => setOpen(false)} />}
    </>
  );
}

function SearchPanel({ onClose }: { onClose: () => void }) {
  const { project, openTask, go } = useHub();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<Result | null>(null);
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const kw = q.trim();
    if (!kw) return setRes(null);
    let stale = false;
    const t = setTimeout(async () => {
      try {
        const r = await get<Result>(`/search?q=${encodeURIComponent(kw)}${project ? `&project=${project}` : ''}`);
        if (!stale) (setRes(r), setSel(0));
      } catch {
        // 网络错误时保留上一次结果
      }
    }, 180);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [q, project]);

  const done = (fn: () => void) => () => (onClose(), fn());
  const kw = res?.query ?? '';
  const rows: Row[] = res
    ? [
        ...res.tasks.map((t) => ({
          key: `t${t.id}`,
          group: '任务',
          go: done(() => openTask(t.id)),
          body: (
            <>
              <StatusBadge task={t} />
              <div className="search-main">
                <div>
                  <b>{t.id}</b> <Mark text={t.title} q={kw} />
                </div>
                <div className="faint">{[t.assignee_name, t.progress_note].filter(Boolean).join(' · ') || '未指派'}</div>
              </div>
            </>
          ),
        })),
        ...res.comments.map((c) => ({
          key: `c${c.id}`,
          group: '评论',
          go: done(() => c.task && openTask(c.task)),
          body: (
            <div className="search-main">
              <div>
                <Mark text={c.text} q={kw} />
              </div>
              <div className="faint">
                {c.who} · {c.task}「{c.title}」 · {clock(c.at)}
              </div>
            </div>
          ),
        })),
        ...res.messages.map((m) => ({
          key: `m${m.id}`,
          group: '私信',
          go: done(() => go('messages')),
          body: (
            <div className="search-main">
              <div>
                <Mark text={m.text} q={kw} />
              </div>
              <div className="faint">
                {m.who} · {clock(m.at)}
              </div>
            </div>
          ),
        })),
        ...res.agents.map((a) => ({
          key: `a${a.id}`,
          group: 'Agent',
          go: done(() => go('agents')),
          body: (
            <div className="search-main">
              <div>
                <b>
                  <Mark text={a.name} q={kw} />
                </b>{' '}
                <span className="faint">{a.id}</span>
              </div>
            </div>
          ),
        })),
      ]
    : [];

  useEffect(() => {
    list.current?.querySelector('.search-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  return (
    <div className="modal-mask search-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="search-panel" role="dialog" aria-label="搜索">
        <input
          className="input search-input"
          autoFocus
          placeholder={`搜索${project ? ` ${project} 的` : ''}任务编号、标题、描述、笔记、评论、私信…`}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Escape') return onClose();
            if (!rows.length) return;
            if (e.key === 'ArrowDown') return e.preventDefault(), setSel((sel + 1) % rows.length);
            if (e.key === 'ArrowUp') return e.preventDefault(), setSel((sel - 1 + rows.length) % rows.length);
            if (e.key === 'Enter') return e.preventDefault(), rows[Math.min(sel, rows.length - 1)].go();
          }}
        />
        <div className="search-results" ref={list}>
          {!q.trim() && <div className="empty">输入关键字，或直接输入任务编号如 P1-T3</div>}
          {res && rows.length === 0 && <div className="empty">没有找到「{res.query}」</div>}
          {rows.map((r, i) => (
            <div key={r.key}>
              {(i === 0 || rows[i - 1].group !== r.group) && <div className="search-group">{r.group}</div>}
              <div className={`search-row ${i === sel ? 'active' : ''}`} onMouseEnter={() => setSel(i)} onClick={r.go}>
                {r.body}
              </div>
            </div>
          ))}
        </div>
        <div className="search-foot faint">↑↓ 选择 · Enter 打开 · Esc 关闭</div>
      </div>
    </div>
  );
}
