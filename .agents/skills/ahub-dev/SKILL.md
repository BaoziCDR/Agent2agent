---
name: ahub-dev
description: 在 Agent2agent（ahub 协作中枢）仓库里开发和调试的规范：目录分工、构建测试命令、本地起隔离的 Hub、数据库迁移、接入说明与控制台的改动约定、提交 PR 前的检查。改这个仓库的代码、加功能、修 bug、写测试时使用。
---

# ahub 开发调试规范

面向人的开发说明见 [docs/development.md](../../../docs/development.md)。这个仓库就是协作中枢本身：Node.js 服务端（Hub）、`ahub` 命令行、React 控制台、给 agent 读的接入说明。所有面向用户的文字（控制台、命令行输出、报错、接入说明、提交信息）都用中文。

## 1. 环境与常用命令

需要 Node.js 22.13 以上（用内置的 `node:sqlite`，不要引入 better-sqlite3 之类的原生依赖）。

```bash
npm ci                 # 安装依赖；prepare 会顺带构建
npm run build:server   # tsc 编译服务端和命令行到 dist/
npm run build:web      # vite 构建控制台到 web/dist/
npm run build          # 两个都构建
npm test               # 先 build:server，再用 node --test 跑 test/*.test.mjs
npm run typecheck      # 服务端 + 控制台的类型检查
npm run dev:web        # 控制台开发服务器，/api 和 /skill.md 代理到 127.0.0.1:7788
```

测试直接 import `dist/` 里的产物，所以改了 `src/` 一定要重新 `build:server`（`npm test` 会自动做）。只跑一个文件：`npm run build:server && node --test test/hub.test.mjs`；只跑名字匹配的用 `--test-name-pattern "领取"`。

## 2. 目录分工

| 位置 | 内容 | 改动时注意 |
| --- | --- | --- |
| `src/server/db.ts` | 表结构 `SCHEMA` 和 `migrate()` | 见第 4 节 |
| `src/server/hub.ts` | 全部业务逻辑（任务状态机、事件日志、在线状态、领取打分、回执） | 新逻辑放这里，HTTP 和 MCP 只做参数转换 |
| `src/server/app.ts` | Fastify 路由：`/api/v1/*`（agent）、`/api/v1/admin/*`（负责人）、`/skill.md`、`/ahub.tgz`、控制台静态文件 | 负责人接口必须走负责人令牌校验 |
| `src/server/serve.ts` | `ahub serve` 启动、定时巡检（租约、截止、打转、归档、在线） | |
| `src/server/notify.ts` / `tagger.ts` | 钉钉推送 / 外部模型打标签 | 外部调用出错只记日志，不能拖垮主流程 |
| `src/shared/mcp-tools.ts` | MCP 工具定义，HTTP `/mcp` 和 stdio `ahub mcp` 共用 | 工具名前缀 `hub_` |
| `src/cli/ahub.ts` | 命令行入口和帮助文字 | 新命令同时更新帮助 |
| `src/cli/run.ts`、`session.ts`、`claim.ts`、`judge.ts`、`interject.ts` | 值守进程：唤起 harness、会话续用、智能领取、小模型判断、运行中插话 | |
| `src/cli/config.ts`、`auth.ts` | 用户目录 `~/.ahub/identities/` 的身份、授权 ID | |
| `skill/SKILL.md` | 给 agent 读的接入说明（`ahub skill install` 装的就是它） | 见第 5 节 |
| `web/src/` | 控制台 | 见第 6 节 |
| `test/` | `node:test` 测试 | |

## 3. 本地调试

**不要拿正在用的 Hub 数据目录做实验。** 起一个隔离的 Hub，换端口、换数据目录：

```bash
npm run build
node dist/cli/ahub.js serve --port 7790 --data "$(mktemp -d)/ahub-data"
# 终端会打印控制台地址和负责人令牌
```

模拟 agent 时也要隔离用户目录，否则会碰到本机真实身份（`~/.ahub/identities/`）：

```bash
export HOME=$(mktemp -d)          # 只在这个终端里生效
node dist/cli/ahub.js join --hub http://127.0.0.1:7790 --code <控制台新建的身份码> --platform codex
node dist/cli/ahub.js inbox
node dist/cli/ahub.js run --harness claude --dry-run   # 只打印将要执行的命令和提示词，不真正唤起
```

- 控制台开发：另开终端 `npm run dev:web`（代理写死到 7788，调别的端口时临时改 `web/vite.config.ts`，别提交）。
- 直接调接口：`curl -H "Authorization: Bearer <负责人令牌>" http://127.0.0.1:7790/api/v1/admin/projects`；agent 接口先 `POST /api/v1/sessions {"code": "<身份码>"}` 换授权 ID。
- 看实时事件：`ahub stream`，或浏览器打开控制台的「实时动态」。
- 查数据库用只读方式，避免和运行中的 Hub 抢锁：

  ```bash
  node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});console.table(db.prepare(process.argv[2]).all())" .ahub-data/hub.db "SELECT id,name,status,presence,last_seen_at FROM agents"
  ```

## 4. 数据库改动

- 表结构写在 `SCHEMA`（`CREATE TABLE IF NOT EXISTS`），给已有的表加列一律写进 `migrate()`：先 `has(表, 列)` 判断再 `ALTER TABLE ... ADD COLUMN`，带 `NOT NULL DEFAULT`，保证对新库、旧库重复执行都安全。每条迁移上面写一行中文注释说明用途。
- 不删列、不改列名、不改已有值的含义；需要改语义时加新列并在 `migrate()` 里一次性回填（参考 `archive_kind` 把旧的 `canceled` 迁成手动归档）。
- 加测试：用旧表结构建库再 `openDb` 一次，断言迁移后数据正确。
- PR 描述里写明「有表结构变化」，部署时要先在备份副本上试跑迁移（见 `ahub-deploy`）。

## 5. 接入说明（skill/SKILL.md）

- agent 的行为全靠它，命令、参数、状态流转、回复规则变了都要同步改，并保持和 `ahub --help` 一致。
- `{{HUB_URL}}` 是占位符，由 Hub 和 `ahub skill install` 渲染，不要写死地址。
- 版本号是内容的哈希，改完后 agent 侧需要 `ahub skill update`（`ahub run` 启动时自动更新），在 PR 描述里提醒。
- `test/skill.test.mjs` 会检查安装和版本，改了结构要跑一遍。
- 不要把身份码、授权 ID、负责人令牌写进示例。

## 6. 控制台

- 所有文字中文；同时看桌面和手机宽度（底部导航、底部弹窗、表格在手机上变卡片）。
- `web/src/styles.css` 用了 CSS 嵌套，少一个括号浏览器不报错，`test/web.test.mjs` 会检查配平。
- 纯前端改动上线只需重建 `web/dist`，不用重启 Hub；在 PR 描述里写明。
- 有界面变化的 PR 附截图（Playwright 截图即可）。

## 7. 提交和 PR

- 一个 PR 只做一件事。提交和 PR 标题用中文写清用户能感知的变化，例如「ahub run：每小时唤起上限默认改为 50」。
- 提交前本地跑通：`npm run typecheck && npm test`（CI 跑的就是这两步）。
- PR 描述写：改了什么、为什么、怎么验证的、上线影响（是否改表结构、是否要重启 Hub、agent 是否要重装 ahub 或更新 skill）。
- 改了用户可见的行为同时更新 README 和对应文档。
- 遇到问题先看 `ahub-troubleshoot`；上线流程见 `ahub-deploy`。
