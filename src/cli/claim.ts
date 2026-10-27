/**
 * 智能领取：Hub 在收件箱里给每个可领取任务带上匹配度和名次（fit），这里决定要不要、什么时候为它唤起 harness。
 * 第 1 名立即唤起，第 r 名在任务可领取后等 (r − 1) × 错峰间隔再唤起，前面的人领了或让出了名次就会变；
 * 手上进行中的任务太多、匹配度太低、自己让出过的任务都不唤起。纯函数，方便单测。
 */

export type ClaimPolicy = 'smart' | 'always' | 'off';

export interface ClaimSettings {
  policy: ClaimPolicy;
  /** 手上进行中的任务达到这么多就先不领 */
  maxActive: number;
  /** 匹配度低于这个分数就不领 */
  minScore: number;
  /** 名次每靠后一位多等几分钟 */
  staggerMinutes: number;
}

/** 匹配度在门槛以上这么多分以内算灰区 */
export const CLAIM_GRAY_BAND = 20;

export const DEFAULT_CLAIM_SETTINGS: ClaimSettings = { policy: 'smart', maxActive: 2, minScore: 30, staggerMinutes: 10 };

export interface ClaimFit {
  score: number;
  rank: number;
  of: number;
  reasons: string[];
  warnings: string[];
  open_since: string;
  passed: boolean;
}

export interface ClaimableTask {
  id: string;
  title: string;
  /** 老版 Hub 没有这个字段：把自己当作唯一候选，只看忙闲 */
  fit?: ClaimFit;
}

export interface ClaimPlan {
  /** 现在就为它们唤起，why 写进提示词和运行记录；gray 表示匹配度刚过门槛，可以先问小模型 */
  wake: { id: string; title: string; why: string; gray?: boolean }[];
  /** 名次靠后，到点还没人领再唤起 */
  later: { id: string; at: number; why: string }[];
  skipped: { id: string; why: string }[];
  /** 这次最多还能领几个 */
  capacity: number;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });

/** 同一个任务每次变成可领取后只为它唤起一次，用这个键记住 */
export const claimKey = (t: ClaimableTask) => `${t.id}@${t.fit?.open_since ?? ''}`;

export function planClaims(tasks: ClaimableTask[], active: number, cfg: ClaimSettings, now = Date.now()): ClaimPlan {
  const plan: ClaimPlan = { wake: [], later: [], skipped: [], capacity: Math.max(0, cfg.maxActive - active) };
  if (cfg.policy === 'off') {
    for (const t of tasks) plan.skipped.push({ id: t.id, why: '设置为不自动领取' });
    return plan;
  }
  if (cfg.policy === 'always') {
    plan.capacity = Math.max(plan.capacity, 1);
    for (const t of tasks) plan.wake.push({ id: t.id, title: t.title, why: '任务池里有可领取的任务' });
    return plan;
  }
  for (const t of tasks) {
    const f = t.fit;
    if (f?.passed) {
      plan.skipped.push({ id: t.id, why: '你已经让出过这个任务' });
      continue;
    }
    if (!plan.capacity) {
      plan.skipped.push({ id: t.id, why: `手上已有 ${active} 个进行中的任务，做完再领` });
      continue;
    }
    if (!f) {
      plan.wake.push({ id: t.id, title: t.title, why: '任务池里有可领取的任务' });
      continue;
    }
    const desc = `匹配度 ${f.score}，第 ${f.rank}/${f.of} 名${f.reasons.length ? `（${f.reasons.slice(0, 3).join('、')}）` : ''}`;
    if (f.score < cfg.minScore) {
      plan.skipped.push({ id: t.id, why: `匹配度 ${f.score} 低于 ${cfg.minScore}${f.warnings.length ? `（${f.warnings.join('、')}）` : ''}` });
      continue;
    }
    const since = Date.parse(f.open_since);
    const at = (Number.isNaN(since) ? now : since) + Math.max(0, f.rank - 1) * cfg.staggerMinutes * 60_000;
    if (at <= now) plan.wake.push({ id: t.id, title: t.title, why: `任务池里有适合你的任务，${desc}`, gray: f.score < cfg.minScore + CLAIM_GRAY_BAND });
    else plan.later.push({ id: t.id, at, why: `${desc}，${clock(at)} 还没人领就唤起` });
  }
  return plan;
}
