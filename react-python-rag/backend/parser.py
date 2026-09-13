# 文档解析：把不同格式文件统一抽成纯文本
# PDF 处理策略：先 pypdf 抽纯文本；某页文字太少（扫描版）则回退 OCR（pdf2image + pytesseract）
import io

import pypdf
import mammoth

import config


def _ocr_page(page_no: int, data: bytes, lang: str) -> str:
    """把 PDF 第 page_no（从1起）页转成图片再做 OCR 文字识别"""
    try:
        from pdf2image import convert_from_bytes  # 依赖 poppler
        from pytesseract import image_to_string    # 依赖系统 tesseract
    except ImportError as e:
        raise RuntimeError(
            "OCR 依赖未安装：`uv pip install pdf2image pytesseract pillow`，"
            "且系统需安装 poppler 与 tesseract（含中文语言包），详见 requirements 注释"
        ) from e
    # 只转目标这一页
    images = convert_from_bytes(data, first_page=page_no, last_page=page_no, dpi=200)
    return image_to_string(images[0], lang=lang)


def _parse_pdf(data: bytes) -> str:
    reader = pypdf.PdfReader(io.BytesIO(data))
    parts = []
    for i, page in enumerate(reader.pages):
        # 1) 先尝试常规文本抽取
        text = page.extract_text() or ""
        stripped = text.strip()
        # 2) 文字太少（疑似扫描/图片页）且开启 OCR → 回退识别这一页
        if config.Config.OCR_ENABLED and len(stripped) < config.Config.OCR_MIN_PAGE_LEN:
            try:
                ocr = _ocr_page(i + 1, data, config.Config.OCR_LANG).strip()
                if ocr:
                    stripped = ocr
            except RuntimeError:
                # OCR 环境缺失时静默降级，不清掉原本可能有的少量文字
                pass
        parts.append(f"--- 第{i+1}页 ---\n{stripped}")
    return "\n\n".join(parts)


def _preprocess_for_ocr(img):
    """翻拍屏幕的照片多为深底浅字+摩尔纹+小字，tesseract 假定浅底深字，先预处理"""
    from PIL import Image, ImageOps
    g = ImageOps.grayscale(img)
    # 深色背景（亮度均值偏低）→ 反转成浅底深字
    pixels = list(g.getdata())
    if pixels and sum(pixels) / len(pixels) < 127:
        g = ImageOps.invert(g)
    # 文字太小的翻拍图放大（LANCZOS），上限 4 倍防爆内存
    if max(g.size) < 2200:
        ratio = min(2200 / max(g.size), 4.0)
        g = g.resize((int(g.width * ratio), int(g.height * ratio)), Image.LANCZOS)
    return ImageOps.autocontrast(g)


def _ocr_image(data: bytes) -> str:
    """直接对一张图片做 OCR 文字识别（原图通常比转 PDF 更清晰）"""
    try:
        from PIL import Image
        from pytesseract import image_to_string
    except ImportError:
        raise RuntimeError("OCR 依赖未安装：请确认 pip 装过 pillow 与 pytesseract，并安装系统 tesseract")
    img = Image.open(io.BytesIO(data))
    return image_to_string(_preprocess_for_ocr(img), lang=config.Config.OCR_LANG).strip()


def _ocr_docx_images(data: bytes) -> str:
    """Word(.docx) 是 zip，图片在 word/media/ 下。逐张转 OCR，识别扫描/截图里的文字"""
    try:
        from zipfile import ZipFile
        from PIL import Image
        from pytesseract import image_to_string
    except ImportError:
        return ""  # OCR 环境缺失时忽略图片

    parts = []
    with ZipFile(io.BytesIO(data)) as z:
        for name in z.namelist():
            if not name.startswith("word/media/"):
                continue
            if not name.lower().endswith((".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tiff")):
                continue
            try:
                img = Image.open(io.BytesIO(z.read(name)))
                txt = image_to_string(_preprocess_for_ocr(img), lang=config.Config.OCR_LANG).strip()
                if txt:
                    parts.append(f"[图片 {name}]\n{txt}")
            except Exception:
                continue  # 个别损坏图不阻断整篇
    return ("\n\n" + "\n\n".join(parts)) if parts else ""


def _parse_docx(data: bytes) -> str:
    # mammoth：把 Word 转成 markdown 文本（段落/表格文字） + 图片 OCR 补全
    result = mammoth.convert_to_markdown(io.BytesIO(data))
    return result.value + _ocr_docx_images(data)


def parse_bytes(filename: str, data: bytes) -> str:
    """根据扩展名分发到对应解析器。filename 决定类型，data 是文件字节"""
    name = filename.lower()

    if name.endswith(".txt"):
        # txt 用 utf-8 优先，常见编码兜底（也可补 gbk）
        for enc in ("utf-8", "gbk", "latin-1"):
            try:
                return data.decode(enc)
            except UnicodeDecodeError:
                continue
        return data.decode("utf-8", errors="replace")

    if name.endswith(".md"):
        return data.decode("utf-8", errors="replace")

    if name.endswith(".docx"):
        return _parse_docx(data)

    if name.endswith((".png", ".jpg", ".jpeg", ".bmp", ".gif", ".tiff", ".webp")):
        # 图片处理：直接 OCR 提取其中的文字
        return _ocr_image(data)

    if name.endswith(".pdf"):
        return _parse_pdf(data)

    raise ValueError(f"暂不支持的文件类型: {name}（仅支持 txt/md/docx/pdf/图片）")