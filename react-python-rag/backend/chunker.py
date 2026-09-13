# 切块：固定窗口 + 重叠。把长文本切成小块，兼顾上下文连续性
import config


def chunk_text(text: str, size: int | None = None, overlap: int | None = None) -> list[str]:
    """按字符固定窗口切块，相邻块保留 overlap 字符作为上下文缓冲。

    例：text=ABCDEFGHIJ, size=4, overlap=1 → ["ABCD","DEFG","GHIJ"]
    每一步从 size-overlap=3 处滑进，保证不丢内容又延续上文。
    """
    size = size or config.Config.CHUNK_SIZE
    overlap = overlap or config.Config.CHUNK_OVERLAP
    step = max(1, size - overlap)  # 每块前进多少字符，至少为 1

    # 先压缩大量空白，让切块更均匀、也省 token
    text = " ".join(text.split())

    if len(text) <= size:
        return [text] if text else []

    chunks = []
    for i in range(0, len(text), step):
        chunks.append(text[i : i + size])
        if i + size >= len(text):
            break
    return chunks