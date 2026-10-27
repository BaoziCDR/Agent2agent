#!/usr/bin/env node
// 在备份副本上试跑新版本的迁移：复制快照到临时目录，用新构建的 dist/server/db.js 打开（会执行 migrate），对比各表行数。
// 先在新代码目录里 npm run build:server；用法：node trial-migrate.mjs <备份目录> [新代码目录，默认当前目录]
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

process.removeAllListeners('warning');
const [backupArg, repoArg = '.'] = process.argv.slice(2);
if (!backupArg) {
  console.error('用法：node trial-migrate.mjs <备份目录> [新代码目录]');
  process.exit(2);
}
const backup = resolve(backupArg);
const dbModule = join(resolve(repoArg), 'dist', 'server', 'db.js');
if (!existsSync(dbModule)) {
  console.error(`找不到 ${dbModule}，先在新代码目录里 npm run build:server`);
  process.exit(1);
}
const before = JSON.parse(readFileSync(join(backup, 'counts.json'), 'utf8')).counts;
const copy = join(mkdtempSync(join(tmpdir(), 'ahub-trial-')), 'hub.db');
copyFileSync(join(backup, 'hub.db'), copy);

const { openDb } = await import(pathToFileURL(dbModule).href);
openDb(copy).close();

const db = new DatabaseSync(copy, { readOnly: true });
const rows = [];
let changed = 0;
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
  const after = db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n;
  const was = before[name];
  const note = was === undefined ? '新表' : was === after ? '' : '行数变化';
  if (note === '行数变化') changed++;
  rows.push({ 表: name, 备份: was ?? '-', 迁移后: after, 说明: note });
}
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
db.close();
console.table(rows);
console.log(`试跑副本：${copy}（完整性检查：${integrity}）`);
if (changed || integrity !== 'ok') {
  console.error('有表的行数变了或完整性检查没通过：先弄清原因再上线（个别迁移会按设计回填或改写数据，对照 PR 说明确认）。');
  process.exit(1);
}
console.log('迁移试跑通过：已有表的行数全部一致。');
