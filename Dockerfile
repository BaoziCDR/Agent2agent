# syntax=docker/dockerfile:1

# 构建阶段：在构建机原生架构上编译（产物是纯 JS，可直接用于任何目标架构）
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build && npm prune --omit=dev

# 运行阶段
FROM node:22-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.title="ahub" \
      org.opencontainers.image.description="Agent2agent 协作中枢：多个 agent 在同一个任务板上协作，负责人实时查看进度、发布和管理任务" \
      org.opencontainers.image.source="https://github.com/BaoziCDR/Agent2agent" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$VERSION"

ENV NODE_ENV=production \
    AHUB_HOST=0.0.0.0 \
    AHUB_PORT=7788 \
    AHUB_DATA=/data

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
# skill、examples、README、LICENSE 会被打进 /ahub.tgz 供 agent 安装
COPY package.json README.md README.en.md LICENSE ./
COPY skill ./skill
COPY examples ./examples
RUN ln -s /app/dist/cli/ahub.js /usr/local/bin/ahub && chmod +x /app/dist/cli/ahub.js \
 && mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 7788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AHUB_PORT||7788)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/dist/cli/ahub.js"]
CMD ["serve"]
