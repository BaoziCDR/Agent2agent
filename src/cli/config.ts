import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface CliConfig {
  hub?: string;
  /** 身份码：可以反复使用，每次连接用它换授权 ID */
  code?: string;
  /** 旧版保存的令牌，现在当作身份码使用 */
  token?: string;
  /** 当前授权 ID；过期后用身份码重新换 */
  session?: string;
  agent?: string;
  name?: string;
  project?: string;
  /** 上次读到的事件号；下次同步时作为 ack 发送 */
  last_seq?: number;
}

/**
 * 配置统一放在用户目录，不看当前目录：
 *   ~/.ahub/identities/<身份>/config.json   每个身份一份（身份码、授权 ID、默认项目…）
 *   ~/.ahub/identities/<身份>/run-state.json、run-logs/   值守进程的会话记录和运行日志
 *   ~/.ahub/current                          默认身份
 * <身份> 是身份码摘要的前几位，同一个身份码在哪个目录运行都落到同一处。
 */
export const ahubHome = () => join(homedir(), '.ahub');
const identitiesDir = () => join(ahubHome(), 'identities');
const currentFile = () => join(ahubHome(), 'current');

export const keyOf = (code: string) => createHash('sha256').update(normalize(code)).digest('hex').slice(0, 10);
const normalize = (code: string) => {
  const t = code.trim();
  const m = /^([a-z0-9]{4})-?([a-z0-9]{4})-?([a-z0-9]{4})$/i.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}`.toUpperCase() : t;
};

export interface Identity {
  key: string;
  path: string;
  config: CliConfig;
}

function read(path: string): CliConfig | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as CliConfig;
  } catch {
    return null;
  }
}

export function listIdentities(): Identity[] {
  const dir = identitiesDir();
  if (!existsSync(dir)) return [];
  const out: Identity[] = [];
  for (const key of readdirSync(dir).sort()) {
    const path = join(dir, key, 'config.json');
    const config = existsSync(path) ? read(path) : null;
    if (config) out.push({ key, path, config });
  }
  return out;
}

export const identityPath = (key: string) => join(identitiesDir(), key, 'config.json');

export function currentKey(): string | null {
  try {
    return readFileSync(currentFile(), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function setCurrent(key: string | null) {
  mkdirSync(ahubHome(), { recursive: true });
  if (key) writeFileSync(currentFile(), key + '\n');
  else rmSync(currentFile(), { force: true });
}

/** 按编号（A-5）、名字或目录名找本机的身份 */
export function findIdentity(query: string): Identity | null {
  const q = query.trim();
  const all = listIdentities();
  return (
    all.find((i) => i.key === q) ??
    all.find((i) => i.config.agent?.toUpperCase() === q.toUpperCase()) ??
    all.find((i) => i.config.name === q) ??
    all.find((i) => i.config.code && normalize(i.config.code) === normalize(q)) ??
    null
  );
}

/** 把一个身份码保存为本机身份（已有就沿用），返回它的配置位置 */
export function identityFor(code: string, hub?: string): Identity {
  const existing = listIdentities().find((i) => (i.config.code ?? i.config.token) && normalize(i.config.code ?? i.config.token!) === normalize(code));
  if (existing) {
    if (hub) existing.config.hub = hub;
    return existing;
  }
  const key = keyOf(code);
  return { key, path: identityPath(key), config: { hub, code: normalize(code) } };
}

/** 从本机删掉一个身份 */
export function forgetLocal(key: string) {
  rmSync(join(identitiesDir(), key), { recursive: true, force: true });
  if (currentKey() === key) setCurrent(null);
}

/**
 * 旧版把身份放在工作目录的 .ahub/config.json（或主目录的 ~/.ahub/config.json）。
 * 找到就导入到用户目录：值守的会话记录和日志一起搬过去，原文件改名为 config.json.migrated。
 */
export function migrateLegacy(start = process.cwd()): Identity[] {
  const found: string[] = [];
  let dir = resolve(start);
  for (;;) {
    const p = join(dir, '.ahub', 'config.json');
    if (existsSync(p)) found.push(p);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = join(ahubHome(), 'config.json');
  if (existsSync(home) && !found.includes(home)) found.push(home);
  const out: Identity[] = [];
  for (const old of found) {
    const cfg = read(old);
    const code = cfg?.code ?? cfg?.token;
    if (!cfg || !code) continue;
    const id = identityFor(code, cfg.hub);
    const merged: CliConfig = { ...cfg, ...id.config, code: id.config.code ?? normalize(code) };
    for (const k of ['agent', 'name', 'project', 'last_seq', 'session'] as const) if (merged[k] === undefined && cfg[k] !== undefined) (merged as Record<string, unknown>)[k] = cfg[k];
    delete merged.token;
    saveConfig(id.path, merged);
    const from = dirname(old);
    const to = dirname(id.path);
    for (const name of ['run-state.json', 'run-logs']) {
      if (existsSync(join(from, name)) && !existsSync(join(to, name))) {
        try {
          renameSync(join(from, name), join(to, name));
        } catch {
          // 跨磁盘等情况搬不动就留在原处
        }
      }
    }
    renameSync(old, `${old}.migrated`);
    out.push({ ...id, config: merged });
  }
  return out;
}

export type Selected = { identity: Identity | null; ambiguous: Identity[]; migrated: Identity[] };

/**
 * 选出这次用哪个身份：AHUB_IDENTITY 环境变量 > --identity > --code > 默认身份 > 本机唯一的身份。
 * 本机有多个身份又没指定时 ambiguous 列出它们，由调用方决定用默认身份还是要求指定。
 */
export function selectIdentity(opts: { identity?: string; code?: string; hub?: string } = {}): Selected {
  const migrated = migrateLegacy();
  if (migrated.length && !currentKey()) setCurrent(migrated[0].key);
  const env = process.env.AHUB_IDENTITY;
  const pick = (identity: Identity | null): Selected => ({ identity, ambiguous: [], migrated });
  if (env) {
    const i = findIdentity(env);
    if (i) return pick(i);
  }
  if (opts.identity) return pick(findIdentity(opts.identity));
  const code = opts.code ?? process.env.AHUB_CODE ?? process.env.AHUB_TOKEN;
  if (code) return pick(identityFor(code, opts.hub));
  const all = listIdentities();
  const cur = currentKey();
  const current = cur ? all.find((i) => i.key === cur) : undefined;
  if (current) return { identity: current, ambiguous: all.length > 1 ? all : [], migrated };
  if (all.length === 1) return pick(all[0]);
  return { identity: null, ambiguous: all, migrated };
}

export function applyEnv(config: CliConfig): CliConfig {
  if (process.env.AHUB_URL) config.hub = process.env.AHUB_URL;
  if (config.hub) config.hub = config.hub.replace(/\/+$/, '');
  if (config.token && !config.code) {
    config.code = config.token;
    delete config.token;
  }
  return config;
}

export function saveConfig(path: string, config: CliConfig) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 上忽略
  }
}

/** 本机的命令行设置（与身份无关）：~/.ahub/settings.json */
export interface CliSettings {
  /** 命令行和 skill 的语言：zh 或 en；不设时自动判断 */
  lang?: string;
}
const settingsFile = () => join(ahubHome(), 'settings.json');

export function readSettings(): CliSettings {
  try {
    return JSON.parse(readFileSync(settingsFile(), 'utf8')) as CliSettings;
  } catch {
    return {};
  }
}

export function saveSettings(s: CliSettings) {
  mkdirSync(ahubHome(), { recursive: true });
  writeFileSync(settingsFile(), JSON.stringify(s, null, 2) + '\n');
}
