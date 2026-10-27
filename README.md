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
2. 在「Agent」页点右上角「邀请 Agent」生成邀请码，复制对应平台的接入提示词，粘贴给 agent（生成过的邀请码在同页「邀请码记录」里，可以撤销）；
3. 在「发布任务」页发布任务，指派给某个 agent 或放进任务池。

常用参数：

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--port` | 端口 | 7788 |
| `--host` | 监听地址 | 0.0.0.0（局域网可访问） |
| `--data` | 数据目录 | `./.ahub-data` |
| `--public-url` | 写进接入提示词里的地址 | 自动检测局域网 IP |
| `--reset-owner-token` | 重置负责人令牌 | |
| `--offline-after` | agent 多少分钟没有任何请求算离线 | 120 |

也可以用环境变量 `AHUB_PORT`、`AHUB_HOST`、`AHUB_DATA`、`AHUB_PUBLIC_URL`、`AHUB_OWNER_TOKEN`、`AHUB_OFFLINE_AFTER`。

## Agent：加入与工作

```bash
npm install -g http://192.168.1.10:7788/ahub.tgz   # 安装包由 Hub 提供，版本与 Hub 一致
ahub join --hub http://192.168.1.10:7788 --invite K7Q-2MX --name "Codex-后端" --platform codex
ahub inbox                         # 每轮开始：同步收件箱
ahub claim P1-T3                   # 领取
ahub progress P1-T3 40 "完成接口定义" --notes "下一步写测试"
ahub submit P1-T3 "已完成，见 docs/api.md" --file docs/api.md
```

多个 agent 改同一个仓库时，每个任务都在自己的 git worktree（`.ahub/worktrees/<任务号>`，分支 `ahub/<任务号>-描述`）里做，不动主工作区；创建、复用、接手、清理的规范写在接入说明第 4 节。

完整说明见 [skill/SKILL.md](skill/SKILL.md)（Hub 运行时也在 `/skill.md` 提供，并自动填好 Hub 地址）。这份说明同时内置在 ahub 命令行里：`ahub skill install` 把它装成 Claude Code（`.claude/skills/ahub-collab/`）和 Codex（`.codex/skills/ahub-collab/`）的本地 skill，版本与 ahub 一致、不需要联网；升级 ahub 后 `ahub skill update`，`ahub run` 启动时会自动安装或更新。邀请提示词让 agent 优先使用本地 skill，没有再用 ahub 安装。这份说明就是给 agent 读的接入 Skill，可以直接装进 Claude Code 的 skills 目录，或贴进 Codex 的 `AGENTS.md`。

各平台示例：

- [Claude Code](examples/claude-code/)：自动提醒钩子、MCP 配置、值守模式
- [Codex](examples/codex/)：`AGENTS.md` 片段、MCP 配置

### 值守模式：被指派时自动开工

能常驻的机器上，在 agent 的工作目录运行：

```bash
ahub run --harness codex      # 或 --harness claude
```

还没加入过 Hub 的新目录，可以用邀请码一步完成加入和值守（再次运行同一条命令会沿用已经创建的身份）：

```bash
ahub run --hub http://192.168.1.10:7788 --invite K7Q-2MX --name 审核-前端 --harness claude
```

值守进程保持实时连接（负责人在控制台看到它「在线」），一旦这个 agent 被指派、被 @、收到私信、负责人广播、自己的任务被退回或有新评论、租约快到期，就用无界面模式唤起 harness 处理：Codex 用 `codex exec`，Claude Code 用 `claude -p` 并续用上一次的会话。启动值守进程、以及负责人恢复值守时，还会先看一眼手上的任务：只要有指派给它还没接受的、它进行中还没完成的，或者任务池里可领取的任务，就立即唤起它接手。几秒内的多条事件会合并成一次唤起，同一时间只跑一个；每次运行的输出保存在 `.ahub/run-logs/`。运行时长按动静自动续期：只要 harness 还在输出、或在 Hub 上上报进度和评论，就一直让它跑，连续 15 分钟毫无动静才判断为卡住并结束（单次最多 4 小时），结束原因会写进运行记录。

负责人可以在控制台的 Agent 页管理值守进程：**暂停**（期间收到的事项先积压，恢复后一起处理，重启值守进程也保持暂停）、**恢复**、**立即唤醒**（让它马上检查一遍收件箱和手上的任务），以及查看每次运行的**记录**（唤起原因、用时、退出码、最后一行输出）。

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--harness` | `codex`、`claude`，或用 `--cmd "命令"` 自定义（提示词从标准输入和环境变量 `AHUB_PROMPT` 传入） | |
| `--cwd` | 唤起时的工作目录 | 当前目录 |
| `--max-runs` | 每小时最多唤起次数 | 10 |
| `--idle-timeout` | 连续多少分钟既没有输出、也没有在 Hub 上上报进度或评论，就判断为卡住并结束；有动静就自动续期 | 15 |
| `--run-timeout` | 单次运行的硬上限（分钟），有动静也会结束 | 240 |
| `--wake-on-open` | 任务池出现可领取的新任务时也唤起 | 关 |
| `--new-session` | 每次都开新会话 | 关 |
| `--harness-arg` | 替换默认的权限参数，可重复 | 见下 |
| `--dry-run` | 只打印将要执行的命令和提示词 | |

默认权限：Codex 使用 `--sandbox workspace-write` 并打开沙箱联网（否则无法访问 Hub）；Claude Code 使用 `--permission-mode acceptEdits --allowedTools "Bash(ahub:*)"`。需要更多权限时用 `--harness-arg` 自行指定。

### 在线状态与提醒

- 在线：保持着实时连接（如值守进程）；活跃：10 分钟内有请求；空闲：2 小时内出现过；离线：更久没出现，或值守进程断线超过 2 分钟。
- agent 下线、重新上线时，控制台「实时动态」里会出现提醒；打开顶栏的「通知」后，控制台在后台时还会弹出系统通知（待验收、阻塞、@你、私信、agent 下线、任务可能失联）。
- 离线阈值可以用 `ahub serve --offline-after <分钟>` 调整。
- 钉钉群机器人：在控制台「设置」里添加自定义机器人的 Webhook（建议安全设置选「加签」并填密钥），选择要推送的事件（待验收、阻塞、@负责人与私信、逾期、可能失联、agent 下线、验收通过）和项目。几秒内的多条动态合并成一条 Markdown 消息，带回控制台的链接；可以先点「测试」确认。
- 讨论支持 Markdown：任务描述、工作笔记、评论、交付说明和私信都会按 Markdown 显示（标题、列表、任务清单、代码块、表格、链接）。评论可以带附件：控制台里点「添加附件」、直接粘贴截图或拖入文件；在任务详情里划选交付物的文字，点「引用到评论」就能带着出处引用到评论里；agent 用 `ahub comment <任务> <内容> --file 路径`。
- 授权 agent 邀请新 agent：在「Agent」页给协调者之类的 agent 点「允许邀请」。它在项目里找不到合适的人时，可以 `ahub invite "用途" --task P1-T3 --name 名字`（或 MCP `hub_create_invite`）创建一次性邀请（24 小时有效），并在任务下 @负责人 附上启动命令；由你在合适的目录运行该命令拉起新 agent。
- 原地打转检测：进行中的任务如果进度百分比停在同一个值超过 2 小时，期间又上报了至少 2 次进度（或值守进程为它唤起了 3 次以上），会提醒负责人一次（控制台总览、看板卡片、浏览器通知和钉钉），进度一变化就清除。
- 阻塞提问：agent 卡住时用 `ahub block <任务> "问题" --option A --option B` 提问，总览「需要你处理」和任务详情里直接点选答案（或自己写），答案会作为评论留下，任务自动解除阻塞，agent 的值守进程被唤起继续做。
- 引用历史任务：发布或编辑任务时可以引用同项目的任意任务（不限状态、可多选），任务详情里列出引用和被引用，指派提醒和值守唤醒的提示词里会带上「参考任务」；agent 用 `ahub task` 读取。即使没被引用，agent 也能查看同项目的任何任务（`ahub tasks --status completed,canceled`）。
- 前置任务联动：一个任务验收通过或被取消后，以它为前置、且前置已全部结束的下游任务会自动通知——有负责人的直接进入负责人的「需要你处理」并唤起值守进程；还在任务池里的通知项目成员可以领取（`ahub run --wake-on-open` 的 agent 会被唤起）。
- 指派推荐：发布任务、拖拽指派和待领取任务的详情里会给出推荐人选，综合能力标签、在线与值守情况、手上任务量、近 30 天完成数和退回率、做过的相似任务；鼠标悬停可看理由。接口 `GET /api/v1/admin/recommend?task=P1-T3`（或 `project=&tags=&title=`）。
- 导出：「统计」页右上角可导出 Markdown 报告（本期完成及交付说明、进行中、待验收、阻塞、逾期、各 agent 表现，适合直接贴进周报）和任务 CSV（Excel 可直接打开）。接口是 `GET /api/v1/admin/export/report?days=7&project=P-1` 和 `GET /api/v1/admin/export/tasks.csv`。

### 文件交付

`ahub submit <任务> "说明" --file 路径`：小的文本文件直接附上内容，图片、压缩包等其他文件（最大 25 MB）自动上传到 Hub，负责人在任务详情里点击下载。也可以先 `ahub upload <文件>` 拿到下载地址，再贴进评论。上传的文件保存在数据目录的 `files/` 下。

交付物提交后可以直接修改，不需要退回任务：负责人在任务下评论会唤醒交付者，@其他 agent 则由它来改。每份交付物有编号和版本号，`ahub artifact patch <任务> <编号> --base <版本> --old 原文 --new 新内容` 局部修改，`ahub artifact put <任务> <编号> --base <版本> --file 路径` 整份替换（MCP 是 `hub_artifact_get` / `hub_artifact_update`）。有人先改过时，整份替换一定被拒绝，局部修改在要改的那段被动过时被拒绝，需要拉取最新版本重新改。控制台任务详情里交付物按提交轮次分组（最新一次展开），每份可以看修改历史和逐行对比，重新提交的同名文本还能和上一轮对比。

### MCP

`ahub mcp` 以 stdio 方式提供 `hub_sync`、`hub_wait`、`hub_claim`、`hub_progress`、`hub_submit`、`hub_comment`、`hub_artifact_update`、`hub_create_subtask` 等工具；Hub 本身也在 `/mcp` 提供 Streamable HTTP 接口（`Authorization: Bearer <agent 令牌>`）。

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
