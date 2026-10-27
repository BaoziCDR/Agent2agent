// 身份码与授权 ID：每次连接用身份码换一个授权 ID，之后的请求都带授权 ID。
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { type CliConfig, saveConfig } from './config.js';

export type Client = 'cli' | 'run' | 'mcp';

/** 授权 ID 失效、身份码无效等 Hub 拒绝连接的情况 */
export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 被顶掉、被强制下线：不能自动重连 */
export const isFinal = (code: string) => code === 'session_revoked' || code === 'session_replaced';
/** 身份本身不能用了：身份码无效、身份被停用或删除 */
export const isDeadIdentity = (code: string) => ['invalid_code', 'agent_disabled', 'agent_deleted'].includes(code);

export function identityCode(cfg: CliConfig): string | undefined {
  return cfg.code ?? cfg.token;
}

/** 老的一次性邀请码（XXX-XXX）；身份码是 12 位 */
export const looksLikeInvite = (s: string) => /^[A-Z0-9]{3}-?[A-Z0-9]{3}$/i.test(s.trim());

export interface OpenOptions {
  client: Client;
  takeover?: boolean;
  cwd?: string;
  name?: string;
  platform?: string;
  tags?: string[];
  skills?: string[];
}

function parseError(status: number, text: string): AuthError {
  try {
    const e = JSON.parse(text).error as { code?: string; message?: string } | undefined;
    if (e?.message) return new AuthError(e.code ?? `http_${status}`, e.message);
  } catch {
    // 不是 JSON
  }
  return new AuthError(`http_${status}`, text.slice(0, 200) || `HTTP ${status}`);
}

/** 用身份码换授权 ID，结果写回配置（老邀请码会换成正式身份码保存）。 */
export async function openSession(cfg: CliConfig, path: string | null, opts: OpenOptions): Promise<string> {
  const code = identityCode(cfg);
  if (!cfg.hub) throw new AuthError('no_hub', '还没有配置 Hub 地址，请加 --hub http://地址:端口');
  if (!code) throw new AuthError('no_code', '还没有身份码。请向负责人要身份码，然后运行 ahub join --code <身份码>');
  let res: Response;
  try {
    res = await fetch(`${cfg.hub}/api/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        client: opts.client,
        host: hostname(),
        cwd: opts.cwd ?? process.cwd(),
        takeover: !!opts.takeover,
        name: opts.name,
        platform: opts.platform,
        tags: opts.tags,
        skills: opts.skills,
      }),
    });
  } catch (err) {
    throw new AuthError('network', `连接 Hub 失败（${cfg.hub}）：${(err as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) throw parseError(res.status, text);
  const data = JSON.parse(text) as { session: string; code: string | null; agent: { id: string; name: string; projects: { id: string }[] } };
  if (data.code) cfg.code = data.code;
  else if (!cfg.code) cfg.code = code;
  delete cfg.token;
  cfg.session = data.session;
  cfg.agent = data.agent.id;
  cfg.name = data.agent.name;
  if (!cfg.project || !data.agent.projects.some((p) => p.id === cfg.project)) cfg.project = data.agent.projects[0]?.id;
  if (path) saveConfig(path, cfg);
  return data.session;
}

/** 别的进程（同一身份的值守、MCP 桥）可能已经换了新的授权 ID，先看看配置文件里的 */
function sessionOnDisk(path: string | null): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as CliConfig).session;
  } catch {
    return undefined;
  }
}

async function errorCode(res: Response): Promise<string> {
  const header = res.headers.get('x-ahub-error');
  if (header) return header;
  try {
    return (JSON.parse(await res.clone().text()).error?.code as string) ?? '';
  } catch {
    return '';
  }
}

/**
 * 带授权 ID 请求 Hub。没有授权 ID 时先用身份码换一个；授权 ID 过期时重新换一次再试。
 * 被顶掉或被强制下线时不重连，原样返回 401，由调用方提示。
 * 环境变量 AHUB_SESSION（值守进程唤起的 harness）优先，且不会自己重新换。
 */
export async function hubFetch(cfg: CliConfig, path: string | null, url: string, init: RequestInit, opts: OpenOptions): Promise<Response> {
  const fromEnv = process.env.AHUB_SESSION;
  const call = (session: string | undefined) =>
    fetch(cfg.hub + url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...(session ? { authorization: `Bearer ${session}` } : {}) },
    });
  if (fromEnv) return call(fromEnv);
  let session = cfg.session;
  if (!session && identityCode(cfg)) session = await openSession(cfg, path, opts);
  let res = await call(session);
  if (res.status !== 401 || !session) return res;
  const code = await errorCode(res);
  if (isFinal(code)) {
    if (cfg.session === session) {
      delete cfg.session;
      if (path) saveConfig(path, cfg);
    }
    return res;
  }
  if (code !== 'session_expired' && code !== 'unauthorized') return res;
  const disk = sessionOnDisk(path);
  if (disk && disk !== session) {
    cfg.session = disk;
    res = await call(disk);
    if (res.status !== 401) return res;
  }
  delete cfg.session;
  session = await openSession(cfg, path, opts);
  return call(session);
}

/** 交还授权 ID（进程退出时），失败不要紧，超时后也会自动失效 */
export async function releaseSession(cfg: CliConfig, session: string | undefined) {
  if (!cfg.hub || !session) return;
  try {
    await fetch(`${cfg.hub}/api/v1/sessions/current`, { method: 'DELETE', headers: { authorization: `Bearer ${session}` } });
  } catch {
    // 忽略
  }
}
