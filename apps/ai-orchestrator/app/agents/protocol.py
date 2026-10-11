from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class AgentRole(str, Enum):
    SUPERVISOR = "supervisor"
    RESEARCHER = "researcher"
    WRITER = "writer"
    EDITOR = "editor"
    CRITIC = "critic"

    def __str__(self) -> str:
        return self.value


@dataclass
class AgentMessage:
    """跨 agent 的协作消息，序列化为 dict 后存入图状态。"""

    sender: AgentRole
    recipient: str
    kind: str
    content: str
    at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {
            "sender": self.sender.value,
            "recipient": self.recipient,
            "kind": self.kind,
            "content": self.content,
            "at": self.at,
        }


@dataclass
class AgentOutput:
    """角色 agent 一次 `act` 的产物。"""

    updates: dict[str, Any] = field(default_factory=dict)
    message: AgentMessage | None = None
    trace: dict[str, Any] | None = None


def append_unique(items: list[str] | None, value: str) -> list[str]:
    items = list(items or [])
    if value and value not in items:
        items.append(value)
    return items


def append_one(items: list[Any] | None, value: Any) -> list[Any]:
    items = list(items or [])
    items.append(value)
    return items


def clip(value: str, limit: int) -> str:
    return " ".join(str(value).split())[:limit]
