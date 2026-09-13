# FastAPI 入口：路由 + CORS + 启动时打印运行环境
# 所有路由统一前缀 /api，前端 vite 用 /api 代理到本服务，规避跨域
import json

from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import config
import embedder
import parser
import rag
import vector_store

app = FastAPI(title="react-rag")

# 允许前端 dev origin（vite 代理时其实不会触发 CORS，这里兜底）
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.Config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- 请求/响应模型 ----------
class IngestIn(BaseModel):
    text: str
    title: str = "手动输入"


class QueryIn(BaseModel):
    question: str
    top_k: int | None = None


# ---------- 录入 ----------
@app.post("/api/ingest")
def ingest(body: IngestIn):
    """手动输入文本 → 入库"""
    if not body.text.strip():
        raise ValueError("文本不能为空")
    return vector_store.add_document(body.title, body.text)


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    """上传 txt/md/docx/pdf 文件 → 解析 → 入库"""
    data = await file.read()
    text = parser.parse_bytes(file.filename, data)
    print(f"[RAG] upload text={text}")
    return vector_store.add_document(file.filename, text)


@app.get("/api/stats")
def stats():
    return vector_store.stats()


@app.post("/api/clear")
def clear():
    vector_store.clear()
    return {"ok": True}


# ---------- 检索（学习：只看召回） ----------
@app.post("/api/query")
def query(body: QueryIn):
    return rag.retrieve(body.question, body.top_k)


# ---------- 生成（检索 + LLM，SSE 流式） ----------
@app.post("/api/ask")
def ask(body: QueryIn):
    def gen():
        for item in rag.generate_stream(body.question, body.top_k):
            yield "data: " + json.dumps(item, ensure_ascii=False) + "\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


# ---------- 启动钩子：打印关键信息便于学习 ----------
@app.on_event("startup")
def startup():
    embedder._get_model()  # 预热：提前加载 embedding 模型
    print(f"[RAG] embed模型={config.Config.EMBEDDING_MODEL} dim={embedder.get_dimension()}")
    print(f"[RAG] 设备={embedder.device_info()} chroma={config.Config.PERSIST_DIR}")
    print(f"[RAG] 已有chunks={vector_store.stats()['documents']}")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)