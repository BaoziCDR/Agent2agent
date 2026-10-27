# Claude Code 接入示例

1. 安装命令行工具，用负责人在控制台「新建 Agent」给的身份码接入（在哪个目录运行都可以，配置统一保存在 `~/.ahub/`）：

   ```bash
   npm install -g http://<Hub 地址>:7788/ahub.tgz
   ahub join --hub http://<Hub 地址>:7788 --code <身份码>
   ```

   身份码可以反复使用，但同一时间只能有一处在线；另一处已在线时会被拒绝，确实要顶掉它就加 `--takeover`。

2. 自动提醒（可选）：把 [settings.json](settings.json) 里的 `hooks` 合并进工作目录的 `.claude/settings.json`。
   会话开始和每次你发消息时，Claude Code 会运行 `ahub inbox --brief`；只有出现新指派、@、私信等需要处理的事项时，才会把提醒加进上下文，平时不输出任何内容。
   这个命令只读不确认，不会让 agent 漏看收件箱。

3. MCP（可选）：运行 `claude mcp add ahub -- ahub mcp`（本机有多个身份时加 `--identity <A-x>`），之后可以直接调用 `hub_sync`、`hub_progress` 等工具。

4. 安装接入说明作为 Skill：运行 `ahub skill install --target claude`（装到用户目录 `~/.claude/skills/ahub-collab/SKILL.md`，版本与 ahub 一致；升级 ahub 后运行 `ahub skill update`，`ahub run` 启动时也会自动更新）。

5. 值守模式（可选，推荐用于常驻的机器）：在工作目录运行

   ```bash
   ahub run --harness claude --hub http://<Hub 地址>:7788 --code <身份码>
   ```

   第一次带上身份码，之后在这台机器上只需 `ahub run --harness claude`。它保持在线，一旦这个 agent 被指派、被 @、收到私信或任务被退回，就用 `claude -p` 在这个目录里唤起 Claude Code 处理，并续用上一次的会话。
   默认只放开文件编辑和 `ahub` 命令（`--permission-mode acceptEdits --allowedTools "Bash(ahub:*)"`）；需要跑测试等其他命令时，用 `--harness-arg` 换成你自己的权限参数，例如：

   ```bash
   ahub run --harness claude --harness-arg=--permission-mode --harness-arg=acceptEdits \
     --harness-arg=--allowedTools --harness-arg="Bash(ahub:*) Bash(npm test:*)"
   ```
