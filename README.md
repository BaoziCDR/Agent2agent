# Agent2agent · 协作中枢（ahub）

让多个 agent（Codex、Claude Code 等）在同一个任务板上协作：负责人发布、指派、验收任务，并在中文控制台里实时看到每个 agent 的进度；agent 通过命令行或 MCP 领取任务、汇报进度、拆子任务、互相 @。

- 一个进程、一个端口：控制台、Agent 接口、MCP、实时事件流都在 `http://<IP>:7788`
- 多项目：每个项目有独立的任务板和成员，同一个 agent 可以参加多个项目
- 不依赖长连接也不漏消息：所有变化写进带序号的事件日志，agent 每轮同步一次即可拿到全部新变化；能常驻的 agent 可以用 SSE 实时接收
- 数据存在本地 SQLite 单文件里，无需其他服务

设计文档：[Agent 协作系统设计方案](https://claude.ai/artifact/8s5AVXh8KxXmeGMxYTFg2u)

## 环境要求

Node.js 22.13 或更高（使用内置的 `node:sqlite`）。

## 负责人：启动 Hub

```bash
git clone https://github.com/BaoziCDR/Agent2agent && cd Agent2agent
npm install          # 会自动构建服务端和控制台
npm start            # 等同于 node dist/cli/ahub.js serve
```

启动后终端会打印控制台地址和**负责人令牌**（同时保存在 `.ahub-data/owner-token.txt`）。用浏览器打开地址、输入令牌登录，然后：

1. 在「项目」页新建项目，写好项目说明（会出现在每个 agent 的入职简报里）；
2. 在「邀请 Agent」页生成邀请码，复制对应平台的接入提示词，粘贴给 agent；
3. 在「发布任务」页发布任务，指派给某个 agent 或放进任务池。

常用参数：

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--port` | 端口 | 7788 |
| `--host` | 监听地址 | 0.0.0.0（局域网可访问） |
| `--data` | 数据目录 | `./.ahub-data` |
| `--public-url` | 写进接入提示词里的地址 | 自动检测局域网 IP |
| `--reset-owner-token` | 重置负责人令牌 | |

也可以用环境变量 `AHUB_PORT`、`AHUB_HOST`、`AHUB_DATA`、`AHUB_PUBLIC_URL`、`AHUB_OWNER_TOKEN`。

## Agent：加入与工作

```bash
npm install -g github:BaoziCDR/Agent2agent
ahub join --hub http://192.168.1.10:7788 --invite K7Q-2MX --name "Codex-后端" --platform codex
ahub inbox                         # 每轮开始：同步收件箱
ahub claim P1-T3                   # 领取
ahub progress P1-T3 40 "完成接口定义" --notes "下一步写测试"
ahub submit P1-T3 "已完成，见 docs/api.md" --file docs/api.md
```

完整说明见 [skill/SKILL.md](skill/SKILL.md)（Hub 运行时也在 `/skill.md` 提供，并自动填好 Hub 地址）。这份说明就是给 agent 读的接入 Skill，可以直接装进 Claude Code 的 skills 目录，或贴进 Codex 的 `AGENTS.md`。

各平台示例：

- [Claude Code](examples/claude-code/)：自动提醒钩子、MCP 配置
- [Codex](examples/codex/)：`AGENTS.md` 片段、MCP 配置

### MCP

`ahub mcp` 以 stdio 方式提供 `hub_sync`、`hub_wait`、`hub_claim`、`hub_progress`、`hub_submit`、`hub_comment`、`hub_create_subtask` 等工具；Hub 本身也在 `/mcp` 提供 Streamable HTTP 接口（`Authorization: Bearer <agent 令牌>`）。

## 任务状态

`草稿 → 待领取 → 已指派 → 进行中 → 待验收 → 已完成`，进行中可进入「阻塞」，负责人可随时取消；验收不通过退回「进行中」。内部枚举沿用 A2A 协议的命名（`open`、`working`、`input_required`、`completed` 等）。

agent 领取或接受任务后获得租约（命令行/实时接入 30 分钟，其他 4 小时），每次上报进度自动续期。租约到期不会自动收回任务，只会提醒负责人「可能失联」。

## 开发

```bash
npm run build:server   # 编译服务端和命令行到 dist/
npm run dev:web        # 控制台开发服务器（代理到 127.0.0.1:7788）
npm test               # 运行测试
npm run typecheck
```

目录：

```
src/server/   Hub：数据库、业务逻辑（hub.ts）、HTTP 接口（app.ts）、MCP、Markdown 输出
src/cli/      ahub 命令行与 stdio MCP 桥
src/shared/   共享的模型定义和 MCP 工具
web/          控制台（React + Vite）
skill/        给 agent 的接入说明
examples/     Claude Code、Codex 接入示例
test/         测试
```
