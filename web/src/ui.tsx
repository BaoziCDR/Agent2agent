import { Component, createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { type Agent, eventSummary, get, type HubEvent, type Presence, type Project, type Receipt, type Task } from './api';
import { ownerSummary } from '../../src/shared/event-view';
import { STATUS_LABELS } from '../../src/shared/model';
import { langTag, msg, t } from './i18n';

/** 短时间内到达的一批事件，合并成一次刷新 */
export interface EventBatch {
  id: number;
  events: HubEvent[];
}

export interface HubCtx {
  projects: Project[];
  project: string | null; // null = 全部项目
  setProject: (p: string | null) => void;
  agents: Agent[];
  tick: number; // 操作之后、断线重连之后 +1，所有页面都重新拉取
  batch: EventBatch; // 最新一批实时事件，页面按需决定要不要刷新
  events: HubEvent[]; // 最近的实时事件
  refresh: () => void;
  toast: (msg: string, error?: boolean) => void;
  /** 打开任务详情；anchor 定位到某个分页或某条评论，如 discussion、progress、artifacts */
  openTask: (id: string, anchor?: string) => void;
  /** 打开一条事件对应的位置（评论、私信、agent 等） */
  openEvent: (e: HubEvent) => void;
  /** 地址里带的定位，如 comment-12；页面据此滚动并高亮 */
  anchor: string | null;
  go: (page: string) => void;
  /** 切换界面语言；null 表示跟随浏览器 */
  onLang: (code: string | null) => void;
}

export const Ctx = createContext<HubCtx>(null as unknown as HubCtx);
export const useHub = () => useContext(Ctx);

/**
 * 拉取数据，并在实时事件到来时自动刷新。
 * 数据大、事件多的页面传 refreshOn，只为真正影响显示内容的事件重新拉取；不传时任何事件都刷新。
 */
export function useData<T>(
  load: () => Promise<T>,
  deps: unknown[],
  opts?: { refreshOn?: (e: HubEvent, data: T | null) => boolean },
): { data: T | null; error: string | null; reload: () => void } {
  const { tick, batch } = useHub();
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
  const seenBatch = useRef(batch.id);
  useEffect(() => {
    if (batch.id === seenBatch.current) return;
    seenBatch.current = batch.id;
    if (!opts?.refreshOn || batch.events.some((e) => opts.refreshOn!(e, data))) setN((x) => x + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data, error, reload };
}

/**
 * 防重入：run(fn) 在上一次没结束前再调用直接忽略；busy 用来禁用按钮、显示转圈。
 * 用法：const [busy, run] = useBusy(); <button disabled={busy} aria-busy={busy} onClick={() => run(save)}>
 */
export function useBusy() {
  const [doing, run] = useBusyKey();
  return [doing !== null, useCallback(<T,>(fn: () => Promise<T>) => run('', fn), [run])] as const;
}

/** 同上，但一组按钮共用：doing 是正在进行的那一个的标识，用来只在被点的按钮上转圈，其他按钮一起禁用 */
export function useBusyKey() {
  const [doing, setDoing] = useState<string | null>(null);
  const running = useRef(false);
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setDoing(key);
    try {
      return await fn();
    } finally {
      running.current = false;
      setDoing(null);
    }
  }, []);
  return [doing, run] as const;
}

/** 滚到地址里定位的元素（data-anchor）并高亮。data 为空或目标还没出现时不动，等下一次数据刷新再试。 */
export function useJumpTo(anchor: string | null, data: unknown) {
  const marked = useRef<Element | null>(null);
  useEffect(() => {
    if (!anchor || !data || marked.current) return;
    const el = document.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`);
    if (!el) return;
    marked.current = el;
    el.classList.add('jump-target');
    el.scrollIntoView({ block: 'center' });
  }, [anchor, data]);
  useEffect(
    () => () => {
      marked.current?.classList.remove('jump-target');
      marked.current = null;
    },
    [anchor],
  );
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return t('从未');
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t('刚刚');
  if (diff < 3600) return t('{n} 分钟前', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('{n} 小时前', { n: Math.floor(diff / 3600) });
  return t('{n} 天前', { n: Math.floor(diff / 86400) });
}

const RECEIPT: Record<Receipt['state'], { icon: string; label: string }> = {
  working: { icon: '👌', label: msg('处理中') },
  done: { icon: '✅', label: msg('已处理') },
  failed: { icon: '⚠️', label: msg('处理失败') },
  stopped: { icon: '⏸', label: msg('处理中断') },
};

/** 消息下面一排小标签：哪个 agent 接手了、处理到哪一步，像聊天软件里的表情回应。 */
export function Receipts({ list }: { list: Receipt[] | undefined }) {
  if (!list?.length) return null;
  return (
    <div className="receipts">
      {list.map((r) => {
        const s = RECEIPT[r.state] ?? RECEIPT.working;
        return (
          <span
            key={r.agent}
            className={`receipt ${r.state}`}
            title={`${r.agent_name} (${r.agent}) ${t(s.label)} · ${clock(r.updated_at)}${r.note ? `\n${r.note}` : ''}`}
          >
            <span aria-label={t(s.label)}>{s.icon}</span> {r.agent_name}
          </span>
        );
      })}
    </div>
  );
}

export function clock(iso: string): string {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toLocaleTimeString(langTag(), { hour: '2-digit', minute: '2-digit', hour12: false });
  return today ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

const span = (ms: number) =>
  ms >= 86400_000
    ? t('{n} 天', { n: Math.floor(ms / 86400_000) })
    : ms >= 3600_000
      ? t('{n} 小时', { n: Math.floor(ms / 3600_000) })
      : t('{n} 分钟', { n: Math.max(1, Math.floor(ms / 60_000)) });

/** 完整日期时间，如 11月1日 18:00（英文为 Nov 1, 18:00） */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(langTag(), { year: sameYear ? undefined : 'numeric', month: langTag() === 'zh-CN' ? 'numeric' : 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 任务状态的显示名：按状态枚举翻译，不用 Hub 返回的中文 status_label */
export const statusLabel = (status: string) => t(STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status);

/** 截止时间的提示：逾期标红，24 小时内到期标黄；已结束或待验收的任务只显示日期。 */
export function dueInfo(task: { due_at: string | null; status: string }): { text: string; cls: '' | 'warn' | 'bad'; title: string } | null {
  if (!task.due_at) return null;
  const title = t('截止：{time}', { time: dateTime(task.due_at) });
  if (!['open', 'assigned', 'working', 'input_required'].includes(task.status)) return { text: t('{time} 截止', { time: clock(task.due_at) }), cls: '', title };
  const left = new Date(task.due_at).getTime() - Date.now();
  if (left < 0) return { text: t('逾期 {span}', { span: span(-left) }), cls: 'bad', title };
  if (left < 86400_000) return { text: t('剩 {span}', { span: span(left) }), cls: 'warn', title };
  return { text: t('{time} 截止', { time: clock(task.due_at) }), cls: '', title };
}

/** ISO 转成 datetime-local 输入框的值 */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const PRESENCE_LABELS: Record<Presence, string> = { online: msg('在线'), active: msg('活跃'), idle: msg('空闲'), offline: msg('离线') };
export const presenceLabel = (p: Presence) => t(PRESENCE_LABELS[p]);

export function presence(a: Agent): Presence {
  return a.status === 'active' ? a.presence : 'offline';
}

export const PLATFORM_LABEL: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
  other: msg('其他'),
};
export const platformLabel = (p: string) => t(PLATFORM_LABEL[p] ?? p);

export function StatusBadge({ task }: { task: Pick<Task, 'status' | 'status_label'> }) {
  const cls =
    task.status === 'completed'
      ? 'good'
      : task.status === 'input_required'
        ? 'bad'
        : task.status === 'review'
          ? 'warn'
          : task.status === 'working'
            ? 'accent'
            : task.status === 'archived'
              ? 'muted'
              : '';
  return <span className={`badge ${cls}`}>{statusLabel(task.status)}</span>;
}

/** 一块内容渲染出错时只影响这一块，不让整个控制台白屏。用 key 区分内容，换内容时自动恢复。 */
export class ErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

/** 复制到剪贴板。局域网里用 http 打开控制台时 navigator.clipboard 不可用，退回到 execCommand。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 退回到下面的方式
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn small"
      type="button"
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }
      }}
    >
      {done ? t('已复制') : (label ?? t('复制'))}
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
  if (code === 'owner') return t('负责人');
  const a = agents.find((x) => x.id === code);
  return a ? `${a.name}` : code;
}

/** 控制台显示的事件摘要：读者是负责人，发给某个 agent 的「你」要换成它的名字 */
export const ownerEventSummary = (e: HubEvent, agents: Agent[]) => ownerSummary(eventSummary(e), e, (code) => agentLabel(agents, code));

export const splitList = (s: string) =>
  s
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

let tagCache: Promise<{ presets: string[]; in_use: string[] }> | null = null;
/** 预设标签和在用的标签；设置页改了预设后调用 resetTagOptions() 刷新 */
export const resetTagOptions = () => (tagCache = null);

/** 能力标签输入：点选预设标签和在用的标签，也可以直接输入自定义的（逗号分隔） */
export function TagPicker({ id, value, onChange, placeholder }: { id?: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [opts, setOpts] = useState<{ presets: string[]; in_use: string[] } | null>(null);
  useEffect(() => {
    tagCache ??= get<{ presets: string[]; in_use: string[] }>('/tags').catch(() => ({ presets: [], in_use: [] }));
    void tagCache.then(setOpts);
  }, []);
  const picked = splitList(value);
  const toggle = (t: string) => onChange((picked.includes(t) ? picked.filter((x) => x !== t) : [...picked, t]).join(', '));
  const all = [...(opts?.presets ?? []), ...(opts?.in_use ?? [])];
  const custom = picked.filter((t) => !all.includes(t));
  return (
    <div className="tag-picker">
      {all.length > 0 && (
        <div className="tag-options">
          {[...all, ...custom].map((t) => (
            <button type="button" key={t} className={`tag-option${picked.includes(t) ? ' on' : ''}`} aria-pressed={picked.includes(t)} onClick={() => toggle(t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      <input id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder ?? t('点选上面的标签，或输入自定义标签，用逗号分隔')} />
    </div>
  );
}
