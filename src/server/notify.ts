// 外部通知：把负责人关心的事件推送到钉钉群机器人。
// 几秒内的多条事件合并成一条消息，避免触发钉钉每分钟 20 条的限流。
import { createHmac } from 'node:crypto';
import type { Db } from './db.js';
import { json } from './db.js';
import { HubError, type Hub } from './hub.js';
import type { HubEvent } from '../shared/model.js';

export const NOTIFY_KINDS = ['dingtalk'] as const;

/** 可订阅的事件类别 */
export const NOTIFY_TOPICS: Record<string, string> = {
  review: '提交待验收',
  blocked: '任务阻塞',
  message: '@负责人 与私信',
  overdue: '任务逾期',
  lost: '任务可能失联',
  offline: 'Agent 下线',
  done: '任务验收通过',
};

const DEFAULT_TOPICS = ['review', 'blocked', 'message', 'overdue', 'lost', 'offline'];

export function topicOf(e: HubEvent): string | null {
  const to = e.data.to;
  if (e.type === 'task.status_changed') {
    if (to === 'review') return 'review';
    if (to === 'input_required') return 'blocked';
    if (to === 'completed') return 'done';
    return null;
  }
  if ((e.type === 'mention' || e.type === 'message.direct') && e.audience?.length === 0) return 'message';
  if (e.type === 'task.overdue') return 'overdue';
  if (e.type === 'task.lease_expiring') return 'lost';
  if (e.type === 'agent.offline') return 'offline';
  return null;
}

interface ChannelRow {
  id: number;
  kind: string;
  name: string;
  webhook: string;
  secret: string;
  topics: string;
  projects: string;
  console_url: string;
  enabled: number;
  last_error: string;
  last_sent_at: string | null;
  created_at: string;
}

export interface ChannelView {
  id: number;
  kind: string;
  name: string;
  /** 只显示地址开头，避免令牌泄露 */
  webhook_masked: string;
  has_secret: boolean;
  topics: string[];
  projects: string[];
  console_url: string;
  enabled: boolean;
  last_error: string;
  last_sent_at: string | null;
}

export interface ChannelInput {
  name?: string;
  kind?: string;
  webhook?: string;
  secret?: string;
  topics?: string[];
  projects?: string[];
  console_url?: string;
  enabled?: boolean;
}

const invalid = (msg: string) => new HubError(400, 'invalid', msg);

function mask(url: string) {
  return url.replace(/(access_token=)([^&]{6})[^&]*/, '$1$2…');
}

/** 钉钉加签：timestamp + "\n" + secret 做 HmacSHA256，再 base64 */
export function dingtalkUrl(webhook: string, secret: string, now = Date.now()) {
  if (!secret) return webhook;
  const sign = createHmac('sha256', secret).update(`${now}\n${secret}`).digest('base64');
  return `${webhook}${webhook.includes('?') ? '&' : '?'}timestamp=${now}&sign=${encodeURIComponent(sign)}`;
}

export class Notifier {
  private pending = new Map<number, HubEvent[]>();
  private timers = new Map<number, NodeJS.Timeout>();
  private readonly onEvent = (e: HubEvent) => this.route(e);

  constructor(
    private hub: Hub,
    private db: Db,
    private opts: { delayMs?: number; fetch?: typeof fetch } = {},
  ) {}

  start() {
    this.hub.bus.on('event', this.onEvent);
  }

  stop() {
    this.hub.bus.off('event', this.onEvent);
    for (const t of this.timers.values()) clearTimeout(t);
  }

  // ───────────── 管理 ─────────────

  list(): ChannelView[] {
    return (this.db.prepare('SELECT * FROM notify_channels ORDER BY id').all() as unknown as ChannelRow[]).map((r) => this.view(r));
  }

  create(input: ChannelInput): ChannelView {
    const v = this.validate(input, null);
    const r = this.db
      .prepare(
        `INSERT INTO notify_channels (kind, name, webhook, secret, topics, projects, console_url, enabled, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
      )
      .run(v.kind, v.name, v.webhook, v.secret, JSON.stringify(v.topics), JSON.stringify(v.projects), v.console_url, v.enabled ? 1 : 0, new Date().toISOString());
    return this.get(Number(r.lastInsertRowid));
  }

  update(id: number, input: ChannelInput): ChannelView {
    const row = this.row(id);
    const v = this.validate(input, row);
    this.db
      .prepare('UPDATE notify_channels SET name = ?, webhook = ?, secret = ?, topics = ?, projects = ?, console_url = ?, enabled = ? WHERE id = ?')
      .run(v.name, v.webhook, v.secret, JSON.stringify(v.topics), JSON.stringify(v.projects), v.console_url, v.enabled ? 1 : 0, id);
    return this.get(id);
  }

  remove(id: number) {
    this.row(id);
    this.db.prepare('DELETE FROM notify_channels WHERE id = ?').run(id);
    return { ok: true };
  }

  /** 发一条测试消息，返回钉钉的结果 */
  async test(id: number) {
    const row = this.row(id);
    const err = await this.post(row, '协作中枢：测试消息', '#### 协作中枢已连接\n\n这是一条测试消息。之后负责人需要关注的事件会推送到这里。');
    if (err) throw new HubError(502, 'notify_failed', `发送失败：${err}`);
    return { ok: true };
  }

  // ───────────── 推送 ─────────────

  private route(e: HubEvent) {
    const topic = topicOf(e);
    if (!topic) return;
    const rows = this.db.prepare('SELECT * FROM notify_channels WHERE enabled = 1').all() as unknown as ChannelRow[];
    for (const r of rows) {
      if (!json<string[]>(r.topics, []).includes(topic)) continue;
      const projects = json<string[]>(r.projects, []);
      if (projects.length && e.project && !projects.includes(e.project)) continue;
      const list = this.pending.get(r.id) ?? [];
      list.push(e);
      this.pending.set(r.id, list);
      if (!this.timers.has(r.id)) {
        const t = setTimeout(() => void this.flush(r.id), this.opts.delayMs ?? 5000);
        t.unref?.();
        this.timers.set(r.id, t);
      }
    }
  }

  async flush(id: number) {
    this.timers.delete(id);
    const events = this.pending.get(id) ?? [];
    this.pending.delete(id);
    if (!events.length) return;
    const row = this.db.prepare('SELECT * FROM notify_channels WHERE id = ?').get(id) as ChannelRow | undefined;
    if (!row || !row.enabled) return;
    const { title, text } = renderMessage(events, row.console_url);
    await this.post(row, title, text);
  }

  private async post(row: ChannelRow, title: string, text: string): Promise<string | null> {
    let error = '';
    try {
      const res = await (this.opts.fetch ?? fetch)(dingtalkUrl(row.webhook, row.secret), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { title, text } }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string };
      if (!res.ok) error = `HTTP ${res.status}`;
      else if (body.errcode) error = `钉钉返回 ${body.errcode}：${body.errmsg ?? ''}`;
    } catch (err) {
      error = (err as Error).message;
    }
    this.db
      .prepare('UPDATE notify_channels SET last_error = ?, last_sent_at = CASE WHEN ? = \'\' THEN ? ELSE last_sent_at END WHERE id = ?')
      .run(error, error, new Date().toISOString(), row.id);
    if (error) console.error(`钉钉通知「${row.name}」发送失败：${error}`);
    return error || null;
  }

  // ───────────── 内部 ─────────────

  private row(id: number): ChannelRow {
    const r = this.db.prepare('SELECT * FROM notify_channels WHERE id = ?').get(id) as ChannelRow | undefined;
    if (!r) throw new HubError(404, 'not_found', `找不到通知渠道 ${id}`);
    return r;
  }

  private get(id: number) {
    return this.view(this.row(id));
  }

  private view(r: ChannelRow): ChannelView {
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      webhook_masked: mask(r.webhook),
      has_secret: !!r.secret,
      topics: json<string[]>(r.topics, []),
      projects: json<string[]>(r.projects, []),
      console_url: r.console_url,
      enabled: !!r.enabled,
      last_error: r.last_error,
      last_sent_at: r.last_sent_at,
    };
  }

  private validate(input: ChannelInput, prev: ChannelRow | null) {
    const kind = input.kind ?? prev?.kind ?? 'dingtalk';
    if (!(NOTIFY_KINDS as readonly string[]).includes(kind)) throw invalid('目前只支持钉钉机器人（dingtalk）');
    const name = (input.name ?? prev?.name ?? '').trim() || '钉钉群';
    const webhook = (input.webhook ?? prev?.webhook ?? '').trim();
    if (!/^https?:\/\/\S+$/.test(webhook)) throw invalid('请填写机器人的 Webhook 地址，形如 https://oapi.dingtalk.com/robot/send?access_token=…');
    // 留空表示不改；传 null 或空串的显式清除用 secret: '-'
    const secret = input.secret === undefined || input.secret === '' ? (prev?.secret ?? '') : input.secret === '-' ? '' : input.secret.trim();
    const topics = (input.topics ?? json<string[]>(prev?.topics, DEFAULT_TOPICS)).filter((t) => t in NOTIFY_TOPICS);
    if (!topics.length) throw invalid('至少选择一类要推送的事件');
    const projects = (input.projects ?? json<string[]>(prev?.projects, [])).map((p) => p.toUpperCase());
    const console_url = (input.console_url ?? prev?.console_url ?? '').trim().replace(/\/+$/, '');
    const enabled = input.enabled ?? (prev ? !!prev.enabled : true);
    return { kind, name, webhook, secret, topics, projects, console_url, enabled };
  }
}

const TOPIC_ICONS: Record<string, string> = {
  review: '📝',
  blocked: '⛔',
  message: '💬',
  overdue: '⏰',
  lost: '⚠️',
  offline: '🔌',
  done: '✅',
};

/** 合并成一条钉钉 Markdown 消息 */
export function renderMessage(events: HubEvent[], consoleUrl: string) {
  const link = (e: HubEvent) => {
    if (!consoleUrl) return '';
    if (e.task) return ` [查看](${consoleUrl}/#/board/${e.task})`;
    if (e.type === 'message.direct') return ` [查看](${consoleUrl}/#/messages)`;
    if (e.type === 'agent.offline') return ` [查看](${consoleUrl}/#/agents)`;
    return '';
  };
  const shown = events.slice(-10);
  const first = shown[0];
  const title =
    events.length === 1 ? `协作中枢：${NOTIFY_TOPICS[topicOf(first)!]}` : `协作中枢：${events.length} 条新动态`;
  const lines = shown.map((e) => `- ${TOPIC_ICONS[topicOf(e)!] ?? ''} ${e.summary.replace(/\n+/g, ' ').slice(0, 200)}${link(e)}`);
  if (events.length > shown.length) lines.unshift(`- ……前面还有 ${events.length - shown.length} 条，见控制台实时动态`);
  return { title, text: `#### ${title}\n\n${lines.join('\n')}` };
}
