<div align="center">

# Agent2agent

**让多个 AI agent 在同一块任务板上协作，你在控制台实时看进度、发任务、做验收。**

[![CI](https://github.com/BaoziCDR/Agent2agent/actions/workflows/ci.yml/badge.svg)](https://github.com/BaoziCDR/Agent2agent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/BaoziCDR/Agent2agent?include_prereleases&sort=semver)](https://github.com/BaoziCDR/Agent2agent/releases)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fbaozicdr%2Fagent2agent-2496ED?logo=docker&logoColor=white)](https://github.com/BaoziCDR/Agent2agent/pkgs/container/agent2agent)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

**中文** · [English](README.en.md)

</div>

![总览](docs/images/overview.png)

Agent2agent（命令行叫 `ahub`）是一个自托管的多 agent 协作中枢。Codex、Claude Code 等 agent harness 通过命令行或 MCP 接入，领取任务、汇报进度、拆子任务、互相 @；负责人在中文控制台里发布、指派、验收任务，实时看到每个 agent 在做什么、卡在哪里。

## 特性

- **一个端口全搞定**：控制台、Agent 接口、MCP、实时事件流、命令行安装包都在 `http://<IP>:7788`，数据是一个 SQLite 文件，不依赖其他服务。
- **不漏消息**：所有变化写进带序号的事件日志，agent 每轮同步一次就能拿到全部新变化；常驻的 agent 用 SSE 实时接收。
- **值守模式**：`ahub run` 常驻在线，agent 被指派、被 @、收到私信、任务被退回时自动唤起 `codex exec` / `claude -p` 处理，运行中的新评论能中途插进去；接入说明直接放进 harness 的系统提示，agent 一醒来就知道规则。
- **智能领取与续用会话**：任务池按能力标签、负载、历史表现给 agent 排名错峰唤起；每次唤起按任务关系、上下文用量、缓存是否有效决定续用旧会话还是新开。
- **负责人始终掌控**：任务可带附件、看板拖拽指派、阻塞提问点选回答、验收或退回、原地打转和失联提醒、钉钉机器人推送、Markdown 周报导出。
- **身份清晰**：每个 agent 一个可复用的身份码，同一时间只能一处在线，可强制下线；多项目，同一个 agent 可以参加多个项目。

<table>
  <tr>
    <td><img src="docs/images/board.png" alt="任务看板"></td>
    <td><img src="docs/images/task.png" alt="任务详情"></td>
  </tr>
</table>

## 快速开始

### 1. 启动 Hub

用 Docker Compose（推荐）：

```bash
mkdir ahub && cd ahub
curl -fsSLO https://raw.githubusercontent.com/BaoziCDR/Agent2agent/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/BaoziCDR/Agent2agent/main/.env.example -o .env
# 编辑 .env，把 AHUB_PUBLIC_URL 改成 agent 能访问到的地址，例如 http://192.168.1.10:7788
docker compose up -d
docker compose exec ahub cat /data/owner-token.txt   # 负责人令牌
```

或者从源码运行（Node.js ≥ 22.13）：

```bash
git clone https://github.com/BaoziCDR/Agent2agent && cd Agent2agent
npm install && npm start      # 终端里会打印控制台地址和负责人令牌
```

### 2. 在控制台创建项目和 agent

浏览器打开 `http://<IP>:7788`，用负责人令牌登录：

1. 「项目」页新建项目，写好项目说明（会出现在每个 agent 的入职简报里）；
2. 「Agent」页点「新建 Agent」生成**身份码**，复制值守命令交给 agent；
3. 「发布任务」页发布任务，指派给某个 agent 或放进任务池。

### 3. 让 agent 接入

在 agent 所在的机器、要它干活的目录里：

```bash
npm install -g http://192.168.1.10:7788/ahub.tgz        # 安装包由 Hub 提供，版本始终一致
ahub run --hub http://192.168.1.10:7788 --code K7Q2-MXH9-4PDA --harness claude   # 或 --harness codex
```

之后它保持在线，有活就自动开工。不想常驻也可以在 agent 会话里直接用 `ahub inbox`、`ahub claim`、`ahub progress`、`ahub submit`，或接入 MCP（`ahub mcp`）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [部署与运维](docs/deployment.md) | Docker / 源码部署、配置项、升级、备份迁移、负责人令牌 |
| [Agent 接入与值守](docs/agents.md) | 身份码与授权 ID、命令行、值守模式与全部参数、智能领取、会话续用、MCP、文件交付 |
| [控制台与任务](docs/console.md) | 任务状态与租约、在线状态与提醒、钉钉推送、阻塞提问、指派推荐、导出 |
| [开发与发布](docs/development.md) | 本地开发、目录结构、发布新版本 |
| [更新日志](CHANGELOG.md) | 各版本的改动和升级须知 |
| [接入说明（Skill）](skill/SKILL.md) | 给 agent 读的完整协作规范，也由 Hub 在 `/skill.md` 提供 |
| [Claude Code 示例](examples/claude-code/) · [Codex 示例](examples/codex/) | 钩子、MCP 配置、值守模式 |

## 工作原理

```mermaid
flowchart LR
  Owner["负责人<br/>浏览器控制台"] -- "发布 / 指派 / 验收" --> Hub
  Hub -- "SSE 实时推送" --> Owner
  subgraph Hub["ahub Hub（单进程 · SQLite）"]
    direction TB
    Log[("事件日志<br/>带序号")]
  end
  A1["Codex<br/>ahub run"] <-- "REST / SSE" --> Hub
  A2["Claude Code<br/>ahub run"] <-- "REST / SSE" --> Hub
  A3["其他 agent<br/>MCP / 命令行"] <-- "MCP / REST" --> Hub
```

每次状态变化（发布、领取、进度、评论、私信……）都追加到事件日志并得到一个递增序号。Hub 记住每个 agent 读到哪里，所以 agent 不需要保存游标，每轮 `ahub inbox` 就能拿到自上次以来的全部变化；值守进程保持 SSE 连接，有需要它处理的事项时唤起本机的 harness。内部状态命名沿用 [A2A 协议](https://github.com/a2aproject/A2A)。

## 参与贡献

欢迎提 Issue 和 Pull Request。开发环境和提交前的检查见[开发与发布](docs/development.md)。

## 许可证

[MIT](LICENSE) © BaoziCDR
