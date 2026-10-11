import json

import pytest
from fastapi.testclient import TestClient

import fake_claude as fc
from idea_loom import github, review, tasks, trail, wishes
from idea_loom.server import app

client = TestClient(app)


def actions(n):
    return [trail.Action(at=f"2020-01-01T08:{i // 60:02d}:{i % 60:02d}Z", kind="click" if i % 3 else "navigate", url="/ideas" if i % 2 else "/", text=f"按钮{i % 4}") for i in range(n)]


@pytest.fixture
def log(tmp_path, monkeypatch, seeded):
    return fc.install(tmp_path, monkeypatch)


def test_review_needs_enough_actions(log):
    trail.append(actions(3))
    with pytest.raises(ValueError, match="太少"):
        review.run()
    assert client.post("/api/review").status_code == 409


def test_review_proposes_at_most_three_and_records_only_on_accept(log, monkeypatch):
    trail.append(actions(40))
    wishes.record(title="已有的一条", kind="other", stuck="", suggestion="")
    monkeypatch.setenv("FAKE_STRUCTURED", json.dumps({"wishes": [
        {"title": f"愿望{i}", "kind": "unclear", "stuck": "s", "suggestion": "g", "evidence": "按钮1 点了很多次"} for i in range(5)
    ] + [{"title": "种类不对的", "kind": "nope", "stuck": "", "suggestion": "", "evidence": ""}]}, ensure_ascii=False))
    assert review.status().actions_since == 40
    found = client.post("/api/review").json()
    assert [s["title"] for s in found] == ["愿望0", "愿望1", "愿望2"]
    prompt = fc.calls(log)[0]["stdin"]
    assert "一共 40 条操作" in prompt and "按钮1×" in prompt and "已有的一条" in prompt
    assert len(wishes.listing().wishes) == 1  # 提议不落盘 / proposals are not stored
    assert review.status().actions_since == 0
    made = client.post("/api/wishes", json=found[0]).json()
    assert made["source"] == "review" and len(wishes.listing().wishes) == 2


def test_advance_files_the_proposed_milestone_as_a_task(log, monkeypatch, tmp_path):
    root = tmp_path / "repo"
    (root / "strata").mkdir(parents=True)
    (root / "strata" / "README.md").write_text("# strata\n现在只有二维。\n")
    monkeypatch.setenv("IDEA_LOOM_REPO", str(root))
    monkeypatch.setattr(github, "pull_requests", lambda force=False: github.parse([{"number": 5, "title": "strata: 加入 Ising", "state": "MERGED", "createdAt": "x", "mergedAt": "y"}]))
    tasks.link_project("strata", "1.1")
    monkeypatch.setenv("FAKE_STRUCTURED", json.dumps({"title": "加入三维盒子", "brief": "把粒子放进三维。做到能量守恒测试通过算完。"}, ensure_ascii=False))
    task = client.post("/api/projects/strata/advance").json()
    assert (task["title"], task["project"], task["idea_id"], task["status"]) == ("加入三维盒子", "strata", "1.1", "todo")
    prompt = fc.calls(log)[0]["stdin"]
    assert "现在只有二维" in prompt and "#5 strata: 加入 Ising" in prompt and "1.1 往上走一层" in prompt
    assert client.post("/api/projects/nope/advance").status_code == 404
