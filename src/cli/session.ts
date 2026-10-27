/**
 * 值守进程每次唤起 harness 前决定：续用哪个旧会话，还是新开一个。
 * 只在本机做判断（会话、上下文用量、缓存都只有本机知道）；Hub 只提供任务之间的关系。
 * 这里都是纯函数，方便单测；run.ts 负责取数据、调用 harness、写回记录。
 */

export type SessionPolicy = 'smart' | 'task' | 'shared' | 'new';

export interface SessionRecord {
  id: string;
  harness: 'claude' | 'codex';
  /** 这个会话处理过的任务 */
  tasks: string[];
  created_at: string;
  last_used_at: string;
  runs: number;
  /** 最近一次运行结束时的上下文大小（token），拿不到用量时按每次运行估算 */
  context_tokens: number;
  context_window: number;
  /** 提示词缓存的有效期（分钟）：Claude 订阅额度内 60，API key 或用量额度 5；Codex 按 5 */
  cache_ttl_minutes: number;
  /** 最近几次运行是否正常结束，新的在后 */
  outcomes: boolean[];
  /** 上次续用失败（会话不存在、参数不支持等），以后不再续用 */
  broken?: boolean;
  summary?: string;
}

export interface SessionSettings {
  policy: SessionPolicy;
  threshold: number;
  grayBand: number;
  contextMaxRatio: number;
  maxAgeHours: number;
  maxRuns: number;
}

export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  policy: 'smart',
  threshold: 25,
  grayBand: 10,
  contextMaxRatio: 0.6,
  maxAgeHours: 72,
  maxRuns: 30,
};

/** 一个任务和它的亲属：父任务、子任务、引用 / 依赖 / 被引用的任务 */
export interface TaskRelations {
  id: string;
  family: string[];
  links: string[];
}

export interface WakeInfo {
  /** 本次唤起涉及的任务（去重） */
  tasks: string[];
  relations: TaskRelations[];
  /** 本次是对已有任务的跟进（退回、评论、@、交付物被改）的任务 */
  followups: string[];
  /** 已经完成或取消的任务（只需要覆盖候选会话里的任务） */
  closed: string[];
  /** 读不到 Hub 上的任务关系，只按同一任务匹配 */
  offline?: boolean;
}

export interface SessionDecision {
  action: 'reuse' | 'new';
  session?: SessionRecord;
  score?: number;
  /** 落在阈值附近的灰区，可以交给小模型再判断 */
  gray: boolean;
  /** 一句话理由，写进运行记录 */
  reason: string;
  /** 打分明细 */
  breakdown: string[];
}

const HOUR = 3600_000;
const pct = (r: number) => `${Math.round(r * 100)}%`;

export function contextRatio(s: SessionRecord) {
  return s.context_window > 0 ? s.context_tokens / s.context_window : 0;
}

/** 会话和一个任务的关系分：同一任务 50，父子 30，引用或依赖 20，无关 0 */
function relationScore(s: SessionRecord, rel: TaskRelations, offline: boolean): [number, string] {
  if (s.tasks.includes(rel.id)) return [50, `同一任务 ${rel.id}`];
  if (offline) return [0, ''];
  const f = rel.family.find((t) => s.tasks.includes(t));
  if (f) return [30, `${rel.id} 的父子任务 ${f}`];
  const l = rel.links.find((t) => s.tasks.includes(t));
  if (l) return [20, `${rel.id} 引用或依赖的任务 ${l}`];
  return [0, ''];
}

/** 不需要打分就必须新开的情况，返回原因 */
function hardStop(s: SessionRecord, wake: WakeInfo, cfg: SessionSettings, now: number): string | null {
  if (s.broken) return '上次续用失败';
  const ratio = contextRatio(s);
  if (ratio >= cfg.contextMaxRatio) return `上下文已用 ${pct(ratio)}，达到上限 ${pct(cfg.contextMaxRatio)}`;
  const age = (now - Date.parse(s.created_at)) / HOUR;
  if (age >= cfg.maxAgeHours) return `会话已开了 ${Math.floor(age)} 小时，超过 ${cfg.maxAgeHours} 小时`;
  if (s.runs >= cfg.maxRuns) return `会话已运行 ${s.runs} 次，达到上限 ${cfg.maxRuns}`;
  if (s.outcomes.length >= 2 && s.outcomes.slice(-2).every((o) => !o)) return '最近两次运行都没有正常结束';
  const isNewTask = !wake.tasks.some((t) => s.tasks.includes(t));
  if (isNewTask && s.tasks.length && s.tasks.every((t) => wake.closed.includes(t))) return '会话里的任务都已结束，这次是新任务';
  return null;
}

/** 给一个候选会话打分；和本次任务无关（或不能覆盖全部任务）时返回 null */
export function scoreSession(s: SessionRecord, wake: WakeInfo, now: number): { score: number; breakdown: string[] } | null {
  const offline = !!wake.offline;
  const parts = wake.relations.map((r) => relationScore(s, r, offline));
  // 一次唤起涉及多个任务时，只有一个会话能覆盖全部任务才续用；分数按最弱的那个关系算
  if (!parts.length || parts.some(([n]) => n === 0)) return null;
  const weakest = parts.reduce((a, b) => (b[0] < a[0] ? b : a));
  const breakdown = [`${weakest[1]} +${weakest[0]}`];
  let score = weakest[0];
  const add = (n: number, why: string) => {
    if (!n) return;
    score += n;
    breakdown.push(`${why} ${n > 0 ? '+' : ''}${n}`);
  };
  if (wake.followups.some((t) => s.tasks.includes(t))) add(10, '是对这个会话处理过的任务的跟进');
  const idleMin = (now - Date.parse(s.last_used_at)) / 60_000;
  if (idleMin < s.cache_ttl_minutes - 1) add(15, `缓存未过期（空闲 ${Math.round(idleMin)} 分钟）`);
  const ratio = contextRatio(s);
  add(-Math.floor(ratio * 20) * 5, `上下文已用 ${pct(ratio)}`);
  add(-Math.min(30, Math.floor(idleMin / 60) * 2), `空闲 ${Math.floor(idleMin / 60)} 小时`);
  if (s.outcomes.length && !s.outcomes[s.outcomes.length - 1]) add(-20, '上次运行没有正常结束');
  if (s.tasks.length >= 3) add(-10, `会话里已有 ${s.tasks.length} 个任务`);
  return { score, breakdown };
}

export function decideSession(sessions: SessionRecord[], harness: string, wake: WakeInfo, cfg: SessionSettings, now = Date.now()): SessionDecision {
  const mine = sessions.filter((s) => s.harness === harness).sort((a, b) => Date.parse(b.last_used_at) - Date.parse(a.last_used_at));
  const fresh = (reason: string, breakdown: string[] = []): SessionDecision => ({ action: 'new', gray: false, reason, breakdown });
  if (cfg.policy === 'new') return fresh('设置为每次新开会话');
  if (cfg.policy === 'shared') {
    // 所有事项共用一个会话（旧版行为），只保留硬性上限
    const s = mine[0];
    if (!s) return fresh('还没有可续用的会话');
    const stop = hardStop(s, { ...wake, closed: [] }, cfg, now);
    return stop ? fresh(stop) : { action: 'reuse', session: s, gray: false, reason: '设置为共用一个会话', breakdown: [] };
  }
  if (!wake.tasks.length) return fresh('这次唤起不涉及任务（私信、广播等）');

  const stops: string[] = [];
  let best: { s: SessionRecord; score: number; breakdown: string[] } | null = null;
  for (const s of mine) {
    if (cfg.policy === 'task' && !wake.tasks.every((t) => s.tasks.includes(t))) continue;
    const scored = scoreSession(s, wake, now);
    if (!scored) continue;
    const stop = hardStop(s, wake, cfg, now);
    if (stop) {
      stops.push(`${short(s.id)}：${stop}`);
      continue;
    }
    if (!best || scored.score > best.score) best = { s, ...scored };
  }
  if (!best) return fresh(stops.length ? `相关会话不能续用（${stops.join('；')}）` : '没有处理过相关任务的会话');
  if (cfg.policy === 'task') {
    return { action: 'reuse', session: best.s, score: best.score, gray: false, reason: `同一任务的会话 ${short(best.s.id)}`, breakdown: best.breakdown };
  }
  const gray = Math.abs(best.score - cfg.threshold) <= cfg.grayBand;
  const detail = best.breakdown.join('，');
  if (best.score >= cfg.threshold) {
    return { action: 'reuse', session: best.s, score: best.score, gray, reason: `续用会话 ${short(best.s.id)}，得分 ${best.score}（${detail}）`, breakdown: best.breakdown };
  }
  return { action: 'new', session: best.s, score: best.score, gray, reason: `最相关的会话 ${short(best.s.id)} 得分 ${best.score}，低于 ${cfg.threshold}（${detail}）`, breakdown: best.breakdown };
}

export const short = (id: string) => id.slice(0, 8);

/** 拿不到用量时每次运行按这么多 token 估算上下文增长 */
export const ESTIMATED_TOKENS_PER_RUN = 15_000;

/** 一次运行结束后更新（或新建）会话记录；最多保留 50 条，最久没用的先删 */
export function recordSession(
  sessions: SessionRecord[],
  input: {
    id: string;
    previousId?: string;
    harness: 'claude' | 'codex';
    tasks: string[];
    ok: boolean;
    contextTokens?: number;
    contextWindow?: number;
    cacheTtlMinutes?: number;
    summary?: string;
    now?: number;
  },
  defaults: { contextWindow: number; cacheTtlMinutes: number },
): SessionRecord[] {
  const at = new Date(input.now ?? Date.now()).toISOString();
  const prev = sessions.find((s) => s.id === (input.previousId ?? input.id));
  const rest = sessions.filter((s) => s !== prev && s.id !== input.id);
  const rec: SessionRecord = prev
    ? { ...prev, id: input.id }
    : {
        id: input.id,
        harness: input.harness,
        tasks: [],
        created_at: at,
        last_used_at: at,
        runs: 0,
        context_tokens: 0,
        context_window: defaults.contextWindow,
        cache_ttl_minutes: defaults.cacheTtlMinutes,
        outcomes: [],
      };
  rec.tasks = [...new Set([...rec.tasks, ...input.tasks])];
  rec.last_used_at = at;
  rec.runs += 1;
  rec.context_tokens = input.contextTokens ?? rec.context_tokens + ESTIMATED_TOKENS_PER_RUN;
  if (input.contextWindow) rec.context_window = input.contextWindow;
  if (input.cacheTtlMinutes) rec.cache_ttl_minutes = input.cacheTtlMinutes;
  rec.outcomes = [...rec.outcomes, input.ok].slice(-3);
  delete rec.broken;
  if (input.summary) rec.summary = input.summary.slice(0, 1000);
  return [rec, ...rest].slice(0, 50);
}

/** 唤起事件里算作「对已有任务的跟进」的类型：退回、评论、@、交付物更新、依赖解锁 */
export const FOLLOWUP_EVENTS = new Set(['comment.created', 'task.status_changed', 'artifact.updated', 'task.unlocked', 'task.updated']);

/** Claude Code stream-json 输出：取最后一次模型调用的输入大小作为当前上下文，结果行里有会话号、上下文窗口和费用 */
export function parseClaudeOutput(stdout: string) {
  let sessionId: string | undefined;
  let result: string | undefined;
  let contextTokens: number | undefined;
  let contextWindow: number | undefined;
  let cacheTtlMinutes: number | undefined;
  let cost: number | undefined;
  let cacheRead = 0;
  let inputTotal = 0;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.session_id) sessionId = m.session_id;
    // 子代理的消息带 parent_tool_use_id，不算主会话的上下文
    const u = m.type === 'assistant' && !m.parent_tool_use_id ? m.message?.usage : undefined;
    if (u) {
      contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
      if (u.cache_creation?.ephemeral_1h_input_tokens) cacheTtlMinutes = 60;
      else if (u.cache_creation?.ephemeral_5m_input_tokens && !cacheTtlMinutes) cacheTtlMinutes = 5;
    }
    if (m.type === 'result') {
      result = typeof m.result === 'string' ? m.result : undefined;
      cost = typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined;
      const ru = m.usage ?? {};
      cacheRead = ru.cache_read_input_tokens ?? 0;
      inputTotal = (ru.input_tokens ?? 0) + cacheRead + (ru.cache_creation_input_tokens ?? 0);
      if (ru.cache_creation?.ephemeral_1h_input_tokens) cacheTtlMinutes = 60;
      const windows = Object.values(m.modelUsage ?? {})
        .map((x: any) => x?.contextWindow)
        .filter((n): n is number => typeof n === 'number' && n > 0);
      if (windows.length) contextWindow = Math.max(...windows);
    }
  }
  return { sessionId, result, contextTokens, contextWindow, cacheTtlMinutes, cost, cacheHit: inputTotal ? cacheRead / inputTotal : undefined };
}

/**
 * codex exec --json 输出：thread.started 带会话号，最后一条 agent_message 是总结。
 * turn.completed 的用量是整轮累计的，偏大，只在读不到会话文件（见 codexRolloutUsage）时兜底用。
 */
export function parseCodexOutput(stdout: string) {
  let sessionId: string | undefined;
  let result: string | undefined;
  let contextTokens: number | undefined;
  let cacheHit: number | undefined;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    let m: Record<string, any>;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === 'thread.started' && m.thread_id) sessionId = m.thread_id;
    if (m.type === 'item.completed' && m.item?.type === 'agent_message' && typeof m.item.text === 'string') result = m.item.text;
    if (m.type === 'turn.completed' && m.usage) {
      const input = m.usage.input_tokens ?? 0;
      contextTokens = input + (m.usage.output_tokens ?? 0);
      cacheHit = input ? (m.usage.cached_input_tokens ?? 0) / input : undefined;
    }
  }
  return { sessionId, result, contextTokens, cacheHit };
}

/** Codex 会话文件里的 token_count 事件：最近一次调用的输入大小就是当前上下文，还带上下文窗口 */
export function parseCodexRollout(text: string) {
  let contextTokens: number | undefined;
  let contextWindow: number | undefined;
  for (const line of text.split('\n')) {
    if (!line.includes('token_count')) continue;
    try {
      const info = JSON.parse(line)?.payload?.info;
      const last = info?.last_token_usage;
      if (last) contextTokens = (last.input_tokens ?? 0) + (last.output_tokens ?? 0);
      if (typeof info?.model_context_window === 'number') contextWindow = info.model_context_window;
    } catch {
      // 跳过坏行
    }
  }
  return { contextTokens, contextWindow };
}
