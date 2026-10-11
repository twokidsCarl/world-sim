"""作业：在临时仓库里用假 claude 和假 pr.sh 测。 / Jobs, tested in a throwaway repository with a fake claude and a fake pr.sh."""

import json
import subprocess

import pytest
from fastapi.testclient import TestClient

import fake_claude as fc
from idea_loom import jobs, tasks, wishes
from idea_loom.server import app

client = TestClient(app)
DONE = {"done": True, "title_zh": "空格画斜线", "title_en": "Hatch empty cells", "summary_zh": "改了地图的样式。", "summary_en": "Changed the map styles.", "not_done": ""}


def git(repo, *args):
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path, monkeypatch, seeded):
    root = tmp_path / "repo"
    data = root / "idea-loom" / "data"
    data.mkdir(parents=True)
    for f in seeded.iterdir():
        if f.is_file():
            (data / f.name).write_bytes(f.read_bytes())
    (root / "idea-loom" / "README.md").write_text("# idea-loom\n")
    (root / "idea-loom" / "src").mkdir()
    (root / "idea-loom" / "src" / "a.py").write_text("x = 1\n")
    (root / "other.txt").write_text("别的项目的文件\n")
    tools = root / "tools"
    tools.mkdir()
    (tools / "pr.sh").write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$(dirname "$0")/args.txt"\nprintf "%s" "$PR_BODY" > "$(dirname "$0")/body.txt"\n'
                                 'if [ -n "$FAKE_PR_FAIL" ]; then echo "还没有合并（状态: OPEN）。" >&2; exit 1; fi\necho "PR: https://example.test/pull/12"\necho "已合并。"\n')
    (tools / "pr.sh").chmod(0o755)
    (root / ".gitignore").write_text("runs/\ntools/args.txt\ntools/body.txt\n")
    git(root, "init", "-q", "-b", "main")
    git(root, "add", "-A")
    git(root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init")
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD")
    monkeypatch.setenv("IDEA_LOOM_DATA", str(data))
    monkeypatch.setenv("IDEA_LOOM_REPO", str(root))
    monkeypatch.setenv("IDEA_LOOM_JOBS_INPLACE", "1")  # 这些测试测的是就地改的老做法；工作区的做法在 test_worker.py / these test the old in-place path; workspaces are covered in test_worker.py
    monkeypatch.setattr(jobs, "_spawn", lambda job, phase: jobs.main([phase, job.job_id]))  # 同步跑，测试才确定 / run in-process for determinism
    monkeypatch.setattr(jobs, "_commands", lambda directory: [])
    fc.install_stream(tmp_path, monkeypatch, [fc.tool_use("t1", "Read", {"file_path": "x"}), fc.tool_result("t1"), fc.text_delta("1. 理解：空格不显眼。\n2. 改 `idea-loom/src/a.py`。"), fc.result()])
    monkeypatch.setenv("FAKE_STREAM_EXEC", json.dumps([fc.text_delta("```json\n" + json.dumps(DONE, ensure_ascii=False) + "\n```"), fc.result()], ensure_ascii=False))
    monkeypatch.setenv("FAKE_WRITES", json.dumps({"idea-loom/src/a.py": "x = 2\n", "idea-loom/src/b.py": "y = 1\n"}))
    return root


@pytest.fixture
def wish(repo):
    return wishes.record(title="地图上看不出哪格是空的", kind="unclear", stuck="找了半天", suggestion="空格画斜线", where={"url": "/", "title": "地图"}, question="哪格是空的？")


def test_plan_first_and_nothing_is_written_before_approval(repo, wish):
    job = jobs.start("wish", wish)
    job = jobs.get(job.job_id)
    assert (job.phase, job.directory) == ("plan_ready", "idea-loom")
    assert "改 `idea-loom/src/a.py`" in job.plan
    assert (repo / "idea-loom" / "src" / "a.py").read_text() == "x = 1\n"
    assert wishes.get(wish).status == "open" and wishes.get(wish).links[0].kind == "job"
    call = fc.calls(repo.parent / "calls.jsonl")[0]
    argv = call["argv"]
    assert argv[argv.index("--tools") + 1] == "Read,Grep,Glob" and "dontAsk" in argv
    assert "地图上看不出哪格是空的" in call["stdin"] and "现在只调研和写方案，不动手" in call["stdin"]
    assert [e["type"] for e in jobs.events(job.job_id)] == ["note", "step", "step", "plan"]


def test_in_place_mode_still_runs_one_job_per_directory(repo, wish):
    jobs.start("wish", wish)
    other = wishes.record(title="另一条", kind="other", stuck="", suggestion="")
    with pytest.raises(jobs.JobError, match="同时只跑一个"):
        jobs.start("wish", other)


def test_the_same_wish_cannot_be_started_twice(repo, wish):
    first = jobs.start("wish", wish)
    with pytest.raises(jobs.JobError, match=first.job_id):
        jobs.start("wish", wish)


def test_revise_carries_the_feedback(repo, wish):
    job = jobs.start("wish", wish)
    jobs.revise(job.job_id, "不要动 a.py，只改样式")
    second = fc.calls(repo.parent / "calls.jsonl")[1]["stdin"]
    assert "不要动 a.py，只改样式" in second and "上一版" in second
    assert jobs.get(job.job_id).phase == "plan_ready"
    with pytest.raises(jobs.JobError):
        jobs.revise(job.job_id, "  ")


def test_approve_executes_tests_submits_and_reports_back(repo, wish):
    job = jobs.start("wish", wish)
    jobs.approve(job.job_id)
    job = jobs.get(job.job_id)
    assert (job.phase, job.pr, job.restart_needed) == ("merged", 12, True)
    assert sorted(job.changed) == ["idea-loom/src/a.py", "idea-loom/src/b.py"]
    argv = fc.calls(repo.parent / "calls.jsonl")[1]["argv"]
    allowed = argv[argv.index("--allowedTools") + 1:argv.index("--permission-mode")]
    assert "Edit(idea-loom/**)" in allowed and not any(a.startswith(("Bash(git", "Bash(gh")) for a in allowed)
    assert "Bash(uv run --project idea-loom:*)" in allowed and "Bash(bun run --cwd idea-loom/web:*)" in allowed
    stdin = fc.calls(repo.parent / "calls.jsonl")[1]["stdin"]
    assert "不要用 `cd`" in stdin and "被拒绝了不算没做完" in stdin and "哪格是空的？" not in stdin
    assert json.loads(argv[argv.index("--settings") + 1])["permissions"]["deny"][:2] == ["Bash(git:*)", "Bash(gh:*)"]
    args = (repo / "tools" / "args.txt").read_text().splitlines()
    assert args == ["idea-loom: 空格画斜线 / Hatch empty cells", "idea-loom"]
    body = (repo / "tools" / "body.txt").read_text()
    assert "## 中文" in body and "## English" in body and wish in body and "批准的方案" in body
    w = wishes.get(wish)
    assert (w.status, w.pr, w.status_note) == ("done", 12, "改了地图的样式。")
    assert [l.kind for l in w.links] == ["pr", "job"]


def test_cannot_approve_twice_or_with_uncommitted_changes(repo, wish):
    job = jobs.start("wish", wish)
    (repo / "idea-loom" / "src" / "a.py").write_text("x = 99  # 你自己没提交的改动\n")
    with pytest.raises(jobs.JobError, match="还没提交的改动"):
        jobs.approve(job.job_id)
    assert jobs.get(job.job_id).phase == "plan_ready"
    (repo / "idea-loom" / "src" / "a.py").write_text("x = 1\n")
    jobs.approve(job.job_id)
    with pytest.raises(jobs.JobError):
        jobs.approve(job.job_id)


def test_other_sessions_changing_other_directories_do_not_fail_the_job(repo, wish):
    job = jobs.start("wish", wish)
    (repo / "other.txt").write_text("别的会话同时改了别的目录\n")
    jobs.approve(job.job_id)
    assert jobs.get(job.job_id).phase == "merged"
    assert (repo / "tools" / "args.txt").read_text().splitlines()[1:] == ["idea-loom"]  # PR 只含这个目录 / the PR holds this directory only


def test_failed_tests_block_the_pr_and_revert_restores_the_files(repo, wish, monkeypatch):
    monkeypatch.setattr(jobs, "_commands", lambda directory: [["sh", "-c", "echo 2 failed; exit 1"]])
    job = jobs.start("wish", wish)
    jobs.approve(job.job_id)
    job = jobs.get(job.job_id)
    assert job.phase == "failed" and "测试没过" in job.error and "2 failed" in job.test_log
    assert not (repo / "tools" / "args.txt").exists()
    assert sorted(jobs.revert(job.job_id)) == ["idea-loom/src/a.py", "idea-loom/src/b.py"]
    assert (repo / "idea-loom" / "src" / "a.py").read_text() == "x = 1\n" and not (repo / "idea-loom" / "src" / "b.py").exists()
    assert jobs.dirty("idea-loom") == []
    jobs.start("wish", wish)  # 目录让出来了 / the directory is free again


def test_unmerged_pr_and_agent_saying_not_done(repo, wish, monkeypatch):
    monkeypatch.setenv("FAKE_PR_FAIL", "1")
    job = jobs.start("wish", wish)
    jobs.approve(job.job_id)
    assert "PR 没有合并" in jobs.get(job.job_id).error
    jobs.revert(job.job_id)
    monkeypatch.delenv("FAKE_PR_FAIL")
    # 它说"没法亲自验证"不算失败：以程序重跑的测试为准，没做的部分写进 PR。
    # "Could not verify it myself" is not a failure: the runner's tests decide, and what was left goes into the PR body.
    monkeypatch.setenv("FAKE_STREAM_EXEC", json.dumps([fc.text_delta(json.dumps({"done": False, "title_zh": "空格画斜线", "not_done": "没有在浏览器里看"}, ensure_ascii=False)), fc.result()], ensure_ascii=False))
    job = jobs.start("wish", wish)
    jobs.approve(job.job_id)
    assert jobs.get(job.job_id).phase == "merged"
    assert "它说没做的部分：没有在浏览器里看" in (repo / "tools" / "body.txt").read_text()


def test_decline_and_task_jobs(repo):
    tid = tasks.create(project="idea-loom", title="加一个导出按钮", brief="导出成 CSV", idea_id="1.1")
    job = jobs.start("task", tid)
    assert tasks.get(tid).status == "plan_ready" and tasks.get(tid).job_id == job.job_id
    assert "1.1 往上走一层" in jobs.get(job.job_id).what
    jobs.decline(job.job_id, "先不做")
    assert jobs.get(job.job_id).phase == "declined" and tasks.get(tid).status == "todo"
    job = jobs.start("task", tid)
    jobs.approve(job.job_id)
    t = tasks.get(tid)
    assert (t.status, t.pr, t.pr_url) == ("merged", 12, "https://example.test/pull/12")
    with pytest.raises(jobs.JobError):
        jobs.start("task", tid)


def test_a_dead_runner_is_reaped(repo, wish, monkeypatch):
    monkeypatch.setattr(jobs, "_spawn", lambda job, phase: None)
    job = jobs.start("wish", wish)
    stale = jobs.get(job.job_id)
    stale.pid = 999999
    jobs.save(stale)
    raw = json.loads((jobs._dir(job.job_id) / "job.json").read_text())
    raw["updated_at"] = "2026-01-01T00:00:00+00:00"
    (jobs._dir(job.job_id) / "job.json").write_text(json.dumps(raw))
    assert jobs.listing()[0].phase == "failed" and "进程不在了" in jobs.get(job.job_id).error


def test_api(repo, wish):
    r = client.post("/api/jobs", json={"kind": "wish", "ref": wish})
    assert r.status_code == 200
    jid = r.json()["job_id"]
    view = client.get(f"/api/jobs/{jid}").json()
    assert view["job"]["phase_label"] == "方案待批" and view["events"][-1]["type"] == "plan"
    assert client.get(f"/api/jobs/{jid}?after=3").json()["events"][0]["seq"] == 4
    assert client.post(f"/api/jobs/{jid}/revert").status_code == 409
    assert client.post(f"/api/jobs/{jid}/approve").json()["phase"] == "running" or client.get(f"/api/jobs/{jid}").json()["job"]["phase"] == "merged"
    assert client.get("/api/jobs").json()[0]["job_id"] == jid
    assert client.post("/api/jobs", json={"kind": "wish", "ref": "nope"}).status_code == 409


def test_failing_tests_go_back_to_claude_for_repair(repo, wish, monkeypatch):
    marker = repo.parent / "fixed"
    # 第一次跑测试失败，修过之后通过。 / The tests fail the first time and pass after the repair.
    monkeypatch.setattr(jobs, "_commands", lambda directory: [["sh", "-c", f'if [ -f "{marker}" ]; then echo ok; else echo "1 failed: a.py"; exit 1; fi']])
    job = jobs.start("wish", wish)
    real = jobs._claude

    def claude(job, prompt, tools, allowed, limit):
        if "没有通过" in prompt:
            marker.write_text("x")
        return real(job, prompt, tools, allowed, limit)

    monkeypatch.setattr(jobs, "_claude", claude)
    jobs.approve(job.job_id)
    done = jobs.get(job.job_id)
    assert (done.phase, done.repairs) == ("merged", 1)
    repair = fc.calls(repo.parent / "calls.jsonl")[2]["stdin"]
    assert "1 failed: a.py" in repair and "idea-loom/src/a.py" in repair and "不要为了让它过而删掉" in repair


def test_repair_gives_up_after_two_rounds(repo, wish, monkeypatch):
    monkeypatch.setattr(jobs, "_commands", lambda directory: [["sh", "-c", "echo still failing; exit 1"]])
    job = jobs.start("wish", wish)
    jobs.approve(job.job_id)
    done = jobs.get(job.job_id)
    assert done.phase == "failed" and done.repairs == 2 and "已经让它修了 2 轮" in done.error
    assert not (repo / "tools" / "args.txt").exists()


def test_resume_continues_a_failed_job_from_the_tests(repo, wish, monkeypatch):
    monkeypatch.setenv("FAKE_PR_FAIL", "1")
    job = jobs.start("wish", wish)
    jobs.approve(job.job_id)
    assert jobs.get(job.job_id).phase == "failed"
    calls_before = len(fc.calls(repo.parent / "calls.jsonl"))
    monkeypatch.delenv("FAKE_PR_FAIL")
    jobs.resume(job.job_id)
    done = jobs.get(job.job_id)
    assert (done.phase, done.pr) == ("merged", 12)
    assert len(fc.calls(repo.parent / "calls.jsonl")) == calls_before  # 没有再叫 Claude / Claude was not called again
    assert wishes.get(wish).status == "done"
    with pytest.raises(jobs.JobError):
        jobs.resume(job.job_id)


def test_denied_operations_are_kept_for_the_owner_to_see(repo, wish, monkeypatch):
    denied = dict(fc.result())
    denied["permission_denials"] = [{"tool_name": "Bash", "tool_input": {"command": "cd idea-loom/web && npm run typecheck"}}]
    monkeypatch.setenv("FAKE_STREAM_EXEC", json.dumps([fc.text_delta(json.dumps(DONE, ensure_ascii=False)), denied], ensure_ascii=False))
    job = jobs.start("wish", wish)
    jobs.approve(job.job_id)
    assert jobs.get(job.job_id).denied == ["Bash: cd idea-loom/web && npm run typecheck"]


def test_a_passing_error_while_submitting_is_retried_not_fatal(repo, wish, monkeypatch):
    """提交时别的会话正好也在更新仓库：git 报锁冲突。等一下重来就好，不该让整个作业失败。

    Another session updates the repository just as the job submits and git reports a lock conflict. Waiting and retrying fixes it; the whole job must not fail.
    """
    monkeypatch.setattr(jobs, "SUBMIT_WAIT", 0)
    (repo / "tools" / "pr.sh").write_text('#!/bin/sh\nn=$(cat "$(dirname "$0")/n" 2>/dev/null || echo 0)\necho $((n+1)) > "$(dirname "$0")/n"\n'
                                          "if [ \"$n\" -lt 2 ]; then echo \"error: cannot lock ref 'refs/remotes/origin/main': is at 21 but expected 2a\" >&2; exit 1; fi\n"
                                          'echo "PR: https://example.test/pull/12"\necho "已合并。"\n')
    (repo / ".gitignore").write_text("runs/\ntools/n\n")
    git(repo, "add", "-A")
    git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "pr")
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    job = jobs.start("wish", wish)
    jobs.approve(job.job_id)
    job = jobs.get(job.job_id)
    assert (job.phase, job.pr) == ("merged", 12) and (repo / "tools" / "n").read_text().strip() == "3"
    assert len([e for e in jobs.events(job.job_id) if "一闪而过" in e.get("text", "")]) == 2
    assert jobs.transient("fatal: unable to access: Operation timed out") and not jobs.transient("error: 测试没过") and not jobs.transient("还没有合并（状态: OPEN）。")


def test_the_wish_list_shows_the_stage_of_the_job_working_on_it(repo, wish):
    """愿望自己的状态要到方案批准才变；在那之前，列表靠作业的阶段告诉人它已经有人在做了。

    A wish's own status only changes once the plan is approved; until then the list relies on the job's stage to say that it is being worked on.
    """
    def row(wish_id):
        return next(w for w in client.get("/api/wishes").json()["wishes"] if w["wish_id"] == wish_id)

    idle = wishes.record(title="没人在做的一条", kind="other", stuck="", suggestion="")
    assert (row(wish)["job_phase"], row(wish)["job_label"], row(wish)["job_id"]) == (None, None, None)
    job = jobs.start("wish", wish)
    got = row(wish)
    assert (got["status"], got["job_phase"], got["job_label"], got["job_id"], got["job_queued"]) == ("open", "plan_ready", "方案待批", job.job_id, False)
    assert row(idle)["job_phase"] is None
    one = client.get(f"/api/wishes/{wish}").json()
    assert (one["job_phase"], one["job_label"]) == ("plan_ready", "方案待批")
    jobs.cancel(job.job_id)
    assert (row(wish)["job_phase"], row(wish)["job_label"]) == (None, None)
    again = jobs.start("wish", wish)
    jobs.approve(again.job_id)
    assert jobs.get(again.job_id).phase == "merged"
    done = client.get(f"/api/wishes/{wish}").json()
    assert (done["status"], done["job_phase"], done["job_id"]) == ("done", None, None)
