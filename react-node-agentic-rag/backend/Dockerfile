FROM node:24-slim
WORKDIR /app

# better-sqlite3 无预编译包时回退 node-gyp，需 python3/make/g++
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# 依赖层缓存：先 lockfile 再源码
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV NODE_ENV=production
EXPOSE 8788
CMD ["node", "src/server.js"]
