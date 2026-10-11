"""同步：在一个临时仓库里测，不碰真的仓库。 / Sync, tested in a throwaway repository."""

import subprocess

import pytest

from idea_loom import edits, ideas, render, store, sync


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path, monkeypatch, seeded):
    """一个带 origin/main 的仓库，数据目录在里面。 / A repository with an origin/main and the data directory inside."""
    root = tmp_path / "repo"
    data = root / "idea-loom" / "data"
    data.mkdir(parents=True)
    for f in seeded.iterdir():
        if f.is_file():
            (data / f.name).write_bytes(f.read_bytes())
    monkeypatch.setenv("IDEA_LOOM_DATA", str(data))
    monkeypatch.setenv("IDEA_LOOM_REPO", str(root))
    blocks = "\n\n".join(f"{render.begin(b)}\n{render.end(b)}" for b in render.BLOCKS)
    (root / "IDEAS.md").write_text(f"# 想法\n\n手写的前言。\n\n{blocks}\n\n手写的后记。\n", encoding="utf-8")
    (root / "IDEAS.md").write_text(render.apply((root / "IDEAS.md").read_text(encoding="utf-8"), ideas.state()), encoding="utf-8")
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init")
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
    return root


def test_nothing_to_sync_right_after_commit(repo):
    st = sync.status()
    assert (st.pending, st.ideas_md_stale, st.can_sync) == (0, False, False)
    assert sync.run().ok is False


def test_local_edits_count_as_pending_and_make_ideas_md_stale(repo):
    edits.edit("1.2", title="沙堆与雪崩")
    edits.discard("1.3", reason="重复")
    st = sync.status()
    assert (st.pending, st.ideas_md_stale, st.can_sync) == (2, True, True)


def test_position_change_that_does_not_show_in_the_file_is_still_pending(repo):
    edits.note("1.1", "只是一条说明")
    st = sync.status()
    assert (st.pending, st.ideas_md_stale, st.can_sync) == (1, False, True)


def test_missing_markers_block_sync_with_a_reason(repo):
    (repo / "IDEAS.md").write_text("没有标记\n", encoding="utf-8")
    st = sync.status()
    assert st.can_sync is False and "标记" in st.reason


def test_run_regenerates_and_calls_pr_script_with_the_right_paths(repo):
    tools = repo / "tools"
    tools.mkdir()
    script = tools / "pr.sh"
    script.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$(dirname "$0")/args.txt"\necho "PR: https://example.test/pull/7"\necho "已合并。"\n', encoding="utf-8")
    script.chmod(0o755)
    edits.edit("1.2", title="沙堆与雪崩")
    result = sync.run()
    assert result.ok and result.pr_url == "https://example.test/pull/7"
    args = (tools / "args.txt").read_text(encoding="utf-8").splitlines()
    assert args[0].startswith("ideas: 同步想法池（1 处改动）")
    assert args[1:] == ["idea-loom/data/ideas.jsonl", "idea-loom/data/frame.json", "idea-loom/data/projects.json", "IDEAS.md"]
    text = (repo / "IDEAS.md").read_text(encoding="utf-8")
    assert "**1.2 沙堆与雪崩**（B）" in text and text.startswith("# 想法\n\n手写的前言。") and text.endswith("手写的后记。\n")


def test_failed_script_reports_its_last_line(repo):
    tools = repo / "tools"
    tools.mkdir()
    script = tools / "pr.sh"
    script.write_text('#!/bin/sh\necho "PR: https://example.test/pull/8"\necho "还没有合并（状态: OPEN）。" >&2\nexit 1\n', encoding="utf-8")
    script.chmod(0o755)
    edits.note("1.1", "x")
    result = sync.run()
    assert result.ok is False and result.pr_url.endswith("/8") and "还没有合并" in result.message


def test_changes_in_other_data_files_can_be_synced_too(repo):
    from idea_loom import wishes

    wishes.record(title="甲", kind="other", stuck="", suggestion="")
    st = sync.status()
    assert (st.pending, st.ideas_md_stale, st.other_data, st.can_sync) == (0, False, True, True)
