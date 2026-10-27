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

/** 预设标签的默认值，负责人可以在设置里改 */
export const DEFAULT_PRESET_TAGS = ['前端', '后端', '移动端', '测试', '文档', '设计', '运维', '数据'];

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
  daemon_paused: number;
  can_invite: number;
  /** 身份码明文；老身份（原来的令牌）为 null */
  code: string | null;
}

export interface SessionRow {
  id: number;
  agent_id: number;
  token_hash: string;
  client: string;
  host: string;
  cwd: string;
  ip: string;
  created_at: string;
  last_seen_at: string;
  ended_at: string | null;
  end_reason: SessionEndReason | null;
  end_note: string;
}

/** released 进程退出时交还；expired 超时自动下线；replaced 被别处的新连接顶掉；revoked 负责人强制下线 */
export type SessionEndReason = 'released' | 'expired' | 'replaced' | 'revoked';

export interface SessionView {
  /** 授权 ID 的前几位，用来区分不同连接 */
  id: string;
  client: string;
  client_label: string;
  host: string;
  cwd: string;
  ip: string;
  created_at: string;
  last_seen_at: string;
  ended_at: string | null;
  end_reason: SessionEndReason | null;
  end_note: string;
}

const CLIENT_LABELS: Record<string, string> = { run: '值守', cli: '命令行', mcp: 'MCP' };

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
  refs: string;
  required_tags: string;
  progress: number;
  progress_note: string;
  notes: string;
  block_reason: string;
  block_options: string;
  lease_until: string | null;
  lease_warned: number;
  due_warned: number;
  stall_warned: number;
  due_at: string | null;
  opened_at: string | null;
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
  /** 值守进程（ahub run）是否连着 Hub，是否被负责人暂停 */
  daemon: boolean;
  daemon_paused: boolean;
  /** 在交互式会话里用 ahub wait --resident 常驻待命 */
  resident: boolean;
  /** 负责人允许它为所在项目创建邀请 */
  can_invite: boolean;
  /** 当前有效的连接（授权 ID）；不在线时为 null */
  connection: SessionView | null;
  /** 还没用身份码连接过 */
  pending: boolean;
  projects: { id: string; name: string; tags: string[] }[];
  active_tasks: string[];
}

/** 智能领取：一个可领取任务对某个 agent 的匹配度和它在所有候选里的名次 */
export interface ClaimFit {
  score: number;
  /** 从 1 开始；让出过就是 0 */
  rank: number;
  /** 候选人数（能自动响应的 agent，加上自己） */
  of: number;
  reasons: string[];
  warnings: string[];
  /** 任务最近一次变成可领取的时间，值守进程按它和名次错峰唤起 */
  open_since: string;
  passed: boolean;
}

export interface Recommendation {
  id: string;
  name: string;
  /** 0–100，越高越合适 */
  score: number;
  reasons: string[];
  warnings: string[];
  presence: Presence;
  load: number;
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
  /** 引用的同项目任务（参考资料，任意状态） */
  refs: string[];
  required_tags: string[];
  progress: number;
  progress_note: string;
  notes: string;
  block_reason: string;
  /** 阻塞时给负责人的可选答案 */
  block_options: string[];
  /** 疑似原地打转：一直在报进度，但百分比很久没变 */
  stalled: boolean;
  lease_until: string | null;
  due_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}

export interface TaskDetail extends TaskView {
  subtasks: TaskView[];
  /** 引用的任务和引用了本任务的任务，带标题和状态方便直接展示 */
  ref_tasks: TaskBrief[];
  referenced_by: TaskBrief[];
  comments: { id: number; author: string; author_name: string; parts: Part[]; created_at: string; receipts: ReceiptView[] }[];
  /** 指派、退回等需要处理的事项被 agent 接手的回执 */
  receipts: ReceiptView[];
  artifacts: ArtifactView[];
  progress_log: { author: string; percent: number; note: string; created_at: string }[];
  /** 看过任务后觉得不适合、让给别人的 agent */
  passes: { agent: string; agent_name: string; reason: string; created_at: string }[];
  /** 待领取时：能自动领取的 agent 按匹配度的排名，值守进程按这个名次错峰唤起 */
  candidates: ClaimCandidate[];
  /** 最近一次变成可领取的时间 */
  open_since: string | null;
}

export interface ClaimCandidate {
  rank: number;
  agent: string;
  agent_name: string;
  score: number;
  reasons: string[];
  warnings: string[];
}

export type ReceiptKind = 'comment' | 'message' | 'task';
/** working 处理中 👌、done 已处理 ✅、failed 处理失败 ⚠️、stopped 处理中断 ⏸ */
export type ReceiptState = 'working' | 'done' | 'failed' | 'stopped';
const RECEIPT_STATES: ReceiptState[] = ['working', 'done', 'failed', 'stopped'];

export interface ReceiptView {
  agent: string;
  agent_name: string;
  state: ReceiptState;
  note: string;
  updated_at: string;
}

export interface TaskBrief {
  id: string;
  title: string;
  status: TaskStatus;
  status_label: string;
  assignee: string | null;
  assignee_name: string | null;
}

export interface ArtifactView {
  id: number;
  author: string;
  name: string;
  parts: Part[];
  created_at: string;
  /** 当前版本号，每次修改加一 */
  rev: number;
  /** 第几次提交（退回后重新提交会加一） */
  round: number;
  updated_at: string | null;
  updated_by: string | null;
}

export interface ArtifactRevision {
  rev: number;
  author: string;
  author_name: string;
  parts: Part[];
  note: string;
  created_at: string;
}

interface ArtifactRow {
  id: number;
  task_id: number;
  author: string;
  name: string;
  parts: string;
  created_at: string;
  rev: number;
  round: number;
  updated_at: string | null;
  updated_by: string | null;
}

/** 交付物里可以按文本修改的部分：只有一段文本时才能整份替换文本或打补丁。 */
const editableText = (parts: Part[]) => {
  const texts = parts.filter((p) => p.kind === 'text' && typeof p.text === 'string');
  return texts.length === 1 && parts.length === 1 ? texts[0].text! : null;
};

/** 预设名称会写进启动命令的引号里，去掉会破坏命令的字符。 */
const inviteName = (name?: string) => (name ?? '').trim().replace(/["`$\\]/g, '').slice(0, 40);

const countOf = (text: string, part: string) => {
  let n = 0;
  for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + 1)) n++;
  return n;
};

export interface InboxResult {
  agent: string;
  ack_seq: number;
  last_seq: number;
  more: boolean;
  events: HubEvent[];
  needs_action: HubEvent[];
  my_tasks: TaskView[];
  pending_assignments: TaskView[];
  claimable: (TaskView & { fit: ClaimFit })[];
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

/** 身份码：12 位，分三组，约 60 位随机性；可以反复使用，所以比一次性的邀请码长 */
function newIdentityCode(): string {
  let s = '';
  for (let i = 0; i < 12; i++) s += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

/** 身份码不区分大小写、可以不写连字符；老身份的令牌（ahub_…）原样使用 */
function normalizeCode(input: string): string {
  const t = input.trim();
  const m = /^([a-z0-9]{4})-?([a-z0-9]{4})-?([a-z0-9]{4})$/i.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}`.toUpperCase() : t;
}

const MENTION_RE = /@(A-\d+|负责人|owner)/gi;

export interface HubOptions {
  now?: () => Date;
  /** 多久没有任何请求算离线（分钟），默认 30；授权 ID 随之失效 */
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
  /** agent id → 最近一次常驻等待（ahub wait --resident）的时间（毫秒） */
  private residents = new Map<number, number>();
  private offlineAfterMs: number;
  private streamGraceMs: number;

  constructor(
    readonly db: Db,
    opts: HubOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.offlineAfterMs = (opts.offlineAfterMinutes ?? 30) * 60_000;
    this.streamGraceMs = (opts.streamGraceMinutes ?? 2) * 60_000;
    this.bus.setMaxListeners(0);
    // 负责人在控制台改过的超时时长优先于启动参数
    const saved = (key: string) => {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return row ? Number(row.value) : NaN;
    };
    const idle = saved('presence_idle_minutes');
    const grace = saved('presence_stream_grace_minutes');
    if (idle > 0) this.offlineAfterMs = idle * 60_000;
    if (grace > 0) this.streamGraceMs = grace * 60_000;
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
      this.sessionEnds = [];
      throw err;
    }
    const events = this.pending;
    this.pending = [];
    for (const e of events) this.bus.emit('event', e);
    const ends = this.sessionEnds;
    this.sessionEnds = [];
    for (const e of ends) this.bus.emit('session.ended', e);
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

  /** 按身份码找 agent（不管是否停用）。老身份的令牌也当作身份码。 */
  agentByCode(code: string): AgentRow | null {
    const t = (code ?? '').trim();
    if (!t) return null;
    for (const c of new Set([normalizeCode(t), t])) {
      const row = this.db.prepare('SELECT * FROM agents WHERE token_hash = ?').get(hashToken(c)) as AgentRow | undefined;
      if (row) return row;
    }
    return null;
  }

  /** 身份对应的 agent 已被停用或删除时，给出具体原因，方便命令行清掉失效的本地配置。 */
  private inactiveError(row: AgentRow): HubError | null {
    if (row.status === 'active') return null;
    const who = `${row.name}（${agentCode(row.id)}）`;
    return row.status === 'deleted'
      ? new HubError(401, 'agent_deleted', `身份 ${who}已被负责人删除`)
      : new HubError(401, 'agent_disabled', `身份 ${who}已被负责人停用`);
  }

  // ───────────── 授权 ID（连接） ─────────────

  private failedLogins = new Map<string, { n: number; at: number }>();

  activeSession(agentId: number): SessionRow | null {
    return (this.db.prepare('SELECT * FROM sessions WHERE agent_id = ? AND ended_at IS NULL').get(agentId) as SessionRow | undefined) ?? null;
  }

  sessionView(r: SessionRow): SessionView {
    return {
      id: `as_${r.token_hash.slice(0, 8)}`,
      client: r.client,
      client_label: CLIENT_LABELS[r.client] ?? r.client,
      host: r.host,
      cwd: r.cwd,
      ip: r.ip,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
      ended_at: r.ended_at,
      end_reason: r.end_reason,
      end_note: r.end_note,
    };
  }

  private describeSession(r: SessionRow) {
    const where = [r.host, CLIENT_LABELS[r.client] ?? r.client, r.cwd].filter(Boolean).join('，');
    return where ? `${where}` : '另一处';
  }

  /**
   * 用身份码换授权 ID。同一身份同时只能有一个有效的授权 ID：
   * 已有有效连接时拒绝，除非 takeover（顶掉旧连接）；旧连接已经超时则直接接手。
   * 兼容老的一次性邀请码：用它创建新身份，同时返回新身份码让客户端保存。
   */
  openSession(input: {
    code: string;
    client?: string;
    host?: string;
    cwd?: string;
    ip?: string;
    takeover?: boolean;
    name?: string;
    platform?: string;
    tier?: string;
    description?: string;
    skills?: string[];
    tags?: string[];
  }): { session: string; code: string | null; agent: AgentView } {
    const ip = input.ip ?? '';
    const now = this.now().getTime();
    const fails = this.failedLogins.get(ip);
    if (fails && now - fails.at < 60_000 && fails.n >= 10) throw new HubError(429, 'too_many_attempts', '身份码错误次数太多，请一分钟后再试');
    let agent = this.agentByCode(input.code ?? '');
    let issued: string | null = null;
    if (!agent && /^[A-Z0-9]{3}-?[A-Z0-9]{3}$/i.test((input.code ?? '').trim())) {
      // 老的邀请码：创建身份（并加入项目），之后用新身份码
      const invite = (input.code ?? '').trim().toUpperCase().replace(/^(...)-?(...)$/, '$1-$2');
      const exists = this.db.prepare('SELECT 1 FROM invites WHERE code = ?').get(invite);
      if (exists) {
        const r = this.join({ ...input, invite }, null);
        issued = r.code;
        agent = this.agentByCode(r.code!);
      }
    }
    if (!agent) {
      this.failedLogins.set(ip, { n: (fails && now - fails.at < 60_000 ? fails.n : 0) + 1, at: fails && now - fails.at < 60_000 ? fails.at : now });
      throw new HubError(401, 'invalid_code', '身份码无效：请检查是否抄错，或向负责人确认这个身份码没有被重置');
    }
    const inactive = this.inactiveError(agent);
    if (inactive) throw inactive;
    const name = input.name?.trim();
    if (!agent.name && !name) throw invalid('这个身份还没有名字：第一次连接时请用 --name 给自己起一个简短、能区分的名字');
    const client = ['run', 'cli', 'mcp'].includes(input.client ?? '') ? input.client! : 'cli';
    const host = String(input.host ?? '').slice(0, 80);
    const cwd = String(input.cwd ?? '').slice(0, 300);
    const a = agent;
    return this.write(() => {
      const first = !this.db.prepare('SELECT 1 FROM sessions WHERE agent_id = ?').get(a.id);
      const old = this.activeSession(a.id);
      let wasOnline = !!old;
      let replaced: SessionRow | null = null;
      if (old) {
        if (this.presenceOf(a) === 'offline') {
          this.closeSession(old, 'expired', '', { quiet: true });
          wasOnline = false;
        }
        else if (!input.takeover)
          throw new HubError(
            409,
            'already_online',
            `${a.name || agentCode(a.id)}（${agentCode(a.id)}）已经在线：${this.describeSession(old)}，最后活动 ${old.last_seen_at.slice(11, 19)}。` +
              '同一身份码同时只能有一个连接。确认要在这里接手，请加 --takeover 顶掉原来的连接。',
          );
        else {
          replaced = old;
          this.closeSession(old, 'replaced', [host, CLIENT_LABELS[client]].filter(Boolean).join('，'), { quiet: true });
        }
      }
      const token = newToken('as');
      const at = this.iso();
      this.db
        .prepare('INSERT INTO sessions (agent_id, token_hash, client, host, cwd, ip, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(a.id, hashToken(token), client, host, cwd, ip, at, at);
      if (name && !a.name) a.name = name;
      this.db
        .prepare(`UPDATE agents SET name = ?, platform = ?, last_seen_at = ?, presence = 'on' WHERE id = ?`)
        .run(a.name, first && input.platform ? input.platform : a.platform, at, a.id);
      const me = agentCode(a.id);
      const where = [host, CLIENT_LABELS[client]].filter(Boolean).join('，');
      if (replaced || !wasOnline) {
        this.emit('agent.online', me, {
          audience: [],
          data: { agent: me, client, host, replaced: replaced ? this.describeSession(replaced) : null },
          summary: replaced
            ? `${a.name}（${me}）在${where || '另一处'}重新上线，原来在${this.describeSession(replaced)}的连接已断开`
            : `${a.name}（${me}）上线了${where ? `（${where}）` : ''}`,
        });
      }
      return { session: token, code: issued, agent: this.agentView(this.requireAgentRow(me)) };
    });
  }

  /**
   * 验证授权 ID。失效的授权 ID 按原因给出不同的错误码，命令行据此决定是否自动重新连接：
   * 超时（session_expired）可以用身份码重新换；被顶掉（session_replaced）和强制下线（session_revoked）不能。
   */
  authSession(token: string): { agent: AgentRow; session: SessionRow } {
    const s = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as SessionRow | undefined;
    if (!s) {
      const byCode = this.agentByCode(token);
      if (byCode)
        throw new HubError(
          401,
          'session_required',
          '这是身份码，不是授权 ID：请先用身份码换取授权 ID（POST /api/v1/sessions）。用的是 ahub 命令行的话，请升级到和 Hub 同一版本：npm install -g <Hub 地址>/ahub.tgz',
        );
      throw new HubError(401, 'unauthorized', '缺少或无效的授权 ID');
    }
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(s.agent_id) as unknown as AgentRow;
    const inactive = this.inactiveError(agent);
    if (inactive) throw inactive;
    if (!s.ended_at && this.presenceOf(agent) === 'offline') {
      this.write(() => this.closeSession(s, 'expired', '', { quiet: false }));
      s.ended_at = this.iso();
      s.end_reason = 'expired';
    }
    if (s.ended_at) throw this.endedError(s);
    const now = this.iso();
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, s.id);
    s.last_seen_at = now;
    return { agent, session: s };
  }

  private endedError(s: SessionRow): HubError {
    switch (s.end_reason) {
      case 'revoked':
        return new HubError(401, 'session_revoked', `负责人已强制你下线${s.end_note ? `：${s.end_note}` : ''}。不要自动重连，等负责人重新启动你`);
      case 'replaced':
        return new HubError(401, 'session_replaced', `这个身份已经在别处上线（${s.end_note || '另一处'}），这里的连接已断开`);
      default:
        return new HubError(401, 'session_expired', '授权 ID 已过期（长时间没有活动或已交还），请用身份码重新连接');
    }
  }

  /** 结束一个连接。quiet 时不发离线通知（由调用方自己发，或马上会有新连接）。 */
  private closeSession(s: SessionRow, reason: SessionEndReason, note: string, opts: { quiet: boolean }) {
    if (s.ended_at) return;
    this.db.prepare('UPDATE sessions SET ended_at = ?, end_reason = ?, end_note = ? WHERE id = ?').run(this.iso(), reason, note, s.id);
    this.sessionEnds.push({ agentId: s.agent_id, sessionId: s.id, reason, note });
    if (reason === 'replaced') return;
    const a = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(s.agent_id) as unknown as AgentRow;
    this.db.prepare("UPDATE agents SET presence = 'off' WHERE id = ?").run(a.id);
    this.activity.delete(a.id);
    this.settleReceipts(a, 'stopped', { note: reason === 'revoked' ? '被负责人强制下线，处理中断' : '已下线，处理中断' });
    if (opts.quiet || a.status !== 'active') return;
    const me = agentCode(a.id);
    const tasks = this.agentView(a).active_tasks;
    this.emit('agent.offline', me, {
      audience: [],
      data: { agent: me, last_seen_at: a.last_seen_at, active_tasks: tasks, reason },
      summary:
        (reason === 'revoked'
          ? `负责人强制 ${a.name}（${me}）下线${note ? `：${note}` : ''}`
          : reason === 'released'
            ? `${a.name}（${me}）下线了`
            : `${a.name}（${me}）很久没有出现，已离线`) + (tasks.length ? `；手上还有 ${tasks.join('、')}` : ''),
    });
  }

  /** 自动下线的超时时长（分钟） */
  presenceSettings() {
    return { idle_minutes: Math.round(this.offlineAfterMs / 60_000), stream_grace_minutes: Math.round(this.streamGraceMs / 60_000) };
  }

  setPresenceSettings(input: { idle_minutes?: number; stream_grace_minutes?: number }) {
    const check = (v: number | undefined, min: number, max: number, what: string) => {
      if (v === undefined) return undefined;
      if (!Number.isInteger(v) || v < min || v > max) throw invalid(`${what}要在 ${min} 到 ${max} 分钟之间`);
      return v;
    };
    const idle = check(input.idle_minutes, 5, 1440, '空闲超时');
    const grace = check(input.stream_grace_minutes, 1, 60, '值守断线宽限');
    const put = this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    if (idle !== undefined) {
      put.run('presence_idle_minutes', String(idle));
      this.offlineAfterMs = idle * 60_000;
    }
    if (grace !== undefined) {
      put.run('presence_stream_grace_minutes', String(grace));
      this.streamGraceMs = grace * 60_000;
    }
    return this.presenceSettings();
  }

  /** 进程退出时交还授权 ID，立即下线 */
  releaseSession(s: SessionRow) {
    this.write(() => this.closeSession(s, 'released', '', { quiet: false }));
    return { ok: true };
  }

  /** 负责人强制下线：吊销当前授权 ID。身份码仍可用，要彻底禁止请重置身份码或停用。 */
  kickAgent(code: string, note = '') {
    const a = this.requireAgentRow(code);
    const s = this.activeSession(a.id);
    if (!s) throw conflict(`${a.name}（${code}）当前不在线`);
    this.write(() => this.closeSession(s, 'revoked', note.trim().slice(0, 200), { quiet: false }));
    return this.agentView(this.requireAgentRow(code));
  }

  listSessions(code: string, limit = 20): SessionView[] {
    const a = this.requireAgentRow(code);
    const rows = this.db.prepare('SELECT * FROM sessions WHERE agent_id = ? ORDER BY id DESC LIMIT ?').all(a.id, limit) as unknown as SessionRow[];
    return rows.map((r) => this.sessionView(r));
  }

  /** 提交后要通知的连接结束（值守进程的实时连接据此断开） */
  private sessionEnds: { agentId: number; sessionId: number; reason: SessionEndReason; note: string }[] = [];

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

  /** 交互式会话里常驻待命的 agent：每次等待都会刷新，15 分钟没再等就不算了 */
  noteResident(agentId: number) {
    this.residents.set(agentId, this.now().getTime());
  }

  isResident(agentId: number) {
    const at = this.residents.get(agentId);
    return at !== undefined && this.now().getTime() - at < 15 * 60_000;
  }

  isLive(agentId: number) {
    return (this.live.get(agentId) ?? 0) > 0;
  }

  presenceOf(a: AgentRow): Presence {
    if (a.status !== 'active') return 'offline';
    // 没有有效的授权 ID 就是离线
    const s = this.activeSession(a.id);
    if (!s) return 'offline';
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
        const s = this.activeSession(a.id);
        if (s) this.closeSession(s, 'expired', '', { quiet: true });
        this.db.prepare("UPDATE agents SET presence = 'off' WHERE id = ?").run(a.id);
        this.settleReceipts(a, 'stopped', { note: '值守进程断开，处理中断' });
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
    this.write(() => {
      // 值守进程退出时，还挂着「处理中」的回执改成中断
      if (state === 'stopped') this.settleReceipts(agent, 'stopped', { note: '值守进程已退出，处理中断' });
      this.emit('agent.activity', agentCode(agent.id), {
        audience: [],
        data: { agent: agentCode(agent.id), state, note },
        summary:
          state === 'working'
            ? `${who}被唤醒：${note || '处理新事项'}`
            : state === 'stopped'
              ? `${who}的值守进程已退出`
              : `${who}处理完毕，回到待命${note ? `：${note}` : ''}`,
      });
    });
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
  inbox(agent: AgentRow, opts: { since?: number; project?: string; limit?: number; mark?: boolean } = {}): InboxResult {
    const since = opts.since ?? agent.ack_seq;
    const page = this.eventsForAgent(agent, since, opts.limit ?? 50, opts.project);
    const more = page.more;
    // 值守控制事件只给 ahub run 看，不放进 harness 的收件箱；但事件号照常推进
    const events = page.events.filter((e) => e.type !== 'agent.control');
    const lastSeq = page.events.length ? page.events[page.events.length - 1].seq : Math.max(since, 0);
    const me = agentCode(agent.id);
    const needs = events.filter((e) => this.needsAction(e, me));
    // 交互式会话读到需要处理的事项，就在对应的评论、私信、任务上打「处理中」的回执
    if (opts.mark && needs.length) this.write(() => this.applyReceipts(agent, needs.flatMap((e) => this.receiptTargets(e)), 'working'));
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
      last_seq: lastSeq,
      more,
      events,
      needs_action: needs,
      my_tasks: mine.filter((t) => t.status !== 'assigned').map((t) => this.taskView(t)),
      pending_assignments: mine.filter((t) => t.status === 'assigned').map((t) => this.taskView(t)),
      claimable: this.claimableFor(agent, projectFilter).map((t) => ({ ...this.taskView(t), fit: this.claimFit(t, agent) })),
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
        // 你拆的子任务提交了，等你验收（指派给你自己的不算，由负责人验收）
        if (e.data.to === 'review' && e.data.creator === me && e.data.assignee !== me) return true;
        // 被退回修改，或者别人（通常是负责人回答了问题）解除了你的阻塞
        return (
          e.data.assignee === me &&
          e.data.to === 'working' &&
          (e.data.from === 'review' || (e.data.from === 'input_required' && e.actor !== me))
        );
      case 'comment.created': {
        if (e.data.assignee !== me) return false;
        // 评论点名给了别的 agent（没有 @ 你）就不用你处理；被 @ 了会另有一条 mention
        const mentions = Array.isArray(e.data.mentions) ? (e.data.mentions as string[]) : [];
        return !mentions.length;
      }
      case 'task.unlocked':
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
        if (this.isTagging(t.id)) continue;
        if (!this.tagsMatch(t, [...tags, ...skills])) continue;
        if (!this.depsDone(t)) continue;
        out.push(t);
      }
    }
    return out.slice(0, 20);
  }

  /**
   * 智能领取的排名：在能自动响应的 agent（值守进程在线且没暂停，或常驻待命）里，按指派推荐的分数排，
   * 再算上「正在处理别的事」和「做过相关任务」。让出过的不参加；me 总是算作候选，方便它知道自己排第几。
   */
  claimRanking(t: TaskRow, me?: number): (Recommendation & { agentId: number })[] {
    const code = taskCode(t.project_id, t.num);
    const passed = new Set(
      (this.db.prepare('SELECT agent_id FROM task_passes WHERE task_id = ?').all(t.id) as { agent_id: number }[]).map((r) => r.agent_id),
    );
    // 做过父任务、兄弟任务、引用或前置任务的 agent 已经有上下文
    const relatedIds = [t.parent_id, ...json<number[]>(t.refs, []), ...json<number[]>(t.depends_on, [])].filter((x): x is number => !!x);
    const related = new Map<number, string>();
    const note = (rows: TaskRow[]) => {
      for (const r of rows) if (r.assignee_id !== null && !related.has(r.assignee_id)) related.set(r.assignee_id, taskCode(r.project_id, r.num));
    };
    if (relatedIds.length) note(this.db.prepare(`SELECT * FROM tasks WHERE id IN (${relatedIds.map(() => '?').join(',')})`).all(...relatedIds) as unknown as TaskRow[]);
    if (t.parent_id) note(this.db.prepare('SELECT * FROM tasks WHERE parent_id = ? AND id != ?').all(t.parent_id, t.id) as unknown as TaskRow[]);
    const out: (Recommendation & { agentId: number })[] = [];
    for (const r of this.recommend({ task: code })) {
      const id = parseId(r.id, 'A')!;
      if (passed.has(id)) continue;
      const row = this.requireAgentRow(r.id);
      if (id !== me) {
        if (!((this.hasDaemon(id) && !row.daemon_paused) || this.isResident(id))) continue;
        const m = this.db.prepare('SELECT tags FROM memberships WHERE project_id = ? AND agent_id = ?').get(t.project_id, id) as { tags: string } | undefined;
        if (!m || !this.tagsMatch(t, [...json<string[]>(m.tags, []), ...json<string[]>(row.skills, [])])) continue;
      }
      // 在线、有值守是参加排名的前提，人人都有，不再写进理由
      const x = { ...r, reasons: r.reasons.filter((y) => !/^(在线|最近活跃|有值守进程)/.test(y)), warnings: [...r.warnings], agentId: id };
      if (this.activity.get(id)?.state === 'working') {
        x.score -= 15;
        x.warnings.push('正在处理别的事');
      }
      const rel = related.get(id);
      if (rel) {
        x.score += 15;
        x.reasons.push(`做过相关任务 ${rel}`);
      }
      x.score = Math.max(0, Math.min(100, x.score));
      out.push(x);
    }
    return out.sort((a, b) => b.score - a.score || a.load - b.load || a.agentId - b.agentId);
  }

  claimFit(t: TaskRow, agent: AgentRow): ClaimFit {
    const open_since = t.opened_at ?? t.updated_at;
    const passed = !!this.db.prepare('SELECT 1 FROM task_passes WHERE task_id = ? AND agent_id = ?').get(t.id, agent.id);
    const ranking = this.claimRanking(t, passed ? undefined : agent.id);
    const i = ranking.findIndex((r) => r.agentId === agent.id);
    const mine = ranking[i];
    return {
      score: mine?.score ?? 0,
      rank: i + 1,
      of: ranking.length + (passed ? 1 : 0),
      reasons: mine?.reasons ?? [],
      warnings: passed ? ['你已经让出过这个任务'] : (mine?.warnings ?? []),
      open_since,
      passed,
    };
  }

  /** agent 看过任务后觉得不适合自己，让给别人；所有候选都让出了就提醒负责人。 */
  pass(agent: AgentRow, code: string, reason: string): { ok: true; task: string; remaining: number } {
    const t = this.requireTask(code);
    this.assertVisible({ kind: 'agent', agent }, t);
    if (t.status !== 'open') throw conflict(`${code} 当前状态是「${STATUS_LABELS[t.status]}」，只有待领取的任务可以让出`);
    if (!reason?.trim()) throw invalid('请说明为什么不适合你，负责人和其他 agent 会看到');
    const me = agentCode(agent.id);
    return this.write(() => {
      this.db
        .prepare('INSERT OR REPLACE INTO task_passes (task_id, agent_id, reason, created_at) VALUES (?, ?, ?, ?)')
        .run(t.id, agent.id, reason.trim().slice(0, 500), this.iso());
      this.emit('task.passed', me, {
        task: t,
        data: { agent: me, reason: reason.trim() },
        summary: `${agent.name}（${me}）让出了 ${code}「${t.title}」：${excerpt(reason.trim())}`,
      });
      const remaining = this.claimRanking(t).length;
      if (remaining === 0) {
        this.emit('task.unclaimed', 'owner', {
          task: t,
          audience: [],
          data: { passes: (this.db.prepare('SELECT COUNT(*) AS n FROM task_passes WHERE task_id = ?').get(t.id) as { n: number }).n },
          summary: `没有 agent 愿意领取 ${code}「${t.title}」：能自动领取的 agent 都让出了，可以看看让出理由，修改任务或直接指派`,
        });
      }
      return { ok: true as const, task: code, remaining };
    });
  }

  // ───────────── 标签 ─────────────

  /** 自动打标签进行中的任务：先不放进可领取列表，免得在打上标签前就被不合适的 agent 领走 */
  private tagging = new Map<number, number>();

  holdForTagging(taskId: number, ms = 30_000) {
    this.tagging.set(taskId, this.now().getTime() + ms);
  }

  releaseTagging(taskId: number) {
    this.tagging.delete(taskId);
  }

  private isTagging(taskId: number) {
    const until = this.tagging.get(taskId);
    if (until === undefined) return false;
    if (until > this.now().getTime()) return true;
    this.tagging.delete(taskId);
    return false;
  }

  /** 创建 agent（邀请码）时可选的预设标签；负责人在设置里维护 */
  presetTags(): string[] {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'preset_tags'").get() as { value: string } | undefined;
    return row ? json<string[]>(row.value, []) : DEFAULT_PRESET_TAGS;
  }

  setPresetTags(tags: string[]): string[] {
    const clean = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 50);
    if (clean.some((t) => t.length > 20)) throw invalid('每个标签最多 20 个字');
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('preset_tags', ?)").run(JSON.stringify(clean));
    return clean;
  }

  taskRowId(code: string) {
    return this.requireTask(code).id;
  }

  /** 预设标签和已经在用的标签（agent 的能力标签、任务要求的标签），给控制台的标签选择器用 */
  tagOptions(): { presets: string[]; in_use: string[] } {
    const used = new Set<string>();
    for (const r of this.db.prepare('SELECT tags FROM memberships').all() as { tags: string }[]) for (const t of json<string[]>(r.tags, [])) used.add(t);
    for (const r of this.db.prepare("SELECT skills FROM agents WHERE status = 'active'").all() as { skills: string }[]) for (const t of json<string[]>(r.skills, [])) used.add(t);
    for (const r of this.db.prepare("SELECT required_tags FROM tasks WHERE required_tags != '[]'").all() as { required_tags: string }[])
      for (const t of json<string[]>(r.required_tags, [])) used.add(t);
    const presets = this.presetTags();
    return { presets, in_use: [...used].filter((t) => !presets.includes(t)).sort() };
  }

  /** 项目里有 agent 具备的能力标签和人数：自动打标签只从这里选，保证打上的标签有人能领 */
  memberTags(projectId: number): Map<string, number> {
    const out = new Map<string, number>();
    const rows = this.db
      .prepare("SELECT m.tags, a.skills FROM memberships m JOIN agents a ON a.id = m.agent_id WHERE m.project_id = ? AND a.status = 'active'")
      .all(projectId) as { tags: string; skills: string }[];
    for (const r of rows) for (const t of new Set([...json<string[]>(r.tags, []), ...json<string[]>(r.skills, [])])) out.set(t, (out.get(t) ?? 0) + 1);
    return out;
  }

  /** 自动打标签的结果：任务还没被人手动打过标签时才写入；没有合适的标签也发一条动态，让值守进程重新检查 */
  applyAutoTags(code: string, tags: string[], reason: string, failed?: string) {
    const t = this.requireTask(code);
    this.releaseTagging(t.id);
    const allowed = this.memberTags(t.project_id);
    const pick = [...new Set(tags)].filter((x) => allowed.has(x)).slice(0, 3);
    const untouched = t.required_tags === '[]' && (t.status === 'open' || t.status === 'draft');
    // 这期间负责人已经手动打了标签，或任务已经被领走：不再改动
    if (!untouched) return this.taskView(t);
    this.write(() => {
      if (pick.length) {
        this.db.prepare('UPDATE tasks SET required_tags = ?, updated_at = ?, version = version + 1 WHERE id = ?').run(JSON.stringify(pick), this.iso(), t.id);
      }
      const updated = this.taskById(t.id);
      this.emit('task.updated', 'owner', {
        task: updated,
        audience: t.status === 'draft' ? [] : null,
        data: { fields: pick.length ? ['required_tags'] : [], auto_tags: pick, reason, ...(failed ? { error: failed } : {}) },
        summary: failed
          ? `自动给 ${code} 打标签失败（${excerpt(failed)}），先不限定能力标签`
          : pick.length
            ? `自动给 ${code} 打了能力标签：${pick.join('、')}${reason ? `（${excerpt(reason)}）` : ''}`
            : `${code} 不需要特定能力标签，所有项目成员都可以领取`,
      });
    });
    return this.taskView(this.taskById(t.id));
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
        .filter((a) => a.status !== 'deleted' && (a.id.toLowerCase() === lower || a.name.toLowerCase().includes(lower)))
        .slice(0, 10);
    }
    return result;
  }

  // ───────────── 值守进程管理 ─────────────

  /** 负责人暂停、恢复或立即唤醒某个 agent 的值守进程（ahub run）。 */
  controlDaemon(code: string, action: string) {
    const a = this.requireAgentRow(code);
    if (!['pause', 'resume', 'wake'].includes(action)) throw invalid('操作只能是 pause、resume 或 wake');
    if (action === 'wake') {
      if (!this.hasDaemon(a.id)) throw conflict(`${a.name} 的值守进程不在线`);
      if (a.daemon_paused) throw conflict(`${a.name} 的值守进程已暂停，请先恢复`);
    }
    const who = `${a.name}（${agentCode(a.id)}）`;
    this.write(() => {
      if (action !== 'wake') this.db.prepare('UPDATE agents SET daemon_paused = ? WHERE id = ?').run(action === 'pause' ? 1 : 0, a.id);
      this.emit('agent.control', 'owner', {
        audience: [agentCode(a.id)],
        data: { agent: agentCode(a.id), action },
        summary: { pause: `负责人暂停了${who}的值守进程`, resume: `负责人恢复了${who}的值守进程`, wake: `负责人让${who}立即检查一遍收件箱` }[action]!,
      });
    });
    return this.agentView(this.requireAgentRow(code));
  }

  /** 值守进程每次唤起 harness 结束后上报一条运行记录；每个 agent 只保留最近 100 条。 */
  recordRun(agent: AgentRow, input: { started_at?: string; ended_at?: string; code?: number | null; trigger?: string; summary?: string; harness?: string; session?: string }) {
    const now = this.iso();
    const at = (v?: string) => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : now);
    this.db
      .prepare('INSERT INTO runs (agent_id, harness, trigger, started_at, ended_at, code, summary, session) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        agent.id,
        String(input.harness ?? '').slice(0, 20),
        String(input.trigger ?? '').slice(0, 500),
        at(input.started_at),
        at(input.ended_at),
        typeof input.code === 'number' ? input.code : null,
        String(input.summary ?? '').slice(0, 2000),
        // 续用还是新开会话、为什么，以及上下文和缓存用量
        String(input.session ?? '').slice(0, 1000),
      );
    this.db
      .prepare('DELETE FROM runs WHERE agent_id = ? AND id NOT IN (SELECT id FROM runs WHERE agent_id = ? ORDER BY id DESC LIMIT 100)')
      .run(agent.id, agent.id);
    return { ok: true };
  }

  listRuns(code: string, limit = 50) {
    const a = this.requireAgentRow(code);
    return this.db
      .prepare('SELECT id, harness, trigger, started_at, ended_at, code, summary, session FROM runs WHERE agent_id = ? ORDER BY id DESC LIMIT ?')
      .all(a.id, limit) as { id: number; harness: string; trigger: string; started_at: string; ended_at: string; code: number | null; summary: string; session: string }[];
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

  createInvite(
    input: { project: string; tags?: string[]; max_uses?: number; hours?: number; note?: string; name?: string },
    createdBy = 'owner',
  ) {
    const p = this.requireProject(input.project);
    const code = newInviteCode();
    const expires = this.iso((input.hours ?? 24) * 60);
    this.db
      .prepare(
        'INSERT INTO invites (code, project_id, tags, max_uses, expires_at, note, agent_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(code, p.id, JSON.stringify(input.tags ?? []), input.max_uses ?? 1, expires, input.note ?? '', inviteName(input.name), createdBy, this.iso());
    return this.inviteView(code);
  }

  /**
   * 被授权的 agent（通常是协调者）找不到合适的人时，为自己所在的项目创建一个一次性邀请，
   * 并 @负责人 说明用途和启动命令。拉起新 agent 始终由负责人手动完成。
   */
  agentInvite(
    agent: AgentRow,
    input: { project?: string; task?: string; note: string; name?: string; tags?: string[]; harness?: string },
    hubUrl: string,
  ) {
    if (!agent.can_invite) throw forbidden('负责人还没有允许你创建邀请');
    const t = input.task ? this.requireTask(input.task) : null;
    const project = t ? projectCode(t.project_id) : input.project;
    if (!project) throw invalid('需要指定项目（project）或任务（task）');
    const p = this.requireProject(project);
    if (!this.isMember(agent.id, p.id)) throw forbidden(`你不是项目 ${project} 的成员`);
    if (p.status !== 'active') throw conflict(`项目 ${project} 已归档`);
    const note = input.note?.trim();
    if (!note) throw invalid('请说明需要什么样的 agent、用来做什么（note）');
    const me = agentCode(agent.id);
    // 身份码长期有效，不能写进评论（项目里所有 agent 都看得到）；负责人到控制台复制启动命令
    const created = this.createAgent({ project, tags: input.tags ?? [], name: input.name, note: `${agent.name}：${note}` }, me);
    const id = created.agent.id;
    const name = created.agent.name || '新 agent';
    const link = `${hubUrl}/#/agents`;
    const text = [
      `${t ? '@负责人 ' : ''}需要一个新 agent：${note}`,
      '',
      `我新建了身份 ${name}（${id}，项目 ${project}${created.agent.projects[0]?.tags.length ? `，能力标签：${created.agent.projects[0].tags.join('、')}` : ''}），还没有启动。` +
        `请到控制台「Agent」页复制它的启动命令，在合适的目录运行：${link}`,
    ].join('\n');
    if (t) this.comment({ kind: 'agent', agent }, input.task!, text);
    else this.message({ kind: 'agent', agent }, 'owner', text);
    return { agent: created.agent, project, console: link, harness: input.harness ?? null };
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
      agent_name: string;
      created_by: string;
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
      /** 预设的 agent 名称，加入时没写 name 就用它 */
      agent_name: r.agent_name,
      created_by: r.created_by,
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
  ): { agent: AgentView; code: string | null; project: ProjectView; briefing: { project: ProjectView & { description: string } } } {
    const code = (input.invite ?? '').trim().toUpperCase();
    const inv = this.db.prepare('SELECT * FROM invites WHERE code = ?').get(code) as
      | { code: string; project_id: number; tags: string; max_uses: number; uses: number; expires_at: string; revoked: number; agent_name: string }
      | undefined;
    if (!inv) throw invalid('邀请码无效');
    if (inv.revoked) throw invalid('邀请码已被撤销');
    if (inv.expires_at < this.iso()) throw invalid('邀请码已过期');
    if (inv.uses >= inv.max_uses) throw invalid('邀请码已用完');
    const tier = (input.tier ?? 'L1').toUpperCase() as Tier;
    if (!TIERS.includes(tier)) throw invalid('tier 只能是 L1、L2、L3、L4');

    return this.write(() => {
      let agent = existing;
      let identity: string | null = null;
      if (!agent) {
        const name = input.name?.trim() || inv.agent_name;
        if (!name) throw invalid('请提供 agent 名称（name）：这个邀请码没有预设名称，给自己起一个简短、能区分的名字');
        identity = newIdentityCode();
        const r = this.db
          .prepare(
            "INSERT INTO agents (name, platform, tier, description, skills, token_hash, code, created_at, last_seen_at, ack_seq, presence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'off')",
          )
          .run(
            name,
            input.platform ?? 'other',
            tier,
            input.description ?? '',
            JSON.stringify(input.skills ?? []),
            hashToken(identity),
            identity,
            this.iso(),
            null,
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
      if (identity) {
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
      return { agent: this.agentView(this.requireAgentRow(me)), code: identity, project: view, briefing: { project: view } };
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
      daemon: this.hasDaemon(a.id),
      daemon_paused: !!a.daemon_paused,
      resident: this.isResident(a.id),
      can_invite: !!a.can_invite,
      connection: (() => {
        const s = presence === 'offline' ? null : this.activeSession(a.id);
        return s ? this.sessionView(s) : null;
      })(),
      pending: !a.last_seen_at && !this.db.prepare('SELECT 1 FROM sessions WHERE agent_id = ?').get(a.id),
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

  updateAgent(
    actor: Actor,
    code: string,
    input: { status?: string; name?: string; description?: string; skills?: string[]; tier?: string; can_invite?: boolean },
  ) {
    const a = this.requireAgentRow(code);
    if (actor.kind === 'agent' && actor.agent.id !== a.id) throw forbidden('只能修改自己的资料');
    if (a.status === 'deleted') throw conflict(`${a.name}（${code}）已被删除`);
    if (input.status !== undefined) {
      if (actor.kind !== 'owner') throw forbidden('只有负责人可以停用或启用 agent');
      if (!['active', 'disabled'].includes(input.status)) throw invalid('status 只能是 active 或 disabled');
    }
    if (input.can_invite !== undefined && actor.kind !== 'owner') throw forbidden('只有负责人可以授权创建邀请');
    const tier = input.tier ? (input.tier.toUpperCase() as Tier) : a.tier;
    if (!TIERS.includes(tier)) throw invalid('tier 只能是 L1、L2、L3、L4');
    return this.write(() => {
      this.db
        .prepare('UPDATE agents SET status = ?, name = ?, description = ?, skills = ?, tier = ?, can_invite = ? WHERE id = ?')
        .run(
          input.status ?? a.status,
          input.name?.trim() || a.name,
          input.description ?? a.description,
          JSON.stringify(input.skills ?? json<string[]>(a.skills, [])),
          tier,
          input.can_invite === undefined ? a.can_invite : input.can_invite ? 1 : 0,
          a.id,
        );
      if (input.status === 'disabled') {
        const s = this.activeSession(a.id);
        if (s) this.closeSession(s, 'revoked', '身份已被负责人停用', { quiet: true });
      }
      const who = actor.kind === 'owner' ? 'owner' : agentCode(a.id);
      this.emit('agent.updated', who, {
        audience: [],
        data: { agent: code, ...input },
        summary:
          input.status === 'disabled'
            ? `负责人停用了 ${a.name}（${code}）`
            : input.status === 'active'
              ? `负责人启用了 ${a.name}（${code}）`
              : input.can_invite !== undefined
                ? `负责人${input.can_invite ? '允许' : '取消了'} ${a.name}（${code}）创建邀请`
                : `${a.name}（${code}）的资料已更新`,
      });
      return this.agentView(this.requireAgentRow(code));
    });
  }

  /**
   * 删除已停用的 agent：身份不能再用，也不再出现在成员列表里；
   * 它做过的任务、评论、交付物和动态都保留，仍然显示它的名字。手上没做完的任务放回任务池。
   */
  deleteAgent(code: string) {
    const a = this.requireAgentRow(code);
    if (a.status === 'deleted') throw conflict(`${a.name}（${code}）已经删除过了`);
    if (a.status !== 'disabled') throw conflict(`请先停用 ${a.name}（${code}）再删除`);
    return this.write(() => {
      const open = this.db
        .prepare("SELECT * FROM tasks WHERE assignee_id = ? AND status IN ('assigned','working','input_required') ORDER BY project_id, num")
        .all(a.id) as unknown as TaskRow[];
      const released: string[] = [];
      for (const t of open) {
        const tc = taskCode(t.project_id, t.num);
        this.setStatus(t, 'owner', 'open', {
          assignee: null,
          lease: null,
          summary: `${a.name}（${code}）已被删除，${tc}「${t.title}」放回任务池`,
        });
        released.push(tc);
      }
      this.db.prepare('DELETE FROM memberships WHERE agent_id = ?').run(a.id);
      this.db.prepare("UPDATE agents SET status = 'deleted', can_invite = 0, daemon_paused = 0 WHERE id = ?").run(a.id);
      this.activity.delete(a.id);
      this.emit('agent.updated', 'owner', {
        audience: [],
        data: { agent: code, deleted: true, released },
        summary: `负责人删除了 ${a.name}（${code}）${released.length ? `，${released.join('、')} 放回了任务池` : ''}`,
      });
      return { deleted: code, released };
    });
  }

  /** 重置身份码：旧码立即作废，当前连接一并强制下线 */
  resetAgentCode(code: string): string {
    const a = this.requireAgentRow(code);
    if (a.status === 'deleted') throw conflict(`${a.name}（${code}）已被删除`);
    const fresh = newIdentityCode();
    this.write(() => {
      this.db.prepare('UPDATE agents SET token_hash = ?, code = ? WHERE id = ?').run(hashToken(fresh), fresh, a.id);
      const s = this.activeSession(a.id);
      if (s) this.closeSession(s, 'revoked', '身份码已被负责人重置', { quiet: false });
    });
    return fresh;
  }

  /** 负责人查看身份码（老身份没有明文，需要先重置） */
  agentCodeOf(code: string): string | null {
    return this.requireAgentRow(code).code;
  }

  /**
   * 新建一个 agent 身份（待连接），加入指定项目，返回身份码。名字可以留空，第一次连接时由 agent 自己起。
   */
  createAgent(input: { project: string; name?: string; tags?: string[]; platform?: string; note?: string }, createdBy = 'owner') {
    const p = this.requireProject(input.project);
    if (p.status !== 'active') throw conflict(`项目 ${input.project} 已归档`);
    const code = newIdentityCode();
    return this.write(() => {
      const r = this.db
        .prepare(
          "INSERT INTO agents (name, platform, tier, description, skills, token_hash, code, created_at, last_seen_at, ack_seq, presence) VALUES (?, ?, 'L1', ?, '[]', ?, ?, ?, NULL, ?, 'off')",
        )
        .run(inviteName(input.name), input.platform ?? 'other', input.note ?? '', hashToken(code), code, this.iso(), this.lastSeq());
      const id = Number(r.lastInsertRowid);
      const tags = [...new Set(input.tags ?? [])];
      this.db.prepare('INSERT INTO memberships (project_id, agent_id, tags, joined_at) VALUES (?, ?, ?, ?)').run(p.id, id, JSON.stringify(tags), this.iso());
      const me = agentCode(id);
      const name = inviteName(input.name) || '待命名的 agent';
      this.emit('agent.joined', createdBy, {
        project: p.id,
        data: { agent: me, name, tags, pending: true, created_by: createdBy },
        summary: `${createdBy === 'owner' ? '负责人' : this.actorName(createdBy)}新建了 ${name}（${me}），加入项目 ${projectCode(p.id)}，等待它第一次连接`,
      });
      return { agent: this.agentView(this.requireAgentRow(me)), code };
    });
  }

  /** 负责人把已有的 agent 加入另一个项目 */
  addAgentToProject(code: string, input: { project: string; tags?: string[] }) {
    const a = this.requireAgentRow(code);
    if (a.status === 'deleted') throw conflict(`${a.name}（${code}）已被删除`);
    const p = this.requireProject(input.project);
    if (this.isMember(a.id, p.id)) throw conflict(`${a.name}（${code}）已经是项目 ${input.project} 的成员`);
    return this.write(() => {
      const tags = [...new Set(input.tags ?? [])];
      this.db.prepare('INSERT INTO memberships (project_id, agent_id, tags, joined_at) VALUES (?, ?, ?, ?)').run(p.id, a.id, JSON.stringify(tags), this.iso());
      this.emit('agent.joined', 'owner', {
        project: p.id,
        data: { agent: code, name: a.name, platform: a.platform, tier: a.tier, tags },
        summary: `负责人把 ${a.name}（${code}）加入了项目 ${projectCode(p.id)}`,
      });
      return this.agentView(this.requireAgentRow(code));
    });
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

  private codeOf(id: number) {
    const d = this.taskById(id);
    return taskCode(d.project_id, d.num);
  }

  private brief(t: TaskRow): TaskBrief {
    return {
      id: taskCode(t.project_id, t.num),
      title: t.title,
      status: t.status,
      status_label: STATUS_LABELS[t.status],
      assignee: t.assignee_id === null ? null : agentCode(t.assignee_id),
      assignee_name: this.agentName(t.assignee_id),
    };
  }

  /** 校验引用：同一个项目、不能引用自己，去重后返回内部编号。 */
  private resolveRefs(codes: string[], projectId: number, self?: number): number[] {
    const ids = codes.map((c) => {
      const d = this.requireTask(c);
      if (d.project_id !== projectId) throw invalid(`只能引用同一个项目的任务（${c} 不在 ${projectCode(projectId)}）`);
      if (d.id === self) throw invalid('任务不能引用自己');
      return d.id;
    });
    return [...new Set(ids)];
  }

  /** 指派、发布时附在摘要后面，值守唤醒的提示词里就能看到要参考哪些任务。 */
  private refNote(t: TaskRow) {
    const refs = json<number[]>(t.refs, []);
    return refs.length ? `（参考任务：${refs.map((id) => this.codeOf(id)).join('、')}）` : '';
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
      refs: json<number[]>(t.refs, []).map((id) => this.codeOf(id)),
      required_tags: json<string[]>(t.required_tags, []),
      progress: t.progress,
      progress_note: t.progress_note,
      notes: t.notes,
      block_reason: t.block_reason,
      block_options: t.status === 'input_required' ? json<string[]>(t.block_options, []) : [],
      stalled: t.status === 'working' && t.stall_warned === 1,
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
    const artifacts = this.db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY id').all(t.id) as unknown as ArtifactRow[];
    const log = this.db
      .prepare('SELECT author, percent, note, created_at FROM progress_log WHERE task_id = ? ORDER BY id')
      .all(t.id) as { author: string; percent: number; note: string; created_at: string }[];
    const commentReceipts = this.receiptsFor('comment', comments.map((c) => c.id));
    return {
      ...this.taskView(t),
      subtasks: subtasks.map((s) => this.taskView(s)),
      ref_tasks: json<number[]>(t.refs, []).map((id) => this.brief(this.taskById(id))),
      referenced_by: (
        this.db
          .prepare('SELECT * FROM tasks WHERE project_id = ? AND EXISTS (SELECT 1 FROM json_each(tasks.refs) WHERE value = ?) ORDER BY num')
          .all(t.project_id, t.id) as unknown as TaskRow[]
      ).map((r) => this.brief(r)),
      comments: comments.map((c) => ({
        id: c.id,
        author: c.author,
        author_name: this.actorName(c.author),
        parts: json<Part[]>(c.parts, []),
        created_at: c.created_at,
        receipts: commentReceipts.get(c.id) ?? [],
      })),
      receipts: this.receiptsFor('task', [t.id]).get(t.id) ?? [],
      artifacts: artifacts.map((a) => this.artifactView(a)),
      progress_log: log,
      passes: (
        this.db.prepare('SELECT agent_id, reason, created_at FROM task_passes WHERE task_id = ? ORDER BY created_at').all(t.id) as {
          agent_id: number;
          reason: string;
          created_at: string;
        }[]
      ).map((p) => ({ agent: agentCode(p.agent_id), agent_name: this.agentName(p.agent_id) ?? '', reason: p.reason, created_at: p.created_at })),
      candidates:
        t.status === 'open' && t.assignee_id === null
          ? this.claimRanking(t).map((r, i) => ({ rank: i + 1, agent: r.id, agent_name: r.name, score: r.score, reasons: r.reasons, warnings: r.warnings }))
          : [],
      open_since: t.status === 'open' ? (t.opened_at ?? t.updated_at) : null,
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
      refs?: string[];
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
      if (parent.assignee_id !== actor.agent.id) {
        // 别人负责的任务下也可以建子任务，但只能指派给自己：拆出来的是自己要做的那部分，父任务负责的 agent 会在动态里看到
        const me = agentCode(actor.agent.id);
        if (input.assignee && this.requireAgentRow(input.assignee).id !== actor.agent.id) throw forbidden(`${input.parent} 不在你名下，只能建指派给自己的子任务`);
        input = { ...input, assignee: me };
      }
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
    const refs = this.resolveRefs(input.refs ?? [], projectId);
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
            parent_id, depends_on, refs, required_tags, due_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(refs),
          JSON.stringify(input.required_tags ?? []),
          input.due_at ?? parent?.due_at ?? null,
          now,
          now,
        );
      if (status === 'open') this.db.prepare('UPDATE tasks SET opened_at = ? WHERE id = ?').run(now, Number(r.lastInsertRowid));
      const t = this.taskById(Number(r.lastInsertRowid));
      const code = taskCode(projectId, num);
      const who = this.actorName(creator);
      this.emit('task.created', creator, {
        task: t,
        audience: status === 'draft' ? [] : null,
        data: { title, status, priority, parent: input.parent ?? null, required_tags: input.required_tags ?? [] },
        summary: parent
          ? `${who}为 ${input.parent} 创建了子任务 ${code}「${title}」${this.refNote(t)}`
          : `${who}发布了任务 ${code}「${title}」${this.refNote(t)}`,
      });
      if (assignee) {
        const to = agentCode(assignee.id);
        this.emit('task.assigned', creator, {
          task: t,
          audience: [to],
          data: { assignee: to, title },
          summary: `${who}把 ${code}「${title}」指派给了你${this.refNote(t)}`,
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
      refs?: string[];
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
    const refs = input.refs === undefined ? t.refs : JSON.stringify(this.resolveRefs(input.refs, t.project_id, t.id));
    return this.write(() => {
      this.db
        .prepare(
          `UPDATE tasks SET title = ?, description = ?, acceptance = ?, priority = ?, required_tags = ?, depends_on = ?, refs = ?, due_at = ?,
            due_warned = CASE WHEN due_at IS ? THEN due_warned ELSE 0 END, updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(
          input.title?.trim() || t.title,
          input.description ?? t.description,
          input.acceptance === undefined ? t.acceptance : JSON.stringify(input.acceptance),
          priority,
          input.required_tags === undefined ? t.required_tags : JSON.stringify(input.required_tags),
          deps,
          refs,
          due === undefined ? t.due_at : due,
          due === undefined ? t.due_at : due,
          this.iso(),
          t.id,
        );
      const fields = Object.keys(input).filter((k) => k !== 'version' && (input as Record<string, unknown>)[k] !== undefined);
      // 任务内容变了，之前的让出理由可能不再成立：清空，大家重新排名
      if (fields.some((f) => ['title', 'description', 'acceptance', 'required_tags'].includes(f))) {
        const cleared = this.db.prepare('DELETE FROM task_passes WHERE task_id = ?').run(t.id).changes;
        if (cleared && t.status === 'open') this.db.prepare('UPDATE tasks SET opened_at = ? WHERE id = ?').run(this.iso(), t.id);
      }
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
        `UPDATE tasks SET status = ?, assignee_id = ?, lease_until = ?, lease_warned = 0, stall_warned = 0, block_reason = ?, updated_at = ?,
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
    if (to === 'open') this.db.prepare('UPDATE tasks SET opened_at = ? WHERE id = ?').run(this.iso(), t.id);
    const updated = this.taskById(t.id);
    // agent 自己接受、提交、阻塞或放下任务，说明指派这件事已经处理了
    const self = parseId(actor, 'A');
    if (self !== null) this.settleOwn(self, { task: t.id });
    this.emit('task.status_changed', actor, {
      task: updated,
      data: {
        from: t.status,
        to,
        assignee: assignee === null ? null : agentCode(assignee),
        // agent 拆的子任务记下创建者：提交待验收时唤起它来验收
        ...(updated.parent_id !== null && updated.created_by !== 'owner' ? { creator: updated.created_by } : {}),
        ...extra.data,
      },
      summary: extra.summary,
    });
    if (to === 'completed' || to === 'canceled') this.unlockDependents(updated);
    return updated;
  }

  /**
   * 一个任务完成（或取消）后，找出以它为前置、且前置现在全部结束的下游任务：
   * 已有负责人的直接通知负责人（会唤起值守进程）；还在任务池里的通知项目成员可以领取了。
   */
  private unlockDependents(t: TaskRow) {
    const code = taskCode(t.project_id, t.num);
    const rows = this.db
      .prepare(
        `SELECT * FROM tasks WHERE project_id = ? AND status IN ('open', 'assigned', 'working', 'input_required')
           AND EXISTS (SELECT 1 FROM json_each(tasks.depends_on) WHERE value = ?) ORDER BY num`,
      )
      .all(t.project_id, t.id) as unknown as TaskRow[];
    for (const d of rows) {
      if (!this.depsDone(d)) continue;
      if (d.status === 'open') this.db.prepare('UPDATE tasks SET opened_at = ? WHERE id = ?').run(this.iso(), d.id);
      const dcode = taskCode(d.project_id, d.num);
      const how = t.status === 'canceled' ? `前置任务 ${code} 已取消` : `前置任务 ${code}「${excerpt(t.title)}」已完成`;
      const assignee = d.assignee_id === null ? null : agentCode(d.assignee_id);
      this.emit('task.unlocked', 'owner', {
        task: d,
        audience: assignee ? [assignee] : null,
        data: { from: code, from_status: t.status, assignee },
        summary: assignee
          ? `${how}，${dcode}「${d.title}」的前置任务已全部结束，可以开始了`
          : `${how}，${dcode}「${d.title}」现在可以领取了`,
      });
    }
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
          summary: `负责人把 ${code}「${t.title}」指派给了你${this.refNote(t)}${message ? `：${message}` : ''}`,
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
          summary: `负责人把 ${code}「${t.title}」指派给了你${this.refNote(t)}`,
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
    // 待验收时也可以更新进度和工作笔记（例如补充说明、改了交付物），任务仍是待验收
    if (!['assigned', 'working', 'input_required', 'review'].includes(t.status)) {
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
          `UPDATE tasks SET progress = ?, progress_note = ?, notes = ?, lease_until = ?, lease_warned = 0,
             stall_warned = CASE WHEN progress = ? THEN stall_warned ELSE 0 END, updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        // 待验收没有租约，不要因为上报进度又开始计租约
        .run(percent, note, input.notes ?? row.notes, t.status === 'review' ? t.lease_until : this.lease(agent), percent, this.iso(), t.id);
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

  /**
   * 标记阻塞。reason 最好写成一个负责人能直接回答的问题；options 是可选答案，
   * 负责人在控制台点一个就会解除阻塞并把答案发回给 agent。
   */
  block(agent: AgentRow, code: string, reason: string, options: string[] = []): TaskView {
    const t = this.requireTask(code);
    this.requireAssignee(agent, t, code);
    if (t.status !== 'working') throw conflict(`只有进行中的任务可以标记阻塞`);
    if (!reason?.trim()) throw invalid('请说明阻塞的原因');
    const opts = [...new Set(options.map((o) => o.trim()).filter(Boolean))];
    if (opts.length > 6) throw invalid('可选答案最多 6 个');
    if (opts.some((o) => o.length > 100)) throw invalid('每个可选答案不超过 100 个字');
    const me = agentCode(agent.id);
    return this.write(() => {
      this.db.prepare('UPDATE tasks SET block_options = ? WHERE id = ?').run(JSON.stringify(opts), t.id);
      return this.taskView(
        this.setStatus(this.taskById(t.id), me, 'input_required', {
          block_reason: reason.trim(),
          summary: `${agent.name}（${me}）标记 ${code} 阻塞：${reason.trim()}${opts.length ? `（可选：${opts.join(' / ')}）` : ''}`,
          data: { reason: reason.trim(), options: opts },
        }),
      );
    });
  }

  /** 负责人回答阻塞提问：答案作为评论留在任务里，同时解除阻塞并唤起负责的 agent。 */
  answer(code: string, answer: string): TaskView {
    const t = this.requireTask(code);
    if (t.status !== 'input_required') throw conflict(`${code} 没有处于阻塞状态`);
    const text = answer?.trim();
    if (!text) throw invalid('请填写回答');
    return this.write(() => {
      this.addComment('owner', t, `**回答**「${excerpt(t.block_reason, 80)}」：${text}`);
      return this.taskView(
        this.setStatus(this.taskById(t.id), 'owner', 'working', {
          summary: `负责人回答了 ${code} 的问题：${text}`,
          data: { answer: text, question: t.block_reason },
        }),
      );
    });
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
      const round =
        ((this.db.prepare('SELECT MAX(round) AS r FROM artifacts WHERE task_id = ?').get(t.id) as { r: number | null }).r ?? 0) + 1;
      const add = (name: string, parts: Part[]) => {
        const r = this.db
          .prepare('INSERT INTO artifacts (task_id, author, name, parts, created_at, rev, round) VALUES (?, ?, ?, ?, ?, 1, ?)')
          .run(t.id, me, name, JSON.stringify(parts), now, round);
        this.db
          .prepare('INSERT INTO artifact_revisions (artifact_id, rev, author, parts, created_at) VALUES (?, 1, ?, ?, ?)')
          .run(Number(r.lastInsertRowid), me, JSON.stringify(parts), now);
      };
      add('交付说明', [{ kind: 'text', text: summary }]);
      for (const a of input.artifacts ?? []) add(a.name ?? '交付物', a.parts ?? []);
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

  /**
   * 验收、退回、取消通常由负责人做；agent 拆出来的子任务，创建它的 agent 也可以验收、退回，
   * 在还没人开工（待领取、已指派）时取消。指派给自己的子任务不能自己验收。父任务最终仍由负责人验收。
   */
  private reviewer(actor: Actor, t: TaskRow, code: string, what: '验收' | '退回' | '取消'): { by: string; who: string } {
    if (actor.kind === 'owner') return { by: 'owner', who: '负责人' };
    const me = agentCode(actor.agent.id);
    if (t.parent_id === null || t.created_by !== me) throw forbidden(`只有负责人或创建这个子任务的 agent 可以${what} ${code}`);
    if (what !== '取消' && t.assignee_id === actor.agent.id) throw forbidden(`${code} 指派给了你自己，不能自己${what}，请等负责人处理`);
    if (what === '取消' && !['open', 'assigned'].includes(t.status)) throw forbidden(`${code} 已经有人开工了，只有负责人可以取消`);
    return { by: me, who: `${actor.agent.name}（${me}）` };
  }

  approve(code: string, comment?: string, actor: Actor = { kind: 'owner' }): TaskView {
    const t = this.requireTask(code);
    if (t.status !== 'review') throw conflict(`${code} 不在待验收状态`);
    const { by, who } = this.reviewer(actor, t, code, '验收');
    return this.write(() => {
      if (comment?.trim()) this.addComment(by, t, comment);
      const updated = this.setStatus(this.taskById(t.id), by, 'completed', {
        lease: null,
        summary: `${who}验收通过了 ${code}「${t.title}」`,
      });
      return this.taskView(updated);
    });
  }

  reject(code: string, reason: string, actor: Actor = { kind: 'owner' }): TaskView {
    const t = this.requireTask(code);
    if (t.status !== 'review') throw conflict(`${code} 不在待验收状态`);
    if (!reason?.trim()) throw invalid('请写明修改意见');
    const { by, who } = this.reviewer(actor, t, code, '退回');
    const assignee = t.assignee_id ? this.requireAgentRow(agentCode(t.assignee_id)) : null;
    return this.write(() => {
      this.addComment(by, t, `验收未通过：${reason}`);
      const updated = this.setStatus(this.taskById(t.id), by, 'working', {
        lease: assignee ? this.lease(assignee) : null,
        summary: `${who}退回了 ${code}：${reason}`,
        data: { reason },
      });
      return this.taskView(updated);
    });
  }

  cancel(code: string, reason?: string, actor: Actor = { kind: 'owner' }): TaskView {
    const t = this.requireTask(code);
    if (['completed', 'canceled'].includes(t.status)) throw conflict(`${code} 已经${STATUS_LABELS[t.status]}`);
    const { by, who } = this.reviewer(actor, t, code, '取消');
    return this.write(() =>
      this.taskView(
        this.setStatus(t, by, 'canceled', {
          lease: null,
          summary: `${who}取消了 ${code}「${t.title}」${reason ? `：${reason}` : ''}`,
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

  private addComment(author: string, t: TaskRow, text: string, files: Part[] = []) {
    const parts: Part[] = [...(text ? [{ kind: 'text' as const, text }] : []), ...files];
    const r = this.db
      .prepare('INSERT INTO comments (task_id, author, parts, created_at) VALUES (?, ?, ?, ?)')
      .run(t.id, author, JSON.stringify(parts), this.iso());
    const code = taskCode(t.project_id, t.num);
    // 负责人在任务下回复了，说明这个任务里 @ 他的话已经看过
    if (author === 'owner') this.db.prepare(`UPDATE events SET owner_read = 1 WHERE type = 'mention' AND audience = '[]' AND task_id = ?`).run(t.id);
    const who = this.actorName(author);
    const assignee = t.assignee_id === null ? null : agentCode(t.assignee_id);
    const commentId = Number(r.lastInsertRowid);
    // agent 在任务下回复了，它在这个任务里接手的评论和指派都算处理完
    const self = parseId(author, 'A');
    if (self !== null) this.settleOwn(self, { task: t.id, comments: true });
    const targets = [...new Set(this.mentionTargets(text, t.project_id))].filter((x) => x !== author);
    this.emit('comment.created', author, {
      task: t,
      // mentions：评论 @ 了哪些 agent。@ 了别人、没 @ 任务负责的 agent 时，不唤醒它（它在动态里照样看得到）
      data: { comment_id: commentId, text, assignee, mentions: targets.filter((x) => x !== 'owner'), files: files.map((f) => f.name) },
      summary: `${who}在 ${code} 下评论：${text ? excerpt(text) : ''}${files.length ? `${text ? ' ' : ''}〔附件：${files.map((f) => f.name).join('、')}〕` : ''}`,
    });
    for (const target of targets) {
      this.emit('mention', author, {
        task: t,
        audience: target === 'owner' ? [] : [target],
        data: { target, text, comment_id: commentId },
        summary: `${who}在 ${code} 里 @了${target === 'owner' ? '负责人' : '你'}：${excerpt(text)}`,
      });
    }
  }

  // ───────────── 回执 ─────────────

  /** 一个需要处理的事件落在哪条评论、私信或任务上。老事件没有记录编号的就没有回执。 */
  private receiptTargets(e: HubEvent): { kind: ReceiptKind; id: number }[] {
    switch (e.type) {
      case 'comment.created':
      case 'mention':
        return typeof e.data.comment_id === 'number' ? [{ kind: 'comment', id: e.data.comment_id }] : [];
      case 'message.direct':
        return typeof e.data.message_id === 'number' ? [{ kind: 'message', id: e.data.message_id }] : [];
      case 'task.assigned':
      case 'task.status_changed':
      case 'task.unlocked': {
        const t = e.task ? this.findTask(e.task) : null;
        return t ? [{ kind: 'task', id: t.id }] : [];
      }
      default:
        return [];
    }
  }

  private findTask(code: string): TaskRow | null {
    try {
      return this.requireTask(code);
    } catch {
      return null;
    }
  }

  /**
   * ahub 命令行上报回执。working 时给出这次唤起的事件号（seqs）和手上的任务（tasks），只认真正需要它处理的；
   * done / failed / stopped 不给目标时，把它所有「处理中」的回执一起结束。
   */
  markReceipts(agent: AgentRow, input: { state?: string; seqs?: number[]; tasks?: string[]; note?: string }) {
    const state = input.state as ReceiptState;
    if (!RECEIPT_STATES.includes(state)) throw invalid('state 只能是 working、done、failed 或 stopped');
    const note = String(input.note ?? '').slice(0, 300);
    const me = agentCode(agent.id);
    const targets: { kind: ReceiptKind; id: number }[] = [];
    const seqs = (input.seqs ?? []).filter((n) => Number.isInteger(n)).slice(0, 200);
    if (seqs.length) {
      const rows = this.db
        .prepare(`SELECT * FROM events WHERE seq IN (${seqs.map(() => '?').join(',')})`)
        .all(...seqs) as unknown as EventRow[];
      for (const row of rows) {
        const e = this.toEvent(row);
        if (this.canSee(agent, e) && this.needsAction(e, me)) targets.push(...this.receiptTargets(e));
      }
    }
    for (const code of (input.tasks ?? []).slice(0, 200)) {
      const t = this.findTask(String(code));
      if (t && t.assignee_id === agent.id) targets.push({ kind: 'task', id: t.id });
    }
    const explicit = seqs.length > 0 || (input.tasks ?? []).length > 0;
    const updated = this.write(() =>
      state === 'working' || explicit ? this.applyReceipts(agent, targets, state, note) : this.settleReceipts(agent, state, { note }),
    );
    return { ok: true, updated };
  }

  /** 写入回执并通知控制台；working 新建或重新打开，其他状态只结束「处理中」的。返回改动的条数。 */
  private applyReceipts(agent: AgentRow, targets: { kind: ReceiptKind; id: number }[], state: ReceiptState, note = ''): number {
    const at = this.iso();
    const seen = new Set<string>();
    const changed: { kind: ReceiptKind; id: number }[] = [];
    for (const t of targets) {
      const key = `${t.kind}:${t.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r =
        state === 'working'
          ? this.db
              .prepare(
                `INSERT INTO receipts (kind, target_id, agent_id, state, note, created_at, updated_at) VALUES (?, ?, ?, 'working', ?, ?, ?)
                 ON CONFLICT (kind, target_id, agent_id) DO UPDATE SET state = 'working', note = excluded.note, updated_at = excluded.updated_at
                 WHERE receipts.state <> 'working'`,
              )
              .run(t.kind, t.id, agent.id, note, at, at)
          : this.db
              .prepare(`UPDATE receipts SET state = ?, note = ?, updated_at = ? WHERE kind = ? AND target_id = ? AND agent_id = ? AND state = 'working'`)
              .run(state, note, at, t.kind, t.id, agent.id);
      if (r.changes) changed.push(t);
    }
    this.receiptEvent(agent, state, changed);
    return changed.length;
  }

  /** 结束 agent 「处理中」的回执：不给范围就是全部，task 限定在某个任务里（comments 时连同该任务下的评论），replyTo 是回私信的对象。 */
  private settleReceipts(
    agent: AgentRow,
    state: ReceiptState,
    scope: { note?: string; task?: number; comments?: boolean; replyTo?: string } = {},
  ): number {
    const where = ["agent_id = ?", "state = 'working'"];
    const params: (string | number)[] = [agent.id];
    if (scope.task !== undefined) {
      where.push(
        scope.comments
          ? "((kind = 'task' AND target_id = ?) OR (kind = 'comment' AND target_id IN (SELECT id FROM comments WHERE task_id = ?)))"
          : "kind = 'task' AND target_id = ?",
      );
      params.push(scope.task, ...(scope.comments ? [scope.task] : []));
    } else if (scope.replyTo !== undefined) {
      where.push("kind = 'message' AND target_id IN (SELECT id FROM messages WHERE sender = ? AND recipient = ?)");
      params.push(scope.replyTo, agentCode(agent.id));
    }
    const rows = this.db.prepare(`SELECT kind, target_id FROM receipts WHERE ${where.join(' AND ')}`).all(...params) as {
      kind: ReceiptKind;
      target_id: number;
    }[];
    if (!rows.length) return 0;
    this.db
      .prepare(`UPDATE receipts SET state = ?, note = ?, updated_at = ? WHERE ${where.join(' AND ')}`)
      .run(state, scope.note ?? '', this.iso(), ...params);
    this.receiptEvent(agent, state, rows.map((r) => ({ kind: r.kind, id: r.target_id })));
    return rows.length;
  }

  /**
   * agent 自己回复、接受或提交时顺手把相关回执标成已处理。
   * 值守进程唤起的这一轮还没跑完时不动，等跑完再由 ahub run 统一标记，免得回了一句「收到」就显示处理完。
   */
  private settleOwn(agentId: number, scope: { task?: number; comments?: boolean; replyTo?: string }) {
    if (this.activity.get(agentId)?.state === 'working') return;
    const agent = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as unknown as AgentRow | undefined;
    if (agent) this.settleReceipts(agent, 'done', scope);
  }

  private receiptEvent(agent: AgentRow, state: ReceiptState, targets: { kind: ReceiptKind; id: number }[]) {
    if (!targets.length) return;
    const who = `${agent.name}（${agentCode(agent.id)}）`;
    const verb = { working: '开始处理', done: '处理完', failed: '没能处理完', stopped: '中断了处理' }[state];
    // 事件挂在相关任务上，控制台据此只刷新打开的那个任务
    const taskIds = new Set<number>();
    for (const t of targets) {
      if (t.kind === 'task') taskIds.add(t.id);
      else if (t.kind === 'comment') {
        const c = this.db.prepare('SELECT task_id FROM comments WHERE id = ?').get(t.id) as { task_id: number } | undefined;
        if (c) taskIds.add(c.task_id);
      }
    }
    const task = taskIds.size === 1 ? this.taskById([...taskIds][0]) : null;
    this.emit('receipt.updated', agentCode(agent.id), {
      task,
      audience: [],
      data: { agent: agentCode(agent.id), state, targets },
      summary: `${who}${verb} ${targets.length} 条事项`,
    });
  }

  /** 一批评论、私信或任务上的回执，按对象分组，先接手的排前面。 */
  private receiptsFor(kind: ReceiptKind, ids: number[]): Map<number, ReceiptView[]> {
    const out = new Map<number, ReceiptView[]>();
    if (!ids.length) return out;
    const rows = this.db
      .prepare(
        `SELECT r.*, a.name FROM receipts r JOIN agents a ON a.id = r.agent_id
         WHERE r.kind = ? AND r.target_id IN (${ids.map(() => '?').join(',')}) ORDER BY r.created_at, r.agent_id`,
      )
      .all(kind, ...ids) as { target_id: number; agent_id: number; name: string; state: ReceiptState; note: string; updated_at: string }[];
    for (const r of rows) {
      const list = out.get(r.target_id) ?? [];
      list.push({ agent: agentCode(r.agent_id), agent_name: r.name, state: r.state, note: r.note, updated_at: r.updated_at });
      out.set(r.target_id, list);
    }
    return out;
  }

  // ───────────── 交付物版本 ─────────────

  private artifactView(a: ArtifactRow): ArtifactView {
    return {
      id: a.id,
      author: a.author,
      name: a.name,
      parts: json<Part[]>(a.parts, []),
      created_at: a.created_at,
      rev: a.rev,
      round: a.round,
      updated_at: a.updated_at,
      updated_by: a.updated_by,
    };
  }

  private requireArtifact(t: TaskRow, id: number | string): ArtifactRow {
    const a = this.db.prepare('SELECT * FROM artifacts WHERE id = ? AND task_id = ?').get(Number(id), t.id) as unknown as
      | ArtifactRow
      | undefined;
    if (!a) throw notFound(`${taskCode(t.project_id, t.num)} 下没有编号为 ${id} 的交付物`);
    return a;
  }

  /** 读取一份交付物；给了 rev 就读那个历史版本。 */
  getArtifact(actor: Actor, code: string, id: number | string, rev?: number): ArtifactView {
    const t = this.requireTask(code);
    this.assertVisible(actor, t);
    const a = this.artifactView(this.requireArtifact(t, id));
    if (rev === undefined || rev === a.rev) return a;
    const r = this.artifactRevisions(actor, code, id).find((x) => x.rev === rev);
    if (!r) throw notFound(`交付物 ${id} 没有第 ${rev} 版`);
    return { ...a, parts: r.parts, rev: r.rev, updated_at: r.created_at, updated_by: r.author };
  }

  artifactRevisions(actor: Actor, code: string, id: number | string): ArtifactRevision[] {
    const t = this.requireTask(code);
    this.assertVisible(actor, t);
    const a = this.requireArtifact(t, id);
    const rows = this.db.prepare('SELECT * FROM artifact_revisions WHERE artifact_id = ? ORDER BY rev').all(a.id) as {
      rev: number;
      author: string;
      parts: string;
      note: string;
      created_at: string;
    }[];
    return rows.map((r) => ({
      rev: r.rev,
      author: r.author,
      author_name: this.actorName(r.author),
      parts: json<Part[]>(r.parts, []),
      note: r.note,
      created_at: r.created_at,
    }));
  }

  /**
   * 修改交付物，不需要退回任务。项目成员（交付者、被 @ 来帮忙的 agent）都可以改。
   * - 整份替换（content 或 parts）：base_rev 必须等于当前版本，否则说明有人先改了，需要拉取最新再改。
   * - 补丁（edits）：每段 old 必须在当前内容里恰好出现一次；版本落后时，只要要改的那段没被别人动过就照样生效，
   *   被动过（找不到或不唯一）就失败。
   */
  updateArtifact(
    actor: Actor,
    code: string,
    id: number | string,
    input: { base_rev?: number; content?: string; parts?: Part[]; edits?: { old: string; new: string }[]; note?: string },
  ): ArtifactView {
    const t = this.requireTask(code);
    this.assertVisible(actor, t);
    if (t.status === 'canceled') throw conflict(`${code} 已取消，不能再改交付物`);
    const a = this.requireArtifact(t, id);
    const baseRev = Number(input.base_rev);
    if (!Number.isInteger(baseRev) || baseRev < 1) throw invalid('请带上 base_rev：你是在第几版的基础上修改的（先读取交付物拿到当前版本号）');
    if (baseRev > a.rev) throw invalid(`交付物 ${a.id} 目前只到第 ${a.rev} 版`);
    const who = actor.kind === 'owner' ? 'owner' : agentCode(actor.agent.id);
    const stale = () =>
      `交付物 ${a.id}「${a.name}」已经被${this.actorName(a.updated_by ?? a.author)}改到第 ${a.rev} 版（你基于第 ${baseRev} 版）`;
    let parts: Part[];
    const current = json<Part[]>(a.parts, []);
    if (input.edits?.length) {
      if (input.content !== undefined || input.parts) throw invalid('edits 和 content 只能二选一');
      let text = editableText(current);
      if (text === null) throw invalid(`交付物 ${a.id} 不是单段文本，只能整份替换`);
      for (const [i, e] of input.edits.entries()) {
        if (typeof e?.old !== 'string' || !e.old || typeof e.new !== 'string') throw invalid(`第 ${i + 1} 处修改需要 old（原文片段）和 new（替换后的内容）`);
        const n = countOf(text, e.old);
        if (n !== 1) {
          if (baseRev < a.rev) throw conflict(`${stale()}，而且你要改的第 ${i + 1} 处已经被改动。请重新读取最新版本后再改。`);
          throw invalid(`第 ${i + 1} 处的原文片段${n === 0 ? '在交付物里找不到' : `出现了 ${n} 次，请多带一些上下文让它唯一`}`);
        }
        text = text.replace(e.old, () => e.new);
      }
      parts = [{ kind: 'text', text }];
    } else if (input.content !== undefined || input.parts) {
      if (baseRev !== a.rev) throw conflict(`${stale()}，整份替换会覆盖别人的修改。请先读取最新版本，在它的基础上修改后再提交。`);
      parts = input.parts ?? [{ kind: 'text', text: String(input.content) }];
      if (!parts.length) throw invalid('交付物内容不能为空');
    } else throw invalid('请给出 content（整份替换）或 edits（局部修改）');
    const before = editableText(current);
    if (before !== null && before === editableText(parts)) throw invalid('内容没有变化');
    const note = input.note?.trim() ?? '';
    return this.write(() => {
      const now = this.iso();
      const rev = a.rev + 1;
      this.db
        .prepare('UPDATE artifacts SET parts = ?, rev = ?, updated_at = ?, updated_by = ? WHERE id = ?')
        .run(JSON.stringify(parts), rev, now, who, a.id);
      this.db
        .prepare('INSERT INTO artifact_revisions (artifact_id, rev, author, parts, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(a.id, rev, who, JSON.stringify(parts), note, now);
      const assignee = t.assignee_id ? agentCode(t.assignee_id) : null;
      this.emit('artifact.updated', who, {
        task: t,
        data: { artifact: a.id, name: a.name, rev, assignee, note, mode: input.edits?.length ? 'patch' : 'replace' },
        summary: `${this.actorName(who)}把 ${code} 的交付物「${a.name}」改到了第 ${rev} 版${note ? `：${excerpt(note)}` : ''}`,
      });
      return this.artifactView(this.requireArtifact(t, a.id));
    });
  }

  /** 评论可以带附件：fileIds 是先通过 /api/v1/files 上传得到的文件编号。 */
  comment(actor: Actor, code: string, text: string, fileIds: string[] = []) {
    const t = this.requireTask(code);
    this.assertVisible(actor, t);
    if (fileIds.length > 10) throw invalid('一条评论最多带 10 个附件');
    const files = [...new Set(fileIds)].map((id) => this.filePart(id));
    if (!text?.trim() && files.length === 0) throw invalid('评论内容不能为空');
    const author = actor.kind === 'owner' ? 'owner' : agentCode(actor.agent.id);
    this.write(() => this.addComment(author, t, text?.trim() ?? '', files));
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
      const r = this.db
        .prepare('INSERT INTO messages (sender, recipient, body, created_at) VALUES (?, ?, ?, ?)')
        .run(from, target, body.trim(), this.iso());
      // agent 回了私信，对方发给它、它接手了的私信都算处理完
      if (actor.kind === 'agent') this.settleOwn(actor.agent.id, { replyTo: target });
      // 负责人回了私信，就当已读过对方发来的私信
      if (from === 'owner') this.db.prepare(`UPDATE events SET owner_read = 1 WHERE type = 'message.direct' AND audience = '[]' AND actor = ?`).run(target);
      this.emit('message.direct', from, {
        audience: target === 'owner' ? [] : [target],
        data: { from, to: target, body: body.trim(), message_id: Number(r.lastInsertRowid) },
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
    const receipts = this.receiptsFor('message', rows.map((m) => m.id));
    return rows.map((m) => ({
      ...m,
      sender_name: this.actorName(m.sender),
      recipient_name: this.actorName(m.recipient),
      receipts: receipts.get(m.id) ?? [],
    }));
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

  /**
   * 定时调用：找出「一直在报进度但没有实际进展」的任务提醒负责人（每次停滞只提醒一次）。
   * 判断标准：进度百分比停在同一个值已超过 2 小时，期间又上报了至少 2 次进度，
   * 或者值守进程为这个任务唤起了至少 3 次。
   */
  sweepStalls(): number {
    const now = this.now().getTime();
    const rows = this.db.prepare("SELECT * FROM tasks WHERE status = 'working' AND stall_warned = 0").all() as unknown as TaskRow[];
    let n = 0;
    this.write(() => {
      for (const t of rows) {
        const logs = this.db
          .prepare('SELECT percent, created_at FROM progress_log WHERE task_id = ? ORDER BY id DESC LIMIT 50')
          .all(t.id) as { percent: number; created_at: string }[];
        if (!logs.length || logs[0].percent !== t.progress || t.progress >= 100) continue;
        // 从最新往前数，进度一直是同一个值的那几次上报
        let same = 0;
        while (same < logs.length && logs[same].percent === t.progress) same++;
        const since = logs[same - 1].created_at;
        if (now - Date.parse(since) < STALL_MS) continue;
        const code = taskCode(t.project_id, t.num);
        const runs =
          t.assignee_id === null
            ? 0
            : (
                this.db
                  .prepare('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND started_at >= ? AND trigger LIKE ?')
                  .get(t.assignee_id, since, `%${code}%`) as { n: number }
              ).n;
        const repeats = same - 1;
        if (repeats < 2 && runs < 3) continue;
        n++;
        this.db.prepare('UPDATE tasks SET stall_warned = 1 WHERE id = ?').run(t.id);
        const hours = Math.round((now - Date.parse(since)) / 3600_000);
        const who = this.agentName(t.assignee_id) ?? '负责的 agent';
        const what = [repeats >= 2 ? `又上报了 ${repeats} 次进度` : '', runs >= 3 ? `被唤起了 ${runs} 次` : ''].filter(Boolean).join('、');
        this.emit('task.stalled', 'owner', {
          task: t,
          audience: [],
          data: { assignee: t.assignee_id === null ? null : agentCode(t.assignee_id), percent: t.progress, since, reports: repeats, runs },
          summary: `${code}「${t.title}」可能在原地打转：${who} 近 ${hours} 小时${what}，进度一直停在 ${t.progress}%`,
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

  // ───────────── 指派推荐 ─────────────

  /**
   * 给一个任务推荐负责人：看能力标签是否匹配、在线和值守情况、手上的任务量、
   * 最近 30 天在这个项目里的完成数和退回率，以及是否做过标题相近的任务。
   * 只是建议，分数高低不影响任何权限。
   */
  recommend(input: { project?: string; task?: string; tags?: string[]; title?: string }): Recommendation[] {
    const t = input.task ? this.requireTask(input.task) : null;
    const project = t ? `P-${t.project_id}` : input.project;
    if (!project) throw invalid('需要指定项目或任务');
    const projectId = this.requireProject(project).id;
    const required = t ? json<string[]>(t.required_tags, []) : (input.tags ?? []).filter(Boolean);
    const title = t?.title ?? input.title ?? '';
    const stats = new Map(this.stats(project, 30).agents.map((a) => [a.id, a]));
    const grams = (s: string) => {
      const x = s.toLowerCase().replace(/[\s\p{P}]+/gu, '');
      const out = new Set<string>();
      for (let i = 0; i < x.length - 1; i++) out.add(x.slice(i, i + 2));
      return out;
    };
    const mine = grams(title);
    const done = this.db
      .prepare(`SELECT assignee_id, num, title FROM tasks WHERE project_id = ? AND status = 'completed' AND assignee_id IS NOT NULL ORDER BY updated_at DESC LIMIT 300`)
      .all(projectId) as { assignee_id: number; num: number; title: string }[];

    return this.listAgents(project)
      .filter((a) => a.status === 'active' && (!t || agentCode(t.assignee_id ?? 0) !== a.id))
      .map((a) => {
        let score = 50;
        const reasons: string[] = [];
        const warnings: string[] = [];
        const tags = [...(a.projects.find((p) => p.id === project)?.tags ?? []), ...a.skills];
        if (required.length) {
          const hit = required.filter((r) => tags.includes(r));
          if (hit.length) {
            score += 25;
            reasons.push(`能力匹配：${hit.join('、')}`);
          } else {
            score -= 40;
            warnings.push(`没有能力标签 ${required.join('、')}`);
          }
        }
        if (a.presence === 'online') {
          score += 15;
          reasons.push('在线');
        } else if (a.presence === 'active') {
          score += 10;
          reasons.push('最近活跃');
        } else if (a.presence === 'idle') score += 3;
        else warnings.push('离线');
        if (a.daemon_paused) {
          score -= 15;
          warnings.push('值守已暂停');
        } else if (a.daemon) {
          score += 10;
          reasons.push('有值守进程，指派后会自动唤醒');
        }
        const load = a.active_tasks.length;
        score -= Math.min(load, 5) * 8;
        if (load === 0) reasons.push('手上没有任务');
        else (load >= 3 ? warnings : reasons).push(`手上 ${load} 个任务`);
        const s = stats.get(a.id);
        if (s?.completed) {
          score += Math.min(s.completed, 5) * 3;
          reasons.push(`近 30 天完成 ${s.completed} 个`);
        }
        if (s && s.submitted >= 2 && (s.reject_rate ?? 0) >= 50) {
          score -= 10;
          warnings.push(`退回率 ${s.reject_rate}%`);
        }
        if (s?.overdue) {
          score -= 5 * s.overdue;
          warnings.push(`${s.overdue} 个任务已逾期`);
        }
        if (mine.size) {
          let best: { sim: number; code: string; title: string } | null = null;
          for (const d of done) {
            if (agentCode(d.assignee_id) !== a.id) continue;
            const g = grams(d.title);
            let common = 0;
            for (const x of mine) if (g.has(x)) common++;
            const sim = common / (mine.size + g.size - common);
            if (sim >= 0.25 && (!best || sim > best.sim)) best = { sim, code: taskCode(projectId, d.num), title: d.title };
          }
          if (best) {
            score += Math.round(best.sim * 20);
            reasons.push(`做过类似任务 ${best.code}「${best.title}」`);
          }
        }
        return { id: a.id, name: a.name, score: Math.max(0, Math.min(100, Math.round(score))), reasons, warnings, presence: a.presence, load };
      })
      .sort((x, y) => y.score - x.score || x.load - y.load || x.id.localeCompare(y.id, undefined, { numeric: true }));
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

  // ───────────── 负责人已读 ─────────────

  /**
   * 把发给负责人的 @ / 私信标为已读，返回这次新标记的条数。
   * seqs：指定事件；task：某个任务下的全部 @；from：某个 agent 发来的全部私信；
   * type：只标 mention 或 message.direct；都不给时标记全部（可用 project 限定范围）。
   */
  markOwnerRead(
    opts: { seqs?: number[]; task?: string; from?: string; type?: string; project?: string } = {},
  ): { count: number } {
    const where = [OWNER_INBOX_SQL, 'owner_read = 0'];
    const params: (number | string)[] = [];
    if (opts.seqs) {
      const seqs = opts.seqs.filter((n) => Number.isInteger(n));
      if (seqs.length === 0) return { count: 0 };
      where.push(`seq IN (${seqs.map(() => '?').join(',')})`);
      params.push(...seqs);
    }
    if (opts.task) {
      where.push("type = 'mention' AND task_id = ?");
      params.push(this.requireTask(opts.task).id);
    }
    if (opts.from) {
      where.push("type = 'message.direct' AND actor = ?");
      params.push(agentCode(this.requireAgentRow(opts.from).id));
    }
    if (opts.type) {
      if (opts.type !== 'mention' && opts.type !== 'message.direct') throw invalid(`未知的类型：${opts.type}`);
      where.push('type = ?');
      params.push(opts.type);
    }
    if (opts.project) {
      where.push('(project_id = ? OR project_id IS NULL)');
      params.push(this.requireProject(opts.project).id);
    }
    const r = this.db.prepare(`UPDATE events SET owner_read = 1 WHERE ${where.join(' AND ')}`).run(...params);
    return { count: Number(r.changes) };
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
    const stalled = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE stall_warned = 1 AND status = 'working' ${scope}`).get(...params) as { n: number }
    ).n;
    const attention = this.db
      .prepare(
        `SELECT * FROM tasks WHERE (status IN ('review','input_required','draft') OR ((lease_warned = 1 OR stall_warned = 1) AND status = 'working')
           OR (due_at IS NOT NULL AND due_at < ? AND status IN (${LIVE_SQL}))) ${scope}
         ORDER BY updated_at DESC LIMIT 50`,
      )
      .all(now, ...params) as unknown as TaskRow[];
    const mentions = (
      this.db
        .prepare(
          `SELECT * FROM events WHERE ${OWNER_INBOX_SQL} AND owner_read = 0
           ${projectId === null ? '' : 'AND (project_id = ? OR project_id IS NULL)'} ORDER BY seq DESC LIMIT 20`,
        )
        .all(...params) as unknown as EventRow[]
    ).map((r) => this.toEvent(r));
    return {
      counts: {
        working: count('working'),
        review: count('review'),
        input_required: count('input_required'),
        open: count('open'),
        lost,
        overdue,
        stalled,
      },
      attention: attention.map((t) => this.taskView(t)),
      mentions,
      agents_online: this.listAgents(project).filter((a) => a.online).length,
    };
  }
}

// 发给负责人的 @ 和私信（总览「需要你处理」里那几条）
const OWNER_INBOX_SQL = "type IN ('mention','message.direct') AND audience = '[]'";

const DUE_SOON_MS = 2 * 3600_000;
const STALL_MS = 2 * 3600_000;
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
      refs: '引用的任务',
      due_at: '截止时间',
    } as Record<string, string>
  )[f] ?? f;
}
