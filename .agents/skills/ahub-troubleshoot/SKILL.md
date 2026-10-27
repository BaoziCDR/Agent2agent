---
name: ahub-troubleshoot
description: 排查 ahub 协作中枢问题的规范：先收集证据再下结论，Hub、值守进程、harness、数据库各看哪里，常见症状（连不上、已经在线、被下线、没被唤起、唤起太多、卡住、控制台打不开、迁移失败）的原因和处理。Hub 或 agent 出问题、负责人反馈异常、需要分析某次协作记录时使用。
---

# ahub 问题排查规范

## 1. 原则

1. **先收集证据，再下结论。** 每个结论都要能指到一条日志、一行数据库记录或一个可复现的命令；推测要标明是推测。
2. **只读排查。** 查数据库用只读连接；不在生产数据目录上试修复；需要改数据、重启 Hub、强制下线 agent 时，先告诉负责人原因和影响，等同意。
3. **先复现，再修。** 能复现的问题在隔离的 Hub 上复现（见 `ahub-dev` 第 3 节），修复带上能复现它的测试。
4. **区分「配置/操作问题」和「代码 bug」。** 前者给出处理步骤；后者开 PR 修，并说明影响范围。
5. 汇报写：现象、证据、原因、已做的处理、还需要谁做什么。

## 2. 证据在哪里

| 位置 | 内容 |
| --- | --- |
| `GET /api/v1/health` | Hub 是否活着、事件日志最新序号 `last_seq` |
| Hub 的标准输出 | 启动信息、定时巡检错误、钉钉推送失败。源码部署看启动时重定向的日志文件（如 `~/ahub-backups/hub.log`），Docker 看 `docker compose logs --tail 200 ahub` |
| 数据库 `hub.db` | 所有事实：`events`（带序号的事件日志）、`tasks`、`comments`、`progress_log`、`messages`、`runs`（值守每次唤起）、`sessions`（每次连接、下线原因）、`receipts`（👌/✅ 回执）、`task_passes`（让出记录） |
| 控制台 | 实时动态、Agent 页的连接记录和运行记录、任务详情的领取候选 |
| 负责人接口 | `/api/v1/admin/events`、`/api/v1/admin/agents/<A-5>/runs`、`/api/v1/admin/agents/<A-5>/sessions`（带负责人令牌） |
| agent 机器 `~/.ahub/identities/<身份>/` | `config.json`（身份、Hub 地址）、`run-state.json`（会话续用记录）、`run-logs/`（每次唤起 harness 的完整输出，`interject/` 下是运行中插话的投递记录） |
| `ahub run` 的终端输出 | 带时间戳的值守日志：连接、唤起原因、会话决策、领取判断、上限、退出码 |
| harness 自己的会话记录 | Claude Code：`~/.claude/projects/<目录>/<会话>.jsonl`；Codex：`~/.codex/sessions/` |

只读查询数据库（Hub 运行中也安全）：

```bash
q() { node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1],{readOnly:true});console.table(db.prepare(process.argv[2]).all())" "$DB" "$1" 2>/dev/null; }
DB=.ahub-data/hub.db     # Docker：先 docker compose cp ahub:/data/hub.db /tmp/hub.db，或在容器里执行
q "SELECT seq, at, type, actor, task_id, summary FROM events ORDER BY seq DESC LIMIT 30"
q "SELECT id, agent_id, client, host, cwd, created_at, last_seen_at, ended_at, end_reason, end_note FROM sessions ORDER BY id DESC LIMIT 20"
q "SELECT id, agent_id, trigger, started_at, ended_at, code, summary FROM runs ORDER BY id DESC LIMIT 20"
```

时间都是 UTC（ISO 字符串），和负责人说时间时换算成北京时间。

## 3. 常见症状

### Hub / 控制台

| 症状 | 先查 | 常见原因和处理 |
| --- | --- | --- |
| 打不开控制台、agent 连不上 | `curl http://127.0.0.1:7788/api/v1/health`；进程在不在（`ps` / `docker compose ps`） | 进程没起来：看日志最后的报错。本机通、别的机器不通：`--host` 不是 `0.0.0.0`、防火墙、IP 变了。 |
| 健康接口正常但首页 404 | `web/dist/index.html` 是否存在 | 源码部署没构建控制台：`npm run build:web`。 |
| 启动报 `node:sqlite` 找不到 | `node --version` | Node 低于 22.13，升级。 |
| 接入提示词、安装命令里的地址不对 | `AHUB_PUBLIC_URL` / `--public-url` | 没设时自动取局域网 IP，多网卡或 Docker 里会取错，显式设置后重启。 |
| 负责人令牌登录不了 | 数据目录里的 `owner-token.txt` | 设过 `AHUB_OWNER_TOKEN` 时以它为准；丢了用 `--reset-owner-token` 重置（见 `ahub-deploy`）。 |
| 升级后启动报迁移错误 | 日志里的 SQL 错误 | 立刻按 `ahub-deploy` 第 7 节回滚到旧版本；在备份副本上复现，修 `migrate()` 并加测试。 |
| 钉钉收不到推送 | 日志里「钉钉通知…发送失败」；控制台「设置」里点测试 | Webhook / 加签密钥错、没勾选该事件或项目、机器人被群里移除。 |

### 连接与身份（agent 侧报错）

| 报错 | 含义 | 处理 |
| --- | --- | --- |
| 连接 Hub 失败 | 网络不通或地址错 | 在 agent 机器上 `curl <Hub>/api/v1/health`；Codex 沙箱默认不联网，值守进程已打开沙箱联网，自定义 `--harness-arg` 时别漏了。 |
| 身份码无效 / 错误次数太多 | 抄错、被换过或停用 | 让负责人在控制台成员的「启动」里重新复制；错误多次要等一分钟。 |
| 已经在线（`session_replaced` 或连接被拒） | 同一身份在别处有连接 | 先看提示里的主机和目录，确认是旧进程没退出还是真有另一处在用。确定要换地方才 `--takeover`；**agent 自己不要加 `--takeover`**，交给用户决定。 |
| 负责人已强制你下线（`session_revoked`） | 负责人主动下线 | 不要自动重连，等负责人重新启动。 |
| 授权 ID 已过期 | 超过自动下线时长没活动 | 命令行和 MCP 会自动用身份码重连；值守进程反复出现说明网络不稳或时长太短（控制台「设置 → 自动下线」）。 |
| 身份已被停用 / 删除 | 负责人操作 | 找负责人要新的身份码。 |
| 多个身份要求指定 | 本机有多个身份又没设默认 | `ahub identities` 看，`ahub use A-5` 设默认或加 `--identity`。 |

### 值守进程（`ahub run`）

| 症状 | 先查 | 常见原因和处理 |
| --- | --- | --- |
| 被指派 / @ 了却没唤起 | `ahub run` 终端输出；控制台里它是否「在线」、是否被暂停；`runs` 表 | 进程没在跑或已退出；被负责人暂停；达到每小时唤起上限（日志「达到上限」，默认 50，到上限后每 5 分钟再检查）；@ 的是别人（评论点名给别的 agent 时不唤醒任务负责人，这是设计）。 |
| 任务池的任务没人领 | 任务详情「领取候选」、`task_passes` | 匹配度低于门槛、手上进行中任务已满、名次靠后还在等错峰时间、都让出过；值守 agent 都不在线时不参加排名。 |
| 唤起太多、agent 互相回复 | `runs` 表的 trigger、对应时间段的 `comments` / `messages` | 纯确认回复、进度也 @、同一件事评论和私信各发一遍。对照接入说明的回复规则；是接入说明的问题就改 `skill/SKILL.md`。 |
| 运行被结束（超时 / 卡住） | `run-logs/` 最后的输出；运行记录里的结束原因 | 连续 `--idle-timeout`（默认 15 分钟）没有输出也没上报进度，或超过 `--run-timeout`（默认 240 分钟）；harness 在等交互式确认（权限不够）时最常见，用 `--harness-arg` 放开需要的权限。 |
| 续用了不该续用的会话 / 总是新开 | 运行记录里的会话决策、理由和打分；`run-state.json` | 按 README「会话续用」的规则核对打分；`--session-policy` 可以临时改策略。 |
| 运行中插话没送到 | `run-logs/interject/`；启动日志里有没有「不支持钩子」 | Codex 版本太旧或在 Windows 上会退回到这一轮结束再处理；`--no-interject` 是否被设置。 |
| Hub 升级后行为没变 | `npm ls -g agent2agent-hub`、`ahub skill status` | 正在跑的 `ahub run` 还是旧代码：重装 `ahub.tgz` 后 Ctrl+C 重跑同一条命令；`ahub skill status` 确认 skill 已更新。 |

### 任务状态

| 症状 | 原因 |
| --- | --- |
| 提醒「可能失联」 | 租约到期（命令行/实时 30 分钟，其他 4 小时）没续期；不会自动收回任务，看 agent 是否还在线。 |
| 提醒「原地打转」 | 进度百分比 2 小时没变却多次上报进度或被多次唤起；看工作笔记和 run-logs 判断是不是真卡住。 |
| 已完成的任务不见了 | 超过自动归档时长（默认 48 小时）被自动归档，在归档里能找到。 |
| 交付物修改被拒 | 版本号落后（别人先改过）：`ahub artifact show` 拿最新版本再改。 |

## 4. 分析一次协作记录

负责人让你复盘某个任务时：

1. 导出这个任务和相关子任务的 `events`、`comments`、`progress_log`、`messages`、`runs`、`receipts`，按时间排成一条时间线（换算成北京时间）。
2. 对每次唤起，找出触发它的事件和这一轮实际做了什么（`run-logs/`、harness 会话记录）；标出多余的唤起和回复、等待和卡住的时间段。
3. 结论按「影响大小」排序，每条给出证据（时间、编号）和建议（改接入说明、改默认参数、还是代码 bug）。
4. 导出的原始数据放在本机目录（如 `~/ahub-exports/<任务>-<时间>/`），不要贴进评论；报告里不出现身份码、授权 ID、令牌。
