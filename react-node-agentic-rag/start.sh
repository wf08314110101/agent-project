#!/usr/bin/env bash
# 一键启动：qdrant/phoenix + backend(8788) + frontend(5174)，Ctrl-C 一起停
set -e
cd "$(dirname "$0")"

kill_port() {
  local pids
  pids=$(lsof -ti :"$1" 2>/dev/null || true)
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
}

cleanup() {
  echo
  echo "==> 停止服务"
  kill_port 8788
  kill_port 5174
  exit 0
}
trap cleanup INT TERM

# 0. 前置检查：.env 与 key
[ -f backend/.env ] || cp backend/.env.example backend/.env
if grep -q "sk-你的key" backend/.env; then
  echo "⚠️  backend/.env 未填 LLM_API_KEY，聊天生成阶段会报错" >&2
fi

# 1. 基础设施：qdrant 必须有；phoenix 尽力而为（M1 观测走 Langfuse 云端，M2 才接 OTel）
docker compose up -d qdrant
docker compose up -d phoenix 2>/dev/null || echo "⚠️ phoenix 启动失败，可忽略（M1 不依赖）" >&2

# 2. 依赖（node_modules 缺失才装）
[ -d backend/node_modules ] || (cd backend && npm install --no-audit --no-fund)
[ -d frontend/node_modules ] || (cd frontend && npm install --no-audit --no-fund)

# 3. 清理旧进程，避免端口占用
kill_port 8788
kill_port 5174
sleep 1

# 4. 启动前后端，日志落 logs/
mkdir -p logs
echo "==> 启动 backend :8788（日志 logs/backend.log）"
(cd backend && npm run dev) > logs/backend.log 2>&1 &
echo "==> 启动 frontend :5174（日志 logs/frontend.log）"
(cd frontend && npm run dev) > logs/frontend.log 2>&1 &

# 5. 等后端就绪（最多 30s）
for i in $(seq 1 30); do
  curl -sf http://localhost:8788/api/health >/dev/null 2>&1 && break
  sleep 1
done

echo
echo "==> 全部就绪"
echo "    前端   http://localhost:5174"
echo "    后端   http://localhost:8788/api/health"
echo "    Qdrant http://localhost:6333/dashboard"
echo "    Ctrl-C 停止全部"
wait
