"""Search a versioned IP canon without sending the whole library to every agent."""

import jieba
from langchain_text_splitters import RecursiveCharacterTextSplitter
from rank_bm25 import BM25Okapi


def _tokens(text: str) -> list[str]:
    return [token.lower() for token in jieba.lcut(text) if token.strip() and any(char.isalnum() for char in token)]


def search_lore(lore: str, query: str, *, limit: int = 4) -> str:
    chunks = RecursiveCharacterTextSplitter(
        chunk_size=850, chunk_overlap=100,
        separators=["\n\n", "\n", "。", "！", "？", " ", ""],
    ).split_text(lore)
    if not chunks:
        return ""
    corpus = [_tokens(chunk) for chunk in chunks]
    query_tokens = _tokens(query)
    if not query_tokens:
        return "\n".join(chunks[:limit])
    ranking = BM25Okapi(corpus).get_scores(query_tokens)
    ordered = sorted(range(len(chunks)), key=lambda index: (-ranking[index], index))[:limit]
    return "\n".join(f"[设定片段 {index + 1}] {chunks[index]}" for index in ordered)
