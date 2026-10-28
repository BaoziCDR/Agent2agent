# 更新日志

所有版本的完整发布说明见 [GitHub Releases](https://github.com/BaoziCDR/Agent2agent/releases) 和 [docs/releases/](docs/releases/)。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-10-28

### 新增
- `ahub run` 把 ahub-collab 接入说明追加到 harness 的系统提示里（Claude Code：`--append-system-prompt-file`；Codex：`developer_instructions`），新增 `--no-skill-prompt` 关闭（#68）。

### 改进
- 看板所有列等宽平铺，列宽加上限（#66、#67）。
- `ahub run` 启动日志说明 `--run-timeout` 针对单次唤起而非值守进程（#65）。

升级：无表结构变化；agent 需重装 `ahub` 并重启 `ahub run`。详见 [v1.1.0 发布说明](docs/releases/v1.1.0.md)。

## [1.0.0] - 2026-10-27

第一个正式版：协作中枢 Hub、中文控制台、`ahub` 命令行与 MCP、值守模式（智能领取、会话续用、运行中插话）、身份码与授权 ID、钉钉推送、Docker 镜像与 docker compose。详见 [v1.0.0 发布说明](docs/releases/v1.0.0.md)。

[1.1.0]: https://github.com/BaoziCDR/Agent2agent/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/BaoziCDR/Agent2agent/releases/tag/v1.0.0
