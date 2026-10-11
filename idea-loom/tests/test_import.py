"""导入往返：从 git 历史导入，再生成，得到的东西要和现在的 IDEAS.md 一致。

Import round trip: importing from git history and rendering again must give
what IDEAS.md holds today.
"""

import subprocess

import pytest

from idea_loom import ideas, importer, render, store
from idea_loom.markdown import parse
from idea_loom.model import State

REPO = store.repo_root()


def _head_text() -> str:
    try:
        return subprocess.run(["git", "-C", str(REPO), "show", "origin/main:IDEAS.md"], check=True, capture_output=True, text=True).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        pytest.skip("这里没有 world-sim 的 git 历史")


@pytest.fixture(scope="module")
def imported() -> tuple[State, str]:
    text = _head_text()
    # 这些测试顺着 IDEAS.md 的提交历史还原每条 idea 的来历；浅克隆里没有历史，测不了。
    # These tests rebuild each idea's history from the commits of IDEAS.md; a shallow clone has no history to rebuild from.
    if subprocess.run(["git", "-C", str(REPO), "rev-parse", "--is-shallow-repository"], capture_output=True, text=True).stdout.strip() == "true":
        pytest.skip("这是一个浅克隆，没有完整的 git 历史")
    snapshots = importer.history(REPO)
    events = importer.events_from(snapshots)
    folded, _ = ideas.fold(events)
    frame = importer.frame_from(parse(text))
    ordered = sorted(folded.values(), key=lambda i: ideas.sort_key(i.id))
    state = State(
        frame=frame, projects=importer.PROJECTS, ideas=ordered, links=[], coverage=ideas.coverage(folded),
        kernels=ideas.kernel_counts(folded, frame),
        counts={"total": len(ordered), "by_status": {}, "live": 0}, labels={},  # type: ignore[arg-type]
    )
    return state, text


def test_live_ideas_match_the_file(imported):
    state, text = imported
    want = {e.id: (e.title, e.threads and sorted(e.threads), e.body) for e in parse(text).entries}
    got = {i.id: (i.title, i.threads, i.body) for i in state.ideas if i.status == "pool"}
    assert got.keys() == want.keys()
    for idea_id in want:
        assert got[idea_id] == want[idea_id], idea_id
    assert len(got) == 105


def test_vanished_ids_are_merged_not_lost(imported):
    state, _ = imported
    merged = {i.id: i.merged_into for i in state.ideas if i.status == "merged"}
    assert merged == importer.MERGES


def test_rendered_pool_parses_back_to_the_same_entries(imported):
    state, text = imported
    again = parse("## 6. Idea 池\n\n" + render.pool(state) + "\n")
    key = lambda e: (e.id, e.title, sorted(e.threads), e.body)
    assert sorted(map(key, again.entries)) == sorted(map(key, parse(text).entries))


def test_coverage_table_matches_the_hand_written_one(imported):
    state, text = imported
    assert render.coverage(state) in text


def test_kernel_assignment_matches_the_table(imported):
    state, text = imported
    want = parse(text).kernels
    got = {i.id: i.kernel for i in state.ideas if i.status == "pool" and i.kernel}
    assert got == want


def test_apply_replaces_only_between_markers(imported):
    state, _ = imported
    doc = "前言\n\n" + "\n\n".join(f"{render.begin(b)}\n@@旧内容@@\n{render.end(b)}" for b in render.BLOCKS) + "\n\n后记\n"
    out = render.apply(doc, state)
    assert out.startswith("前言\n") and out.endswith("后记\n")
    assert "@@旧内容@@" not in out and "**1.1 往上走一层**（E）" in out
    with pytest.raises(ValueError):
        render.apply("没有标记", state)
