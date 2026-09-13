# 向量库封装：基于 chroma 持久化，文档/向量存取与检索
# 学习要点：这里用「自建 embedding + 显式传向量」的方式，不依赖 chroma 内置 embedding 函数，便于看清向量化这步
import chromadb
import uuid

import config
import embedder

_client = None
_collection = None


def _get_collection():
    """惰性初始化持久化 client 和 collection（按 dim 建集合）"""
    global _collection, _client
    if _collection is not None:
        return _collection

    # PersistentClient：数据落在 config.PERSIST_DIR，跨进程保留
    _client = chromadb.PersistentClient(path=config.Config.PERSIST_DIR)
    # 注意：col.add 时我们必须自己给 embedding，因此建集合不指定 embedding_function
    _collection = _client.get_or_create_collection(name=config.Config.COLLECTION_NAME)
    return _collection


def add_document(title: str, text: str) -> dict:
    """整篇文档：切块 → 向量化 → 入库，返回统计信息"""
    import chunker

    chunks = chunker.chunk_text(text)
    if not chunks:
        return {"doc_id": None, "chunks": 0, "title": title}

    ids = [uuid.uuid4().hex for _ in chunks]
    embeddings = embedder.embed(chunks)  # 一次性批量向量化

    _get_collection().add(
        ids=ids,
        embeddings=embeddings,
        documents=chunks,
        metadatas=[{"title": title, "i": i} for i in range(len(chunks))],
    )
    return {"doc_id": ids[0], "chunks": len(chunks), "title": title}


def search(question: str, top_k: int | None = None) -> list[dict]:
    """相似度检索：query 向量化 → 余弦相似度 top-k → 返回片段与来源"""
    top_k = top_k or config.Config.TOP_K
    query_vec = embedder.embed_query(question)

    n_results = min(top_k, _get_collection().count())
    if n_results <= 0:
        return []

    res = _get_collection().query(
        query_embeddings=[query_vec],
        n_results=n_results,
        include=["documents", "metadatas", "distances"],
    )
    out = []
    # res 结构：{ids:[...], documents:[[...]], metadatas:[[...]], distances:[[...]]}
    for i, doc in enumerate(res["documents"][0]):
        meta = res["metadatas"][0][i]
        out.append(
            {
                "chunk": doc,
                "title": meta.get("title", ""),
                "distance": round(res["distances"][0][i], 4),  # chroma 默认距离，越小越相似
            }
        )
    return out


def stats() -> dict:
    """前端展示集合概览"""
    col = _get_collection()
    return {"collection": col.name, "documents": col.count()}


def clear():
    """清空集合（开发用）"""
    global _collection
    _get_collection().delete()
    _collection = None