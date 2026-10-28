---
name: ahub-deploy
description: 发布和上线 ahub 协作中枢的规范：打 tag 发布 Docker 镜像、用 docker compose 或源码部署 Hub、上线前备份并在副本上试跑迁移、重启后核对、各 agent 机器更新 ahub 和 skill、回滚。要发版、更新或重启 Hub、升级 agent 机器上的 ahub 时使用。
---

# ahub 部署 / 更新规范

Hub 是单进程：一个端口（默认 7788）提供控制台、Agent 接口、MCP、`/skill.md` 和 `/ahub.tgz` 安装包；数据全在一个数据目录里：

| 文件 | 内容 |
| --- | --- |
| `hub.db`（及 `-wal`、`-shm`） | SQLite 数据库，所有任务、事件、成员 |
| `owner-token.txt` | 负责人令牌（登录控制台用） |
| `files/` | agent 上传的文件 |

源码部署时数据目录默认是运行目录下的 `.ahub-data/`（`--data` / `AHUB_DATA`），Docker 里是卷挂载的 `/data`。

面向人的完整说明在 [docs/deployment.md](../../../docs/deployment.md)（部署运维）和 [docs/development.md](../../../docs/development.md)（开发与发布）；本 skill 是给 agent 的执行规范，两边有出入时以仓库里的 `Dockerfile`、`docker-compose.yml`、`.github/workflows/release.yml` 为准，并顺手修正不一致的一方。

## 0. 几条硬规矩

1. **重启会中断所有在线 agent（约一分钟）。重启前先告诉负责人要上线什么、有没有表结构变化，等负责人明确同意再停旧进程。** 只重建控制台（纯前端改动）不用重启，也不用等同意。
2. **每次重启前备份**，有表结构变化的还要**在备份副本上试跑迁移**，核对通过才上线。
3. 多个已合并的改动攒在一起，一次重启上线。
4. 不在正在用的数据目录上做任何实验；不把负责人令牌、身份码贴进聊天、评论或提交。

## 1. 发版：打 tag 发布 Docker 镜像

镜像由 GitHub Actions（`.github/workflows/release.yml`）构建，**只在推送 `v*` tag 时触发**：先跑 typecheck 和测试，再构建 `linux/amd64` + `linux/arm64` 镜像推到 `ghcr.io/baozicdr/agent2agent`，并创建 GitHub Release。

| tag | 镜像标签 |
| --- | --- |
| `v1.2.3` | `1.2.3`、`1.2`、`1`、`latest` |
| `v1.2.3-rc.1`（预发布） | 只有 `1.2.3-rc.1`，不动 `latest` |

发版步骤：

```bash
git checkout main && git pull
npm ci && npm run typecheck && npm test          # 本地先过一遍
npm version 1.2.3 --no-git-tag-version            # 改 package.json 和 package-lock.json 的版本
git commit -am "发布 v1.2.3"
git tag v1.2.3 && git push origin main v1.2.3     # 推送 tag 触发发布
```

- 版本号按语义化：改表结构或改了 agent 必须跟着变的行为（接入说明、命令参数）至少升次版本号；只修 bug 升修订号。
- 在 Actions 页看发布结果；失败了修好后删掉 tag 重打（`git tag -d v1.2.3 && git push origin :refs/tags/v1.2.3`），**不要复用已经成功推送过镜像的版本号**。
- Release 说明写清：有没有表结构变化、要不要重启、agent 要不要重装 ahub / 更新 skill。写在 `docs/releases/v1.2.3.md`（工作流自动用它作 Release 正文），并在根目录 `CHANGELOG.md` 加一节。
- 版本号、CHANGELOG 和发布说明先走 PR 合并，再在 main 上打 tag。云端会话推不了 tag（会被拒绝，HTTP 403），要让负责人在本机运行 `git fetch origin && git tag -a v1.2.3 origin/main -m "…" && git push origin v1.2.3`。

## 2. 备份与试跑迁移（两种部署方式通用）

仓库自带两个脚本（只依赖 Node 22.13+，Hub 运行中也能用）：

```bash
# 一致性快照（VACUUM INTO）+ 令牌 + 上传文件 + 各表行数 counts.json
node .agents/skills/ahub-deploy/scripts/backup.mjs <数据目录> ~/ahub-backups pre-v1.2.3

# 用新构建的代码在副本上跑一遍迁移，对比行数（新代码目录里先 npm run build:server）
node .agents/skills/ahub-deploy/scripts/trial-migrate.mjs ~/ahub-backups/ahub-data-<时间>-pre-v1.2.3 <新代码目录>
```

`trial-migrate.mjs` 不通过时先停下查原因。个别迁移会按设计改写数据（例如旧的「已取消」迁成手动归档），要对照 PR 说明确认是预期的，再告诉负责人。

## 3. Docker Compose 部署（推荐）

仓库根目录有 `docker-compose.yml` 和 `.env.example`：服务名 `ahub`，命名卷 `ahub-data` 挂到 `/data`，端口 `${AHUB_PORT:-7788}:7788`，容器以非 root 运行，内置 `GET /api/v1/health` 健康检查。

首次部署：

```bash
cp .env.example .env      # 至少填 AHUB_PUBLIC_URL=http://<局域网 IP>:7788（写进接入提示词和安装命令）
docker compose up -d
docker compose exec ahub cat /data/owner-token.txt    # 负责人令牌
```

`.env` 里常用：

| 变量 | 说明 |
| --- | --- |
| `AHUB_VERSION` | 镜像标签，默认 `latest`；生产建议写死版本号，方便回滚 |
| `AHUB_PUBLIC_URL` | agent 访问的地址，写进接入提示词和 `ahub.tgz` 安装命令 |
| `AHUB_PORT` / `AHUB_BIND` | 宿主机端口（默认 7788）/ 监听地址（默认 0.0.0.0） |
| `AHUB_DATA_DIR` | 留空用命名卷 `ahub-data`；填宿主机路径（如 `./data`）则直接挂载，目录要让 uid 1000 可写 |
| `AHUB_OWNER_TOKEN` | 可选，固定负责人令牌，每次启动都会覆盖库里的令牌 |
| `AHUB_OFFLINE_AFTER`、`TZ` | 自动下线分钟数、时区 |

`.env` 和 `/data/` 已在 `.gitignore` 里，不要提交。从源码部署迁到 Docker：`AHUB_DATA_DIR=./.ahub-data`，再 `sudo chown -R 1000:1000 .ahub-data`。

更新：

```bash
# 1) 改 .env 的 AHUB_VERSION 为新版本，先拉镜像（不影响运行中的 Hub）
docker compose pull
# 2) 备份：容器里自带 node，脚本用标准输入传进去（AHUB_DATA_DIR 是宿主机目录时，也可以直接在宿主机上对它跑 backup.mjs）
docker compose exec -T ahub node --input-type=module - /data /data/backups pre-v1.2.3 < .agents/skills/ahub-deploy/scripts/backup.mjs
docker compose cp ahub:/data/backups ~/ahub-backups/       # 拷到宿主机，之后可以删掉容器里的 /data/backups
# 3) 有表结构变化时，用新镜像在备份副本上试跑迁移
docker run --rm -v ~/ahub-backups/backups/<备份目录>:/backup:ro --entrypoint node ghcr.io/baozicdr/agent2agent:<新版本> \
  -e "import('/app/dist/server/db.js').then(m=>{require('fs').copyFileSync('/backup/hub.db','/tmp/hub.db');m.openDb('/tmp/hub.db').close();console.log('迁移通过')})"
# 4) 负责人同意后重启到新版本
docker compose up -d
```

> 最简单的整份备份（会停一下 Hub）：`docker compose stop ahub && docker compose cp ahub:/data ~/ahub-backups/ahub-data-$(date +%Y%m%d-%H%M) && docker compose start ahub`。
> 第 3 步只验证迁移能跑通；要逐表对比行数，就在宿主机上 checkout 同一个 tag、`npm ci && npm run build:server` 后用 `trial-migrate.mjs`。
> 容器内路径、`.env` 变量以仓库里的 `Dockerfile` 和 `docker-compose.yml` 为准，不一致时以它们为准并更新本节。

查负责人令牌：`docker compose exec ahub cat /data/owner-token.txt`。重置：`docker compose stop ahub && docker compose run --rm ahub serve --reset-owner-token`，看到新令牌后 Ctrl+C，再 `docker compose up -d`（源码部署用 `npm start -- --reset-owner-token`）。设了 `AHUB_OWNER_TOKEN` 时以它为准，重置前先改掉或清空它。

想用本地代码构建镜像：把 compose 里的 `image:` 换成 `build: .`（文件里有注释），`docker compose up -d --build`。

## 4. 源码部署（`npm start`）

适合直接在开发机上跑。**先确认实际在跑的进程和目录**，不要凭记忆：

```bash
ps -eo pid,lstart,args | grep -E "ahub(\.js)? serve|npm start" | grep -v grep
readlink /proc/<PID>/cwd        # 运行目录；数据目录默认是其中的 .ahub-data
```

更新步骤：

1. 备份：`node .agents/skills/ahub-deploy/scripts/backup.mjs <运行目录>/.ahub-data ~/ahub-backups pre-<改动>`。
2. 在运行目录拉最新代码：`git fetch origin && git checkout main && git pull --ff-only`，`npm ci`（会顺带构建），`npm test`。
3. 有表结构变化：`trial-migrate.mjs` 在备份上试跑。
4. 告诉负责人：要上线的 PR、当前提交号、有无表结构变化、测试结果；等同意。
5. 重启前再补一次备份，然后停旧进程（`kill <PID>`，Hub 收到 SIGTERM 会正常关闭数据库），用原来的参数在后台重新启动，日志写到文件：

   ```bash
   nohup npm start -- --data .ahub-data >> ~/ahub-backups/hub.log 2>&1 &
   ```

   本机没有权限 kill 时，把命令给负责人让他自己运行。
6. 只是纯前端改动：拉代码后 `npm run build:web` 即可，刷新控制台生效，不用重启。

## 5. 重启后的核对

```bash
curl -s http://127.0.0.1:7788/api/v1/health                 # {"ok":true,"name":"ahub","last_seq":...}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7788/   # 控制台 200
curl -s -H "Authorization: Bearer $(cat <数据目录>/owner-token.txt)" http://127.0.0.1:7788/api/v1/admin/projects | head -c 200   # 负责人令牌可用
```

- 再跑一次 `backup.mjs`（标签 `post-<改动>`），对比前后两份 `counts.json`，行数应一致（新表除外，迁移按设计改写的除外）。
- 看日志里有没有报错；控制台「Agent」页里值守中的 agent 应在几分钟内重新上线。
- 向负责人汇报：上线了什么、现在的提交号或镜像版本、核对结果、agent 侧需要做什么。

## 6. agent 机器的更新

安装包由 Hub 自己提供，版本始终和 Hub 一致。改了命令行、值守进程或接入说明的版本，每台 agent 机器都要：

```bash
npm install -g http://<Hub 地址>/ahub.tgz
ahub skill update            # 或 ahub skill install；ahub run 启动时也会自动更新
ahub skill status            # 确认 Claude Code / Codex 的 skill 都是最新
```

正在跑的 `ahub run` 在 Hub 重启后会自动重连，但用的还是旧代码：在它的终端里 Ctrl+C，再运行同一条启动命令（控制台成员的「启动」里能复制），不需要新的身份码。只改了 Hub 服务端、没动命令行和接入说明的版本，agent 机器不用动。

## 7. 回滚

- Docker：`.env` 里把 `AHUB_VERSION` 改回旧版本，`docker compose up -d`。
- 源码：`git checkout <旧提交> && npm ci`，重启。
- 迁移只会加列加表，旧版本一般能直接读新库。如果新版本改写过数据、旧版本读不了，停掉 Hub，把备份目录里的 `hub.db`、`files/`、`owner-token.txt` 拷回数据目录（先把当前的挪到旁边，并删掉残留的 `hub.db-wal`、`hub.db-shm`），再启动旧版本。**备份之后产生的新数据会丢**，恢复前告诉负责人。

问题排查见 `ahub-troubleshoot`。
