# RAG 后端配置：集中管理，全部可从环境变量覆盖（支持 backend/.env）
import os

from dotenv import load_dotenv

# 启动时读取 backend/.env（若存在），再叠加系统环境变量
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))


class Config:
    # ---- 向量库 ----
    PERSIST_DIR = os.getenv("RAG_PERSIST_DIR", "./data/chroma")  # chroma 本地持久化目录
    COLLECTION_NAME = os.getenv("RAG_COLLECTION", "rag_docs")    # 集合名

    # ---- 分块 ----
    CHUNK_SIZE = int(os.getenv("RAG_CHUNK_SIZE", "500"))   # 每块字符数
    CHUNK_OVERLAP = int(os.getenv("RAG_CHUNK_OVERLAP", "80"))  # 相邻块重叠字符，保留上下文

    # ---- 检索 ----
    TOP_K = int(os.getenv("RAG_TOP_K", "4"))  # 召回数量

    # ---- OCR（扫描版 PDF 回退识别）----
    OCR_ENABLED = os.getenv("RAG_OCR_ENABLED", "true").lower() == "true"
    OCR_LANG = os.getenv("RAG_OCR_LANG", "chi_sim+eng")  # tesseract 语言包，需已安装
    # 页面抽到的文字 < 该字符数，视为扫描版/无文字页，触发 OCR
    OCR_MIN_PAGE_LEN = int(os.getenv("RAG_OCR_MIN_PAGE_LEN", "30"))

    # ---- Embedding（bge，免费本地离线）----
    # 两种可切换：中文高速 bge-base-zh-v1.5（768维） vs 多语长文本 bge-m3（1024维）
    EMBEDDING_MODEL = os.getenv("RAG_EMBEDDING_MODEL", "BAAI/bge-base-zh-v1.5")
    EMBEDDING_DEVICE = os.getenv("RAG_EMBEDDING_DEVICE", "cpu")  # cpu / mps / cuda

    # ---- LLM（OpenAI 兼容 → DeepSeek），复用你 vite 项目同款链路 ----
    LLM_BASE_URL = os.getenv("RAG_LLM_BASE_URL", "https://api.deepseek.com/v1")
    LLM_MODEL = os.getenv("RAG_LLM_MODEL", "deepseek-chat")
    LLM_API_KEY = os.getenv("RAG_LLM_API_KEY", "")

    # ---- CORS（dev：前端 vite 5173）----
    CORS_ORIGINS = os.getenv(
        "RAG_CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
    ).split(",")