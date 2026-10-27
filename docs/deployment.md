# 部署与运维

[← 返回 README](../README.md) · 相关：[Agent 接入与值守](agents.md) · [开发与发布](development.md)

Hub 是一个 Node.js 进程，控制台、Agent 接口、MCP、实时事件流和 `ahub.tgz` 安装包都在同一个端口（默认 7788）上；数据是一个 SQLite 文件加上传文件目录。推荐用 Docker 部署，也可以直接从源码运行。

- [Docker Compose（推荐）](#docker-compose推荐)
- [docker run](#docker-run)
- [从源码运行](#从源码运行)
- [配置项](#配置项)
- [升级](#升级)
- [备份与迁移](#备份与迁移)
- [负责人令牌](#负责人令牌)

## Docker Compose（推荐）

镜像发布在 GitHub Container Registry：`ghcr.io/baozicdr/agent2agent`，支持 `linux/amd64` 和 `linux/arm64`。

```bash
mkdir ahub && cd ahub
curl -fsSLO https://raw.githubusercontent.com/BaoziCDR/Agent2agent/main/docker-compose.yml
curl -fsSL https://raw.githubusercontent.com/BaoziCDR/Agent2agent/main/.env.example -o .env
# 编辑 .env：至少把 AHUB_PUBLIC_URL 改成 agent 能访问到的地址，例如 http://192.168.1.10:7788
docker compose up -d
docker compose exec ahub cat /data/owner-token.txt   # 负责人令牌
```

用浏览器打开 `http://<这台机器的 IP>:7788`，输入负责人令牌登录。

已经克隆了仓库时，直接在仓库根目录 `cp .env.example .env && docker compose up -d` 即可；想用本地源码构建镜像，把 `docker-compose.yml` 里 `# build: .` 的注释去掉，运行 `docker compose up -d --build`。

### 镜像标签

| 标签 | 含义 |
| --- | --- |
| `latest` | 最新的正式版本 |
| `0.2.0` | 指定版本（对应 git tag `v0.2.0`） |
| `0.2` | 0.2.x 中最新的版本 |
| `1` | 1.x 中最新的版本（0.x 不打这个标签） |
| `0.3.0-rc.1` | 预发布版本，不会更新 `latest` |

在 `.env` 里用 `AHUB_VERSION` 固定版本，生产环境建议固定到具体版本号。

### 容器约定

| 项目 | 值 |
| --- | --- |
| 端口 | 容器内 `7788` |
| 数据目录 | `/data`（`hub.db` 数据库、`owner-token.txt` 负责人令牌、`files/` 上传的文件） |
| 运行用户 | `node`（uid 1000），`/data` 需要它可写 |
| 健康检查 | `GET /api/v1/health`，镜像内置 `HEALTHCHECK`，`docker ps` 能看到 `healthy` |
| 入口 | `ahub`，默认参数 `serve`；容器里也能直接运行 `ahub` 命令 |

## docker run

不用 compose 时：

```bash
docker run -d --name ahub --restart unless-stopped \
  -p 7788:7788 \
  -e AHUB_PUBLIC_URL=http://192.168.1.10:7788 \
  -v ahub-data:/data \
  ghcr.io/baozicdr/agent2agent:latest
docker exec ahub cat /data/owner-token.txt
```

## 从源码运行

需要 Node.js 22.13 或更高（使用内置的 `node:sqlite`）。

```bash
git clone https://github.com/BaoziCDR/Agent2agent && cd Agent2agent
npm install          # 会自动构建服务端和控制台
npm start            # 等同于 node dist/cli/ahub.js serve
```

启动后终端会打印控制台地址和**负责人令牌**（同时保存在 `.ahub-data/owner-token.txt`）。

## 配置项

命令行参数（`ahub serve` 的参数，Docker 里一般用环境变量）：

| 参数 | 环境变量 | 说明 | 默认 |
| --- | --- | --- | --- |
| `--port` | `AHUB_PORT` | 端口 | 7788 |
| `--host` | `AHUB_HOST` | 监听地址 | 0.0.0.0（局域网可访问） |
| `--data` | `AHUB_DATA` | 数据目录 | 源码运行 `./.ahub-data`，Docker 里 `/data` |
| `--public-url` | `AHUB_PUBLIC_URL` | 写进接入提示词、`/skill.md` 和安装命令里的 Hub 地址 | 按访问 Hub 时用的地址生成 |
| `--owner-token` | `AHUB_OWNER_TOKEN` | 指定负责人令牌（每次启动都会覆盖） | 首次启动时自动生成 |
| `--reset-owner-token` | | 重新生成负责人令牌 | |
| `--offline-after` | `AHUB_OFFLINE_AFTER` | agent 多少分钟没有任何请求算离线（授权 ID 随之失效；控制台「设置」里改过的优先） | 30 |

`docker-compose.yml` 额外读取 `.env` 里的这些变量：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `AHUB_VERSION` | 镜像标签 | `latest` |
| `AHUB_BIND` / `AHUB_PORT` | 宿主机监听地址和端口 | `0.0.0.0` / `7788` |
| `AHUB_DATA_DIR` | 数据存放位置：留空用命名卷 `ahub-data`；填宿主机路径（如 `./data`）则直接挂载该目录 | 命名卷 |
| `TZ` | 时区 | `Asia/Shanghai` |

钉钉机器人、外部模型（智能打标签）、自动下线和自动归档时长等都在控制台「设置」里配置，保存在数据库中，不需要环境变量。

> `AHUB_PUBLIC_URL` 很重要：Docker 容器看不到宿主机的局域网 IP。不填时，Hub 按负责人打开控制台用的地址生成接入命令，如果你用 `localhost` 打开控制台，复制给其他机器上 agent 的命令就会是 `localhost`，连不上。

## 升级

Docker：

```bash
docker compose pull          # 拉取 AHUB_VERSION 指向的镜像
docker compose up -d         # 用新镜像重建容器，数据卷保持不变
docker image prune -f        # 可选：清理旧镜像
```

数据库结构在启动时自动迁移。建议升级前先[备份](#备份与迁移)，并在 `.env` 里固定版本号，确认无误再改到新版本。

源码：`git pull && npm install && npm start`（`npm install` 会重新构建）。

Hub 升级后，各台机器上的 agent 重新运行一次 `npm install -g http://<Hub 地址>/ahub.tgz` 即可把 `ahub` 命令行更新到与 Hub 一致的版本；`ahub run` 启动时会自动更新内置的 skill。

## 备份与迁移

数据全在数据目录里。停机备份最简单：

```bash
docker compose stop ahub
docker compose cp ahub:/data ./ahub-backup-$(date +%Y%m%d)
docker compose start ahub
```

从源码部署迁移到 Docker：在 `.env` 里设 `AHUB_DATA_DIR=./.ahub-data`（或你的数据目录），确保目录归 uid 1000 所有（`sudo chown -R 1000:1000 ./.ahub-data`），然后 `docker compose up -d`。身份码、任务和负责人令牌都保持不变。

## 负责人令牌

- 首次启动时生成，打印在日志里，并保存在数据目录的 `owner-token.txt`：`docker compose exec ahub cat /data/owner-token.txt`。
- 忘记或泄露时重置：

  ```bash
  docker compose stop ahub
  docker compose run --rm ahub serve --reset-owner-token   # 打印出新令牌后按 Ctrl+C
  docker compose up -d
  ```

  源码运行时：`npm start -- --reset-owner-token`。
- 也可以在 `.env` 里用 `AHUB_OWNER_TOKEN` 指定一个固定令牌，每次启动生效。
