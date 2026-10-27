import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import type { Agent, HubEvent, Presence, Project, Task } from './api';

export interface HubCtx {
  projects: Project[];
  project: string | null; // null = 全部项目
  setProject: (p: string | null) => void;
  agents: Agent[];
  tick: number; // 每收到一个事件 +1，页面据此刷新
  events: HubEvent[]; // 最近的实时事件
  refresh: () => void;
  toast: (msg: string, error?: boolean) => void;
  openTask: (id: string) => void;
  go: (page: string) => void;
}

export const Ctx = createContext<HubCtx>(null as unknown as HubCtx);
export const useHub = () => useContext(Ctx);

/** 拉取数据，并在实时事件到来时自动刷新。 */
export function useData<T>(load: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; reload: () => void } {
  const { tick } = useHub();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    load()
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, reload };
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '从未';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

const span = (ms: number) =>
  ms >= 86400_000 ? `${Math.floor(ms / 86400_000)} 天` : ms >= 3600_000 ? `${Math.floor(ms / 3600_000)} 小时` : `${Math.max(1, Math.floor(ms / 60_000))} 分钟`;

/** 完整日期时间，如 11月1日 18:00 */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/** 截止时间的提示：逾期标红，24 小时内到期标黄；已结束或待验收的任务只显示日期。 */
export function dueInfo(t: { due_at: string | null; status: string }): { text: string; cls: '' | 'warn' | 'bad'; title: string } | null {
  if (!t.due_at) return null;
  const title = `截止：${dateTime(t.due_at)}`;
  if (!['open', 'assigned', 'working', 'input_required'].includes(t.status)) return { text: `${clock(t.due_at)} 截止`, cls: '', title };
  const left = new Date(t.due_at).getTime() - Date.now();
  if (left < 0) return { text: `逾期 ${span(-left)}`, cls: 'bad', title };
  if (left < 86400_000) return { text: `剩 ${span(left)}`, cls: 'warn', title };
  return { text: `${clock(t.due_at)} 截止`, cls: '', title };
}

/** ISO 转成 datetime-local 输入框的值 */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const PRESENCE_LABEL: Record<Presence, string> = { online: '在线', active: '活跃', idle: '空闲', offline: '离线' };

export function presence(a: Agent): Presence {
  return a.status === 'active' ? a.presence : 'offline';
}

export const PLATFORM_LABEL: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
  other: '其他',
};

export function StatusBadge({ task }: { task: Task }) {
  const cls =
    task.status === 'completed'
      ? 'good'
      : task.status === 'input_required'
        ? 'bad'
        : task.status === 'review'
          ? 'warn'
          : task.status === 'working'
            ? 'accent'
            : '';
  return <span className={`badge ${cls}`}>{task.status_label}</span>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn small"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => undefined,
        );
      }}
    >
      {done ? '已复制' : label}
    </button>
  );
}

export function CodeBox({ text }: { text: string }) {
  return (
    <div className="code-box">
      <pre>{text}</pre>
      <CopyButton text={text} />
    </div>
  );
}

export function agentLabel(agents: Agent[], code: string | null): string {
  if (!code) return '—';
  if (code === 'owner') return '负责人';
  const a = agents.find((x) => x.id === code);
  return a ? `${a.name}` : code;
}

export const splitList = (s: string) =>
  s
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
