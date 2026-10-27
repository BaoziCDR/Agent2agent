import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { type Db, json, tx } from './db.js';
import {
  type EventType,
  type HubEvent,
  type Part,
  type Presence,
  type Priority,
  type TaskStatus,
  type Tier,
  ACTIVE_STATUSES,
  LEASE_MINUTES,
  PRESENCE_LABELS,
  PRIORITIES,
  STATUS_LABELS,
  TIERS,
} from '../shared/model.js';

export class HubError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const notFound = (what: string) => new HubError(404, 'not_found', `找不到${what}`);
const forbidden = (msg: string) => new HubError(403, 'forbidden', msg);
const conflict = (msg: string) => new HubError(409, 'conflict', msg);
const invalid = (msg: string) => new HubError(400, 'invalid', msg);

export type Actor = { kind: 'owner' } | { kind: 'agent'; agent: AgentRow };

export interface AgentRow {
  id: number;
  name: string;
  platform: string;
  tier: Tier;
  description: string;
  skills: string;
  token_hash: string;
  status: string;
  ack_seq: number;
  created_at: string;
  last_seen_at: string | null;
  presence: 'on' | 'off';
}

interface ProjectRow {
  id: number;
  name: string;
  description: string;
  status: string;
  task_counter: number;
  created_at: string;
}

interface TaskRow {
  id: number;
  project_id: number;
  num: number;
  title: string;
  description: string;
  acceptance: string;
  status: TaskStatus;
  priority: Priority;
  assignee_id: number | null;
  created_by: string;
  parent_id: number | null;
  depends_on: string;
  required_tags: string;
  progress: number;
  progress_note: string;
  notes: string;
  block_reason: string;
  lease_until: string | null;
  lease_warned: number;
  due_warned: number;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

interface EventRow {
  seq: number;
  type: EventType;
  at: string;
  actor: string;
  project_id: number | null;
  task_id: number | null;
  audience: string | null;
  data: string;
  summary: string;
}

export interface AgentView {
  id: string;
  name: string;
  platform: string;
  tier: Tier;
  description: string;
  skills: string[];
  status: string;
  created_at: string;
  last_seen_at: string | null;
  online: boolean;
  presence: Presence;
  presence_label: string;
  /** ahub run 守护进程最近一次上报的状态，如「正在处理 P1-T3」 */
  activity: { state: string; note: string; at: string } | null;
  projects: { id: string; name: string; tags: string[] }[];
  active_tasks: string[];
}

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  status: string;
  created_at: string;
  counts: Record<TaskStatus, number>;
  members: number;
}

export interface TaskView {
  id: string;
  project: string;
  title: string;
  description: string;
  acceptance: string[];
  status: TaskStatus;
  status_label: string;
  priority: Priority;
  assignee: string | null;
  assignee_name: string | null;
  created_by: string;
  parent: string | null;
  depends_on: string[];
  required_tags: string[];
  progress: number;
  progress_note: string;
  notes: string;
  block_reason: string;
  lease_until: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface TaskDetail extends TaskView {
  subtasks: TaskView[];
  comments: { id: number; author: string; author_name: string; parts: Part[]; created_at: string }[];
  artifacts: { id: number; author: string; name: string; parts: Part[]; created_at: string }[];
  progress_log: { author: string; percent: number; note: string; created_at: string }[];
}

export interface InboxResult {
  agent: string;
  ack_seq: number;
  last_seq: number;
  more: boolean;
  events: HubEvent[];
  needs_action: HubEvent[];
  my_tasks: TaskView[];
  pending_assignments: TaskView[];
  claimable: TaskView[];
  projects: { id: string; name: string }[];
  /** 长轮询等待落空时给 agent 的提示；skipped 表示这次没有真正等待就直接返回了 */
  wait?: { skipped: boolean; hint: string };
}

export const projectCode = (id: number) => `P-${id}`;
export const agentCode = (id: number) => `A-${id}`;
export const taskCode = (projectId: number, num: number) => `P${projectId}-T${num}`;

function parseId(code: string, prefix: string): number | null {
  const m = new RegExp(`^${prefix}-?(\\d+)$`, 'i').exec(code.trim());
  return m ? Number(m[1]) : null;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = (prefix: string) => `${prefix}_${randomBytes(24).toString('base64url')}`;

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newInviteCode(): string {
  let s = '';
  for (let i = 0; i < 6; i++) s += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return `${s.slice(0, 3)}-${s.slice(3)}`;
}

const MENTION_RE = /@(A-\d+|负责人|owner)/gi;

export interface HubOptions {
  now?: () => Date;
  /** 多久没有任何请求算离线（分钟），默认 120 */
  offlineAfterMinutes?: number;
  /** 实时连接断开后多久算离线（分钟），默认 2；给守护进程留出重连时间 */
  streamGraceMinutes?: number;
}

const ACTIVE_MINUTES = 10;

export class Hub {
  readonly bus = new EventEmitter();
  private pending: HubEvent[] = [];
  private now: () => Date;
  /** agent id → 当前打开的 SSE 连接和挂起的长轮询数量 */
  private live = new Map<number, number>();
  /** agent id → 最后一条 SSE 连接断开的时间（毫秒） */
  private streamLostAt = new Map<number, number>();
  /** agent id → 守护进程上报的当前状态 */
  private activity = new Map<number, { state: string; note: string; at: string }>();
  private daemons = new Map<number, number>();
  private emptyWaits = new Map<number, { n: number; at: number }>();
  private offlineAfterMs: number;
  private streamGraceMs: number;

  constructor(
    readonly db: Db,
    opts: HubOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.offlineAfterMs = (opts.offlineAfterMinutes ?? 120) * 60_000;
    this.streamGraceMs = (opts.streamGraceMinutes ?? 2) * 60_000;
    this.bus.setMaxListeners(0);
  }

  private iso(offsetMinutes = 0) {
    return new Date(this.now().getTime() + offsetMinutes * 60_000).toISOString();
  }

  /** 在事务里执行，提交后再广播事件，保证订阅者看到的事件都已落盘。 */
  private write<T>(fn: () => T): T {
    this.pending = [];
    let result: T;
    try {
      result = tx(this.db, fn);
    } catch (err) {
      this.pending = [];
      throw err;
    }
    const events = this.pending;
    this.pending = [];
    for (const e of events) this.bus.emit('event', e);
    return result;
  }

  // ───────────── 负责人 ─────────────

  /** 首次启动时生成负责人令牌；已存在时返回 null。 */
  ensureOwnerToken(preset?: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'owner_token_hash'").get() as
      | { value: string }
      | undefined;
    if (preset) {
      this.db
        .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('owner_token_hash', ?)")
        .run(hashToken(preset));
      return null;
    }
    if (row) return null;
    const token = newToken('owner');
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('owner_token_hash', ?)").run(hashToken(token));
    return token;
  }

  resetOwnerToken(): string {
    const token = newToken('owner');
    this.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('owner_token_hash', ?)")
      .run(hashToken(token));
    return token;
  }

  isOwnerToken(token: string): boolean {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'owner_token_hash'").get() as
      | { value: string }
      | undefined;
    return !!row && row.value === hashToken(token);
  }

  authAgent(token: string): AgentRow | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE token_hash = ?').get(hashToken(token)) as
      | AgentRow
      | undefined;
    if (!row || row.status !== 'active') return null;
    return row;
  }

  /** 记录 agent 出现；如果之前已判定离线，通知负责人它回来了。 */
  touchAgent(agent: AgentRow) {
    const now = this.iso();
    if (agent.presence === 'off') {
      this.write(() => {
        this.db.prepare("UPDATE agents SET last_seen_at = ?, presence = 'on' WHERE id = ?").run(now, agent.id);
        this.emit('agent.online', agentCode(agent.id), {
          audience: [],
          data: { agent: agentCode(agent.id) },
          summary: `${agent.name}（${agentCode(agent.id)}）上线了`,
        });
      });
      agent.presence = 'on';
    } else {
      this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(now, agent.id);
    }
    agent.last_seen_at = now;
  }

  /** 实时连接计数。kind 为 stream 时，最后一条连接断开后超过宽限期即判定离线。 */
  markLive(agentId: number, delta: 1 | -1, kind: 'stream' | 'poll' = 'poll') {
    const n = (this.live.get(agentId) ?? 0) + delta;
    if (n <= 0) this.live.delete(agentId);
    else this.live.set(agentId, n);
    if (delta === 1) {
      this.streamLostAt.delete(agentId);
      return;
    }
    // 断开时记一次「最后出现」，否则长连接期间的 last_seen 一直停在连接建立时
    this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(this.iso(), agentId);
    if (n <= 0 && kind === 'stream') {
      this.streamLostAt.set(agentId, this.now().getTime());
      this.activity.delete(agentId);
    }
  }

  /** `ahub run` 值守进程的实时连接计数：有值守进程时，agent 不需要自己等待 */
  markDaemon(agentId: number, delta: 1 | -1) {
    const n = (this.daemons.get(agentId) ?? 0) + delta;
    if (n <= 0) this.daemons.delete(agentId);
    else this.daemons.set(agentId, n);
  }

  hasDaemon(agentId: number) {
    return (this.daemons.get(agentId) ?? 0) > 0;
  }

  /** 连续落空的等待次数（30 分钟没再等过就重新计数） */
  idleWaits(agentId: number): number {
    const w = this.emptyWaits.get(agentId);
    return w && this.now().getTime() - w.at < 30 * 60_000 ? w.n : 0;
  }

  noteWait(agentId: number, empty: boolean) {
    if (!empty) this.emptyWaits.delete(agentId);
    else this.emptyWaits.set(agentId, { n: this.idleWaits(agentId) + 1, at: this.now().getTime() });
  }

  isLive(agentId: number) {
    return (this.live.get(agentId) ?? 0) > 0;
  }

  presenceOf(a: AgentRow): Presence {
    if (a.status !== 'active') return 'offline';
    if (this.isLive(a.id)) return 'online';
    const now = this.now().getTime();
    const seen = a.last_seen_at ? Date.parse(a.last_seen_at) : 0;
    const lost = this.streamLostAt.get(a.id);
    // 守护进程断线：断开之后没有再出现过，且超过宽限期
    if (lost !== undefined && seen <= lost + 1000 && now - lost > this.streamGraceMs) return 'offline';
    const age = now - seen;
    if (age <= ACTIVE_MINUTES * 60_000) return 'active';
    if (age <= this.offlineAfterMs) return 'idle';
    return 'offline';
  }

  /** 定时调用：把刚刚变成离线的 agent 标记出来并通知负责人。返回新离线的数量。 */
  sweepPresence(): number {
    const rows = this.db.prepare("SELECT * FROM agents WHERE presence = 'on'").all() as unknown as AgentRow[];
    const gone = rows.filter((a) => this.presenceOf(a) === 'offline');
    if (!gone.length) return 0;
    this.write(() => {
      for (const a of gone) {
        this.db.prepare("UPDATE agents SET presence = 'off' WHERE id = ?").run(a.id);
        if (a.status !== 'active') continue; // 被停用的不必再通知
        const tasks = this.agentView(a).active_tasks;
        const lost = this.streamLostAt.has(a.id);
        this.emit('agent.offline', agentCode(a.id), {
          audience: [],
          data: { agent: agentCode(a.id), last_seen_at: a.last_seen_at, active_tasks: tasks, reason: lost ? 'disconnected' : 'silent' },
          summary:
            `${a.name}（${agentCode(a.id)}）${lost ? '断开了连接' : '很久没有出现'}，已离线` +
            (tasks.length ? `；手上还有 ${tasks.join('、')}` : ''),
        });
      }
    });
    return gone.length;
  }

  /** 守护进程上报状态（被唤醒、处理完成等），只通知负责人。 */
  reportActivity(agent: AgentRow, input: { state?: string; note?: string; tasks?: string[] }) {
    const state = input.state === 'working' || input.state === 'stopped' ? input.state : 'idle';
    const note = String(input.note ?? '').slice(0, 300);
    const at = this.iso();
    if (state === 'working') this.activity.set(agent.id, { state, note, at });
    else this.activity.delete(agent.id);
    const who = `${agent.name}（${agentCode(agent.id)}）`;
    this.write(() =>
      this.emit('agent.activity', agentCode(agent.id), {
        audience: [],
        data: { agent: agentCode(agent.id), state, note },
        summary:
          state === 'working'
            ? `${who}被唤醒：${note || '处理新事项'}`
            : state === 'stopped'
              ? `${who}的值守进程已退出`
              : `${who}处理完毕，回到待命${note ? `：${note}` : ''}`,
      }),
    );
    return { ok: true };
  }

  // ───────────── 事件 ─────────────

  private emit(
    type: EventType,
    actor: string,
    opts: {
      project?: number | null;
      task?: TaskRow | null;
      audience?: string[] | null;
      data?: Record<string, unknown>;
      summary: string;
    },
  ): HubEvent {
    const at = this.iso();
    const projectId = opts.project ?? opts.task?.project_id ?? null;
    const audience = opts.audience === undefined ? null : opts.audience;
    const data = opts.data ?? {};
    const r = this.db
      .prepare(
        'INSERT INTO events (type, at, actor, project_id, task_id, audience, data, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        type,
        at,
        actor,
        projectId,
        opts.task?.id ?? null,
        audience === null ? null : JSON.stringify(audience),
        JSON.stringify(data),
        opts.summary,
      );
    const event: HubEvent = {
      seq: Number(r.lastInsertRowid),
      type,
      at,
      actor,
      project: projectId === null ? null : projectCode(projectId),
      task: opts.task ? taskCode(opts.task.project_id, opts.task.num) : null,
      audience,
      data,
      summary: opts.summary,
    };
    this.pending.push(event);
    return event;
  }

  private toEvent(row: EventRow): HubEvent {
    let task: string | null = null;
    if (row.task_id !== null) {
      const t = this.db.prepare('SELECT project_id, num FROM tasks WHERE id = ?').get(row.task_id) as
        | { project_id: number; num: number }
        | undefined;
      if (t) task = taskCode(t.project_id, t.num);
    }
    return {
      seq: row.seq,
      type: row.type,
      at: row.at,
      actor: row.actor,
      project: row.project_id === null ? null : projectCode(row.project_id),
      task,
      audience: json<string[] | null>(row.audience, null),
      data: json(row.data, {}),
      summary: row.summary,
    };
  }

  lastSeq(): number {
    const r = this.db.prepare('SELECT MAX(seq) AS s FROM events').get() as { s: number | null };
    return r.s ?? 0;
  }

  private memberProjectIds(agentId: number): Set<number> {
    const rows = this.db.prepare('SELECT project_id FROM memberships WHERE agent_id = ?').all(agentId) as {
      project_id: number;
    }[];
    return new Set(rows.map((r) => r.project_id));
  }

  /** agent 能否看到这个事件：定向事件只给受众；项目事件给项目成员；自己触发的不再推给自己。 */
  canSee(agent: AgentRow, e: HubEvent, projects?: Set<number>): boolean {
    const me = agentCode(agent.id);
    if (e.actor === me) return false;
    if (e.audience !== null) return e.audience.includes(me);
    if (e.project === null) return true;
    const ids = projects ?? this.memberProjectIds(agent.id);
    return ids.has(Number(e.project.slice(2)));
  }

  eventsForAgent(agent: AgentRow, after: number, limit = 100, project?: string): { events: HubEvent[]; more: boolean } {
    const projects = this.memberProjectIds(agent.id);
    const projectFilter = project ? this.requireProject(project).id : null;
    const out: HubEvent[] = [];
    let cursor = after;
    // 分批扫描，过滤掉不可见的事件
    for (;;) {
      const rows = this.db
        .prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT 500')
        .all(cursor) as unknown as EventRow[];
      if (rows.length === 0) return { events: out, more: false };
      for (const row of rows) {
        cursor = row.seq;
        if (projectFilter !== null && row.project_id !== projectFilter) continue;
        const e = this.toEvent(row);
        if (!this.canSee(agent, e, projects)) continue;
        out.push(e);
        if (out.length >= limit) return { events: out, more: true };
      }
    }
  }

  eventsForOwner(opts: { after?: number; before?: number; limit?: number; project?: string }): HubEvent[] {
    const limit = Math.min(opts.limit ?? 100, 500);
    const projectId = opts.project ? this.requireProject(opts.project).id : null;
    const where: string[] = [];
    const params: (number | null)[] = [];
    if (opts.after !== undefined) {
      where.push('seq > ?');
      params.push(opts.after);
    }
    if (opts.before !== undefined) {
      where.push('seq < ?');
      params.push(opts.before);
    }
    if (projectId !== null) {
      where.push('(project_id = ? OR project_id IS NULL)');
      params.push(projectId);
    }
    const order = opts.after !== undefined ? 'ASC' : 'DESC';
    const rows = this.db
      .prepare(
        `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ${order} LIMIT ${limit}`,
      )
      .all(...params) as unknown as EventRow[];
    return rows.map((r) => this.toEvent(r));
  }

  ack(agent: AgentRow, seq: number) {
    const target = Math.min(seq, this.lastSeq());
    if (target > agent.ack_seq) {
      this.db.prepare('UPDATE agents SET ack_seq = ? WHERE id = ? AND ack_seq < ?').run(target, agent.id, target);
      agent.ack_seq = target;
    }
  }

  /** 收件箱：从 since（默认为已确认的位置）之后的可见事件，加上当前状态快照。 */
  inbox(agent: AgentRow, opts: { since?: number; project?: string; limit?: number } = {}): InboxResult {
    const since = opts.since ?? agent.ack_seq;
    const { events, more } = this.eventsForAgent(agent, since, opts.limit ?? 50, opts.project);
    const me = agentCode(agent.id);
    const needs = events.filter((e) => this.needsAction(e, me));
    const projectFilter = opts.project ? this.requireProject(opts.project).id : null;
    const myRows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE assignee_id = ? AND status IN ('working','input_required','review','assigned') ORDER BY project_id, num`,
      )
      .all(agent.id) as unknown as TaskRow[];
    const mine = myRows.filter((t) => projectFilter === null || t.project_id === projectFilter);
    return {
      agent: me,
      ack_seq: agent.ack_seq,
      last_seq: events.length ? events[events.length - 1].seq : Math.max(since, 0),
      more,
      events,
      needs_action: needs,
      my_tasks: mine.filter((t) => t.status !== 'assigned').map((t) => this.taskView(t)),
      pending_assignments: mine.filter((t) => t.status === 'assigned').map((t) => this.taskView(t)),
      claimable: this.claimableFor(agent, projectFilter).map((t) => this.taskView(t)),
      projects: this.agentProjects(agent.id).map((p) => ({ id: p.id, name: p.name })),
    };
  }

  private needsAction(e: HubEvent, me: string): boolean {
    switch (e.type) {
      case 'task.assigned':
      case 'mention':
      case 'message.direct':
      case 'owner.broadcast':
      case 'task.lease_expiring':
      case 'task.due_soon':
      case 'task.overdue':
        return true;
      case 'task.status_changed':
        return e.data.assignee === me && e.data.from === 'review' && e.data.to === 'working';
      case 'comment.created':
        return e.data.assignee === me;
      default:
        return false;
    }
  }

  private claimableFor(agent: AgentRow, projectFilter: number | null): TaskRow[] {
    const memberships = this.db
      .prepare('SELECT project_id, tags FROM memberships WHERE agent_id = ?')
      .all(agent.id) as { project_id: number; tags: string }[];
    const out: TaskRow[] = [];
    for (const m of memberships) {
      if (projectFilter !== null && m.project_id !== projectFilter) continue;
      const project = this.db.prepare('SELECT status FROM projects WHERE id = ?').get(m.project_id) as {
        status: string;
      };
      if (project.status !== 'active') continue;
      const tags = json<string[]>(m.tags, []);
      const skills = json<string[]>(agent.skills, []);
      const rows = this.db
        .prepare(`SELECT * FROM tasks WHERE project_id = ? AND status = 'open' ORDER BY priority, num`)
        .all(m.project_id) as unknown as TaskRow[];
      for (const t of rows) {
        if (!this.tagsMatch(t, [...tags, ...skills])) continue;
        if (!this.depsDone(t)) continue;
        out.push(t);
      }
    }
    return out.slice(0, 20);
  }

  private tagsMatch(t: TaskRow, tags: string[]) {
    const required = json<string[]>(t.required_tags, []);
    if (required.length === 0) return true;
    return required.some((r) => tags.includes(r));
  }

  private depsDone(t: TaskRow) {
    const deps = json<number[]>(t.depends_on, []);
    if (deps.length === 0) return true;
    const rows = this.db
      .prepare(`SELECT status FROM tasks WHERE id IN (${deps.map(() => '?').join(',')})`)
      .all(...deps) as { status: string }[];
    return rows.every((r) => r.status === 'completed' || r.status === 'canceled');
  }

  // ───────────── 项目 ─────────────

  createProject(input: { name: string; description?: string }): ProjectView {
    const name = input.name?.trim();
    if (!name) throw invalid('项目名称不能为空');
    return this.write(() => {
      const r = this.db
        .prepare('INSERT INTO projects (name, description, created_at) VALUES (?, ?, ?)')
        .run(name, input.description ?? '', this.iso());
      const id = Number(r.lastInsertRowid);
      this.emit('project.created', 'owner', {
        project: id,
        audience: [],
        data: { name },
        summary: `负责人创建了项目 ${projectCode(id)}「${name}」`,
      });
      return this.projectView(this.requireProject(projectCode(id)));
    });
  }

  updateProject(code: string, input: { name?: string; description?: string; status?: string }): ProjectView {
    const p = this.requireProject(code);
    if (input.status && !['active', 'archived'].includes(input.status)) throw invalid('项目状态只能是 active 或 archived');
    return this.write(() => {
      this.db
        .prepare('UPDATE projects SET name = ?, description = ?, status = ? WHERE id = ?')
        .run(input.name?.trim() || p.name, input.description ?? p.description, input.status ?? p.status, p.id);
      const changed = Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined);
      this.emit('project.updated', 'owner', {
        project: p.id,
        data: { fields: changed },
        summary: input.description !== undefined ? `负责人更新了项目 ${code} 的项目说明` : `负责人更新了项目 ${code}`,
      });
      return this.projectView(this.requireProject(code));
    });
  }

  requireProject(code: string): ProjectRow {
    const id = parseId(code, 'P');
    const row = id === null ? undefined : (this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined);
    if (!row) throw notFound(`项目 ${code}`);
    return row;
  }

  getProject(code: string): ProjectView & { members_list: AgentView[] } {
    const p = this.requireProject(code);
    const agents = this.db
      .prepare('SELECT a.* FROM agents a JOIN memberships m ON m.agent_id = a.id WHERE m.project_id = ? ORDER BY a.id')
      .all(p.id) as unknown as AgentRow[];
    return { ...this.projectView(p), members_list: agents.map((a) => this.agentView(a)) };
  }

  listProjects(): ProjectView[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY status, id').all() as unknown as ProjectRow[];
    return rows.map((p) => this.projectView(p));
  }

  private projectView(p: ProjectRow): ProjectView {
    const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((s) => [s, 0])) as Record<TaskStatus, number>;
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? GROUP BY status')
      .all(p.id) as { status: TaskStatus; n: number }[];
    for (const r of rows) counts[r.status] = r.n;
    const members = this.db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE project_id = ?').get(p.id) as {
      n: number;
    };
    return {
      id: projectCode(p.id),
      name: p.name,
      description: p.description,
      status: p.status,
      created_at: p.created_at,
      counts,
      members: members.n,
    };
  }

  private agentProjects(agentId: number) {
    const rows = this.db
      .prepare(
        'SELECT p.id, p.name, m.tags FROM projects p JOIN memberships m ON m.project_id = p.id WHERE m.agent_id = ? ORDER BY p.id',
      )
      .all(agentId) as { id: number; name: string; tags: string }[];
    return rows.map((r) => ({ id: projectCode(r.id), name: r.name, tags: json<string[]>(r.tags, []) }));
  }

  // ───────────── 搜索 ─────────────

  /** 按关键字搜任务（编号、标题、描述、笔记、进展）和评论；负责人还能搜私信和 agent。agent 只能搜自己参加的项目。 */
  search(actor: Actor, q: string, project?: string) {
    const kw = q.trim().slice(0, 100);
    const result = { query: kw, tasks: [] as TaskView[], comments: [] as SearchHit[], messages: [] as SearchHit[], agents: [] as AgentView[] };
    if (!kw) return result;
    let projects: number[] | null = actor.kind === 'agent' ? this.agentProjects(actor.agent.id).map((p) => Number(p.id.slice(2))) : null;
    if (project) {
      const id = this.requireProject(project).id;
      if (projects && !projects.includes(id)) throw forbidden(`你不是项目 ${project} 的成员`);
      projects = [id];
    }
    if (projects && projects.length === 0) return result;
    const scope = (col: string) => (projects ? `AND ${col} IN (${projects.map(() => '?').join(',')})` : '');
    const ps = projects ?? [];
    const like = `%${kw.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const code = /^P(\d+)-T(\d+)$/i.exec(kw);
    const [pid, num] = code ? [Number(code[1]), Number(code[2])] : [-1, -1];
    const L = (col: string) => `${col} LIKE ? ESCAPE '\\'`;

    const tasks = this.db
      .prepare(
        `SELECT * FROM tasks WHERE status != 'draft'
           AND (${L('title')} OR ${L('description')} OR ${L('notes')} OR ${L('progress_note')} OR (project_id = ? AND num = ?)) ${scope('project_id')}
         ORDER BY (project_id = ? AND num = ?) DESC, updated_at DESC LIMIT 20`,
      )
      .all(like, like, like, like, pid, num, ...ps, pid, num) as unknown as TaskRow[];
    result.tasks = tasks.map((t) => this.taskView(t));

    const comments = this.db
      .prepare(
        `SELECT c.task_id, c.id, c.author, c.parts, c.created_at FROM comments c JOIN tasks t ON t.id = c.task_id
         WHERE ${L('c.parts')} ${scope('t.project_id')} ORDER BY c.id DESC LIMIT 10`,
      )
      .all(like, ...ps) as { id: number; task_id: number; author: string; parts: string; created_at: string }[];
    result.comments = comments.map((c) => {
      const t = this.taskById(c.task_id);
      const text = json<Part[]>(c.parts, [])
        .map((p) => p.text ?? '')
        .join(' ');
      return { id: c.id, task: taskCode(t.project_id, t.num), title: t.title, who: this.actorName(c.author), text: snippet(text, kw), at: c.created_at };
    });

    if (actor.kind === 'owner') {
      const msgs = this.db.prepare(`SELECT * FROM messages WHERE ${L('body')} ORDER BY id DESC LIMIT 10`).all(like) as {
        id: number;
        sender: string;
        recipient: string;
        body: string;
        created_at: string;
      }[];
      result.messages = msgs.map((m) => ({
        id: m.id,
        task: null,
        title: null,
        who: `${this.actorName(m.sender)} → ${this.actorName(m.recipient)}`,
        text: snippet(m.body, kw),
        at: m.created_at,
      }));
      const lower = kw.toLowerCase();
      result.agents = this.listAgents(project)
        .filter((a) => a.id.toLowerCase() === lower || a.name.toLowerCase().includes(lower))
        .slice(0, 10);
    }
    return result;
  }

  // ───────────── 任务模板 ─────────────

  listTemplates(): TemplateView[] {
    const rows = this.db.prepare('SELECT * FROM templates ORDER BY name').all() as { id: number; name: string; body: string; updated_at: string }[];
    return rows.map((r) => ({ id: r.id, name: r.name, ...json<TemplateBody>(r.body, EMPTY_TEMPLATE), updated_at: r.updated_at }));
  }

  /** 新建或覆盖同名模板 */
  saveTemplate(input: Partial<Omit<TemplateBody, 'priority'>> & { priority?: string; name?: string; id?: number }): TemplateView {
    const name = input.name?.trim();
    if (!name) throw invalid('模板名称不能为空');
    const priority = (input.priority ?? 'P2').toUpperCase() as Priority;
    if (!PRIORITIES.includes(priority)) throw invalid('优先级只能是 P0–P3');
    const body: TemplateBody = {
      title: input.title?.trim() ?? '',
      description: input.description ?? '',
      acceptance: input.acceptance ?? [],
      priority,
      required_tags: input.required_tags ?? [],
      subtasks: (input.subtasks ?? []).map((s) => s.trim()).filter(Boolean).slice(0, 50),
      chain: !!input.chain,
    };
    const now = this.iso();
    const clash = this.db.prepare('SELECT id FROM templates WHERE name = ?').get(name) as { id: number } | undefined;
    const id = input.id ?? clash?.id;
    if (id !== undefined) {
      if (clash && clash.id !== id) throw conflict(`已经有名为「${name}」的模板`);
      const r = this.db.prepare('UPDATE templates SET name = ?, body = ?, updated_at = ? WHERE id = ?').run(name, JSON.stringify(body), now, id);
      if (r.changes === 0) throw notFound(`模板 ${id}`);
    } else {
      this.db.prepare('INSERT INTO templates (name, body, created_at, updated_at) VALUES (?, ?, ?, ?)').run(name, JSON.stringify(body), now, now);
    }
    return this.listTemplates().find((t) => t.name === name)!;
  }

  deleteTemplate(id: number) {
    if (this.db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes === 0) throw notFound(`模板 ${id}`);
    return { ok: true };
  }

  // ───────────── 邀请与加入 ─────────────

  createInvite(input: { project: string; tags?: string[]; max_uses?: number; hours?: number; note?: string }) {
    const p = this.requireProject(input.project);
    const code = newInviteCode();
    const expires = this.iso((input.hours ?? 24) * 60);
    this.db
      .prepare(
        'INSERT INTO invites (code, project_id, tags, max_uses, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(code, p.id, JSON.stringify(input.tags ?? []), input.max_uses ?? 1, expires, input.note ?? '', this.iso());
    return this.inviteView(code);
  }

  private inviteView(code: string) {
    const r = this.db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as {
      code: string;
      project_id: number;
      tags: string;
      max_uses: number;
      uses: number;
      expires_at: string;
      revoked: number;
      note: string;
      created_at: string;
    };
    const expired = r.expires_at < this.iso();
    return {
      code: r.code,
      project: projectCode(r.project_id),
      tags: json<string[]>(r.tags, []),
      max_uses: r.max_uses,
      uses: r.uses,
      expires_at: r.expires_at,
      note: r.note,
      created_at: r.created_at,
      valid: !r.revoked && !expired && r.uses < r.max_uses,
    };
  }

  listInvites(project?: string) {
    const rows = (
      project
        ? this.db.prepare('SELECT code FROM invites WHERE project_id = ? ORDER BY created_at DESC').all(this.requireProject(project).id)
        : this.db.prepare('SELECT code FROM invites ORDER BY created_at DESC').all()
    ) as { code: string }[];
    return rows.map((r) => this.inviteView(r.code));
  }

  revokeInvite(code: string) {
    const r = this.db.prepare('UPDATE invites SET revoked = 1 WHERE code = ?').run(code.toUpperCase());
    if (r.changes === 0) throw notFound(`邀请码 ${code}`);
  }

  /**
   * 用邀请码加入项目。没有身份的 agent 会新建身份并拿到令牌；
   * 已有身份的 agent（带令牌调用）只是多加入一个项目。
   */
  join(
    input: {
      invite: string;
      name?: string;
      platform?: string;
      tier?: string;
      description?: string;
      skills?: string[];
      tags?: string[];
    },
    existing: AgentRow | null,
  ): { agent: AgentView; token: string | null; project: ProjectView; briefing: { project: ProjectView & { description: string } } } {
    const code = (input.invite ?? '').trim().toUpperCase();
    const inv = this.db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as
      | { code: string; project_id: number; tags: string; max_uses: number; uses: number; expires_at: string; revoked: number }
      | undefined;
    if (!inv) throw invalid('邀请码无效');
    if (inv.revoked) throw invalid('邀请码已被撤销');
    if (inv.expires_at < this.iso()) throw invalid('邀请码已过期');
    if (inv.uses >= inv.max_uses) throw invalid('邀请码已用完');
    const tier = (input.tier ?? 'L1').toUpperCase() as Tier;
    if (!TIERS.includes(tier)) throw invalid('tier 只能是 L1、L2、L3、L4');

    return this.write(() => {
      let agent = existing;
      let token: string | null = null;
      if (!agent) {
        const name = input.name?.trim();
        if (!name) throw invalid('请提供 agent 名称（name）');
        token = newToken('ahub');
        const r = this.db
          .prepare(
            "INSERT INTO agents (name, platform, tier, description, skills, token_hash, created_at, last_seen_at, ack_seq, presence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'on')",
          )
          .run(
            name,
            input.platform ?? 'other',
            tier,
            input.description ?? '',
            JSON.stringify(input.skills ?? []),
            hashToken(token),
            this.iso(),
            this.iso(),
            0,
          );
        agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(Number(r.lastInsertRowid)) as unknown as AgentRow;
      }
      const already = this.db
        .prepare('SELECT 1 FROM memberships WHERE project_id = ? AND agent_id = ?')
        .get(inv.project_id, agent.id);
      if (already) throw conflict(`你已经是项目 ${projectCode(inv.project_id)} 的成员`);
      const tags = [...new Set([...json<string[]>(inv.tags, []), ...(input.tags ?? [])])];
      this.db
        .prepare('INSERT INTO memberships (project_id, agent_id, tags, joined_at) VALUES (?, ?, ?, ?)')
        .run(inv.project_id, agent.id, JSON.stringify(tags), this.iso());
      this.db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(code);
      if (token) {
        // 新身份从当前位置开始，避免把历史事件全部灌进收件箱
        this.db.prepare('UPDATE agents SET ack_seq = ? WHERE id = ?').run(this.lastSeq(), agent.id);
      }
      const me = agentCode(agent.id);
      this.emit('agent.joined', me, {
        project: inv.project_id,
        data: { agent: me, name: agent.name, platform: agent.platform, tier: agent.tier, tags },
        summary: `${agent.name}（${me}）加入了项目 ${projectCode(inv.project_id)}`,
      });
      const p = this.requireProject(projectCode(inv.project_id));
      const view = this.projectView(p);
      return { agent: this.agentView(this.requireAgentRow(me)), token, project: view, briefing: { project: view } };
    });
  }

  // ───────────── Agent ─────────────

  requireAgentRow(code: string): AgentRow {
    const id = parseId(code, 'A');
    const row = id === null ? undefined : (this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined);
    if (!row) throw notFound(`agent ${code}`);
    return row;
  }

  agentView(a: AgentRow): AgentView {
    const active = this.db
      .prepare(`SELECT project_id, num FROM tasks WHERE assignee_id = ? AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`)
      .all(a.id, ...ACTIVE_STATUSES) as { project_id: number; num: number }[];
    const presence = this.presenceOf(a);
    return {
      id: agentCode(a.id),
      name: a.name,
      platform: a.platform,
      tier: a.tier,
      description: a.description,
      skills: json<string[]>(a.skills, []),
      status: a.status,
      created_at: a.created_at,
      last_seen_at: a.last_seen_at,
      online: presence === 'online' || presence === 'active',
      presence,
      presence_label: PRESENCE_LABELS[presence],
      activity: presence === 'online' ? (this.activity.get(a.id) ?? null) : null,
      projects: this.agentProjects(a.id),
      active_tasks: active.map((t) => taskCode(t.project_id, t.num)),
    };
  }

  listAgents(project?: string): AgentView[] {
    const rows = (
      project
        ? this.db
            .prepare('SELECT a.* FROM agents a JOIN memberships m ON m.agent_id = a.id WHERE m.project_id = ? ORDER BY a.id')
            .all(this.requireProject(project).id)
        : this.db.prepare('SELECT * FROM agents ORDER BY id').all()
    ) as unknown as AgentRow[];
    return rows.map((a) => this.agentView(a));
  }

  updateAgent(actor: Actor, code: string, input: { status?: string; name?: string; description?: string; skills?: string[]; tier?: string }) {
    const a = this.requireAgentRow(code);
    if (actor.kind === 'agent' && actor.agent.id !== a.id) throw forbidden('只能修改自己的资料');
    if (input.status !== undefined) {
      if (actor.kind !== 'owner') throw forbidden('只有负责人可以停用或启用 agent');
      if (!['active', 'disabled'].includes(input.status)) throw invalid('status 只能是 active 或 disabled');
    }
    const tier = input.tier ? (input.tier.toUpperCase() as Tier) : a.tier;
    if (!TIERS.includes(tier)) throw invalid('tier 只能是 L1、L2、L3、L4');
    return this.write(() => {
      this.db
        .prepare('UPDATE agents SET status = ?, name = ?, description = ?, skills = ?, tier = ? WHERE id = ?')
        .run(
          input.status ?? a.status,
          input.name?.trim() || a.name,
          input.description ?? a.description,
          JSON.stringify(input.skills ?? json<string[]>(a.skills, [])),
          tier,
          a.id,
        );
      const who = actor.kind === 'owner' ? 'owner' : agentCode(a.id);
      this.emit('agent.updated', who, {
        audience: [],
        data: { agent: code, ...input },
        summary:
          input.status === 'disabled'
            ? `负责人停用了 ${a.name}（${code}）`
            : input.status === 'active'
              ? `负责人启用了 ${a.name}（${code}）`
              : `${a.name}（${code}）的资料已更新`,
      });
      return this.agentView(this.requireAgentRow(code));
    });
  }

  resetAgentToken(code: string): string {
    const a = this.requireAgentRow(code);
    const token = newToken('ahub');
    this.db.prepare('UPDATE agents SET token_hash = ? WHERE id = ?').run(hashToken(token), a.id);
    return token;
  }

  private isMember(agentId: number, projectId: number) {
    return !!this.db.prepare('SELECT 1 FROM memberships WHERE project_id = ? AND agent_id = ?').get(projectId, agentId);
  }

  // ───────────── 任务 ─────────────

  requireTask(code: string): TaskRow {
    const m = /^P(\d+)-T(\d+)$/i.exec(code.trim());
    const row = m
      ? (this.db.prepare('SELECT * FROM tasks WHERE project_id = ? AND num = ?').get(Number(m[1]), Number(m[2])) as
          | TaskRow
          | undefined)
      : undefined;
    if (!row) throw notFound(`任务 ${code}`);
    return row;
  }

  private taskById(id: number): TaskRow {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as unknown as TaskRow;
  }

  private agentName(id: number | null): string | null {
    if (id === null) return null;
    const r = this.db.prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string } | undefined;
    return r?.name ?? null;
  }

  private actorName(actor: string): string {
    if (actor === 'owner') return '负责人';
    const id = parseId(actor, 'A');
    return (id !== null && this.agentName(id)) || actor;
  }

  taskView(t: TaskRow): TaskView {
    const deps = json<number[]>(t.depends_on, []).map((id) => {
      const d = this.taskById(id);
      return taskCode(d.project_id, d.num);
    });
    const parent = t.parent_id ? this.taskById(t.parent_id) : null;
    return {
      id: taskCode(t.project_id, t.num),
      project: projectCode(t.project_id),
      title: t.title,
      description: t.description,
      acceptance: json<string[]>(t.acceptance, []),
      status: t.status,
      status_label: STATUS_LABELS[t.status],
      priority: t.priority,
      assignee: t.assignee_id === null ? null : agentCode(t.assignee_id),
      assignee_name: this.agentName(t.assignee_id),
      created_by: t.created_by,
      parent: parent ? taskCode(parent.project_id, parent.num) : null,
      depends_on: deps,
      required_tags: json<string[]>(t.required_tags, []),
      progress: t.progress,
      progress_note: t.progress_note,
      notes: t.notes,
      block_reason: t.block_reason,
      lease_until: t.lease_until,
      due_at: t.due_at,
      created_at: t.created_at,
      updated_at: t.updated_at,
      version: t.version,
    };
  }

  getTask(code: string): TaskDetail {
    const t = this.requireTask(code);
    const subtasks = this.db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY num').all(t.id) as unknown as TaskRow[];
    const comments = this.db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY id').all(t.id) as {
      id: number;
      author: string;
      parts: string;
      created_at: string;
    }[];
    const artifacts = this.db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY id').all(t.id) as {
      id: number;
      author: string;
      name: string;
      parts: string;
      created_at: string;
    }[];
    const log = this.db
      .prepare('SELECT author, percent, note, created_at FROM progress_log WHERE task_id = ? ORDER BY id')
      .all(t.id) as { author: string; percent: number; note: string; created_at: string }[];
    return {
      ...this.taskView(t),
      subtasks: subtasks.map((s) => this.taskView(s)),
      comments: comments.map((c) => ({
        id: c.id,
        author: c.author,
        author_name: this.actorName(c.author),
        parts: json<Part[]>(c.parts, []),
        created_at: c.created_at,
      })),
      artifacts: artifacts.map((a) => ({ ...a, parts: json<Part[]>(a.parts, []) })),
      progress_log: log,
    };
  }

  listTasks(
    actor: Actor,
    filter: { project?: string; status?: string; assignee?: string; mine?: boolean; parent?: string } = {},
  ): TaskView[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.project) {
      const p = this.requireProject(filter.project);
      if (actor.kind === 'agent' && !this.isMember(actor.agent.id, p.id)) throw forbidden(`你不是项目 ${filter.project} 的成员`);
      where.push('project_id = ?');
      params.push(p.id);
    } else if (actor.kind === 'agent') {
      where.push('project_id IN (SELECT project_id FROM memberships WHERE agent_id = ?)');
      params.push(actor.agent.id);
    }
    if (filter.status) {
      const statuses = filter.status.split(',');
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (filter.mine && actor.kind === 'agent') {
      where.push('assignee_id = ?');
      params.push(actor.agent.id);
    } else if (filter.assignee) {
      where.push('assignee_id = ?');
      params.push(this.requireAgentRow(filter.assignee).id);
    }
    if (filter.parent) {
      where.push('parent_id = ?');
      params.push(this.requireTask(filter.parent).id);
    }
    const rows = this.db
      .prepare(`SELECT * FROM tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY project_id, num`)
      .all(...params) as unknown as TaskRow[];
    return rows.map((t) => this.taskView(t));
  }

  private assertVisible(actor: Actor, t: TaskRow) {
    if (actor.kind === 'agent' && !this.isMember(actor.agent.id, t.project_id)) {
      throw forbidden(`你不是项目 ${projectCode(t.project_id)} 的成员`);
    }
  }

  getTaskFor(actor: Actor, code: string): TaskDetail {
    this.assertVisible(actor, this.requireTask(code));
    return this.getTask(code);
  }

  /**
   * 创建任务。负责人可在任何项目建任务；agent 只能在自己参与的任务下建子任务，
   * 子任务直接发布（有建议对象时直接指派给对方）。
   */
  createTask(
    actor: Actor,
    input: {
      project?: string;
      title: string;
      description?: string;
      acceptance?: string[];
      priority?: string;
      assignee?: string | null;
      parent?: string | null;
      depends_on?: string[];
      required_tags?: string[];
      due_at?: string | null;
      draft?: boolean;
    },
  ): TaskView {
    const title = input.title?.trim();
    if (!title) throw invalid('任务标题不能为空');
    input = { ...input, due_at: normalizeDue(input.due_at) };
    const priority = (input.priority ?? 'P2').toUpperCase() as Priority;
    if (!PRIORITIES.includes(priority)) throw invalid('优先级只能是 P0–P3');

    let projectId: number;
    let parent: TaskRow | null = null;
    if (input.parent) {
      parent = this.requireTask(input.parent);
      projectId = parent.project_id;
      if (input.project && this.requireProject(input.project).id !== projectId) throw invalid('子任务必须和父任务在同一个项目');
    } else if (input.project) {
      projectId = this.requireProject(input.project).id;
    } else {
      throw invalid('请指定项目（project）或父任务（parent）');
    }

    if (actor.kind === 'agent') {
      if (!parent) throw forbidden('agent 只能创建子任务，请提供 parent');
      if (!this.isMember(actor.agent.id, projectId)) throw forbidden('你不是该项目的成员');
      if (parent.assignee_id !== actor.agent.id) throw forbidden(`只能为自己负责的任务创建子任务（${input.parent} 不在你名下）`);
    }
    const project = this.requireProject(projectCode(projectId));
    if (project.status !== 'active') throw conflict('项目已归档，不能新建任务');

    let assignee: AgentRow | null = null;
    if (input.assignee) {
      assignee = this.requireAgentRow(input.assignee);
      if (!this.isMember(assignee.id, projectId)) throw invalid(`${input.assignee} 不是项目 ${projectCode(projectId)} 的成员`);
      if (assignee.status !== 'active') throw invalid(`${input.assignee} 已被停用`);
    }
    const deps = (input.depends_on ?? []).map((c) => {
      const d = this.requireTask(c);
      if (d.project_id !== projectId) throw invalid('依赖的任务必须在同一个项目');
      return d.id;
    });
    const status: TaskStatus = input.draft && actor.kind === 'owner' ? 'draft' : assignee ? 'assigned' : 'open';
    const creator = actor.kind === 'owner' ? 'owner' : agentCode(actor.agent.id);

    return this.write(() => {
      this.db.prepare('UPDATE projects SET task_counter = task_counter + 1 WHERE id = ?').run(projectId);
      const { task_counter: num } = this.db.prepare('SELECT task_counter FROM projects WHERE id = ?').get(projectId) as {
        task_counter: number;
      };
      const now = this.iso();
      const r = this.db
        .prepare(
          `INSERT INTO tasks (project_id, num, title, description, acceptance, status, priority, assignee_id, created_by,
            parent_id, depends_on, required_tags, due_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          num,
          title,
          input.description ?? '',
          JSON.stringify(input.acceptance ?? []),
          status,
          priority,
          assignee?.id ?? null,
          creator,
          parent?.id ?? null,
          JSON.stringify(deps),
          JSON.stringify(input.required_tags ?? []),
          input.due_at ?? parent?.due_at ?? null,
          now,
          now,
        );
      const t = this.taskById(Number(r.lastInsertRowid));
      const code = taskCode(projectId, num);
      const who = this.actorName(creator);
      this.emit('task.created', creator, {
        task: t,
        audience: status === 'draft' ? [] : null,
        data: { title, status, priority, parent: input.parent ?? null, required_tags: input.required_tags ?? [] },
        summary: parent
          ? `${who}为 ${input.parent} 创建了子任务 ${code}「${title}」`
          : `${who}发布了任务 ${code}「${title}」`,
      });
      if (assignee) {
        const to = agentCode(assignee.id);
        this.emit('task.assigned', creator, {
          task: t,
          audience: [to],
          data: { assignee: to, title },
          summary: `${who}把 ${code}「${title}」指派给了你`,
        });
      }
      return this.taskView(t);
    });
  }

  /** from 是否直接或间接依赖 target */
  private dependsOn(from: number, target: number): boolean {
    const seen = new Set<number>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === target) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.db.prepare('SELECT depends_on FROM tasks WHERE id = ?').get(id) as { depends_on: string } | undefined;
      stack.push(...json<number[]>(row?.depends_on, []));
    }
    return false;
  }

  updateTask(
    code: string,
    input: {
      title?: string;
      description?: string;
      acceptance?: string[];
      priority?: string;
      required_tags?: string[];
      depends_on?: string[];
      due_at?: string | null;
      version?: number;
    },
  ): TaskView {
    const t = this.requireTask(code);
    if (input.version !== undefined && input.version !== t.version) throw conflict('任务已被其他人修改，请刷新后重试');
    const due = input.due_at === undefined ? undefined : normalizeDue(input.due_at);
    const priority = input.priority ? (input.priority.toUpperCase() as Priority) : t.priority;
    if (!PRIORITIES.includes(priority)) throw invalid('优先级只能是 P0–P3');
    const deps =
      input.depends_on === undefined
        ? t.depends_on
        : JSON.stringify(
            input.depends_on.map((c) => {
              const d = this.requireTask(c);
              if (d.id === t.id) throw invalid('任务不能依赖自己');
              if (this.dependsOn(d.id, t.id)) throw invalid(`${c} 已经直接或间接依赖 ${code}，不能形成循环依赖`);
              return d.id;
            }),
          );
    return this.write(() => {
      this.db
        .prepare(
          `UPDATE tasks SET title = ?, description = ?, acceptance = ?, priority = ?, required_tags = ?, depends_on = ?, due_at = ?,
            due_warned = CASE WHEN due_at IS ? THEN due_warned ELSE 0 END, updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(
          input.title?.trim() || t.title,
          input.description ?? t.description,
          input.acceptance === undefined ? t.acceptance : JSON.stringify(input.acceptance),
          priority,
          input.required_tags === undefined ? t.required_tags : JSON.stringify(input.required_tags),
          deps,
          due === undefined ? t.due_at : due,
          due === undefined ? t.due_at : due,
          this.iso(),
          t.id,
        );
      const fields = Object.keys(input).filter((k) => k !== 'version' && (input as Record<string, unknown>)[k] !== undefined);
      const updated = this.taskById(t.id);
      this.emit('task.updated', 'owner', {
        task: updated,
        audience: t.status === 'draft' ? [] : null,
        data: { fields, assignee: t.assignee_id ? agentCode(t.assignee_id) : null },
        summary: `负责人修改了 ${code} 的${fields.map(fieldLabel).join('、') || '内容'}`,
      });
      return this.taskView(updated);
    });
  }

  private setStatus(
    t: TaskRow,
    actor: string,
    to: TaskStatus,
    extra: { assignee?: number | null; lease?: string | null; block_reason?: string; summary: string; data?: Record<string, unknown> },
  ): TaskRow {
    const assignee = extra.assignee === undefined ? t.assignee_id : extra.assignee;
    const r = this.db
      .prepare(
        `UPDATE tasks SET status = ?, assignee_id = ?, lease_until = ?, lease_warned = 0, block_reason = ?, updated_at = ?,
          version = version + 1 WHERE id = ? AND version = ?`,
      )
      .run(
        to,
        assignee,
        extra.lease === undefined ? t.lease_until : extra.lease,
        extra.block_reason ?? (to === 'input_required' ? t.block_reason : ''),
        this.iso(),
        t.id,
        t.version,
      );
    if (r.changes === 0) throw conflict('任务刚刚被其他人修改，请重试');
    const updated = this.taskById(t.id);
    this.emit('task.status_changed', actor, {
      task: updated,
      data: {
        from: t.status,
        to,
        assignee: assignee === null ? null : agentCode(assignee),
        ...extra.data,
      },
      summary: extra.summary,
    });
    return updated;
  }

  private lease(agent: AgentRow) {
    return this.iso(LEASE_MINUTES[agent.tier] ?? 240);
  }

  private requireAssignee(agent: AgentRow, t: TaskRow, code: string) {
    if (t.assignee_id !== agent.id) throw forbidden(`${code} 不在你名下`);
  }

  assign(code: string, to: string | null, message?: string): TaskView {
    const t = this.requireTask(code);
    if (['completed', 'canceled'].includes(t.status)) throw conflict(`${code} 已经${STATUS_LABELS[t.status]}，不能再指派`);
    let agent: AgentRow | null = null;
    if (to) {
      agent = this.requireAgentRow(to);
      if (!this.isMember(agent.id, t.project_id)) throw invalid(`${to} 不是项目 ${projectCode(t.project_id)} 的成员`);
      if (agent.status !== 'active') throw invalid(`${to} 已被停用`);
    }
    return this.write(() => {
      const prev = t.assignee_id;
      const status: TaskStatus = agent ? 'assigned' : 'open';
      const updated = this.setStatus(t, 'owner', status, {
        assignee: agent?.id ?? null,
        lease: null,
        summary: agent ? `负责人把 ${code} 指派给了 ${agent.name}（${to}）` : `负责人把 ${code} 放回了任务池`,
        data: { previous_assignee: prev === null ? null : agentCode(prev) },
      });
      if (agent) {
        this.emit('task.assigned', 'owner', {
          task: updated,
          audience: [agentCode(agent.id)],
          data: { assignee: agentCode(agent.id), title: t.title, message: message ?? '' },
          summary: `负责人把 ${code}「${t.title}」指派给了你${message ? `：${message}` : ''}`,
        });
      }
      if (prev !== null && prev !== agent?.id) {
        this.emit('task.updated', 'owner', {
          task: updated,
          audience: [agentCode(prev)],
          data: { fields: ['assignee'] },
          summary: `负责人把 ${code} 从你名下改派走了，请停止这个任务的工作`,
        });
      }
      return this.taskView(updated);
    });
  }

  publish(code: string): TaskView {
    const t = this.requireTask(code);
    if (t.status !== 'draft') throw conflict(`${code} 不是草稿`);
    return this.write(() => {
      const to: TaskStatus = t.assignee_id ? 'assigned' : 'open';
      const updated = this.setStatus(t, 'owner', to, { summary: `负责人发布了任务 ${code}「${t.title}」` });
      if (t.assignee_id) {
        this.emit('task.assigned', 'owner', {
          task: updated,
          audience: [agentCode(t.assignee_id)],
          data: { assignee: agentCode(t.assignee_id), title: t.title },
          summary: `负责人把 ${code}「${t.title}」指派给了你`,
        });
      }
      return this.taskView(updated);
    });
  }

  claim(agent: AgentRow, code: string): TaskView {
    const t = this.requireTask(code);
    this.assertVisible({ kind: 'agent', agent }, t);
    if (t.status !== 'open') throw conflict(`${code} 当前状态是「${STATUS_LABELS[t.status]}」，不能领取`);
    if (!this.depsDone(t)) throw conflict(`${code} 的前置任务还没完成`);
    const m = this.db.prepare('SELECT tags FROM memberships WHERE project_id = ? AND agent_id = ?').get(t.project_id, agent.id) as {
      tags: string;
    };
    if (!this.tagsMatch(t, [...json<string[]>(m.tags, []), ...json<string[]>(agent.skills, [])])) {
      throw forbidden(`${code} 需要能力标签：${json<string[]>(t.required_tags, []).join('、')}`);
    }
    const me = agentCode(agent.id);
    return this.write(() => {
      const updated = this.setStatus(t, me, 'working', {
        assignee: agent.id,
        lease: this.lease(agent),
        summary: `${agent.name}（${me}）领取了 ${code}「${t.title}」`,
      });
      return this.taskView(updated);
    });
  }

  accept(agent: AgentRow, code: string): TaskView {
    const t = this.requireTask(code);
    this.requireAssignee(agent, t, code);
    if (t.status !== 'assigned') throw conflict(`${code} 当前状态是「${STATUS_LABELS[t.status]}」，无需接受`);
    const me = agentCode(agent.id);
    return this.write(() =>
      this.taskView(
        this.setStatus(t, me, 'working', {
          lease: this.lease(agent),
          summary: `${agent.name}（${me}）接受了 ${code}「${t.title}」`,
        }),
      ),
    );
  }

  decline(agent: AgentRow, code: string, reason: string): TaskView {
    const t = this.requireTask(code);
    this.requireAssignee(agent, t, code);
    if (t.status !== 'assigned') throw conflict(`只能拒绝尚未接受的指派`);
    if (!reason?.trim()) throw invalid('请说明拒绝的理由');
    const me = agentCode(agent.id);
    return this.write(() =>
      this.taskView(
        this.setStatus(t, me, 'open', {
          assignee: null,
          lease: null,
          summary: `${agent.name}（${me}）拒绝了 ${code}：${reason}`,
          data: { reason },
        }),
      ),
    );
  }

  progress(agent: AgentRow, code: string, input: { percent?: number; note: string; notes?: string }): TaskView {
    const t = this.requireTask(code);
    this.requireAssignee(agent, t, code);
    if (!['assigned', 'working', 'input_required'].includes(t.status)) {
      throw conflict(`${code} 当前状态是「${STATUS_LABELS[t.status]}」，不能上报进度`);
    }
    const note = input.note?.trim();
    if (!note) throw invalid('请用一句话说明当前进展（note）');
    const percent = input.percent === undefined ? t.progress : Math.round(Number(input.percent));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw invalid('percent 必须是 0–100 的数字');
    const me = agentCode(agent.id);
    return this.write(() => {
      let row = t;
      if (t.status === 'assigned') {
        row = this.setStatus(t, me, 'working', { lease: this.lease(agent), summary: `${agent.name}（${me}）接受了 ${code}「${t.title}」` });
      }
      this.db
        .prepare(
          'UPDATE tasks SET progress = ?, progress_note = ?, notes = ?, lease_until = ?, lease_warned = 0, updated_at = ?, version = version + 1 WHERE id = ?',
        )
        .run(percent, note, input.notes ?? row.notes, this.lease(agent), this.iso(), t.id);
      this.db
        .prepare('INSERT INTO progress_log (task_id, author, percent, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(t.id, me, percent, note, this.iso());
      const updated = this.taskById(t.id);
      this.emit('task.progress', me, {
        task: updated,
        data: { percent, note, assignee: me },
        summary: `${agent.name}：${code} 进度 ${percent}%，${note}`,
      });
      return this.taskView(updated);
    });
  }

  block(agent: AgentRow, code: string, reason: string): TaskView {
    const t = this.requireTask(code);
    this.requireAssignee(agent, t, code);
    if (t.status !== 'working') throw conflict(`只有进行中的任务可以标记阻塞`);
    if (!reason?.trim()) throw invalid('请说明阻塞的原因');
    const me = agentCode(agent.id);
    return this.write(() =>
      this.taskView(
        this.setStatus(t, me, 'input_required', {
          block_reason: reason,
          summary: `${agent.name}（${me}）标记 ${code} 阻塞：${reason}`,
          data: { reason },
        }),
      ),
    );
  }

  unblock(actor: Actor, code: string, note?: string): TaskView {
    const t = this.requireTask(code);
    if (actor.kind === 'agent') this.requireAssignee(actor.agent, t, code);
    if (t.status !== 'input_required') throw conflict(`${code} 没有处于阻塞状态`);
    const who = actor.kind === 'owner' ? 'owner' : agentCode(actor.agent.id);
    return this.write(() =>
      this.taskView(
        this.setStatus(t, who, 'working', {
          summary: `${this.actorName(who)}解除了 ${code} 的阻塞${note ? `：${note}` : ''}`,
          data: { note: note ?? '' },
        }),
      ),
    );
  }

  submit(agent: AgentRow, code: string, input: { summary: string; artifacts?: { name?: string; parts: Part[] }[] }): TaskView {
    const t = this.requireTask(code);
    this.requireAssignee(agent, t, code);
    if (t.status !== 'working') throw conflict(`只有进行中的任务可以提交验收`);
    const summary = input.summary?.trim();
    if (!summary) throw invalid('请写一段交付说明（summary）');
    const me = agentCode(agent.id);
    return this.write(() => {
      const now = this.iso();
      this.db
        .prepare('INSERT INTO artifacts (task_id, author, name, parts, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(t.id, me, '交付说明', JSON.stringify([{ kind: 'text', text: summary }]), now);
      for (const a of input.artifacts ?? []) {
        this.db
          .prepare('INSERT INTO artifacts (task_id, author, name, parts, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(t.id, me, a.name ?? '交付物', JSON.stringify(a.parts ?? []), now);
      }
      const fresh = this.taskById(t.id);
      const updated = this.setStatus(fresh, me, 'review', {
        lease: null,
        summary: `${agent.name}（${me}）提交了 ${code}「${t.title}」等待验收`,
        data: { summary },
      });
      return this.taskView(updated);
    });
  }

  release(agent: AgentRow, code: string, reason: string): TaskView {
    const t = this.requireTask(code);
    this.requireAssignee(agent, t, code);
    if (!['assigned', 'working', 'input_required'].includes(t.status)) throw conflict(`${code} 当前状态不能放弃`);
    if (!reason?.trim()) throw invalid('请说明放弃的理由');
    const me = agentCode(agent.id);
    return this.write(() =>
      this.taskView(
        this.setStatus(t, me, 'open', {
          assignee: null,
          lease: null,
          summary: `${agent.name}（${me}）放弃了 ${code}：${reason}`,
          data: { reason },
        }),
      ),
    );
  }

  approve(code: string, comment?: string): TaskView {
    const t = this.requireTask(code);
    if (t.status !== 'review') throw conflict(`${code} 不在待验收状态`);
    return this.write(() => {
      if (comment?.trim()) this.addComment('owner', t, comment);
      const updated = this.setStatus(this.taskById(t.id), 'owner', 'completed', {
        lease: null,
        summary: `负责人验收通过了 ${code}「${t.title}」`,
      });
      return this.taskView(updated);
    });
  }

  reject(code: string, reason: string): TaskView {
    const t = this.requireTask(code);
    if (t.status !== 'review') throw conflict(`${code} 不在待验收状态`);
    if (!reason?.trim()) throw invalid('请写明修改意见');
    const assignee = t.assignee_id ? this.requireAgentRow(agentCode(t.assignee_id)) : null;
    return this.write(() => {
      this.addComment('owner', t, `验收未通过：${reason}`);
      const updated = this.setStatus(this.taskById(t.id), 'owner', 'working', {
        lease: assignee ? this.lease(assignee) : null,
        summary: `负责人退回了 ${code}：${reason}`,
        data: { reason },
      });
      return this.taskView(updated);
    });
  }

  cancel(code: string, reason?: string): TaskView {
    const t = this.requireTask(code);
    if (['completed', 'canceled'].includes(t.status)) throw conflict(`${code} 已经${STATUS_LABELS[t.status]}`);
    return this.write(() =>
      this.taskView(
        this.setStatus(t, 'owner', 'canceled', {
          lease: null,
          summary: `负责人取消了 ${code}「${t.title}」${reason ? `：${reason}` : ''}`,
          data: { reason: reason ?? '' },
        }),
      ),
    );
  }

  // ───────────── 文件 ─────────────

  /** 登记一个上传的文件，返回文件编号（同时也是难以猜测的下载地址的一部分）。内容由调用方写到磁盘。 */
  recordFile(uploader: string, input: { name: string; mime: string; size: number }): Part {
    const id = randomBytes(18).toString('base64url');
    const name = input.name.replace(/[\\/\0]/g, '_').slice(0, 200) || 'file';
    this.db
      .prepare('INSERT INTO files (id, name, mime, size, uploader, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, name, input.mime, input.size, uploader, this.iso());
    return { kind: 'file', name, mime: input.mime, size: input.size, url: `/files/${id}` };
  }

  getFile(id: string): { id: string; name: string; mime: string; size: number } | null {
    return (this.db.prepare('SELECT id, name, mime, size FROM files WHERE id = ?').get(id) as never) ?? null;
  }

  /** 把交付物里的 file_id 换成文件信息。 */
  filePart(id: string): Part {
    const f = this.getFile(id);
    if (!f) throw invalid(`找不到上传的文件 ${id}`);
    return { kind: 'file', name: f.name, mime: f.mime, size: f.size, url: `/files/${f.id}` };
  }

  // ───────────── 讨论与消息 ─────────────

  /** 找出文本里 @ 到的对象：@A-3、@负责人/@owner，或 @项目成员的完整名字（如 @Codex-后端）。 */
  private mentionTargets(text: string, projectId: number): string[] {
    const found: { at: number; target: string }[] = [];
    for (const m of text.matchAll(MENTION_RE)) {
      const target = /^A-\d+$/i.test(m[1]) ? m[1].toUpperCase() : 'owner';
      if (target !== 'owner' && !this.isMember(parseId(target, 'A')!, projectId)) continue;
      found.push({ at: m.index, target });
    }
    const members = this.db
      .prepare('SELECT a.id, a.name FROM agents a JOIN memberships m ON m.agent_id = a.id WHERE m.project_id = ?')
      .all(projectId) as { id: number; name: string }[];
    // 名字长的先匹配，避免「Codex」抢走「Codex-后端」
    const taken = new Set(found.map((f) => f.at));
    for (const a of members.filter((x) => x.name).sort((x, y) => y.name.length - x.name.length)) {
      const needle = `@${a.name}`;
      for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
        if (taken.has(i)) continue;
        taken.add(i);
        found.push({ at: i, target: agentCode(a.id) });
      }
    }
    return found.sort((x, y) => x.at - y.at).map((f) => f.target);
  }

  private addComment(author: string, t: TaskRow, text: string) {
    const parts: Part[] = [{ kind: 'text', text }];
    const r = this.db
      .prepare('INSERT INTO comments (task_id, author, parts, created_at) VALUES (?, ?, ?, ?)')
      .run(t.id, author, JSON.stringify(parts), this.iso());
    const code = taskCode(t.project_id, t.num);
    const who = this.actorName(author);
    const assignee = t.assignee_id === null ? null : agentCode(t.assignee_id);
    this.emit('comment.created', author, {
      task: t,
      data: { comment_id: Number(r.lastInsertRowid), text, assignee },
      summary: `${who}在 ${code} 下评论：${excerpt(text)}`,
    });
    const mentioned = new Set<string>();
    for (const target of this.mentionTargets(text, t.project_id)) {
      if (target === author || mentioned.has(target)) continue;
      mentioned.add(target);
      this.emit('mention', author, {
        task: t,
        audience: target === 'owner' ? [] : [target],
        data: { target, text },
        summary: `${who}在 ${code} 里 @了${target === 'owner' ? '负责人' : '你'}：${excerpt(text)}`,
      });
    }
  }

  comment(actor: Actor, code: string, text: string) {
    const t = this.requireTask(code);
    this.assertVisible(actor, t);
    if (!text?.trim()) throw invalid('评论内容不能为空');
    const author = actor.kind === 'owner' ? 'owner' : agentCode(actor.agent.id);
    this.write(() => this.addComment(author, t, text.trim()));
    return this.getTask(code).comments.at(-1)!;
  }

  message(actor: Actor, to: string, body: string) {
    if (!body?.trim()) throw invalid('私信内容不能为空');
    const from = actor.kind === 'owner' ? 'owner' : agentCode(actor.agent.id);
    let target: string;
    if (/^(owner|负责人)$/i.test(to)) {
      if (actor.kind === 'owner') throw invalid('不能给自己发私信');
      target = 'owner';
    } else {
      const a = this.requireAgentRow(to);
      target = agentCode(a.id);
      if (actor.kind === 'agent') {
        const shared = this.db
          .prepare('SELECT 1 FROM memberships a JOIN memberships b ON a.project_id = b.project_id WHERE a.agent_id = ? AND b.agent_id = ?')
          .get(actor.agent.id, a.id);
        if (!shared) throw forbidden(`你和 ${to} 没有共同参与的项目`);
      }
    }
    return this.write(() => {
      this.db
        .prepare('INSERT INTO messages (sender, recipient, body, created_at) VALUES (?, ?, ?, ?)')
        .run(from, target, body.trim(), this.iso());
      this.emit('message.direct', from, {
        audience: target === 'owner' ? [] : [target],
        data: { from, to: target, body: body.trim() },
        summary: `${this.actorName(from)}给${target === 'owner' ? '负责人' : '你'}发来私信：${excerpt(body)}`,
      });
      return { ok: true };
    });
  }

  listMessages(filter: { agent?: string } = {}) {
    const rows = (
      filter.agent
        ? this.db
            .prepare('SELECT * FROM messages WHERE sender = ? OR recipient = ? ORDER BY id DESC LIMIT 200')
            .all(filter.agent, filter.agent)
        : this.db.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT 200').all()
    ) as { id: number; sender: string; recipient: string; body: string; created_at: string }[];
    return rows.map((m) => ({ ...m, sender_name: this.actorName(m.sender), recipient_name: this.actorName(m.recipient) }));
  }

  broadcast(project: string, body: string) {
    const p = this.requireProject(project);
    if (!body?.trim()) throw invalid('广播内容不能为空');
    return this.write(() => {
      this.emit('owner.broadcast', 'owner', {
        project: p.id,
        data: { body: body.trim() },
        summary: `负责人在项目 ${project} 广播：${excerpt(body, 80)}`,
      });
      return { ok: true };
    });
  }

  // ───────────── 租约 ─────────────

  /** 找出租约到期的任务，提醒负责人和当事 agent（每个租约只提醒一次，不自动收回）。 */
  /** 定时调用：任务快到截止时间（2 小时内）和已经逾期时，各提醒负责的 agent 一次（没人负责时只提醒负责人）。 */
  sweepDue(): number {
    const now = this.now().getTime();
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE due_at IS NOT NULL AND due_at < ? AND due_warned < 2
         AND status IN ('open','assigned','working','input_required')`,
      )
      .all(new Date(now + DUE_SOON_MS).toISOString()) as unknown as TaskRow[];
    let n = 0;
    this.write(() => {
      for (const t of rows) {
        const overdue = Date.parse(t.due_at!) <= now;
        if (!overdue && t.due_warned >= 1) continue;
        n++;
        this.db.prepare('UPDATE tasks SET due_warned = ? WHERE id = ?').run(overdue ? 2 : 1, t.id);
        const who = t.assignee_id === null ? null : agentCode(t.assignee_id);
        const code = taskCode(t.project_id, t.num);
        const left = Math.max(1, Math.round((Date.parse(t.due_at!) - now) / 60_000));
        this.emit(overdue ? 'task.overdue' : 'task.due_soon', 'owner', {
          task: t,
          audience: who ? [who] : [],
          data: { assignee: who, due_at: t.due_at },
          summary: overdue
            ? `${code}「${t.title}」已超过截止时间${who ? `（${this.agentName(t.assignee_id)}）` : '，还没有人领取'}`
            : `${code}「${t.title}」还有 ${left >= 60 ? `${Math.round(left / 60)} 小时` : `${left} 分钟`}到截止时间${who ? '' : '，还没有人领取'}`,
        });
      }
    });
    return n;
  }

  sweepLeases(): number {
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE lease_until IS NOT NULL AND lease_until < ? AND lease_warned = 0 AND status IN ('working','input_required')`,
      )
      .all(this.iso()) as unknown as TaskRow[];
    if (rows.length === 0) return 0;
    this.write(() => {
      for (const t of rows) {
        this.db.prepare('UPDATE tasks SET lease_warned = 1 WHERE id = ?').run(t.id);
        const who = t.assignee_id === null ? null : agentCode(t.assignee_id);
        this.emit('task.lease_expiring', 'owner', {
          task: t,
          audience: who ? [who] : [],
          data: { assignee: who, lease_until: t.lease_until },
          summary: `${taskCode(t.project_id, t.num)} 已经很久没有上报进度，可能已失联${who ? `（${this.agentName(t.assignee_id)}）` : ''}`,
        });
      }
    });
    return rows.length;
  }

  // ───────────── 幂等 ─────────────

  idempotent<T>(agent: AgentRow, key: string | undefined, fn: () => T): T {
    if (!key) return fn();
    const hit = this.db.prepare('SELECT response FROM idempotency WHERE agent_id = ? AND key = ?').get(agent.id, key) as
      | { response: string }
      | undefined;
    if (hit) return JSON.parse(hit.response) as T;
    const result = fn();
    this.db
      .prepare('INSERT OR REPLACE INTO idempotency (agent_id, key, response, created_at) VALUES (?, ?, ?, ?)')
      .run(agent.id, key, JSON.stringify(result ?? null), this.iso());
    return result;
  }

  // ───────────── 统计 ─────────────

  /** 最近 days 天的产出统计：每天新建/完成数，以及每个 agent 的完成数、平均用时、退回率。 */
  stats(project?: string, days = 14) {
    const projectId = project ? this.requireProject(project).id : null;
    const scope = projectId === null ? '' : 'AND project_id = ?';
    const params = projectId === null ? [] : [projectId];
    const now = this.now();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1));
    const startIso = start.toISOString();
    const dayKey = (iso: string) => {
      const d = new Date(iso);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const daily = new Map<string, { date: string; created: number; completed: number }>();
    for (let i = 0; i < days; i++) {
      const k = dayKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i).toISOString());
      daily.set(k, { date: k, created: 0, completed: 0 });
    }
    const created = this.db.prepare(`SELECT created_at FROM tasks WHERE status != 'draft' AND created_at >= ? ${scope}`).all(startIso, ...params) as {
      created_at: string;
    }[];
    for (const r of created) {
      const d = daily.get(dayKey(r.created_at));
      if (d) d.created++;
    }

    type Per = { completed: number; submitted: number; rejected: number; hours: number[] };
    const per = new Map<string, Per>();
    const of = (code: string) => {
      let p = per.get(code);
      if (!p) per.set(code, (p = { completed: 0, submitted: 0, rejected: 0, hours: [] }));
      return p;
    };
    const firstWorking = new Map<number, number>();
    const changes = this.db
      .prepare(`SELECT at, task_id, data FROM events WHERE type = 'task.status_changed' ${scope} ORDER BY seq`)
      .all(...params) as { at: string; task_id: number; data: string }[];
    for (const e of changes) {
      const d = json<{ from?: string; to?: string; assignee?: string | null }>(e.data, {});
      if (d.to === 'working' && !firstWorking.has(e.task_id)) firstWorking.set(e.task_id, Date.parse(e.at));
      if (e.at < startIso || !d.assignee) continue;
      const p = of(d.assignee);
      if (d.to === 'review') p.submitted++;
      if (d.from === 'review' && d.to === 'working') p.rejected++;
      if (d.to === 'completed') {
        p.completed++;
        const day = daily.get(dayKey(e.at));
        if (day) day.completed++;
        const began = firstWorking.get(e.task_id);
        if (began !== undefined) p.hours.push((Date.parse(e.at) - began) / 3600_000);
      }
    }

    const nowIso = now.toISOString();
    const live = this.db
      .prepare(`SELECT assignee_id, status, due_at FROM tasks WHERE assignee_id IS NOT NULL AND status IN ('working','input_required','assigned') ${scope}`)
      .all(...params) as { assignee_id: number; status: string; due_at: string | null }[];
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    const agents = this.listAgents(project).map((a) => {
      const p = per.get(a.id) ?? { completed: 0, submitted: 0, rejected: 0, hours: [] };
      const mine = live.filter((t) => agentCode(t.assignee_id) === a.id);
      return {
        id: a.id,
        name: a.name,
        completed: p.completed,
        submitted: p.submitted,
        rejected: p.rejected,
        reject_rate: p.submitted ? Math.round((p.rejected / p.submitted) * 100) : null,
        avg_hours: avg(p.hours),
        working: mine.filter((t) => t.status !== 'assigned').length,
        overdue: mine.filter((t) => t.due_at !== null && t.due_at < nowIso).length,
      };
    });
    const all = [...per.values()];
    const sum = (f: (p: Per) => number) => all.reduce((n, p) => n + f(p), 0);
    return {
      days: [...daily.values()],
      totals: {
        created: created.length,
        completed: sum((p) => p.completed),
        avg_hours: avg(all.flatMap((p) => p.hours)),
        reject_rate: sum((p) => p.submitted) ? Math.round((sum((p) => p.rejected) / sum((p) => p.submitted)) * 100) : null,
      },
      agents: agents.sort((a, b) => b.completed - a.completed || a.id.localeCompare(b.id)),
    };
  }

  // ───────────── 总览 ─────────────

  overview(project?: string) {
    const projectId = project ? this.requireProject(project).id : null;
    const scope = projectId === null ? '' : 'AND project_id = ?';
    const params = projectId === null ? [] : [projectId];
    const count = (status: string) =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = ? ${scope}`).get(status, ...params) as { n: number }).n;
    const lost = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE lease_warned = 1 AND status IN ('working','input_required') ${scope}`)
        .get(...params) as { n: number }
    ).n;
    const now = this.iso();
    const overdue = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE due_at IS NOT NULL AND due_at < ? AND status IN (${LIVE_SQL}) ${scope}`)
        .get(now, ...params) as { n: number }
    ).n;
    const attention = this.db
      .prepare(
        `SELECT * FROM tasks WHERE (status IN ('review','input_required','draft') OR (lease_warned = 1 AND status = 'working')
           OR (due_at IS NOT NULL AND due_at < ? AND status IN (${LIVE_SQL}))) ${scope}
         ORDER BY updated_at DESC LIMIT 50`,
      )
      .all(now, ...params) as unknown as TaskRow[];
    const mentions = this.eventsForOwner({ limit: 20, project })
      .filter((e) => (e.type === 'mention' || e.type === 'message.direct') && e.audience !== null && e.audience.length === 0);
    return {
      counts: {
        working: count('working'),
        review: count('review'),
        input_required: count('input_required'),
        open: count('open'),
        lost,
        overdue,
      },
      attention: attention.map((t) => this.taskView(t)),
      mentions,
      agents_online: this.listAgents(project).filter((a) => a.online).length,
    };
  }
}

const DUE_SOON_MS = 2 * 3600_000;
const LIVE_SQL = "'open','assigned','working','input_required'";

/** 截止时间统一存成 ISO；空串表示清除。 */
function normalizeDue(v: string | null | undefined): string | null {
  if (v == null || v.trim() === '') return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw invalid(`截止时间格式不对：${v}，请用 ISO 格式，如 2026-11-01T18:00:00+08:00`);
  return new Date(ms).toISOString();
}

export interface SearchHit {
  id: number;
  task: string | null;
  title: string | null;
  who: string;
  text: string;
  at: string;
}

/** 关键字前后各留一段上下文 */
function snippet(text: string, kw: string, around = 30) {
  const flat = text.replace(/\s+/g, ' ').trim();
  const i = flat.toLowerCase().indexOf(kw.toLowerCase());
  if (i < 0) return excerpt(flat, around * 2);
  const start = Math.max(0, i - around);
  const end = Math.min(flat.length, i + kw.length + around);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export interface TemplateBody {
  title: string;
  description: string;
  acceptance: string[];
  priority: Priority;
  required_tags: string[];
  subtasks: string[]; // 子任务标题，每项一个
  chain: boolean; // 子任务是否按顺序依次进行（后一个依赖前一个）
}

export type TemplateView = TemplateBody & { id: number; name: string; updated_at: string };

const EMPTY_TEMPLATE: TemplateBody = { title: '', description: '', acceptance: [], priority: 'P2', required_tags: [], subtasks: [], chain: false };

function excerpt(text: string, n = 60) {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function fieldLabel(f: string) {
  return (
    {
      title: '标题',
      description: '描述',
      acceptance: '验收标准',
      priority: '优先级',
      required_tags: '能力标签',
      depends_on: '依赖',
      due_at: '截止时间',
    } as Record<string, string>
  )[f] ?? f;
}
