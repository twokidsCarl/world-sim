import json
import time

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
    monkeypatch.setattr(review, "_checked_at", 0.0)  # 每个测试从头检查 / every test starts checking afresh
    return fc.install(tmp_path, monkeypatch)


def found(*importance, kind="unclear"):
    """假模型的回答：每个重要程度一条发现。 / The fake model's answer: one finding per importance."""
    return json.dumps({"wishes": [{"title": f"愿望{i}", "kind": kind, "stuck": "s", "suggestion": "g", "evidence": "按钮1 点了很多次",
                                   "importance": n, "reason": f"理由{i}"} for i, n in enumerate(importance)]}, ensure_ascii=False)


def pile(n):
    """一次最多记 200 条，所以分几次记。 / At most 200 are kept per call, so record them in batches."""
    rows = actions(n)
    for i in range(0, n, 100):
        trail.append(rows[i:i + 100])


def titles(group="all"):
    return sorted(w.title for w in wishes.listing(group=group).wishes)


def test_review_needs_enough_actions(log):
    trail.append(actions(3))
    with pytest.raises(ValueError, match="太少"):
        review.run()
    assert client.post("/api/review").status_code == 409


def test_review_records_the_important_findings_and_drops_the_rest(log, monkeypatch):
    trail.append(actions(40))
    wishes.record(title="已有的一条", kind="other", stuck="", suggestion="")
    done = wishes.record(title="不做的一条", kind="other", stuck="", suggestion="")
    wishes.set_status(done, "declined", note="不需要")
    answer = json.loads(found(5, 2, 4, 1, 3, 5))
    answer["wishes"].append({"title": "种类不对的", "kind": "nope", "stuck": "", "suggestion": "", "evidence": "", "importance": 5, "reason": ""})
    monkeypatch.setenv("FAKE_STRUCTURED", json.dumps(answer, ensure_ascii=False))
    assert review.status().actions_since == 40
    done_run = review.run()
    prompt = fc.calls(log)[0]["stdin"]
    assert "一共 40 条操作" in prompt and "按钮1×" in prompt and "已有的一条" in prompt and "不做的一条" in prompt
    # 最多看五条；4 分及以上的直接记进许愿池，其余的丢掉 / at most five findings; 4 and above are recorded, the rest dropped
    assert [(f.title, f.importance, bool(f.wish_id)) for f in done_run.findings] == [
        ("愿望0", 5, True), ("愿望1", 2, False), ("愿望2", 4, True), ("愿望3", 1, False), ("愿望4", 3, False)]
    assert titles() == ["不做的一条", "已有的一条", "愿望0", "愿望2"]
    made = wishes.get(done_run.findings[0].wish_id)
    assert made.source == "review" and "理由0" in made.seen[0].question
    status = review.status()
    assert status.actions_since == 0 and not status.running
    assert [r.id for r in status.runs] == [done_run.id] and status.runs[0].findings[1].reason == "理由1"


def test_a_dropped_finding_can_be_rescued_once_and_is_not_proposed_again(log, monkeypatch):
    trail.append(actions(40))
    monkeypatch.setenv("FAKE_STRUCTURED", found(2, 4))
    first = review.run()
    rescued = client.post(f"/api/review/{first.id}/rescue/0").json()
    assert rescued["title"] == "愿望0" and rescued["source"] == "review"
    assert client.post(f"/api/review/{first.id}/rescue/0").status_code == 409  # 已经记了 / already recorded
    assert client.post(f"/api/review/{first.id}/rescue/1").status_code == 409  # 本来就记了 / recorded at the time
    assert client.post("/api/review/nope/rescue/0").status_code == 409
    shown = review.status().runs[0].findings[0]
    assert shown.rescued and shown.wish_id == rescued["wish_id"]
    # 以前丢掉、没捞回来的，下次告诉模型别再提 / a dropped finding that was not rescued is listed for the next review
    monkeypatch.setenv("FAKE_STRUCTURED", found(1, kind="missing"))
    trail.append(actions(20))
    second = review.run()
    prompt = fc.calls(log)[1]["stdin"]
    assert "以前回看时判为不重要、丢掉的" not in prompt  # 第一次只丢了一条，又捞回来了 / the only drop was rescued
    review.run()
    assert "以前回看时判为不重要、丢掉的：\n- 愿望0" in fc.calls(log)[2]["stdin"]
    assert second.findings[0].wish_id is None


def test_review_runs_by_itself_once_enough_actions_pile_up(log, monkeypatch):
    sent = []
    monkeypatch.setattr(review.notify, "send", lambda *a, **kw: sent.append(a))
    monkeypatch.setenv("FAKE_STRUCTURED", found(4, 1))
    pile(review.DUE_AFTER - 1)
    assert review.maybe_start(now=1000.0) is False  # 还不够 / not yet due
    trail.append(actions(1))
    assert review.maybe_start(now=1010.0) is False  # 隔得太近，不读轨迹 / too soon after the last check
    assert review.maybe_start(now=2000.0) is True
    review.wait()
    assert titles() == ["愿望0"]
    assert review.status().runs[0].trigger == "auto" and review.status().actions_since == 0
    assert sent == [("回看记了 1 条愿望", "愿望0")]
    assert review.maybe_start(now=3000.0) is False  # 刚回看过 / just reviewed
    assert len(fc.calls(log)) == 1


def test_only_one_review_runs_at_a_time(log, monkeypatch):
    pile(review.DUE_AFTER)
    assert review._running.acquire(blocking=False)
    try:
        assert review.maybe_start(now=1000.0) is False
        assert client.post("/api/review").status_code == 409
        assert review.status().running
    finally:
        review._running.release()
    assert fc.calls(log) == []


def test_review_now_starts_in_the_background(log, monkeypatch):
    trail.append(actions(40))
    monkeypatch.setenv("FAKE_STRUCTURED", found(5))
    assert client.post("/api/review").status_code == 200
    review.wait()
    assert titles() == ["愿望0"] and review.status().runs[0].trigger == "manual"


def test_recording_the_owners_actions_triggers_the_review(log, monkeypatch):
    monkeypatch.setenv("FAKE_STRUCTURED", found(5))
    pile(review.DUE_AFTER - 1)
    assert client.post("/api/trail", json={"actions": [actions(1)[0].model_dump()]}).json() == {"saved": 1}
    review.wait()
    assert titles() == ["愿望0"]


def test_a_failed_review_is_logged_and_not_retried_at_once(log, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "always_fail")
    pile(review.DUE_AFTER)
    assert review.maybe_start(now=time.time()) is True
    review.wait()
    status = review.status()
    assert status.runs[0].error and status.actions_since == review.DUE_AFTER and not status.running
    assert review.maybe_start(now=time.time() + review.CHECK_EVERY + 1) is False  # 失败后先歇一阵 / rest a while after a failure
    assert review.maybe_start(now=time.time() + review.RETRY_AFTER + review.CHECK_EVERY + 2) is True
    review.wait()


def test_no_auto_review_without_a_model(log, monkeypatch):
    monkeypatch.setenv("IDEA_LOOM_CLAUDE_BIN", "/nonexistent/claude")
    pile(review.DUE_AFTER)
    assert review.maybe_start(now=1000.0) is False
    assert review.status().auto is False


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
