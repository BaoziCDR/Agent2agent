// 智能打标签：任务发布时，用负责人在设置里配置的外部模型（Chat Completions 接口）
// 从项目成员已有的能力标签里挑出这个任务需要的。没有配置就不开启。
import type { Db } from './db.js';
import { json } from './db.js';
import { HubError, type Hub } from './hub.js';
import type { HubEvent } from '../shared/model.js';

export interface LlmConfig {
  /** 例如 https://api.openai.com/v1，会请求 <base_url>/chat/completions */
  base_url: string;
  api_key: string;
  model: string;
  /** 发布任务时自动打标签 */
  auto_tag: boolean;
}

export interface LlmConfigView {
  base_url: string;
  model: string;
  auto_tag: boolean;
  has_key: boolean;
  key_masked: string;
  configured: boolean;
}

const EMPTY: LlmConfig = { base_url: '', api_key: '', model: '', auto_tag: true };

const SYSTEM = [
  '你帮一个多 agent 协作平台给任务打「能力标签」。只有具备其中至少一个标签的 agent 才能领取这个任务，所以标签打得越多、越偏，能领的人越少。',
  '规则：只能从给出的可选标签里选；只在任务明显需要某种专门能力时才打，通用任务（整理、调研、沟通等）返回空数组；最多 3 个；宁缺毋滥。',
  '只回答一个 JSON 对象：{"tags":["标签"],"reason":"一句中文理由"}。',
].join('\n');

const invalid = (msg: string) => new HubError(400, 'invalid_argument', msg);

export class Tagger {
  private readonly onEvent = (e: HubEvent) => void this.route(e);

  constructor(
    private hub: Hub,
    private db: Db,
    private opts: { fetch?: typeof fetch; timeoutMs?: number } = {},
  ) {}

  start() {
    this.hub.bus.on('event', this.onEvent);
  }

  stop() {
    this.hub.bus.off('event', this.onEvent);
  }

  // ───────────── 配置 ─────────────

  config(): LlmConfig {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'llm'").get() as { value: string } | undefined;
    return { ...EMPTY, ...(row ? json<Partial<LlmConfig>>(row.value, {}) : {}) };
  }

  view(c = this.config()): LlmConfigView {
    return {
      base_url: c.base_url,
      model: c.model,
      auto_tag: c.auto_tag,
      has_key: !!c.api_key,
      key_masked: c.api_key ? `${c.api_key.slice(0, 3)}…${c.api_key.slice(-4)}` : '',
      configured: !!(c.base_url && c.model),
    };
  }

  /** api_key 不传（undefined）就保留原来的；传空字符串表示清除 */
  update(input: Partial<LlmConfig>): LlmConfigView {
    const c = this.config();
    const next: LlmConfig = {
      base_url: input.base_url === undefined ? c.base_url : String(input.base_url).trim().replace(/\/+$/, ''),
      api_key: input.api_key === undefined ? c.api_key : String(input.api_key).trim(),
      model: input.model === undefined ? c.model : String(input.model).trim(),
      auto_tag: input.auto_tag === undefined ? c.auto_tag : !!input.auto_tag,
    };
    if (next.base_url && !/^https?:\/\/\S+$/.test(next.base_url)) throw invalid('接口地址要以 http:// 或 https:// 开头，例如 https://api.openai.com/v1');
    if (next.base_url && !next.model) throw invalid('请填写模型名称');
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('llm', ?)").run(JSON.stringify(next));
    return this.view(next);
  }

  enabled() {
    const c = this.config();
    return !!(c.base_url && c.model && c.auto_tag);
  }

  // ───────────── 打标签 ─────────────

  private async route(e: HubEvent) {
    // 直接发布的任务和草稿发布时打标签；手动指定了标签或负责人的不管
    const published = e.type === 'task.created' || (e.type === 'task.status_changed' && e.data.from === 'draft' && e.data.to === 'open');
    if (!published || !e.task || !this.enabled()) return;
    let task: { id: string; required_tags: string[]; status: string };
    try {
      task = this.hub.getTask(e.task);
    } catch {
      return;
    }
    if (task.required_tags.length || task.status !== 'open') return;
    await this.tagTask(task.id).catch(() => undefined);
  }

  /** 给一个任务打标签；返回选中的标签。出错时放行任务，不打标签 */
  async tagTask(code: string): Promise<{ tags: string[]; reason: string; error?: string }> {
    const t = this.hub.getTask(code);
    const options = this.hub.memberTags(Number(t.project.slice(2)));
    if (!options.size) {
      // 项目里没人有能力标签，打了也没人能领
      return { tags: [], reason: '项目成员都没有能力标签' };
    }
    const internal = this.hub.taskRowId(code);
    this.hub.holdForTagging(internal, (this.opts.timeoutMs ?? 20_000) + 5_000);
    try {
      const prompt = [
        `任务标题：${t.title}`,
        t.description ? `任务描述：${t.description.slice(0, 3000)}` : '',
        t.acceptance.length ? `验收标准：\n${t.acceptance.map((a) => `- ${a}`).join('\n')}` : '',
        t.parent ? `父任务：${t.parent}` : '',
        '',
        `可选标签（括号里是有这个标签的 agent 数）：${[...options].map(([k, n]) => `${k}（${n}）`).join('、')}`,
      ]
        .filter((x) => x !== '')
        .join('\n');
      const reply = await this.chat(prompt);
      const parsed = parseTags(reply);
      if (!parsed) throw new Error(`模型的回答不是预期的 JSON：${reply.slice(0, 200)}`);
      this.hub.applyAutoTags(code, parsed.tags, parsed.reason);
      return parsed;
    } catch (err) {
      // 失败时也发一条动态，让值守进程不用等超时就能看到这个任务
      this.hub.applyAutoTags(code, [], '', (err as Error).message);
      return { tags: [], reason: '', error: (err as Error).message };
    }
  }

  async chat(user: string, cfg = this.config()): Promise<string> {
    if (!cfg.base_url || !cfg.model) throw invalid('还没有配置外部模型');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 20_000);
    try {
      const res = await (this.opts.fetch ?? fetch)(`${cfg.base_url}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {}) },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: user },
          ],
        }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`接口返回 HTTP ${res.status}：${text.slice(0, 200)}`);
      const content = (JSON.parse(text) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error(`接口返回里没有 choices[0].message.content：${text.slice(0, 200)}`);
      return content;
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw new Error('请求外部模型超时');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 设置页的「测试」：用一个示例任务调用一次，看配置能不能用 */
  async test(input?: Partial<LlmConfig>) {
    const c = this.config();
    const cfg: LlmConfig = { ...c, ...Object.fromEntries(Object.entries(input ?? {}).filter(([, v]) => v !== undefined && v !== '')) } as LlmConfig;
    const started = Date.now();
    const reply = await this.chat('任务标题：首页加一个深色模式切换按钮\n\n可选标签（括号里是有这个标签的 agent 数）：前端（2）、后端（1）、测试（1）', cfg).catch((err: Error) => {
      throw new HubError(502, 'upstream_error', err.message);
    });
    const parsed = parseTags(reply);
    return { ok: !!parsed, ms: Date.now() - started, tags: parsed?.tags ?? [], reason: parsed?.reason ?? '', raw: reply.slice(0, 500) };
  }
}

/** 从模型回答里取出 {"tags":[...],"reason":"..."}；允许包在代码块或前后有文字 */
export function parseTags(text: string): { tags: string[]; reason: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]) as { tags?: unknown; reason?: unknown };
    if (!Array.isArray(o.tags)) return null;
    return { tags: o.tags.map((x) => String(x).trim()).filter(Boolean), reason: String(o.reason ?? '').trim().slice(0, 200) };
  } catch {
    return null;
  }
}
