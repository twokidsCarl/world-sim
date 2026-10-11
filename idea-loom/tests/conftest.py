"""测试共用的夹具。 / Shared test fixtures."""

from __future__ import annotations

import pytest

from idea_loom import ideas, store
from idea_loom.model import Frame, IdeaEvent, KernelInfo, LevelInfo, Project, ThreadInfo

SHORT = {"A": "传播", "B": "崩溃", "C": "互猜", "D": "记忆", "E": "接口"}


def ev(at: int, idea_id: str, event: str, **kw) -> IdeaEvent:
    return IdeaEvent(at=f"2026-01-01T00:00:{at:02d}+00:00", by=kw.pop("by", "human"), id=idea_id, event=event, **kw)  # type: ignore[arg-type]


@pytest.fixture
def data(tmp_path, monkeypatch):
    """一个空的数据目录，带最小的骨架。 / An empty data directory with a minimal frame."""
    monkeypatch.setenv("IDEA_LOOM_DATA", str(tmp_path))
    # 运行时的文件也隔开，免得测试写进真实的操作轨迹。 / Isolate runtime files too, so tests never write into the real trail.
    monkeypatch.setenv("IDEA_LOOM_RUNS", str(tmp_path / "runs"))
    levels = [LevelInfo(id=f"L{n}", name=f"层{n}") for n in range(1, 11)]  # type: ignore[arg-type]
    levels += [LevelInfo(id="纵", name="纵线", kind="vertical"), LevelInfo(id="造", name="支线 造", kind="branch"), LevelInfo(id="规", name="支线 规", kind="branch")]
    frame = Frame(
        levels=levels,
        threads=[ThreadInfo(id=t, name=SHORT[t], short=SHORT[t]) for t in "ABCDE"],  # type: ignore[arg-type]
        kernels=[KernelInfo(name="粒子", desc="很多个点", project="strata"), KernelInfo(name="阈值与级联", desc="攒够了就翻转")],
    )
    store.write_json(tmp_path / "frame.json", frame.model_dump())
    store.write_json(tmp_path / "projects.json", [Project(dir="strata", level="L1", keywords=["strata"]).model_dump()])
    return tmp_path


@pytest.fixture
def seeded(data):
    ideas.append_events(
        [
            ev(1, "1.1", "created", title="往上走一层", body="接着 strata：现在只有粒子。", threads=["E"], kernel="粒子"),
            ev(2, "1.2", "created", title="沙堆", body="一粒一粒往下落。\n和 1.1 共用内核吗。", threads=["B"]),
            ev(3, "1.3", "created", title="一点火星", body="烧成一片。", threads=["A", "B"]),
            ev(4, "纵 1", "created", title="一杯酒", body="从分子到社会。"),
        ]
    )
    return data
