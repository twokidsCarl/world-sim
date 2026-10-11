"""一次性导入：顺着 IDEAS.md 的 git 历史，把每条 idea 的来历还原成事件。

One-off import: walk the git history of IDEAS.md and reconstruct each idea's
history as events.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Optional

from . import store
from .ideas import ID_RE, level_of
from .markdown import Parsed, parse
from .model import Frame, IdeaEvent, KernelInfo, LevelInfo, Origin, Project, ThreadInfo

# IDEAS.md 里消失的编号去了哪里（合并发生在 PR #15）。不在表里的按丢弃处理。
# Where ids that vanished from IDEAS.md went (the merges happened in PR #15).
# Anything not listed here is treated as discarded.
MERGES = {
    "1.7": "1.6",
    "2.7": "2.6",
    "2.8": "2.3",
    "3.5": "4.2",
    "4.4": "4.2",
    "4.9": "4.8",
    "6.9": "6.2",
    "10.7": "10.2",
    "规 3": "规 1",
}
THREAD_SHORT = {"A": "传播", "B": "崩溃", "C": "互猜", "D": "记忆", "E": "接口"}
BRANCH_NAMES = {"纵": "纵线：同一件事穿过所有层", "造": "支线 造：人造的东西", "规": "支线 规：纯粹的规则世界"}
PROJECTS = [
    Project(dir="strata", tagline="从微观规则到涌现", level="L1", keywords=["strata"], ui_url="http://localhost:5188"),
    Project(dir="limn", tagline="Goodsell 风格的科学插图", level="L2", keywords=["Goodsell", "limn"], ui_url="http://localhost:5184"),
    Project(dir="soma", tagline="三维人体解剖", level="L4", keywords=["soma"], ui_url="http://localhost:5183"),
    Project(dir="mindloop", tagline="我知道你知道我知道", level="L6", keywords=["mindloop"], ui_url="http://localhost:8765"),
    Project(dir="polis", tagline="平行社会", level="L8", keywords=["polis"], ui_url="http://localhost:5186"),
]


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout


def history(repo: Path, ref: str = "origin/main", path: str = "IDEAS.md") -> list[tuple[str, str, str, str]]:
    """每个改过 IDEAS.md 的提交：(sha, 时间, 标题, 当时的全文)，从旧到新。

    Every commit that touched IDEAS.md as (sha, time, subject, full text), oldest first.
    """
    log = _git(repo, "log", "--reverse", "--format=%H%x09%aI%x09%s", ref, "--", path)
    out = []
    for line in log.splitlines():
        sha, at, subject = line.split("\t", 2)
        out.append((sha, at, subject, _git(repo, "show", f"{sha}:{path}")))
    return out


def events_from(snapshots: list[tuple[str, str, str, str]]) -> list[IdeaEvent]:
    events: list[IdeaEvent] = []
    live: dict[str, tuple[str, str, list[str]]] = {}
    kernels: dict[str, Optional[str]] = {}
    for sha, at, subject, text in snapshots:
        parsed = parse(text)
        pr_match = re.search(r"\(#(\d+)\)\s*$", subject)
        origin = Origin(
            how="import",
            commit=sha[:7],
            pr=int(pr_match.group(1)) if pr_match else None,
            subject=re.sub(r"\s*\(#\d+\)\s*$", "", subject),
        )
        present = {e.id: e for e in parsed.entries}
        for entry in parsed.entries:
            old = live.get(entry.id)
            if old is None:
                events.append(
                    IdeaEvent(
                        at=at, by="import", id=entry.id, event="created", title=entry.title, body=entry.body,
                        level=level_of(entry.id), threads=entry.threads, status="pool", origin=origin,  # type: ignore[arg-type]
                    )
                )
            else:
                if (old[0], old[1]) != (entry.title, entry.body):
                    events.append(
                        IdeaEvent(at=at, by="import", id=entry.id, event="edited", title=entry.title, body=entry.body,
                                  text=f"在「{origin.subject}」里改写", origin=origin)
                    )
                if old[2] != entry.threads:
                    events.append(IdeaEvent(at=at, by="import", id=entry.id, event="moved", threads=entry.threads, origin=origin))  # type: ignore[arg-type]
            live[entry.id] = (entry.title, entry.body, entry.threads)
        for gone in [i for i in live if i not in present]:
            target = MERGES.get(gone)
            if target and target in present:
                events.append(IdeaEvent(at=at, by="import", id=gone, event="merged_into", target=target,
                                        reason="同一层、同一种内核，做出来会是同一个项目", origin=origin))
            else:
                events.append(IdeaEvent(at=at, by="import", id=gone, event="discarded", reason="从 IDEAS.md 中移除", origin=origin))
            del live[gone]
            kernels.pop(gone, None)
        for idea_id in present:
            kernel = parsed.kernels.get(idea_id)
            if parsed.kernel_rows and kernels.get(idea_id) != kernel:
                events.append(IdeaEvent(at=at, by="import", id=idea_id, event="moved", kernel=kernel, origin=origin))
                kernels[idea_id] = kernel
    return events


def frame_from(parsed: Parsed) -> Frame:
    levels = [LevelInfo(id=lv, name=name, unit=unit, emerges=emerges) for lv, name, unit, emerges in parsed.levels]  # type: ignore[arg-type]
    seen = set()
    levels = [lv for lv in levels if not (lv.id in seen or seen.add(lv.id))]
    for key, name in BRANCH_NAMES.items():
        levels.append(LevelInfo(id=key, name=name, intro=parsed.intros.get(key, ""), kind="vertical" if key == "纵" else "branch"))  # type: ignore[arg-type]
    threads = [ThreadInfo(id=t, name=name, short=THREAD_SHORT[t], desc=desc) for t, name, desc in parsed.threads]  # type: ignore[arg-type]
    kernels = [KernelInfo(name=name, desc=desc, project=project or None) for name, desc, project in parsed.kernel_rows]
    return Frame(levels=levels, threads=threads, kernels=kernels)


def run(repo: Optional[Path] = None, force: bool = False) -> dict[str, int]:
    repo = repo or store.repo_root()
    data = store.data_dir()
    target = data / "ideas.jsonl"
    if target.exists() and target.stat().st_size and not force:
        raise FileExistsError(f"{target} 已经有内容；确定要重新导入就加 --force")
    snapshots = history(repo)
    if not snapshots:
        raise RuntimeError("IDEAS.md 在 origin/main 上没有历史")
    events = events_from(snapshots)
    final = parse(snapshots[-1][3])
    if target.exists():
        target.unlink()
    store.append(target, [e.model_dump(exclude_unset=True) for e in events])
    store.write_json(data / "frame.json", frame_from(final).model_dump())
    if force or not (data / "projects.json").exists():
        store.write_json(data / "projects.json", [p.model_dump() for p in PROJECTS])
    return {"commits": len(snapshots), "events": len(events), "ideas": len(final.entries)}


__all__ = ["run", "events_from", "frame_from", "history", "MERGES", "ID_RE"]
