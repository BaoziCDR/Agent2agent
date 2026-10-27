import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  task_counter INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'other',
  tier TEXT NOT NULL DEFAULT 'L1',
  description TEXT NOT NULL DEFAULT '',
  skills TEXT NOT NULL DEFAULT '[]',
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active',
  ack_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  presence TEXT NOT NULL DEFAULT 'off'
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploader TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  tags TEXT NOT NULL DEFAULT '[]',
  joined_at TEXT NOT NULL,
  PRIMARY KEY (project_id, agent_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  tags TEXT NOT NULL DEFAULT '[]',
  max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  num INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'P2',
  assignee_id INTEGER REFERENCES agents(id),
  created_by TEXT NOT NULL,
  parent_id INTEGER REFERENCES tasks(id),
  depends_on TEXT NOT NULL DEFAULT '[]',
  required_tags TEXT NOT NULL DEFAULT '[]',
  progress INTEGER NOT NULL DEFAULT 0,
  progress_note TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  block_reason TEXT NOT NULL DEFAULT '',
  lease_until TEXT,
  lease_warned INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, num)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL,
  parts TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL,
  name TEXT NOT NULL,
  parts TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS progress_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  author TEXT NOT NULL,
  percent INTEGER NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  harness TEXT NOT NULL,
  trigger TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  code INTEGER,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, id);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  webhook TEXT NOT NULL,
  secret TEXT NOT NULL DEFAULT '',
  topics TEXT NOT NULL,
  projects TEXT NOT NULL DEFAULT '[]',
  console_url TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  last_sent_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  project_id INTEGER,
  task_id INTEGER,
  audience TEXT,
  data TEXT NOT NULL,
  summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, seq);

-- 回执：agent 接手评论、私信、指派后在下面显示的 👌/✅，由 ahub 命令行和 Hub 自动维护
CREATE TABLE IF NOT EXISTS receipts (
  kind TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  state TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, target_id, agent_id)
);
CREATE INDEX IF NOT EXISTS receipts_agent ON receipts(agent_id, state);

CREATE TABLE IF NOT EXISTS idempotency (
  agent_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, key)
);
`;

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** 给旧数据库补上后来新增的列。 */
function migrate(db: Db) {
  const has = (table: string, col: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col);
  // 在线状态：on 表示上次判定为在线/活跃/空闲，off 表示已判定离线；用于只在状态变化时通知一次
  if (!has('agents', 'presence')) db.exec("ALTER TABLE agents ADD COLUMN presence TEXT NOT NULL DEFAULT 'off'");
  // 截止提醒：0 未提醒，1 已提醒快到期，2 已提醒逾期；改截止时间时清零
  // 负责人在控制台暂停了这个 agent 的值守进程
  if (!has('agents', 'daemon_paused')) db.exec('ALTER TABLE agents ADD COLUMN daemon_paused INTEGER NOT NULL DEFAULT 0');
  // 阻塞时 agent 给出的可选答案（JSON 数组），负责人在控制台点选即可解除阻塞
  if (!has('tasks', 'block_options')) db.exec("ALTER TABLE tasks ADD COLUMN block_options TEXT NOT NULL DEFAULT '[]'");
  // 疑似原地打转：已提醒负责人为 1，进度有变化或状态变化时清零
  if (!has('tasks', 'stall_warned')) db.exec('ALTER TABLE tasks ADD COLUMN stall_warned INTEGER NOT NULL DEFAULT 0');
  // 负责人授权后，agent（如协调者）可以为自己所在的项目创建邀请
  if (!has('agents', 'can_invite')) db.exec('ALTER TABLE agents ADD COLUMN can_invite INTEGER NOT NULL DEFAULT 0');
  if (!has('invites', 'created_by')) db.exec("ALTER TABLE invites ADD COLUMN created_by TEXT NOT NULL DEFAULT 'owner'");
  if (!has('tasks', 'due_warned')) db.exec('ALTER TABLE tasks ADD COLUMN due_warned INTEGER NOT NULL DEFAULT 0');
  // 邀请码可以预设 agent 名称，加入时不写 --name 就用它
  if (!has('runs', 'session')) db.exec("ALTER TABLE runs ADD COLUMN session TEXT NOT NULL DEFAULT ''");
  if (!has('invites', 'agent_name')) db.exec("ALTER TABLE invites ADD COLUMN agent_name TEXT NOT NULL DEFAULT ''");
  // 任务可以引用同项目的其他任务（任意状态），作为参考资料
  if (!has('tasks', 'refs')) db.exec("ALTER TABLE tasks ADD COLUMN refs TEXT NOT NULL DEFAULT '[]'");
  // 交付物可修改：rev 是当前版本号，round 是第几次提交；每个版本的内容存在 artifact_revisions
  if (!has('artifacts', 'rev')) {
    db.exec('ALTER TABLE artifacts ADD COLUMN rev INTEGER NOT NULL DEFAULT 1');
    db.exec('ALTER TABLE artifacts ADD COLUMN round INTEGER NOT NULL DEFAULT 1');
    db.exec('ALTER TABLE artifacts ADD COLUMN updated_at TEXT');
    db.exec('ALTER TABLE artifacts ADD COLUMN updated_by TEXT');
    // 老数据按「交付说明」出现的次数补上轮次：每次提交都会先写一条交付说明
    const rows = db.prepare('SELECT id, task_id, name, created_at FROM artifacts ORDER BY task_id, id').all() as {
      id: number;
      task_id: number;
      name: string;
      created_at: string;
    }[];
    let task = -1;
    let round = 0;
    let at = '';
    for (const r of rows) {
      if (r.task_id !== task) [task, round, at] = [r.task_id, 0, ''];
      if (r.name === '交付说明' && r.created_at !== at) round++;
      at = r.created_at;
      db.prepare('UPDATE artifacts SET round = ? WHERE id = ?').run(Math.max(round, 1), r.id);
    }
  }
  // 负责人是否已读过发给他的 @ 和私信；读过的不再出现在总览「需要你处理」里
  if (!has('events', 'owner_read')) db.exec('ALTER TABLE events ADD COLUMN owner_read INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    artifact_id INTEGER NOT NULL REFERENCES artifacts(id),
    rev INTEGER NOT NULL,
    author TEXT NOT NULL,
    parts TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (artifact_id, rev)
  )`);
  // 还没有版本记录的交付物（包括老数据）补一条第 1 版
  db.exec(`INSERT INTO artifact_revisions (artifact_id, rev, author, parts, created_at)
    SELECT a.id, a.rev, a.author, a.parts, a.created_at FROM artifacts a
    WHERE NOT EXISTS (SELECT 1 FROM artifact_revisions r WHERE r.artifact_id = a.id)`);
}

// 在一个事务里执行；出错回滚。node:sqlite 是同步的，所以不会和其他请求交错。
export function tx<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function json<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
