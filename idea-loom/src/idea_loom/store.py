"""只追加的事件日志。两种存法，接口一样：

    文件     本地的默认。每条日志一个 JSONL 文件，写入加文件锁，读不出来的行跳过并计数。
             idea-loom/data/ 里的几个文件就在 git 里，别的会话也可以直接往里追加。
    数据库   设了 IDEA_LOOM_DB 时用。几条共享的日志（idea、愿望、任务、操作轨迹、候选、
             模型用量）进同一个 SQLite 文件的一张事件表；云端有多个写入方，以它为准，
             git 里的文件变成导出的记录。

每条事件有一个由内容算出来的编号（内容 + 它是第几条一模一样的），所以"文件导进数据库"
可以反复做而不重复：别的会话往 git 里的文件追加的行，下一次导入时只进新的那几行。

Append-only event logs, stored one of two ways behind the same interface. Files are the
local default: one JSONL file per log, written under a file lock, unreadable lines skipped
and counted; the ones under idea-loom/data/ live in git and other sessions may append to
them directly. The database is used when IDEA_LOOM_DB is set: the shared logs (ideas,
wishes, tasks, the action trail, candidates, model usage) go into one event table in a
SQLite file; with several writers in the cloud it is the source of truth and the files in
git become an exported record. Every event has an id computed from its content (the
content plus which identical copy it is), so importing a file into the database can be
repeated without duplicating anything: rows another session appended to the file in git
come in as just those new rows.
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import sqlite3
from pathlib import Path
from typing import Any, Iterable, Iterator, Optional

# 进数据库的日志。别的（每个作业、每轮对话自己的事件）仍是运行目录里的文件。
# The logs that go into the database. Others (each job's and each conversation turn's own events) stay files in the runs directory.
DATA_STREAMS = ("ideas", "wishes", "tasks")
RUNS_STREAMS = ("trail", "proposals", "llm")


def data_dir() -> Path:
    override = os.environ.get("IDEA_LOOM_DATA")
    return Path(override) if override else Path(__file__).resolve().parents[2] / "data"


def runs_dir() -> Path:
    override = os.environ.get("IDEA_LOOM_RUNS")
    return Path(override) if override else Path(__file__).resolve().parents[2] / "runs"


def repo_root() -> Path:
    override = os.environ.get("IDEA_LOOM_REPO")
    return Path(override) if override else Path(__file__).resolve().parents[3]


# ---------- 数据库 / the database ----------


def db_path() -> Optional[Path]:
    value = os.environ.get("IDEA_LOOM_DB", "")
    return Path(value) if value else None


def stream_of(path: Path) -> Optional[str]:
    """这个路径是不是一条进数据库的日志；是的话返回它在库里的名字。

    Whether this path is one of the logs kept in the database, and if so its name there.
    """
    if db_path() is None or path.suffix != ".jsonl":
        return None
    if path.parent == data_dir() and path.stem in DATA_STREAMS:
        return path.stem
    if path.parent == runs_dir() and path.stem in RUNS_STREAMS:
        return path.stem
    return None


def connect() -> sqlite3.Connection:
    path = db_path()
    if path is None:
        raise RuntimeError("没有设置 IDEA_LOOM_DB")
    path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(path, timeout=30, isolation_level=None)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    con.execute("PRAGMA busy_timeout=30000")
    con.execute(
        "CREATE TABLE IF NOT EXISTS events ("
        " seq INTEGER PRIMARY KEY AUTOINCREMENT,"   # 全局的先后 / the global order
        " stream TEXT NOT NULL,"                    # 哪条日志 / which log
        " eid TEXT NOT NULL,"                       # 由内容算出的编号 / the id computed from the content
        " nth INTEGER NOT NULL,"                    # 第几条一模一样的 / which identical copy
        " at TEXT NOT NULL DEFAULT '',"
        " body TEXT NOT NULL,"
        " UNIQUE (stream, eid))"
    )
    con.execute("CREATE INDEX IF NOT EXISTS events_stream ON events (stream, seq)")
    return con


def _canonical(row: dict[str, Any]) -> str:
    return json.dumps(row, ensure_ascii=False, sort_keys=True)


def event_id(body: str, nth: int) -> str:
    return hashlib.sha256(f"{nth}\n{body}".encode("utf-8")).hexdigest()[:32]


def _db_read(stream: str) -> list[dict[str, Any]]:
    with contextlib.closing(connect()) as con:
        return [json.loads(body) for (body,) in con.execute("SELECT body FROM events WHERE stream = ? ORDER BY seq", (stream,))]


def _db_append(stream: str, rows: Iterable[dict[str, Any]]) -> int:
    """新写入的事件：一模一样的内容也照样记一条（排在已有的那些之后）。

    Newly written events: identical content is still recorded as another event, after the ones already there.
    """
    bodies = [_canonical(r) for r in rows]
    if not bodies:
        return 0
    with contextlib.closing(connect()) as con:
        con.execute("BEGIN IMMEDIATE")
        try:
            for body in bodies:
                (nth,) = con.execute("SELECT COUNT(*) FROM events WHERE stream = ? AND body = ?", (stream, body)).fetchone()
                con.execute("INSERT INTO events (stream, eid, nth, at, body) VALUES (?, ?, ?, ?, ?)",
                            (stream, event_id(body, nth), nth, str(json.loads(body).get("at") or ""), body))
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
    return len(bodies)


def import_rows(stream: str, rows: Iterable[dict[str, Any]]) -> int:
    """把一个文件里的行并进数据库：库里已经有的不动，只进新的。返回新进了几条。

    文件里第 n 条一模一样的行对应库里第 n 条一模一样的事件，所以反复导入同一个文件、
    或者导入一个只是多了几行的文件，都不会重复。

    Merge a file's rows into the database: what is already there is left alone and only new
    rows come in. Returns how many came in. The nth identical row in the file corresponds to
    the nth identical event in the database, so importing the same file again, or a file
    that merely has a few more rows, never duplicates anything.
    """
    seen: dict[str, int] = {}
    added = 0
    with contextlib.closing(connect()) as con:
        con.execute("BEGIN IMMEDIATE")
        try:
            for row in rows:
                body = _canonical(row)
                nth = seen.get(body, 0)
                seen[body] = nth + 1
                cur = con.execute("INSERT OR IGNORE INTO events (stream, eid, nth, at, body) VALUES (?, ?, ?, ?, ?)",
                                  (stream, event_id(body, nth), nth, str(row.get("at") or ""), body))
                added += cur.rowcount
            con.execute("COMMIT")
        except BaseException:
            con.execute("ROLLBACK")
            raise
    return added


def export_text(stream: str) -> str:
    """这条日志导出成 JSONL 的样子，和文件存法写出来的一模一样。 / This log as JSONL text, identical to what the file backend writes."""
    return "".join(_canonical(r) + "\n" for r in _db_read(stream))


def counts() -> dict[str, int]:
    with contextlib.closing(connect()) as con:
        return {stream: n for stream, n in con.execute("SELECT stream, COUNT(*) FROM events GROUP BY stream ORDER BY stream")}


@contextlib.contextmanager
def locked(name: str) -> Iterator[None]:
    """"先读再写"要连成一步的地方用：比如分配 idea 的编号，两个人同时新建不能撞号。

    For read-then-write steps that must be one step, such as allocating an idea id: two
    people creating at the same moment must not get the same number.
    """
    base = db_path().parent if db_path() else runs_dir()
    base.mkdir(parents=True, exist_ok=True)
    with (base / f".{name}.lock").open("a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


# ---------- 读和写 / reading and writing ----------


def _read_file(path: Path) -> tuple[list[dict[str, Any]], int]:
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


def read_lines(path: Path) -> tuple[list[dict[str, Any]], int]:
    """返回（读得出来的行，读不出来的行数）。 / Returns (readable rows, count of unreadable lines)."""
    stream = stream_of(path)
    return (_db_read(stream), 0) if stream else _read_file(path)


def append(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    """把若干行一次写完。同一次调用里的行不会和别的写入交错。

    Write several rows in one go; rows from one call never interleave with another writer.
    """
    stream = stream_of(path)
    if stream:
        return _db_append(stream, rows)
    text = "".join(_canonical(r) + "\n" for r in rows)
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
