# RAG 检索 + LLM 生成：把召回片段拼进 Prompt，调用 OpenAI 兼容接口（DeepSeek）生成回答
# 学习要点：RAG 的本质 = 用向量检索把「外部知识」拉进上下文，再让 LLM 基于它作答、避免凭空编造

import re
import config
import vector_store

SYSTEM_PROMPT = """你是一个严谨的知识库问答助手。
只依据给定的「参考资料」回答；若资料中找不到答案，明确说不知道，不要编造。
回答时用简体中文，尽量引用对应的资料来源标题。"""


def retrieve(question: str, top_k: int | None = None) -> list[dict]:
    """第 1 步：向量检索，召回最相关的若干片段"""
    return vector_store.search(question, top_k)


def build_prompt(question: str, hits: list[dict]) -> list[dict]:
    """第 2 步：把召回片段组织成 messages（组装上下文）"""
    refs = "\n\n".join(
        f"[来源: {h['title']}]\n{h['chunk']}" for h in hits
    )
    user = (
        f"参考资料:\n{refs}\n\n"
        f"问题:{question}\n"
        "请根据上面的参考资料回答问题。"
    )
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]


def _client():
    from openai import OpenAI

    return OpenAI(base_url=config.Config.LLM_BASE_URL, api_key=config.Config.LLM_API_KEY)


def generate(question: str, top_k: int | None = None) -> dict:
    """第 3 步：非流式一次返回（学习用简单路径）"""
    hits = retrieve(question, top_k)
    messages = build_prompt(question, hits)
    resp = _client().chat.completions.create(
        model=config.Config.LLM_MODEL, messages=messages, temperature=0.2
    )
    return {"answer": resp.choices[0].message.content, "sources": hits}


def generate_stream(question: str, top_k: int | None = None):
    """流式版本：每步也把得分/来源先交出去，方便前端展示「检索了什么」
    yield 约定：先发 {"sources": hits}，再逐 token 发 {"delta": text}
    """
    hits = retrieve(question, top_k)
    yield {"sources": hits}

    messages = build_prompt(question, hits)
    stream = _client().chat.completions.create(
        model=config.Config.LLM_MODEL, messages=messages, temperature=0.2, stream=True
    )
    for chunk in stream:
        delta = chunk.choices[0].delta.content if chunk.choices else None
        if delta:
            yield {"delta": delta}