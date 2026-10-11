"""只追加的 JSONL 文件。写入加文件锁，读不出来的行跳过并计数。

Append-only JSONL files. Writes take a file lock; unreadable lines are skipped
and counted.
"""

from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
from typing import Any, Iterable


def data_dir() -> Path:
    override = os.environ.get("IDEA_LOOM_DATA")
    return Path(override) if override else Path(__file__).resolve().parents[2] / "data"


def repo_root() -> Path:
    override = os.environ.get("IDEA_LOOM_REPO")
    return Path(override) if override else Path(__file__).resolve().parents[3]


def read_lines(path: Path) -> tuple[list[dict[str, Any]], int]:
    """返回（读得出来的行，读不出来的行数）。 / Returns (readable rows, count of unreadable lines)."""
    if not path.exists():
        return [], 0
    rows: list[dict[str, Any]] = []
    bad = 0
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue
            if isinstance(row, dict):
                rows.append(row)
            else:
                bad += 1
    return rows, bad


def append(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    """把若干行一次写完。同一次调用里的行不会和别的写入交错。

    Write several rows in one go; rows from one call never interleave with another writer.
    """
    text = "".join(json.dumps(r, ensure_ascii=False, sort_keys=True) + "\n" for r in rows)
    if not text:
        return 0
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)
    return text.count("\n")


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
