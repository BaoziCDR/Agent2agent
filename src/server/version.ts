import { readFileSync } from 'node:fs';

/** 与 package.json 一致的版本号（dist/server → 仓库根目录） */
export const VERSION = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
