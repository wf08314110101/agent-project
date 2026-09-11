# Embedding 封装：对外只暴露 embed() / get_dimension()
# 好处：上层（向量库/检索）不关心用的是 bge 还是云端 API，后续可无缝替换
import torch
from sentence_transformers import SentenceTransformer

import config

# 慵懒加载：首次调用才真正下载并载入模型，避免 import 即阻塞
_model = None


def _get_model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer(
            config.Config.EMBEDDING_MODEL, device=config.Config.EMBEDDING_DEVICE
        )
    return _model


def embed(texts: list[str]) -> list[list[float]]:
    """把一批文本转成向量列表（每行一个向量）"""
    model = _get_model()
    # normalize_embeddings=True：bge 官方建议向量归一化后做内积/余弦更稳定
    vecs = model.encode(
        texts, normalize_embeddings=True, convert_to_numpy=True
    )
    return vecs.tolist()


def embed_query(text: str) -> list[float]:
    """query 单独嵌出。bge 对检索 query 依赖已有模型基线，这里与文档同编码即可"""
    return embed([text])[0]


def get_dimension() -> int:
    """当前模型的向量维度：bge-base-zh-v1.5=768，bge-m3=1024"""
    model = _get_model()
    return model.get_sentence_embedding_dimension()


def device_info() -> str:
    """便于启动时打印当前运行设备"""
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"