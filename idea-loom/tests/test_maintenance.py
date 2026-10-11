"""定时维护和连续推进：用假 claude、假 gh、本地的远端仓库测。

Scheduled maintenance and chains, tested with a fake claude, a fake gh and a local remote.
"""

import json
import time

import pytest

import fake_claude as fc
from idea_loom import chains, gates, jobs, maintenance, tasks, worker
from test_jobs import DONE, git, repo, wish  # noqa: F401 — 夹具 / fixtures
from test_worker import cloud, gh_calls  # noqa: F401


@pytest.fixture
def quiet(cloud, repo, monkeypatch):  # noqa: F811
    """一个安静的仓库：最近没有提交，维护是开着的。 / A quiet repository: no recent commits and maintenance switched on."""
    old = "2026-01-01T00:00:00"
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--amend", "--no-edit", "--date", old)
    monkeypatch.setenv("GIT_COMMITTER_DATE", old)
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--amend", "--no-edit", "--date", old)
    monkeypatch.delenv("GIT_COMMITTER_DATE")
    monkeypatch.setenv("IDEA_LOOM_MAINTENANCE", "1")
    cloud("worker")
    return worker.Worker()


def run_until_idle(w, limit=8):
    for _ in range(limit):
        w.maintained_at = 0.0
        if not w.tick() and not any(j.queued or j.phase in jobs.ACTIVE for j in jobs.listing()):
            break


def test_it_stays_off_unless_switched_on_and_waits_for_a_quiet_repository(quiet, monkeypatch):
    w = quiet
    worker.ensure_clone()
    monkeypatch.setenv("IDEA_LOOM_MAINTENANCE", "0")
    assert maintenance.due(worker.clone()) == "没有打开" and w.maybe_maintain([]) is None
    monkeypatch.setenv("IDEA_LOOM_MAINTENANCE", "1")
    monkeypatch.setenv("IDEA_LOOM_MAINTENANCE_BELOW", "0")
    assert "不算少" in maintenance.due(worker.clone())
    monkeypatch.setenv("IDEA_LOOM_MAINTENANCE_BELOW", "5")
    assert maintenance.due(worker.clone()) is None
    assert maintenance.pick(worker.clone()) == "docs:idea-loom"          # 清单的第一项，最久没维护的目录 / first item, the directory maintained longest ago
    maintenance.record("docs", "idea-loom", "j1")
    assert maintenance.due(worker.clone()) == "上一次维护还不到一小时"
    assert maintenance.pick(worker.clone()).split(":")[0] == "review"     # 清单轮着来 / the list rotates


def test_documents_only_is_tier_a_and_merges_by_itself(quiet, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_WRITES", json.dumps({"idea-loom/README.md": "# idea-loom\n\n改对了的说明。\n"}))
    w = quiet
    run_until_idle(w)
    (job,) = jobs.listing()
    assert (job.kind, job.ref, job.phase, job.tier, job.pr) == ("maintenance", "docs:idea-loom", "merged", "A", 34)
    create = [c for c in gh_calls(tmp_path) if c["argv"][:2] == ["pr", "create"]][0]
    assert "--draft" not in create["argv"]
    body = create["argv"][create["argv"].index("--body") + 1]
    assert "无人值守的定时维护" in body and "只改了文档" in body and "unattended scheduled maintenance" in body and "批准的方案" not in body
    first = fc.calls(tmp_path / "calls.jsonl")[0]["stdin"]
    assert "文档一致性" in first and "没有值得改的就什么都不要改" in first
    assert [e["text"] for e in jobs.events(job.job_id) if e["type"] == "note" and "事先批准" in e["text"]]   # 没等人批 / it did not wait for approval
    assert [r["item"] for r in maintenance.history()] == ["docs"]
    run_until_idle(w)
    assert len(jobs.listing()) == 1                                       # 一小时内不会再开一次 / no second run within the hour


def test_anything_else_is_tier_b_a_draft_that_waits_for_the_owner(quiet, tmp_path):
    w = quiet                                                             # 假 claude 默认改的是 src/ 下的代码 / the fake claude edits code under src/ by default
    run_until_idle(w)
    (job,) = jobs.listing()
    assert (job.phase, job.tier, job.pr_url) == ("review", "B", "https://example.test/pull/34")
    calls = gh_calls(tmp_path)
    assert "--draft" in calls[0]["argv"] and all(c["argv"][:2] != ["pr", "view"] for c in calls)   # 草稿，不等合并 / a draft; no waiting for a merge
    body = calls[0]["argv"][calls[0]["argv"].index("--body") + 1]
    assert "开成草稿，等仓库主人看过再合并" in body
    assert worker.status()["review"] == [{"job_id": job.job_id, "title": job.title, "pr_url": job.pr_url}]
    assert maintenance.tier(["a/README.md", "a/docs/x.MD"]) == "A" and maintenance.tier(["a/README.md", "a/x.py"]) == "B" and maintenance.tier([]) == "B"


def test_finding_nothing_to_change_is_a_normal_result(quiet, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_WRITES", "{}")
    w = quiet
    run_until_idle(w)
    (job,) = jobs.listing()
    assert job.phase == "clean" and job.error is None and gh_calls_or_none(tmp_path) == []


def gh_calls_or_none(tmp_path):
    return gh_calls(tmp_path) if (tmp_path / "gh.jsonl").exists() else []


def test_maintenance_gives_way_to_other_jobs_and_to_the_gates(quiet, wish, monkeypatch):  # noqa: F811
    w = quiet
    monkeypatch.setenv("IDEA_LOOM_ROLE", "hub")
    mine = jobs.start("wish", wish)
    monkeypatch.setenv("IDEA_LOOM_ROLE", "worker")
    w.tick()
    w.maintained_at = 0.0
    assert w.maybe_maintain(jobs.listing()) is None                        # 有主人的作业在等批准 / an owner's job is waiting for approval
    jobs.cancel(mine.job_id)
    soon = time.time() + 3600
    gates.note_usage({"status": "allowed", "resetsAt": soon, "unifiedWindows": {"seven_day": {"utilization": 0.95, "resetsAt": soon}}})
    w.maintained_at = 0.0
    assert w.maybe_maintain(jobs.listing()) is None                        # 额度到线 / the allowance is at the threshold


def test_a_chain_runs_its_steps_without_asking_and_stops_when_one_fails(quiet, tmp_path, monkeypatch):
    w = quiet
    monkeypatch.setenv("IDEA_LOOM_MAINTENANCE", "0")
    with pytest.raises(ValueError, match="没有这个子项目"):
        chains.approve("nowhere", 2)
    with pytest.raises(ValueError, match="步数"):
        chains.approve("strata", 99)
    assert chains.approve("strata", 1) == {"strata": 1}
    made = []

    def propose(directory, repo=None):
        made.append(tasks.create(project=directory, title=f"第 {len(made) + 1} 步", brief="做一件小事。"))
        return made[-1]

    monkeypatch.setattr(chains, "propose", propose)
    monkeypatch.setenv("FAKE_WRITES", json.dumps({"strata/src/a.ts": "export const a = 1\n"}))
    run_until_idle(w)
    first = jobs.listing()[-1]
    assert (first.kind, first.chain, first.phase, first.directory) == ("task", True, "merged", "strata") and tasks.get(made[0]).status == "merged"
    body = [c for c in gh_calls(tmp_path) if c["argv"][:2] == ["pr", "create"]][0]["argv"]
    assert "事先批准的连续推进里的一步" in body[body.index("--body") + 1]
    w.tick()
    assert chains.load() == {} and len(made) == 1                          # 步数用完就结束 / it ends when the steps run out

    chains.approve("strata", 3)
    monkeypatch.setenv("FAKE_PR_STATE", "CLOSED")                          # 第二步没做成 / the second step fails
    run_until_idle(w)
    assert len(made) == 2 and sorted(j.phase for j in jobs.listing()) == ["failed", "merged"]
    w.tick()
    assert chains.load() == {} and len(made) == 2                          # 这条线停了，不会再提议第三步 / the chain stopped; no third step is proposed
    assert chains.approve("strata", 0) == {}
