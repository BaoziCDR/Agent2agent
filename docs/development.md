# 开发与发布

[← 返回 README](../README.md) · 相关：[部署与运维](deployment.md)

## 本地开发

需要 Node.js 22.13 或更高。

```bash
npm install            # 安装依赖并构建
npm start              # 启动 Hub（端口 7788，数据在 ./.ahub-data）
npm run dev:web        # 控制台开发服务器，热更新，接口代理到 127.0.0.1:7788
npm run build:server   # 只编译服务端和命令行到 dist/
npm run typecheck      # 服务端与控制台类型检查
npm test               # 构建服务端并运行全部测试
```

提交前请确保 `npm run typecheck` 和 `npm test` 通过，CI 会在每个 PR 上跑这两项并验证 Docker 镜像能构建。新增或修改界面、命令行文案时要同时补英文译文，规则见[多语言](i18n.md#新增一种语言)。

## 目录结构

```
src/server/   Hub：数据库、业务逻辑（hub.ts）、HTTP 接口（app.ts）、MCP、Markdown 输出
src/cli/      ahub 命令行与 stdio MCP 桥
src/shared/   共享的模型定义、MCP 工具和多语言公共函数
src/i18n/     命令行和 Hub 的英文译文（en.ts）与语言判断
web/          控制台（React + Vite），语言包在 web/src/i18n/
skill/        给 agent 的接入说明，中文 SKILL.md、英文 SKILL.en.md（打进 ahub 命令行，由 ahub skill install 安装）
examples/     Claude Code、Codex 接入示例
test/         测试（node:test）
docs/         文档
.agents/skills/  本仓库的开发调试、部署更新、问题排查规范（给在这个仓库里干活的 agent 读；.claude/skills 是指向它的软链接）
```

## 发布新版本

发布由 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 完成，**只在推送 `v*` 格式的 tag 时触发**，普通提交和 PR 不会发布。

```bash
npm version 1.1.0 --no-git-tag-version   # 更新 package.json 里的版本号（ahub.tgz 安装包和 MCP 服务用它）
# 同时更新 CHANGELOG.md，并写 docs/releases/v1.1.0.md 作为 Release 正文（写清有没有表结构变化、agent 要不要重装 ahub）
git commit -am "发布 1.1.0"
git tag v1.1.0
git push origin main v1.1.0
```

工作流依次：

1. 运行类型检查和测试；
2. 构建 `linux/amd64`、`linux/arm64` 镜像，推送到 `ghcr.io/baozicdr/agent2agent`，标签见[部署文档](deployment.md#镜像标签)；
3. 创建 GitHub Release：有 `docs/releases/<tag>.md` 就用它作正文，再附上自动生成的变更列表（tag 带 `-` 的如 `v0.3.0-rc.1` 标记为预发布）。

推送只用工作流自带的 `GITHUB_TOKEN`，不需要配置任何密钥。

> 首次发布后，到 GitHub 个人主页的 **Packages → agent2agent → Package settings** 确认 **Change visibility** 为 **Public**（公开仓库发布的镜像通常默认公开；如果显示 Private，手动改一次即可，之后的版本都沿用）。
