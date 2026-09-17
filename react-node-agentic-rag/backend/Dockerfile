FROM node:24-slim
WORKDIR /app

# 依赖层缓存：先 lockfile 再源码（better-sqlite3 已移入 devDependencies，生产镜像无需 node-gyp 工具链）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8788
CMD ["node", "src/server.js"]
