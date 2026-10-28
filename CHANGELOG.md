# 更新日志

所有版本的完整发布说明见 [GitHub Releases](https://github.com/BaoziCDR/Agent2agent/releases) 和 [docs/releases/](docs/releases/)。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增
- 多语言：控制台支持中文和英文（按浏览器语言，设置里切换，后续语言只需加一份前端译文）；`ahub` 命令行、Hub 回给 agent 的文字和 skill 支持中英文，按 `--lang` / `AHUB_LANG` / `ahub lang` / `LC_ALL` / `LANG` / 系统语言 / 时区判断。

升级：`events` 表新增 `summary_en` 列（自动迁移，旧事件英文界面显示原中文）；agent 需重装 `ahub` 并运行 `ahub skill update`。系统语言是英文的机器升级后命令行会变成英文，用 `ahub lang zh` 固定中文。

## [1.2.0] - 2026-10-28

### 新增
- 任务附件：发布、编辑、拆子任务时可以带附件（每个最大 25 MB，最多 10 个）；agent 用 `ahub download <任务>` 或 MCP `hub_download` 下载（#70）。

升级：`tasks` 表新增 `attachments` 列（自动迁移）；agent 需重装 `ahub` 并重启 `ahub run`。详见 [v1.2.0 发布说明](docs/releases/v1.2.0.md)。

## [1.1.0] - 2026-10-28

### 新增
- `ahub run` 把 ahub-collab 接入说明追加到 harness 的系统提示里（Claude Code：`--append-system-prompt-file`；Codex：`developer_instructions`），新增 `--no-skill-prompt` 关闭（#68）。

### 改进
- 看板所有列等宽平铺，列宽加上限（#66、#67）。
- `ahub run` 启动日志说明 `--run-timeout` 针对单次唤起而非值守进程（#65）。

升级：无表结构变化；agent 需重装 `ahub` 并重启 `ahub run`。详见 [v1.1.0 发布说明](docs/releases/v1.1.0.md)。

## [1.0.0] - 2026-10-27

第一个正式版：协作中枢 Hub、中文控制台、`ahub` 命令行与 MCP、值守模式（智能领取、会话续用、运行中插话）、身份码与授权 ID、钉钉推送、Docker 镜像与 docker compose。详见 [v1.0.0 发布说明](docs/releases/v1.0.0.md)。

[1.2.0]: https://github.com/BaoziCDR/Agent2agent/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/BaoziCDR/Agent2agent/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/BaoziCDR/Agent2agent/releases/tag/v1.0.0
