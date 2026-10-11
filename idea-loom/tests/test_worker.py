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
    monkeypatch.delenv("IDEA_LOOM_JOBS_INPLACE", raising=False)
    monkeypatch.setenv("IDEA_LOOM_RETRY_SCALE", "0")
    # 不读这台机器上的 git 配置，测试才和谁在跑无关。 / Do not read this machine's git configuration, so the tests do not depend on who runs them.
    (tmp_path / "gitconfig").write_text("")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "gitconfig"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
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


def test_plans_run_in_parallel_but_execution_queues_behind_the_previous_job(cloud, wish, tmp_path):  # noqa: F811
    other_wish = wishes.record(title="另一条", kind="other", stuck="", suggestion="")
    first, second = jobs.start("wish", wish), jobs.start("wish", other_wish)
    with pytest.raises(jobs.JobError, match=first.job_id):
        jobs.start("wish", wish)                       # 同一条愿望不重复开 / the same wish is not started twice
    cloud("worker")
    w = worker.Worker()
    assert sorted(w.tick()) == sorted([first.job_id, second.job_id])   # 两个方案都出得来 / both plans get written
    w.running.clear()
    cloud("hub")
    assert jobs.approve(first.job_id).queued == "execute"
    queued = jobs.approve(second.job_id)
    assert queued.queued == "execute" and queued.waiting is None       # 第一个还只是排着，没在动手 / the first is only queued, not working yet
    cloud("worker")
    assert w.tick() == [first.job_id] and jobs.get(first.job_id).phase == "merged"
    held = jobs.get(second.job_id)                                     # 第二个等第一个，原因写出来 / the second waits for the first, with the reason
    assert held.queued == "execute" and "等《" in (held.waiting or "")
    w.running.clear()
    assert w.tick() == [second.job_id] and jobs.get(second.job_id).phase == "merged"


def test_hold_names_the_job_in_the_same_directory_that_is_waiting_for_its_merge(cloud, wish):  # noqa: F811
    first = jobs.start("wish", wish)
    second = jobs.start("wish", wishes.record(title="另一条", kind="other", stuck="", suggestion=""))
    jobs.save(jobs.get(first.job_id).model_copy(update={"phase": "pr", "queued": None}))
    queued = jobs.get(second.job_id).model_copy(update={"phase": "running", "queued": "execute"})
    jobs.save(queued)
    w = worker.Worker()
    reason = w._hold(queued, jobs.listing())
    assert reason and "等《" in reason
    plan = jobs.get(second.job_id).model_copy(update={"phase": "planning", "queued": "plan"})
    assert w._hold(plan, jobs.listing()) is None       # 出方案不受影响 / planning is not held


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


def test_the_worker_exports_the_database_to_the_repository_and_keeps_what_others_committed(cloud, repo, tmp_path, monkeypatch):  # noqa: F811
    from idea_loom import cloud as bootstrap
    from idea_loom import edits, ideas, store

    (repo / "IDEAS.md").write_text("# IDEAS\n")           # 没有标记的文件不会被改写 / a file without the markers is left alone
    extra = '{"at": "2026-01-02T00:00:00+00:00", "body": "别的会话提交的。", "by": "human", "event": "created", "id": "2.1", "level": "L2", "title": "别处来的"}\n'
    with (repo / "idea-loom" / "data" / "ideas.jsonl").open("a", encoding="utf-8") as f:
        f.write(extra)
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "another session")
    monkeypatch.setenv("IDEA_LOOM_DB", str(tmp_path / "db" / "loom.sqlite"))
    cloud("worker")
    assert worker.export_pool() is None                    # 库是空的时候先并进 main 上的，没有可导出的 / an empty database first takes in main; nothing to export
    assert "2.1" in ideas.current()[0]
    new_id = edits.create(title="云端写的", body="在手机上想到的。", level="L2")
    assert new_id == "2.2"
    assert worker.export_pool() == "https://example.test/pull/34"
    create = [c for c in gh_calls(tmp_path) if c["argv"][:2] == ["pr", "create"]][-1]
    title = create["argv"][create["argv"].index("--title") + 1]
    assert title == "ideas: 同步想法池（1 处改动）/ sync the idea pool (1 change)" and create["has_token"]
    branch = create["argv"][create["argv"].index("--head") + 1]
    pushed = subprocess.run(["git", "-C", str(repo), "show", f"{branch}:idea-loom/data/ideas.jsonl"], capture_output=True, text=True).stdout
    assert pushed == store.export_text("ideas") and pushed.count("\n") == 6 and "别处来的" in pushed and "云端写的" in pushed
    stat = subprocess.run(["git", "-C", str(repo), "show", "--stat", "--format=", branch], capture_output=True, text=True).stdout
    assert "idea-loom/data/ideas.jsonl" in stat and "other.txt" not in stat and "IDEAS.md" not in stat
    assert not (tmp_path / "work" / "sync").exists()
    w = worker.Worker()
    assert w.maybe_export() is False                       # 还没到时间 / not due yet
    w.exported_at -= worker.EXPORT_EVERY
    assert w.maybe_export() is True
    w.exporting.join(timeout=20)
    assert bootstrap.import_from_main(repo=worker.clone()) == {"ideas": 0}


def test_a_local_job_works_in_its_own_worktree_and_syncs_back_into_the_shared_directory(cloud, repo, wish, tmp_path, monkeypatch):  # noqa: F811
    """本机：作业不在共用目录里改。别人同时在那里改的文件不算它的；合并后它的改动回到那里，同一个文件两边都改了就合并。

    Locally a job does not edit in the shared directory. Files others change there meanwhile are not counted as its own; after the merge its changes return there, and a file changed on both sides is merged.
    """
    monkeypatch.delenv("IDEA_LOOM_ROLE")          # 本机：一个进程什么都做 / local: one process does everything
    monkeypatch.delenv("IDEA_LOOM_WORK")
    monkeypatch.delenv("GH_TOKEN")
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    origin = tmp_path / "origin.git"
    subprocess.run(["git", "clone", "-q", "--bare", str(repo), str(origin)], check=True)
    git(repo, "remote", "add", "origin", str(origin))
    git(repo, "fetch", "-q", "origin")
    (repo / "idea-loom" / "src" / "c.py").write_text("line 1\nline 2\nline 3\nline 4\nline 5\n")
    (repo / "idea-loom" / "src" / "d.py").write_text("d = 1\n")
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "more")
    git(repo, "push", "-q", "origin", "HEAD:main")
    git(repo, "fetch", "-q", "origin")
    monkeypatch.setenv("FAKE_WRITES", json.dumps({"idea-loom/src/a.py": "x = 2\n", "idea-loom/src/b.py": "y = 1\n",
                                                  "idea-loom/src/c.py": "line 1\nline 2\nline 3\nline 4\nline 5 (job)\n", "idea-loom/src/d.py": "d = 2\n"}))
    job = jobs.start("wish", wish)
    job = jobs.get(job.job_id)
    workspace = worker.work_dir() / "jobs" / job.job_id
    assert job.phase == "plan_ready" and job.workspace == str(workspace) and str(workspace).startswith(str(tmp_path / "cache")) and str(repo) not in str(workspace)   # 在仓库目录外面 / outside the repository directory
    assert os.path.realpath(fc.calls(tmp_path / "calls.jsonl")[0]["cwd"]) == os.path.realpath(workspace)

    # 作业在跑的时候，别的会话在共用目录里改东西。 / While the job runs, other sessions edit the shared directory.
    (repo / "other.txt").write_text("别的项目改到一半\n")
    (repo / "idea-loom" / "src" / "mine.py").write_text("别的会话的新文件\n")
    (repo / "idea-loom" / "src" / "c.py").write_text("line 1 (me)\nline 2\nline 3\nline 4\nline 5\n")   # 同一个文件，不同的地方 / the same file, a different place
    (repo / "idea-loom" / "src" / "d.py").write_text("d = 3\n")                                              # 同一行 / the same line
    jobs.approve(job.job_id)                      # 共用目录里有没提交的改动也不再拦着 / uncommitted changes in the shared directory no longer block it
    job = jobs.get(job.job_id)
    assert (job.phase, job.pr) == ("merged", 34)
    assert sorted(job.changed) == ["idea-loom/src/a.py", "idea-loom/src/b.py", "idea-loom/src/c.py", "idea-loom/src/d.py"]     # 没有 mine.py，没有 other.txt / neither mine.py nor other.txt
    pushed = subprocess.run(["git", "-C", str(origin), "show", "--stat", "--format=%s", f"job/{job.job_id}"], capture_output=True, text=True).stdout
    assert "mine.py" not in pushed and "other.txt" not in pushed and "idea-loom/src/b.py" in pushed
    create = [c for c in gh_calls(tmp_path) if c["argv"][:2] == ["pr", "create"]][0]
    assert create["has_token"] is False           # 本机用已经登录好的 gh，不需要令牌 / locally the signed-in gh is used; no token needed

    # 同步回共用目录。 / Synced back into the shared directory.
    src = repo / "idea-loom" / "src"
    assert (src / "a.py").read_text() == "x = 2\n" and (src / "b.py").read_text() == "y = 1\n"
    assert (src / "c.py").read_text() == "line 1 (me)\nline 2\nline 3\nline 4\nline 5 (job)\n"               # 两边的改动都在 / both sides' changes are there
    assert (src / "d.py").read_text() == "d = 3\n" and job.conflicts == ["idea-loom/src/d.py"]                   # 合不了：留着原样并报告 / unmergeable: left alone and reported
    assert (src / "mine.py").exists() and (repo / "other.txt").read_text() == "别的项目改到一半\n"
    assert any("合不到一起" in e.get("text", "") for e in jobs.events(job.job_id))
    assert not workspace.exists() and jobs.get(job.job_id).workspace is None and job.restart_needed is True

