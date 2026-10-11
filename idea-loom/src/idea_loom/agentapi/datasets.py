"""查数据集：记录从 main 上的文件里读，按键取、按文字搜、按字段筛、选字段、翻页。

读的是 origin/main 上的版本，不看工作目录：和托管的模拟是同一个来源。解析过的记录按
"哪个提交"缓存。

Querying datasets: records are read from the files on main and can be fetched by key,
searched by text, filtered by field, projected and paged. The version on origin/main is
read, never the working tree — the same source the hosted simulations come from. Parsed
records are cached per commit.
"""

from __future__ import annotations

import fnmatch
import json
import subprocess
from collections import OrderedDict
from pathlib import PurePosixPath
from typing import Any, Optional

import yaml
from pydantic import BaseModel

from .. import store
from ..play.manifest import REF
from .spec import Dataset

MAX_LIMIT = 100
DEFAULT_LIMIT = 20
MAX_BYTES = 200_000  # 一次最多返回这么多字节的记录 / records returned in one reply are capped at this many bytes
MAX_FILE_BYTES = 20_000_000
_cache: "OrderedDict[tuple[str, str, str], tuple[list[dict[str, Any]], list[str]]]" = OrderedDict()


class DatasetError(ValueError):
    """查不了，原因和怎么改写给 Agent 看。 / The query cannot run; the message tells an agent why and how to fix it."""


class Page(BaseModel):
    project: str
    dataset: str
    version: str  # main 上的哪个提交 / the commit on main
    total: int  # 符合条件的一共多少条 / how many records match in all
    count: int
    next: Optional[int] = None  # 还有下一页时，下一次的 after / the `after` for the next page, when there is one
    truncated: bool = False  # 因为太大而少给了 / fewer were returned because of size
    licence: str
    provenance: dict[str, str]
    records: list[dict[str, Any]]


def _git(*args: str) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(["git", "-C", str(store.repo_root()), *args], capture_output=True)


def version() -> str:
    return _git("rev-parse", "--short=12", REF).stdout.decode().strip()


def _dig(value: Any, path: str) -> Any:
    for part in [p for p in path.split(".") if p]:
        if isinstance(value, dict) and part in value:
            value = value[part]
        else:
            return None
    return value


def _parse(name: str, raw: bytes) -> Any:
    text = raw.decode("utf-8", "replace")
    return json.loads(text) if name.endswith(".json") else yaml.safe_load(text)


def _records(project: str, ds: Dataset) -> list[dict[str, Any]]:
    listed = _git("ls-tree", "-r", "--name-only", REF, f"{project}/").stdout.decode().splitlines()
    pattern = f"{project}/{ds.path}"
    files = sorted(f for f in listed if fnmatch.fnmatchcase(f, pattern))
    if not files:
        raise DatasetError(f"main 上没有 {pattern} 这样的文件")
    out: list[dict[str, Any]] = []
    for name in files:
        shown = _git("show", f"{REF}:{name}")
        if shown.returncode != 0 or len(shown.stdout) > MAX_FILE_BYTES:
            raise DatasetError(f"读不了 {name}")
        try:
            doc = _parse(name, shown.stdout)
        except (ValueError, yaml.YAMLError) as e:
            raise DatasetError(f"{name} 解析不了：{e}") from e
        if "*" in ds.path:  # 每个文件一条记录 / one record per file
            stem = PurePosixPath(name)
            body = _dig(doc, ds.records) if ds.records else doc
            out.append({"_id": stem.stem, "_group": stem.parent.name, **(body if isinstance(body, dict) else {"value": body})})
            continue
        body = _dig(doc, ds.records) if ds.records else doc
        if isinstance(body, list):
            out += [r if isinstance(r, dict) else {"value": r} for r in body]
        elif isinstance(body, dict):
            out += [{"_id": k, **(v if isinstance(v, dict) else {"value": v})} for k, v in body.items()]
        else:
            raise DatasetError(f"{name} 里的 {ds.records or '根'} 不是列表也不是对象")
    return out


def _haystack(record: dict[str, Any], fields: list[str]) -> str:
    picked = {f: _dig(record, f) for f in fields} if fields else record
    return json.dumps(picked, ensure_ascii=False, default=str).lower()


def load(project: str, ds: Dataset) -> tuple[list[dict[str, Any]], list[str], str]:
    """（全部记录，每条用来搜索的文字，版本）。 / (all records, the searchable text of each, the version)."""
    at = version()
    key = (project, ds.id, at)
    if key not in _cache:
        records = _records(project, ds)
        _cache[key] = (records, [_haystack(r, ds.search) for r in records])
        while len(_cache) > 12:
            _cache.popitem(last=False)
    _cache.move_to_end(key)
    records, hay = _cache[key]
    return records, hay, at


def describe(project: str, ds: Dataset) -> dict[str, Any]:
    """这个数据集长什么样：多少条、有哪些字段、一条样例。 / What the dataset looks like: how many records, which fields, one sample."""
    records, _, at = load(project, ds)
    fields: dict[str, str] = {}
    for record in records[:200]:
        for k, v in record.items():
            fields.setdefault(k, type(v).__name__ if v is not None else "null")
    sample = _project(records[0], ds.fields) if records else {}
    return {"project": project, "dataset": ds.id, "title": ds.title.model_dump(), "description": ds.description.model_dump(), "version": at,
            "records": len(records), "key": ds.key, "fields": fields, "searched_fields": ds.search or "all", "default_fields": ds.fields or "all",
            "licence": ds.licence, "provenance": ds.provenance.model_dump(), "sample": _clip(sample),
            "how_to_query": "GET /api/v1/datasets/{project}/{dataset}?q=words&where=field=value&key=K&fields=a,b&limit=20&after=0".replace("{project}", project).replace("{dataset}", ds.id)}


def _clip(value: Any, limit: int = 400) -> Any:
    """样例里太长的东西截短。 / Shorten over-long values in a sample."""
    if isinstance(value, str):
        return value if len(value) <= limit else value[:limit] + "…"
    if isinstance(value, list):
        return [_clip(v, limit) for v in value[:5]] + (["…"] if len(value) > 5 else [])
    if isinstance(value, dict):
        return {k: _clip(v, limit) for k, v in value.items()}
    return value


def _project(record: dict[str, Any], fields: list[str]) -> dict[str, Any]:
    if not fields:
        return record
    return {f: _dig(record, f) for f in fields if _dig(record, f) is not None}


def query(project: str, ds: Dataset, *, q: str = "", key: str = "", where: Optional[list[str]] = None, fields: str = "",
          limit: int = DEFAULT_LIMIT, after: int = 0) -> Page:
    records, hay, at = load(project, ds)
    if limit < 1 or limit > MAX_LIMIT:
        raise DatasetError(f"limit 要在 1 到 {MAX_LIMIT} 之间")
    if after < 0:
        raise DatasetError("after 不能是负数")
    keep = list(range(len(records)))
    if key:
        keep = [i for i in keep if str(records[i].get(ds.key)) == key]
        if not keep:
            raise DatasetError(f"没有键是 {key!r} 的记录。键是字段 {ds.key!r}；先用 q= 搜一下。")
    for clause in where or []:
        name, sep, wanted = clause.partition("=")
        if not sep or not name:
            raise DatasetError(f"where 要写成 字段=值，收到的是 {clause!r}")
        if not any(_dig(records[i], name) is not None for i in keep[:500]) and keep:
            known = sorted({k for i in keep[:50] for k in records[i]})
            raise DatasetError(f"没有 {name!r} 这个字段。有的字段：{', '.join(known[:40])}")
        keep = [i for i in keep if str(_dig(records[i], name)).lower() == wanted.lower()]
    for term in q.lower().split():
        keep = [i for i in keep if term in hay[i]]
    wanted_fields = [] if fields.strip() == "*" else [f.strip() for f in fields.split(",") if f.strip()] or ds.fields
    out: list[dict[str, Any]] = []
    size = 0
    truncated = False
    for i in keep[after:after + limit]:
        record = _project(records[i], wanted_fields)
        size += len(json.dumps(record, ensure_ascii=False, default=str))
        if out and size > MAX_BYTES:
            truncated = True
            break
        out.append(record)
    reached = after + len(out)
    return Page(project=project, dataset=ds.id, version=at, total=len(keep), count=len(out), next=reached if reached < len(keep) else None,
                truncated=truncated, licence=ds.licence, provenance=ds.provenance.model_dump(), records=out)
