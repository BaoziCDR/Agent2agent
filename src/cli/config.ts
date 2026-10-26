import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface CliConfig {
  hub?: string;
  token?: string;
  agent?: string;
  name?: string;
  project?: string;
  /** 上次读到的事件号；下次同步时作为 ack 发送 */
  last_seq?: number;
}

const DIR = '.ahub';
const FILE = 'config.json';

/** 从当前目录往上找 .ahub/config.json，找不到再看用户主目录。 */
export function findConfigPath(start = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    const p = join(dir, DIR, FILE);
    if (existsSync(p)) return p;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = join(homedir(), DIR, FILE);
  return existsSync(home) ? home : null;
}

export function loadConfig(): { path: string | null; config: CliConfig } {
  const path = findConfigPath();
  const config: CliConfig = path ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (process.env.AHUB_URL) config.hub = process.env.AHUB_URL;
  if (process.env.AHUB_TOKEN) config.token = process.env.AHUB_TOKEN;
  if (config.hub) config.hub = config.hub.replace(/\/+$/, '');
  return { path, config };
}

export function saveConfig(path: string, config: CliConfig) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 上忽略
  }
  const ignore = join(dirname(path), '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
}

export function defaultConfigPath(global: boolean) {
  return join(global ? homedir() : process.cwd(), DIR, FILE);
}
