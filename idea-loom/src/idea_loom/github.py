"""读 GitHub 上的合并请求，按标题前缀归到子项目。

Read pull requests from GitHub and assign them to subprojects by title prefix.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from typing import Any, Optional

from pydantic import BaseModel

from . import store

_cache: dict[str, tuple[float, list["PullRequest"]]] = {}
TTL = 60.0


class PullRequest(BaseModel):
    number: int
    title: str
    scope: str  # 标题冒号前的那一段，通常是项目名 / the part before the colon, usually the project
    state: str
    created_at: str
    merged_at: Optional[str] = None
    additions: int = 0
    deletions: int = 0
    url: str = ""


def scope_of(title: str) -> str:
    m = re.match(r"^([A-Za-z][\w.-]*)\s*[:：]", title)
    return m.group(1).lower() if m else ""


def parse(rows: list[dict[str, Any]]) -> list[PullRequest]:
    out = []
    for r in rows:
        if not isinstance(r.get("number"), int):
            continue
        title = str(r.get("title", ""))
        out.append(PullRequest(number=r["number"], title=title, scope=scope_of(title), state=str(r.get("state", "")),
                               created_at=str(r.get("createdAt", "")), merged_at=r.get("mergedAt") or None,
                               additions=int(r.get("additions") or 0), deletions=int(r.get("deletions") or 0), url=str(r.get("url", ""))))
    return sorted(out, key=lambda p: p.number)


def pull_requests(force: bool = False) -> list[PullRequest]:
    """全部合并请求，缓存一分钟。gh 用不了时返回空列表。 / All PRs, cached for a minute; empty when gh is unavailable."""
    repo = str(store.repo_root())
    hit = _cache.get(repo)
    if hit and not force and time.time() - hit[0] < TTL:
        return hit[1]
    try:
        proc = subprocess.run(
            ["gh", "pr", "list", "--state", "all", "--limit", "1000", "--json", "number,title,state,createdAt,mergedAt,additions,deletions,url"],
            cwd=repo, capture_output=True, text=True, timeout=30,
        )
        rows = json.loads(proc.stdout) if proc.returncode == 0 else []
    except (OSError, ValueError, subprocess.TimeoutExpired):
        rows = []
    result = parse(rows if isinstance(rows, list) else [])
    if result or not hit:
        _cache[repo] = (time.time(), result)
    return _cache[repo][1]
