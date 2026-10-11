"""云端的作业：hub 排队，worker 在独立的工作区里做，推分支、开 PR。用假 claude 和假 gh 测。

Jobs in the cloud: the hub queues, the worker works in a separate workspace, pushes a branch
and opens a PR. Tested with a fake claude and a fake gh.
"""

import json
import os
import subprocess
import sys
import time

import pytest

import fake_claude as fc
from idea_loom import gates, jobs, wishes, worker
from test_jobs import git, repo, wish  # noqa: F401 — 夹具 / fixtures

GH = '''#!{python}
import json, os, sys
with open(os.environ["FAKE_GH_LOG"], "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "has_token": bool(os.environ.get("GH_TOKEN")), "cwd": os.getcwd()}}) + "\\n")
if sys.argv[1:3] == ["pr", "create"]:
    print("https://example.test/pull/34")
elif sys.argv[1:3] == ["pr", "view"]:
    print(json.dumps({{"state": os.environ.get("FAKE_PR_STATE", "MERGED")}}))
'''


@pytest.fixture
def cloud(repo, tmp_path, monkeypatch):  # noqa: F811
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    (bin_dir / "gh").write_text(GH.format(python=sys.executable))
    (bin_dir / "gh").chmod(0o755)
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_GH_LOG", str(tmp_path / "gh.jsonl"))
    monkeypatch.setenv("IDEA_LOOM_WORK", str(tmp_path / "work"))
    monkeypatch.setenv("IDEA_LOOM_REPO_URL", str(repo))
    monkeypatch.setenv("GH_TOKEN", "push-credential")
    monkeypatch.setenv("IDEA_LOOM_MERGE_POLL", "0")
    monkeypatch.setattr(jobs, "_commands", lambda directory, repo=None: [])

    def spawn(job, phase):  # 同步跑 / run in-process
        job.queued, job.waiting = None, None
        jobs.save(job)
        jobs.main([phase, job.job_id])

    monkeypatch.setattr(jobs, "_spawn", spawn)

    def as_role(name):
        monkeypatch.setenv("IDEA_LOOM_ROLE", name)

    as_role("hub")
    return as_role


def gh_calls(tmp_path):
    return [json.loads(line) for line in (tmp_path / "gh.jsonl").read_text().splitlines()]


def test_hub_only_queues_and_the_worker_does_the_work_in_its_own_workspace(cloud, repo, wish, tmp_path):  # noqa: F811
    job = jobs.start("wish", wish)
    assert (job.phase, job.queued) == ("planning", "plan") and fc.calls(tmp_path / "calls.jsonl") == []
    time.sleep(0.01)
    assert jobs.reap(jobs.get(job.job_id)).phase == "planning"       # 排着队的不会被当成"进程不在了" / a queued job is not mistaken for a dead one

    cloud("worker")
    w = worker.Worker()
    assert w.tick() == [job.job_id]
    job = jobs.get(job.job_id)
    workspace = tmp_path / "work" / "jobs" / job.job_id
    assert (job.phase, job.queued, job.workspace, job.branch) == ("plan_ready", None, str(workspace), f"job/{job.job_id}")
    call = fc.calls(tmp_path / "calls.jsonl")[0]
    assert os.path.realpath(call["cwd"]) == os.path.realpath(workspace)
    assert call["has_push_token"] is False and call["scrub"] == "1"   # 推送凭证不给 Claude / the push credential is kept from Claude
    assert w.tick() == []                                              # 等批准，不会自己往下走 / waits for approval

    cloud("hub")
    assert jobs.approve(job.job_id).queued == "execute"
    cloud("worker")
    assert w.tick() == [job.job_id]
    job = jobs.get(job.job_id)
    assert (job.phase, job.pr, job.pr_url, job.restart_needed) == ("merged", 34, "https://example.test/pull/34", False)
    assert sorted(job.changed) == ["idea-loom/src/a.py", "idea-loom/src/b.py"]

    # 分支推到了远端，提交里只有这个目录的改动。 / The branch reached the remote and the commit holds this directory's changes only.
    shown = subprocess.run(["git", "-C", str(repo), "show", "--stat", "--format=%an%n%s%n%b", f"job/{job.job_id}"], capture_output=True, text=True).stdout
    assert shown.startswith("idea-loom\nidea-loom: 空格画斜线 / Hatch empty cells") and "idea-loom/src/b.py" in shown and "other.txt" not in shown
    assert "方案经仓库主人批准后执行" in shown and "re-ran the tests" in shown
    create, view = gh_calls(tmp_path)[:2]
    assert create["argv"][:2] == ["pr", "create"] and create["has_token"] and f"job/{job.job_id}" in create["argv"]
    body = create["argv"][create["argv"].index("--body") + 1]
    assert "## 中文" in body and "## English" in body and "### 批准的方案" in body and body.rstrip().endswith("(https://claude.com/claude-code)")
    assert view["argv"][:2] == ["pr", "view"]
    assert wishes.get(wish).status == "done"

    # 共用的那份仓库目录没被动过；合并之后工作区和本地分支都清掉。
    # The shared repository directory was not touched; after the merge the workspace and the local branch are gone.
    assert (repo / "idea-loom" / "src" / "a.py").read_text() == "x = 1\n" and not (repo / "idea-loom" / "src" / "b.py").exists()
    assert w.tick() == [] and not workspace.exists() and jobs.get(job.job_id).workspace is None
    assert subprocess.run(["git", "-C", str(tmp_path / "work" / "repo"), "branch", "--list", "job/*"], capture_output=True, text=True).stdout.strip() == ""


def test_a_pr_that_does_not_merge_fails_the_job_and_keeps_the_workspace_for_resuming(cloud, wish, tmp_path, monkeypatch):  # noqa: F811
    job = jobs.start("wish", wish)
    cloud("worker")
    w = worker.Worker()
    w.tick()
    cloud("hub")
    jobs.approve(job.job_id)
    cloud("worker")
    monkeypatch.setenv("FAKE_PR_STATE", "CLOSED")
    w.tick()
    job = jobs.get(job.job_id)
    assert job.phase == "failed" and "没有合并" in (job.error or "") and job.pr == 34
    w.tick()
    assert (tmp_path / "work" / "jobs" / job.job_id / "idea-loom" / "src" / "b.py").exists()   # 留着 / kept
    cloud("hub")
    with pytest.raises(jobs.JobError, match="不需要还原"):
        jobs.revert(job.job_id)
    assert jobs.resume(job.job_id).queued == "finish"
    cloud("worker")
    monkeypatch.setenv("FAKE_PR_STATE", "MERGED")
    assert w.tick() == [job.job_id] and jobs.get(job.job_id).phase == "merged"
    assert len(fc.calls(tmp_path / "calls.jsonl")) == 2      # 接着做不再调用模型 / resuming does not call the model again


def test_cancelling_a_queued_job_means_it_never_starts(cloud, wish, tmp_path):  # noqa: F811
    job = jobs.start("wish", wish)
    assert jobs.cancel(job.job_id).queued is None
    cloud("worker")
    assert worker.Worker().tick() == [] and fc.calls(tmp_path / "calls.jsonl") == []


def test_daily_cap_and_allowance_pause_hold_the_queue(cloud, wish, monkeypatch):  # noqa: F811
    monkeypatch.setenv("IDEA_LOOM_JOBS_PER_DAY", "1")
    job = jobs.start("wish", wish)
    cloud("worker")
    w = worker.Worker()
    w.tick()
    gates.note_start("an-earlier-job")
    cloud("hub")
    jobs.approve(job.job_id)
    cloud("worker")
    assert w.tick() == []
    held = jobs.get(job.job_id)
    assert (held.phase, held.queued) == ("running", "execute") and "每天的上限（1）" in (held.waiting or "")
    assert [e["text"] for e in jobs.events(job.job_id) if e["type"] == "note"][-1].startswith("还没轮到：今天已经开工了 1 个作业")
    w.tick()
    assert len([e for e in jobs.events(job.job_id) if e.get("text", "").startswith("还没轮到")]) == 1   # 同一个原因只说一次 / the same reason is said once
    monkeypatch.setenv("IDEA_LOOM_JOBS_PER_DAY", "5")
    soon = time.time() + 3600
    gates.note_usage({"status": "allowed", "resetsAt": soon, "unifiedWindows": {"five_hour": {"utilization": 0.86, "resetsAt": soon}, "seven_day": {"utilization": 0.2, "resetsAt": soon}}})
    assert w.tick() == [] and "five_hour" in (jobs.get(job.job_id).waiting or "") and "86%" in jobs.get(job.job_id).waiting
    assert gates.paused(now=soon + 1) is None                  # 窗口过去了就不再停 / once the window has reset nothing is held
    gates.note_usage({"status": "allowed", "resetsAt": soon, "unifiedWindows": {"five_hour": {"utilization": 0.3, "resetsAt": soon}}})
    assert w.tick() == [job.job_id] and jobs.get(job.job_id).phase == "merged"
    assert worker.status()["started_today"] == 2


def test_the_allowance_reported_by_the_cli_is_recorded(cloud, wish, monkeypatch, tmp_path):  # noqa: F811
    limit = {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "resetsAt": time.time() + 60, "rateLimitType": "five_hour",
                                                             "unifiedWindows": {"five_hour": {"utilization": 0.34, "resetsAt": time.time() + 60}}}}
    fc.install_stream(tmp_path, monkeypatch, [limit, fc.text_delta("1. 方案。"), fc.result()])
    jobs.start("wish", wish)
    cloud("worker")
    worker.Worker().tick()
    assert gates.usage()["windows"]["five_hour"]["utilization"] == 0.34 and gates.paused() is None
