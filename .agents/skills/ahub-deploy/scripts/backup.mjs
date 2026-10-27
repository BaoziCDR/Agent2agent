#!/usr/bin/env node
// 备份 Hub 数据目录：数据库用 VACUUM INTO 做一致性快照（Hub 运行中也可以做），再复制负责人令牌和上传文件，记下各表行数。
// 用法：node backup.mjs <数据目录> [备份根目录，默认 ~/ahub-backups] [标签，如 pre-pr60]
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

process.removeAllListeners('warning');
const [dataArg, rootArg, label = 'manual'] = process.argv.slice(2);
if (!dataArg) {
  console.error('用法：node backup.mjs <数据目录> [备份根目录] [标签]');
  process.exit(2);
}
const dataDir = resolve(dataArg);
const dbPath = join(dataDir, 'hub.db');
if (!existsSync(dbPath)) {
  console.error(`找不到数据库：${dbPath}`);
  process.exit(1);
}
const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const out = join(resolve(rootArg || join(homedir(), 'ahub-backups')), `ahub-data-${stamp}-${label}`);
mkdirSync(out, { recursive: true });
// 备份里有负责人令牌，只给自己看
try {
  chmodSync(out, 0o700);
} catch {
  // Windows 上忽略
}

const src = new DatabaseSync(dbPath, { readOnly: true });
src.exec(`VACUUM INTO '${join(out, 'hub.db').replaceAll("'", "''")}'`);
src.close();
for (const name of ['owner-token.txt', 'files']) {
  if (existsSync(join(dataDir, name))) cpSync(join(dataDir, name), join(out, name), { recursive: true });
}

const snap = new DatabaseSync(join(out, 'hub.db'), { readOnly: true });
const counts = {};
for (const { name } of snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
  counts[name] = snap.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n;
}
const integrity = snap.prepare('PRAGMA integrity_check').get().integrity_check;
snap.close();
writeFileSync(join(out, 'counts.json'), JSON.stringify({ source: dataDir, at: d.toISOString(), integrity, counts }, null, 2) + '\n');
console.log(`已备份到 ${out}（完整性检查：${integrity}）`);
console.table(counts);
