"""给 Agent 的令牌。没有令牌也能读和算；令牌换来更高的额度，和"提议"的权限。

令牌只在创建时显示一次，这里只存它的哈希。吊销是把那一条标成作废。

Tokens for agents. Reading and computing need none; a token buys a higher allowance and the
right to propose. A token is shown once, when created; only its hash is stored here.
Revoking marks the entry void.
"""

from __future__ import annotations

import hashlib
import re
import secrets
import time
from pathlib import Path
from typing import Any, Optional

from .. import store

PREFIX = "wsk_"
SCOPES = ("read", "propose")
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$")


def _path() -> Path:
    return store.runs_dir() / "agent_tokens.json"


def _load() -> list[dict[str, Any]]:
    rows = store.read_json(_path(), [])
    return rows if isinstance(rows, list) else []


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def listing() -> list[dict[str, Any]]:
    """不含哈希。 / Without the hashes."""
    return [{k: v for k, v in row.items() if k != "hash"} for row in _load()]


def create(name: str, scopes: list[str]) -> dict[str, Any]:
    name = name.strip()
    if not NAME.match(name):
        raise ValueError("名字用字母、数字、空格、点、横线，40 个字符以内")
    if any(row["name"] == name and not row.get("revoked") for row in _load()):
        raise ValueError("已经有一个同名的令牌")
    wanted = sorted(set(scopes) | {"read"})
    if any(s not in SCOPES for s in wanted):
        raise ValueError(f"权限只能是：{', '.join(SCOPES)}")
    token = PREFIX + secrets.token_urlsafe(32)
    rows = _load()
    rows.append({"id": secrets.token_hex(4), "name": name, "scopes": wanted, "hash": _hash(token), "created_at": time.time(), "revoked": False, "last_used": None})
    store.write_json(_path(), rows)
    return {**{k: v for k, v in rows[-1].items() if k != "hash"}, "token": token}


def revoke(token_id: str) -> bool:
    rows = _load()
    hit = [row for row in rows if row["id"] == token_id and not row.get("revoked")]
    for row in hit:
        row["revoked"] = True
    if hit:
        store.write_json(_path(), rows)
    return bool(hit)


def lookup(token: str) -> Optional[dict[str, Any]]:
    """这个令牌是谁的；不认识或者作废了返回 None。 / Whose token this is, or None when unknown or revoked."""
    if not token.startswith(PREFIX):
        return None
    digest = _hash(token)
    for row in _load():
        if secrets.compare_digest(row["hash"], digest) and not row.get("revoked"):
            return {"id": row["id"], "name": row["name"], "scopes": list(row["scopes"])}
    return None
