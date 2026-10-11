from __future__ import annotations

import abc
import os
from dataclasses import dataclass
from typing import Any


@dataclass
class ObjectRef:
    key: str
    uri: str
    size: int

    def to_dict(self) -> dict[str, Any]:
        return {"key": self.key, "uri": self.uri, "size": self.size}


class ObjectStore(abc.ABC):
    """对象存储抽象：把生成物（成稿、评测/安全/成本报告）与本地磁盘解耦。

    实现可插拔为本地磁盘（开发/单机）或 S3 兼容（生产）。所有方法返回可序列化
    结构，便于写入 Redis/内存 store 与 API 响应。
    """

    @abc.abstractmethod
    async def put(self, key: str, data: str | bytes, *, content_type: str = "application/json") -> ObjectRef:
        ...

    @abc.abstractmethod
    async def get(self, key: str) -> bytes | None:
        ...

    @abc.abstractmethod
    async def exists(self, key: str) -> bool:
        ...

    @abc.abstractmethod
    async def delete(self, key: str) -> None:
        ...

    @abc.abstractmethod
    def uri(self, key: str) -> str:
        ...


class LocalObjectStore(ObjectStore):
    def __init__(self, base_dir: str | os.PathLike):
        self.base_dir = os.path.abspath(base_dir)

    def _path(self, key: str) -> str:
        clean = key.replace("\\", "/").lstrip("/")
        return os.path.join(self.base_dir, *clean.split("/"))

    async def put(self, key: str, data: str | bytes, *, content_type: str = "application/json") -> ObjectRef:
        path = self._path(key)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        payload = data.encode("utf-8") if isinstance(data, str) else data
        with open(path, "wb") as fh:
            fh.write(payload)
        return ObjectRef(key=key, uri=self.uri(key), size=len(payload))

    async def get(self, key: str) -> bytes | None:
        path = self._path(key)
        if not os.path.exists(path):
            return None
        with open(path, "rb") as fh:
            return fh.read()

    async def exists(self, key: str) -> bool:
        return os.path.exists(self._path(key))

    async def delete(self, key: str) -> None:
        path = self._path(key)
        if os.path.exists(path):
            os.remove(path)

    def uri(self, key: str) -> str:
        return f"local://{key.replace(os.sep, '/').lstrip('/')}"


class S3ObjectStore(ObjectStore):
    def __init__(self, bucket: str, *, prefix: str = "", client=None, endpoint_url: str | None = None):
        try:
            import boto3  # noqa: F401  # 仅在需要 S3 后端时声明依赖
        except ImportError as exc:
            raise RuntimeError("使用 S3 对象存储需安装 boto3") from exc
        self.bucket = bucket
        self.prefix = prefix.strip("/")
        self.client = client or boto3.client("s3", endpoint_url=endpoint_url)

    def _full_key(self, key: str) -> str:
        key = key.replace("\\", "/").lstrip("/")
        return f"{self.prefix}/{key}" if self.prefix else key

    async def put(self, key: str, data: str | bytes, *, content_type: str = "application/json") -> ObjectRef:
        full = self._full_key(key)
        payload = data.encode("utf-8") if isinstance(data, str) else data
        self.client.put_object(Bucket=self.bucket, Key=full, Body=payload, ContentType=content_type)
        return ObjectRef(key=key, uri=self.uri(key), size=len(payload))

    async def get(self, key: str) -> bytes | None:
        try:
            resp = self.client.get_object(Bucket=self.bucket, Key=self._full_key(key))
            return resp["Body"].read()
        except Exception:
            return None

    async def exists(self, key: str) -> bool:
        try:
            self.client.head_object(Bucket=self.bucket, Key=self._full_key(key))
            return True
        except Exception:
            return False

    async def delete(self, key: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=self._full_key(key))

    def uri(self, key: str) -> str:
        return f"s3://{self.bucket}/{self._full_key(key)}"


def build_object_store(
    backend: str,
    *,
    local_dir: str | os.PathLike = "storage/generated",
    bucket: str | None = None,
    prefix: str = "",
    endpoint_url: str | None = None,
    client=None,
) -> ObjectStore | None:
    """按环境变量/配置构建对象存储；backend='none' 时返回 None（主链路不持久化大对象）。"""
    backend = (backend or "local").strip().lower()
    if backend in ("none", ""):
        return None
    if backend in ("s3", "minio", "oss"):
        if not bucket:
            raise ValueError("S3 对象存储需要 OBJECT_STORE_BUCKET")
        return S3ObjectStore(bucket, prefix=prefix, client=client, endpoint_url=endpoint_url)
    return LocalObjectStore(local_dir)
