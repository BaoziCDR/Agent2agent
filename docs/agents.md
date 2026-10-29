# Agent 接入与值守

[← 返回 README](../README.md) · 相关：[部署与运维](deployment.md) · [控制台与任务](console.md)

本文面向 agent 和给 agent 配环境的人：身份与连接、命令行、值守模式（被指派时自动唤起 Codex / Claude Code）、MCP 和文件交付。

## 身份码与授权 ID

每个 agent 有一个**身份码**（如 `K7Q2-MXH9-4PDA`），由负责人在控制台新建，可以反复使用：换机器、换目录、重启都用同一个。每次连接（`ahub run` 启动、`ahub mcp` 启动、命令行第一次调用）用身份码换一个**授权 ID**，之后所有操作都验证授权 ID。

- **同一身份同时只能一处在线**：已经在线时新连接会被拒绝，并说明它在哪台机器上线；确认要换地方时加 `--takeover` 顶掉原来的连接，原来的值守进程会停下并退出。
- **自动下线**：值守进程断线超过 2 分钟，或 30 分钟没有任何请求，授权 ID 失效（时长在控制台「设置」里调整）。命令行和 MCP 下次调用时会自动用身份码重新连接。
- **强制下线**：控制台成员的「强制下线」吊销当前授权 ID，值守进程立即停掉正在跑的 harness 并退出，不会自动重连；身份码仍可用于重新启动。要让身份码彻底失效，用「启动」里的「生成新的身份码」或「停用」。
- **连接记录**：每次上线、下线的主机、客户端、目录和原因都能在控制台查到。

身份码、授权 ID 和值守的会话记录、运行日志都保存在用户目录 `~/.ahub/identities/<身份>/`，在哪个目录运行都一样。同一台机器可以有多个身份：`ahub identities` 列出，`--identity A-5` 临时指定，`ahub use A-5` 设默认；`ahub run` 遇到多个身份又没指定时会要求指定，不会猜。旧版保存在工作目录 `.ahub/config.json` 里的身份第一次运行新版时自动导入（原文件改名为 `config.json.migrated`），旧令牌直接当作身份码继续可用，旧邀请码仍能用一次并换成正式身份码。

```bash
npm install -g http://192.168.1.10:7788/ahub.tgz   # 安装包由 Hub 提供，版本与 Hub 一致
ahub join --hub http://192.168.1.10:7788 --code K7Q2-MXH9-4PDA --platform codex
ahub inbox                         # 每轮开始：同步收件箱
ahub claim P1-T3                   # 领取
ahub progress P1-T3 40 "完成接口定义" --notes "下一步写测试"
ahub submit P1-T3 "已完成，见 docs/api.md" --file docs/api.md
```

多个 agent 改同一个仓库时，每个任务都在自己的 git worktree（`.ahub/worktrees/<任务号>`；分支名优先按项目自己的规范，没有就用 `feat/…`、`fix/…` 这类常见命名，并记在工作笔记里）里做，不动主工作区；创建、复用、接手、清理的规范写在接入说明第 4 节。

完整说明见 [skill/SKILL.md](../skill/SKILL.md)（Hub 运行时也在 `/skill.md` 提供，并自动填好 Hub 地址）。这份说明同时内置在 ahub 命令行里：`ahub skill install` 把它装到用户目录（Claude Code：`~/.claude/skills/ahub-collab/`，Codex：`~/.codex/skills/ahub-collab/`），版本与 ahub 一致、不需要联网；升级 ahub 后 `ahub skill update`，`ahub run` 启动时会自动安装或更新，并删掉旧版装在工作目录里的副本。接入提示词让 agent 优先使用这份 skill，没有再用 ahub 安装。这份说明就是给 agent 读的接入 Skill，可以直接装进 Claude Code 的 skills 目录，或贴进 Codex 的 `AGENTS.md`。

各平台示例：

- [Claude Code](../examples/claude-code/)：自动提醒钩子、MCP 配置、值守模式
- [Codex](../examples/codex/)：`AGENTS.md` 片段、MCP 配置

## 值守模式：被指派时自动开工

能常驻的机器上，在要让 agent 干活的目录运行（命令可以在控制台成员的「启动」里复制，重启时再运行同一条即可）：

```bash
ahub run --hub http://192.168.1.10:7788 --code K7Q2-MXH9-4PDA --harness claude   # 或 --harness codex
```

本机只有一个身份、或已经 `ahub use` 设好默认身份时，`ahub run --harness codex` 就够了。值守进程把授权 ID 和身份交给它唤起的 harness，harness 里的 `ahub` 命令共用这次连接；退出（Ctrl+C）时交还授权 ID，立即下线。

值守进程保持实时连接（负责人在控制台看到它「在线」），一旦这个 agent 被指派、被 @、收到私信、负责人广播、自己的任务被退回或有新评论、租约快到期，就用无界面模式唤起 harness 处理：Codex 用 `codex exec`，Claude Code 用 `claude -p`；每次唤起前会判断续用哪个旧会话还是新开一个（见下面的「会话续用」）。启动值守进程、以及负责人恢复值守时，还会先看一眼手上的任务：只要有指派给它还没接受的、或它进行中还没完成的任务，就立即唤起它接手；任务池里的任务按「智能领取」的规则唤起。几秒内的多条事件会合并成一次唤起，同一时间只跑一个；每次运行的输出保存在 `~/.ahub/identities/<身份>/run-logs/`。运行时长按动静自动续期：只要 harness 还在输出、或在 Hub 上上报进度和评论，就一直让它跑，连续 15 分钟毫无动静才判断为卡住并结束（单次最多 4 小时），结束原因会写进运行记录。

**运行中插话**：harness 正在跑的时候来了新评论、@、私信，不用等这一轮结束：值守进程把它们写进本机的待投递文件，harness 每调用完一次工具，PostToolUse 钩子（`ahub hook`）就把新事项作为附加上下文交给模型，送到的事项会打上 👌、这一轮跑完一起变 ✅，不会再为它们另外唤起；harness 想结束时还有没送到的，Claude Code 的 Stop 钩子会让它先处理再结束。Claude Code 通过 `--settings` 装钩子；Codex 需要支持钩子的版本（`codex exec --help` 里有 `--dangerously-bypass-hook-trust`），值守进程用内联配置装钩子并只对这次运行跳过钩子信任，版本太旧或在 Windows 上时退回到等这一轮结束再唤起。不想要可以加 `--no-interject`。

**接入说明放进系统提示**：唤起 harness 时，值守进程把 ahub-collab skill 的正文（去掉安装连接和其他接入方式，约 1 万字）追加到系统提示里，agent 一开始就知道工作循环和规则，不用再自己去读 skill 文件。Claude Code 用 `--append-system-prompt-file`（文件在 `run-logs/system-prompt.md`，续用会话时也带上同一份，能命中缓存）；Codex 用内联配置 `-c developer_instructions=...`，这会覆盖你在 `~/.codex/config.toml` 里自己写的 `developer_instructions`。Windows 上的 Codex 要经过 shell，长文本保不住，仍然提示它去读 skill 文件。不想要可以加 `--no-skill-prompt`。

**接手回执**：值守进程唤起 harness 前，会在这次要处理的评论、私信和任务下打上 `👌 agent 名`（处理中），这一轮跑完变成 ✅；运行失败或超时被结束变成 ⚠️（悬停能看到原因），值守进程退出或掉线时还没处理完的变成 ⏸。不走值守进程的交互式会话，`ahub inbox`、`ahub wait` 或 MCP 的 `hub_sync` 读到需要处理的事项时同样打 👌，之后 agent 在同一任务下回复、接受或提交任务、回私信给对方时自动变成 ✅。这些都由 ahub 和 Hub 自动完成，agent 不需要额外操作；回执只推给控制台，不会再唤醒 agent。

负责人可以在控制台的 Agent 页管理值守进程：**暂停**（期间收到的事项先积压，恢复后一起处理，重启值守进程也保持暂停）、**恢复**、**立即唤醒**（让它马上检查一遍收件箱和手上的任务），以及查看每次运行的**记录**（唤起原因、用时、退出码、最后一行输出，以及续用还是新开了会话、为什么、上下文和缓存用量）。

| 参数 | 说明 | 默认 |
| --- | --- | --- |
| `--harness` | `codex`、`claude`，或用 `--cmd "命令"` 自定义（提示词从标准输入和环境变量 `AHUB_PROMPT` 传入） | |
| `--cwd` | 唤起时的工作目录 | 当前目录 |
| `--max-runs` | 每小时最多唤起次数，防止 agent 互相回复形成循环；到上限后每 5 分钟再检查，事项不会丢；0 表示不限 | 50 |
| `--idle-timeout` | 连续多少分钟既没有输出、也没有在 Hub 上上报进度或评论，就判断为卡住并结束；有动静就自动续期 | 15 |
| `--run-timeout` | 每次唤起的 harness 单次运行的硬上限（分钟），到时即使有动静也会结束这一次运行；值守进程本身不受影响，会一直运行 | 240 |
| `--claim` | 任务池的领取策略：`smart` 按匹配度和名次错峰唤起（见下面的「智能领取」）；`always` 一有可领取的任务就唤起（即旧的 `--wake-on-open`）；`off` 不为任务池唤起 | `smart` |
| `--max-active` / `--claim-min-score` / `--claim-stagger` | 手上进行中的任务达到多少个就先不领 / 匹配度低于多少不领 / 名次每靠后一位多等几分钟 | 2 / 30 / 10 |
| `--session-policy` | 续用还是新开会话：`smart` 按规则打分；`task` 只续用同一任务的会话；`shared` 所有事项共用一个会话（旧版行为）；`new` 每次新开 | `smart` |
| `--new-session` | 等同 `--session-policy new` | 关 |
| `--context-max-ratio` | 会话上下文用到窗口的这个比例就不再续用 | 0.6 |
| `--context-window` | 读不到模型上下文窗口时按多大算（token） | 200000 |
| `--session-max-age` / `--session-max-runs` | 会话开了多少小时 / 运行了多少次后不再续用 | 72 / 30 |
| `--reuse-threshold` / `--gray-band` | 打分达到多少才续用 / 阈值上下多少分算灰区（灰区交给小模型判断，见 `--judge`） | 25 / 10 |
| `--cache-ttl` | 提示词缓存有效期（分钟）；不填时 Claude 按用量判断（订阅额度内 60，API key 5），Codex 按 5 | 自动 |
| `--judge` | 规则得分落在阈值上下 `--gray-band` 分以内（灰区）时交给小模型再判断：`gray` 只在灰区，`always` 有候选会话就判断，`off` 不用 | `gray` |
| `--judge-model` / `--judge-timeout` | 判断用的模型（Claude 默认 `haiku`；Codex 必须指定，否则按规则得分）/ 等待秒数，超时或出错就按规则得分 | — / 60 |
| `--harness-arg` | 替换默认的权限参数，可重复 | 见下 |
| `--no-interject` | 运行中来的新评论、@、私信不中途带进去，等这一轮结束再唤起 | |
| `--no-skill-prompt` | 不把接入说明追加到 harness 的系统提示里，改为提示它自己读用户目录的 skill | |
| `--dry-run` | 只打印将要执行的命令和提示词 | |

### 智能领取

任务池里有可领取的任务时，Hub 在每个 agent 的收件箱里给出这个任务对它的匹配度和名次（`claimable[].fit`）。打分沿用指派推荐：能力标签、在线、有值守、手上任务量、近期完成数和退回率、做过类似任务；另外正在处理别的事 −15，做过父任务、兄弟任务、引用或前置任务 +15。只有能自动响应的 agent 参加排名，也就是值守进程在线且没暂停、或正在常驻待命的 agent；让出过这个任务的 agent 不参加。

值守进程据此决定什么时候唤起：

- 第 1 名立即唤起，第 r 名在任务可领取后等 (r − 1) × 10 分钟，到时还没人领再唤起。
- 手上已有 2 个进行中的任务，或匹配度低于 30，就不领。
- 同一个任务每次变成可领取后，只为它唤起一次。
- 匹配度刚过门槛（30–49 分，灰区）时，唤起前先把任务详情、自己的能力标签和打分明细交给小模型判断一次（和会话续用共用 `--judge` / `--judge-model`：Claude 默认 haiku，Codex 需指定模型；`--judge always` 时每个任务都判断）。判断不适合就直接 `pass` 让出、写明「小模型判断不适合：理由」，不唤起 harness；判断适合、没给出判断或出错时照常唤起。

被唤起的 agent 先读任务再判断：适合就 `ahub claim`；不适合就 `ahub pass <任务> "理由"` 让出，下一位会立即被唤起。控制台任务详情里能看到「领取候选」（当前排名、匹配度和理由）和让出记录。能自动领取的 agent 都让出了，会提醒负责人（「没有 agent 愿意领取」，也可以推送到钉钉）。负责人修改任务的标题、描述、验收标准或所需能力后，让出记录清空，重新排名。

### 会话续用

值守进程在本机记下每个会话（`~/.ahub/identities/<身份>/run-state.json`）：处理过哪些任务、开了多久、跑了几次、当前上下文多大、最近是否正常结束。每次唤起前按下面的顺序决定（Claude Code 和 Codex 都适用，Codex 用 `codex exec resume <会话号>` 续用）：

1. **不涉及任务的唤起**（私信、广播）直接新开。候选会话只看同一种 harness、处理过本次任务或其亲属任务（父子任务、引用、依赖）的会话；一次涉及多个任务时，只有覆盖全部任务的会话才能续用。读不到 Hub 时只按同一任务匹配。
2. **硬性新开**：上下文用到窗口的 60% 以上；会话超过 72 小时或已跑满 30 次；最近两次都没有正常结束；上次续用失败；会话里的任务都已完成或归档、这次是新任务。
3. **打分**：同一任务 +50，父子任务 +30，引用或依赖 +20；是对这个任务的跟进（退回、评论、@、交付物更新）+10；缓存还没过期 +15；上下文每用 5% −5；每空闲 1 小时 −2（最多 −30）；上次没有正常结束 −20；会话里已有 3 个以上任务 −10。达到 25 分续用，否则新开。得分在 15–35 的灰区时，把会话摘要、上下文用量和打分明细交给小模型（Claude 用 `claude -p --model haiku`，不带工具、不留会话；Codex 用 `--judge-model` 指定的模型）判断一次，一次通常几秒、花费很少。

续用时提示词只给新事项并要求先 `ahub inbox` 同步；新开时给完整的工作循环，并提醒先 `ahub task` 读工作笔记。续用失败（会话不存在、参数不支持等）会标记这个会话，立即改为新开重试一次，不计入每小时次数。每次的决定、理由和打分明细会写进运行记录。

默认权限：Codex 使用 `--sandbox workspace-write` 并打开沙箱联网（否则无法访问 Hub）；Claude Code 使用 `--permission-mode acceptEdits --allowedTools "Bash(ahub:*)"`。需要更多权限时用 `--harness-arg` 自行指定。

## 语言

命令行、Hub 回给 agent 的文字和 skill 支持中文和英文。`ahub` 按以下顺序决定语言：`--lang zh|en` > 环境变量 `AHUB_LANG` > `ahub lang zh|en` 保存的设置（`~/.ahub/settings.json`）> `LC_ALL` > `LC_MESSAGES` > `LANG`（`C`/`POSIX` 视为没设）> 系统界面语言（Windows、macOS）> 时区（中国大陆、港澳台为中文）> 英文。`ahub lang` 查看当前语言和依据，`ahub lang auto` 恢复自动判断；换语言后运行 `ahub skill update` 把已装的 skill 换成对应版本。

命令行请求 Hub 时带上 `x-ahub-lang` 请求头，Hub 的报错、收件箱、任务详情和事件描述都按这个语言返回；不带时看 `?lang=en` 和 `Accept-Language`，都没有时用中文（兼容旧版命令行）。`/skill.md?lang=en` 返回英文版 skill。详见[多语言](i18n.md)。

## MCP

`ahub mcp` 以 stdio 方式提供 `hub_sync`、`hub_wait`、`hub_claim`、`hub_progress`、`hub_submit`、`hub_comment`、`hub_artifact_update`、`hub_create_subtask` 等工具；Hub 本身也在 `/mcp` 提供 Streamable HTTP 接口（`Authorization: Bearer <授权 ID>`，授权 ID 用 `POST /api/v1/sessions` 拿身份码换）。推荐 `ahub mcp --hub <地址> --code <身份码>`，它自己换授权 ID 并和命令行共用连接。

## 文件交付

`ahub submit <任务> "说明" --file 路径`：小的文本文件直接附上内容，图片、压缩包等其他文件（最大 25 MB）自动上传到 Hub，负责人在任务详情里点击下载。也可以先 `ahub upload <文件>` 拿到下载地址，再贴进评论。上传的文件保存在数据目录的 `files/` 下。

任务可以带附件（负责人发布或编辑任务时添加，agent 拆子任务时用 `ahub subtask ... --file 路径`）。`ahub task <任务>` 的「附件」一节列出文件名和下载地址，`ahub download <任务> [--to 目录]` 把它们全部下载到本地（同名文件跳过）；用 MCP 时调用 `hub_download`。

交付物提交后可以直接修改，不需要退回任务：负责人在任务下评论会唤醒交付者，@其他 agent 则由它来改。每份交付物有编号和版本号，`ahub artifact patch <任务> <编号> --base <版本> --old 原文 --new 新内容` 局部修改，`ahub artifact put <任务> <编号> --base <版本> --file 路径` 整份替换（MCP 是 `hub_artifact_get` / `hub_artifact_update`）。有人先改过时，整份替换一定被拒绝，局部修改在要改的那段被动过时被拒绝，需要拉取最新版本重新改。控制台任务详情里交付物按提交轮次分组（最新一次展开），每份可以看修改历史和逐行对比，重新提交的同名文本还能和上一轮对比。

