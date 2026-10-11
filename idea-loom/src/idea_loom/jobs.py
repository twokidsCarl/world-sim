"""作业：从界面触发 Claude Code 去做一条愿望或一个开发任务。

    出方案中 → 方案待批 →（你批准）→ 执行中 → 测试 → PR → 已合并
                        ↘ 提意见重写 / 不做          ↘ 失败（可以还原）

出方案时 Claude 只有读文件的工具。批准之后才另起一次，给它写 `<目录>/` 的权限和跑测试的
命令，不给 git 和 gh。它结束后由这里自己跑测试、检查有没有改到目录外面、调用 tools/pr.sh。
每个阶段在一个独立的进程里跑，状态都写在 runs/jobs/<编号>/ 下，所以后端重启不影响它。

Jobs: trigger Claude Code from the UI to do a wish or a development task. While
planning, Claude only has read tools. Only after approval does a second run get write
access to `<directory>/` and the test commands, and never git or gh. When it finishes,
this module runs the tests itself, checks that nothing outside the directory changed,
and calls tools/pr.sh. Each phase runs in its own process with all state on disk under
runs/jobs/<id>/, so a backend restart does not affect it.
"""

from __future__ import annotations

import json
import os
import secrets
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

from . import llm, ops, store, tasks, wishes
from .assistant.stream import StreamParser

Phase = Literal["planning", "plan_ready", "running", "testing", "pr", "merged", "failed", "cancelled", "declined"]
PHASE_LABELS: dict[str, str] = {
    "planning": "出方案中", "plan_ready": "方案待批", "running": "执行中", "testing": "跑测试", "pr": "开 PR、等合并",
    "merged": "已合并", "failed": "失败", "cancelled": "取消", "declined": "不做",
}
ACTIVE = ("planning", "running", "testing", "pr")
HOLDING = ACTIVE + ("plan_ready",)  # 占着目录的阶段 / phases that hold the directory
LIMIT_SECONDS = {"planning": 900, "running": 3600}
MAX_REPAIRS = 2


class JobError(ValueError):
    """这一步做不了，原因写给人看。 / The step cannot be taken; the message is for a person."""


class Job(BaseModel):
    job_id: str
    kind: Literal["wish", "task"]
    ref: str
    directory: str
    title: str
    what: str  # 交给 Claude 的那段说明 / the brief handed to Claude
    phase: Phase = "planning"
    phase_label: str = "出方案中"
    plan: str = ""
    feedback: list[str] = Field(default_factory=list)
    error: Optional[str] = None
    summary: dict[str, Any] = Field(default_factory=dict)
    changed: list[str] = Field(default_factory=list)
    test_log: str = ""
    denied: list[str] = Field(default_factory=list)  # 被拒绝的操作，给人看它卡在哪 / denied operations, to show where it got stuck
    repairs: int = 0  # 测试没过之后让它修了几轮 / repair rounds after failing tests
    pr: Optional[int] = None
    pr_url: Optional[str] = None
    restart_needed: bool = False
    cost_usd: float = 0
    pid: Optional[int] = None
    created_at: str
    updated_at: str


def root() -> Path:
    return llm.runs_dir() / "jobs"


def now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def model() -> str:
    return os.environ.get("IDEA_LOOM_JOB_MODEL") or llm.default_model()


def _dir(job_id: str) -> Path:
    return root() / job_id


def save(job: Job) -> Job:
    job.updated_at = now()
    job.phase_label = PHASE_LABELS[job.phase]
    store.write_json(_dir(job.job_id) / "job.json", job.model_dump())
    return job


def get(job_id: str) -> Job:
    raw = store.read_json(_dir(job_id) / "job.json", None)
    if raw is None:
        raise JobError("没有这个作业")
    job = Job.model_validate(raw)
    job.phase_label = PHASE_LABELS[job.phase]
    return job


def _alive(pid: Optional[int]) -> bool:
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def reap(job: Job) -> Job:
    """作业进程不在了、状态却还停在进行中：标成失败，把目录让出来。

    The runner process is gone but the job still looks active: mark it failed and free the directory.
    """
    if job.phase in ACTIVE and not _alive(job.pid) and time.time() - datetime.fromisoformat(job.updated_at).timestamp() > 5:
        _fail(job, "作业的进程不在了（可能是机器重启或被手动结束），没有做完。")
        return get(job.job_id)
    return job


def listing() -> list[Job]:
    out = []
    for d in sorted(root().iterdir(), reverse=True) if root().exists() else []:
        try:
            out.append(reap(get(d.name)))
        except (JobError, ValueError):
            continue
    return out


def events(job_id: str, after: int = 0) -> list[dict[str, Any]]:
    rows, _ = store.read_lines(_dir(job_id) / "events.jsonl")
    return [r for r in rows if isinstance(r.get("seq"), int) and r["seq"] > after]


def _emit(job_id: str, event: dict[str, Any]) -> None:
    path = _dir(job_id) / "events.jsonl"
    seq = len(store.read_lines(path)[0]) + 1
    store.append(path, [{"seq": seq, "at": now(), **event}])


def _say(job_id: str, text: str) -> None:
    _emit(job_id, {"type": "note", "text": text})


# ---------- 开始、批准、取消 / start, approve, cancel ----------


def _brief(kind: str, ref: str) -> tuple[str, str, str]:
    """（目录，标题，交给 Claude 的说明）。 / (directory, title, brief for Claude)."""
    if kind == "wish":
        wish = wishes.get(ref)
        if wish.status not in ("open", "accepted"):
            raise JobError(f"这条愿望已经是「{wish.status_label}」")
        what = (f"idea-loom 许愿池里的一条愿望（{wish.wish_id}），种类：{wish.kind_label}，遇到 {wish.occurrences} 次。\n\n"
                f"**{wish.title}**\n\n卡在哪：{wish.stuck}\n\n建议：{wish.suggestion}\n\n"
                + (f"出在页面：{wish.where.title} {wish.where.url}\n" if wish.where else ""))
        return "idea-loom", wish.title, what
    if kind == "task":
        task = tasks.get(ref)
        if task.status in ("merged", "cancelled"):
            raise JobError(f"这个任务已经是「{task.status_label}」")
        what = f"子项目 `{task.project}` 的一个开发任务。\n\n**{task.title}**\n\n{task.brief}\n"
        if task.idea_id:
            from . import ideas

            idea = ideas.detail(task.idea_id)
            if idea is not None:
                what += f"\n它对应想法池里的这条 idea（{idea.id} {idea.title}）：\n\n{idea.body}\n"
        if not (store.repo_root() / task.project).exists():
            what += (f"\n`{task.project}/` 目录还不存在：这是一个新的子项目。先读根目录 CLAUDE.md 的「新项目」一节和已有的一两个子项目的结构，"
                     "方案只做能独立运行、有测试的最小第一版。\n")
        return task.project, task.title, what
    raise JobError("作业只能对应一条愿望或一个任务")


def _holder(directory: str) -> Optional[Job]:
    return next((j for j in listing() if j.directory == directory and j.phase in HOLDING), None)


def _spawn(job: Job, phase: str) -> None:
    proc = subprocess.Popen([sys.executable, "-m", "idea_loom.jobs", phase, job.job_id], start_new_session=True,
                            stdout=subprocess.DEVNULL, stderr=(_dir(job.job_id) / "runner.log").open("ab"), cwd=store.repo_root())
    job.pid = proc.pid
    save(job)


def start(kind: str, ref: str) -> Job:
    if llm.claude_bin() is None:
        raise JobError("这台机器上找不到 claude 命令")
    directory, title, what = _brief(kind, ref)
    holder = _holder(directory)
    if holder is not None:
        raise JobError(f"`{directory}/` 上已经有一个作业（{holder.title}，{holder.phase_label}），同一个目录同时只跑一个")
    job = Job(job_id=f"job-{time.strftime('%Y%m%d-%H%M%S')}-{secrets.token_hex(2)}", kind=kind, ref=ref, directory=directory,  # type: ignore[arg-type]
              title=title, what=what, created_at=now(), updated_at=now())
    save(job)
    if kind == "wish":
        wishes.add_link(ref, "job", title="出方案", url=f"/work/jobs/{job.job_id}", by="claude-code")
    else:
        tasks.attach_job(ref, job.job_id)
        tasks.set_status(ref, "planning", by="claude-code")
    _say(job.job_id, "开始出方案。这一步 Claude 只读不写。")
    _spawn(job, "plan")
    return job


def revise(job_id: str, feedback: str) -> Job:
    job = get(job_id)
    if job.phase != "plan_ready":
        raise JobError("只有方案待批的时候才能提意见")
    if not feedback.strip():
        raise JobError("要写上你的意见")
    job.feedback.append(feedback.strip())
    job.phase = "planning"
    save(job)
    _say(job_id, f"收到意见，重写方案：{feedback.strip()}")
    _spawn(job, "plan")
    return job


def dirty(directory: str) -> list[str]:
    """目录里相对 origin/main 改过或没跟踪的文件（事件日志这类数据不算）。

    Files in the directory that differ from origin/main or are untracked (data such as event logs excluded).
    """
    repo = store.repo_root()
    out = subprocess.run(["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=all", "--", directory], capture_output=True, text=True).stdout
    files = [line[3:].split(" -> ")[-1].strip('"') for line in out.splitlines() if line.strip()]
    return [f for f in files if not f.startswith(f"{directory}/data/")]


def _outside(directory: str) -> set[str]:
    repo = store.repo_root()
    out = subprocess.run(["git", "-C", str(repo), "status", "--porcelain", "--untracked-files=all"], capture_output=True, text=True).stdout
    files = {line[3:].split(" -> ")[-1].strip('"') for line in out.splitlines() if line.strip()}
    return {f for f in files if not f.startswith(directory + "/")}


def approve(job_id: str) -> Job:
    job = get(job_id)
    if job.phase != "plan_ready":
        raise JobError("只有方案待批的时候才能批准")
    changed = dirty(job.directory)
    if changed:
        raise JobError(f"`{job.directory}/` 里有还没提交的改动（{'、'.join(changed[:4])}{' 等' if len(changed) > 4 else ''}）。先把它们提交或还原，这样作业失败时才能干净地还原。")
    job.phase = "running"
    save(job)
    store.write_json(_dir(job_id) / "outside.json", sorted(_outside(job.directory)))
    if job.kind == "wish":
        if wishes.get(job.ref).status == "open":
            wishes.set_status(job.ref, "accepted", note="方案已批准，开始动手")
    else:
        tasks.set_status(job.ref, "running", by="claude-code")
    _say(job_id, "方案已批准，开始动手。")
    _spawn(job, "execute")
    return job


def decline(job_id: str, reason: str = "") -> Job:
    job = get(job_id)
    if job.phase != "plan_ready":
        raise JobError("只有方案待批的时候才能标为不做")
    job.phase, job.error = "declined", reason.strip() or None
    save(job)
    if job.kind == "task":
        tasks.set_status(job.ref, "todo", note=f"方案没有批准：{reason}".rstrip("："), by="claude-code")
    _say(job_id, "标为不做。" + reason)
    return job


def cancel(job_id: str) -> Job:
    job = get(job_id)
    if job.phase not in HOLDING:
        raise JobError("这个作业已经结束了")
    if job.pid:
        try:
            os.killpg(job.pid, 15)
        except (ProcessLookupError, PermissionError):
            pass
    was_running = job.phase != "plan_ready" and job.phase != "planning"
    job.phase = "cancelled"
    save(job)
    if job.kind == "task":
        tasks.set_status(job.ref, "todo", note="作业取消了", by="claude-code")
    _say(job_id, "已取消。" + ("它改过的文件还在，可以点「还原改动」。" if was_running else ""))
    return job


def resume(job_id: str) -> Job:
    """失败的作业已经改了文件：不重来，直接从"跑测试"接着走到开 PR。

    A failed job that already changed files: instead of starting over, continue from the tests to the PR.
    """
    job = get(job_id)
    if job.phase != "failed":
        raise JobError("只有失败了的作业才能接着做")
    if not dirty(job.directory):
        raise JobError("它没有留下改动，没有可以接着做的。重新出方案吧。")
    holder = _holder(job.directory)
    if holder is not None:
        raise JobError(f"`{job.directory}/` 上已经有另一个作业在进行（{holder.title}）")
    job.phase, job.error = "testing", None
    save(job)
    if job.kind == "task":
        tasks.set_status(job.ref, "running", by="claude-code")
    _say(job_id, "接着做：从跑测试开始。")
    _spawn(job, "finish")
    return job


def revert(job_id: str) -> list[str]:
    """把作业改过的文件还原成 origin/main 上的样子，新建的删掉。只动这个目录、不动数据文件。

    Put the files a job changed back to their origin/main state and delete the ones it
    created. Only this directory is touched, and never the data files.
    """
    job = get(job_id)
    if job.phase not in ("failed", "cancelled"):
        raise JobError("只有失败或取消了的作业才能还原")
    repo = store.repo_root()
    done = []
    for rel in dirty(job.directory):
        shown = subprocess.run(["git", "-C", str(repo), "show", f"origin/main:{rel}"], capture_output=True)
        target = repo / rel
        if shown.returncode == 0:
            target.write_bytes(shown.stdout)
        elif target.exists():
            target.unlink()
        done.append(rel)
    _say(job_id, f"已还原 {len(done)} 个文件。")
    return done


# ---------- 各阶段（在独立进程里跑）/ the phases (each in its own process) ----------


def _commands(directory: str) -> list[list[str]]:
    """这个目录的测试命令，由程序自己跑；也告诉 Claude 可以跑这些。 / The directory's test commands."""
    repo = store.repo_root()
    out: list[list[str]] = []
    if (repo / directory / "pyproject.toml").exists():
        out.append(["uv", "run", "--project", directory, "pytest", "-q", f"{directory}/tests"])
    for sub in (directory, f"{directory}/web"):
        pkg = repo / sub / "package.json"
        if pkg.exists():
            scripts = json.loads(pkg.read_text(encoding="utf-8")).get("scripts", {})
            out += [["bun", "run", "--cwd", sub, name] for name in ("typecheck", "test") if name in scripts]
    return out


def _claude(job: Job, prompt: str, tools: str, allowed: list[str], limit: int) -> StreamParser:
    binary = llm.claude_bin()
    if binary is None:
        raise JobError("找不到 claude 命令")
    deny = {"permissions": {"deny": ["Bash(git:*)", "Bash(gh:*)", "Read(./**/.env)", "Read(./**/.env.*)", "Edit(./**/.env*)"]}}
    argv = [
        binary, "-p", "--output-format", "stream-json", "--verbose", "--model", model(), "--tools", tools, "--allowedTools", *allowed,
        "--permission-mode", "dontAsk", "--permission-prompts", "none", "--setting-sources", "", "--settings", json.dumps(deny),
        "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
    ]
    parser = StreamParser(repo=str(store.repo_root()))
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, cwd=store.repo_root())
    started = time.monotonic()
    assert proc.stdin and proc.stdout
    proc.stdin.write(prompt.encode("utf-8"))
    proc.stdin.close()
    for raw in proc.stdout:
        if time.monotonic() - started > limit:
            proc.kill()
            raise JobError(f"超过 {limit // 60} 分钟还没做完，已经停掉")
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        for event in parser.feed(obj) if isinstance(obj, dict) else []:
            if event["type"] == "step":
                _emit(job.job_id, event)
    proc.wait()
    final = parser.final()
    if final["type"] != "done":
        raise JobError(str(final.get("message") or "Claude 没有做完"))
    job.cost_usd = round(job.cost_usd + float(final.get("cost_usd") or 0), 4)
    for denial in (parser.result or {}).get("permission_denials") or []:
        tool, args = denial.get("tool_name", ""), denial.get("tool_input") or {}
        text = f"{tool}: {args.get('command') or args.get('file_path') or ''}"[:200]
        if text not in job.denied:
            job.denied.append(text)
    llm.log_call("job", model(), time.monotonic() - started, {"cost_usd": final.get("cost_usd"), "output_tokens": final.get("output_tokens")}, ok=True)
    return parser


def _fail(job: Job, message: str) -> None:
    job.phase, job.error = "failed", message[:2000]
    save(job)
    _emit(job.job_id, {"type": "failed", "message": job.error})
    if job.kind == "task":
        tasks.set_status(job.ref, "failed", note=job.error[:300], by="claude-code")
    else:
        wishes.add_note(job.ref, f"作业失败：{job.error[:300]}", by="claude-code")


def run_plan(job_id: str) -> None:
    job = get(job_id)
    feedback = ""
    if job.feedback:
        feedback = "\n## 上一版方案和主人的意见\n\n上一版：\n\n" + job.plan + "\n\n意见：\n" + "\n".join(f"- {f}" for f in job.feedback) + "\n\n请按意见重写整份方案。\n"
    prompt = ops._fill("job_plan", what=job.what, directory=job.directory, feedback=feedback)
    try:
        parser = _claude(job, prompt, "Read,Grep,Glob", ["Read", "Grep", "Glob"], LIMIT_SECONDS["planning"])
    except JobError as e:
        return _fail(job, f"出方案时出错：{e}")
    job = Job.model_validate({**get(job_id).model_dump(), "cost_usd": job.cost_usd})
    if job.phase == "cancelled":
        return
    job.plan = parser.final().get("text", "").strip()
    if not job.plan:
        return _fail(job, "Claude 没有写出方案")
    job.phase = "plan_ready"
    save(job)
    (_dir(job_id) / "plan.md").write_text(job.plan, encoding="utf-8")
    if job.kind == "task":
        tasks.set_status(job.ref, "plan_ready", by="claude-code")
    _emit(job_id, {"type": "plan", "text": job.plan})


def run_execute(job_id: str) -> None:
    job = get(job_id)
    prompt = ops._fill("job_execute", what=job.what, plan=job.plan, directory=job.directory, commands=_commands_text(job.directory))
    try:
        parser = _claude(job, prompt, "Read,Grep,Glob,Edit,Write,Bash", _allowed(job.directory), LIMIT_SECONDS["running"])
    except JobError as e:
        return _fail(job, f"动手时出错：{e}")
    job = Job.model_validate({**get(job_id).model_dump(), "cost_usd": job.cost_usd, "denied": job.denied})
    if job.phase == "cancelled":
        return
    try:
        summary = llm.extract_json(parser.final().get("text", ""))
    except ValueError:
        summary = {}
    job.summary = summary if isinstance(summary, dict) else {}
    save(job)
    _finish(job_id)


def _allowed(directory: str) -> list[str]:
    """执行阶段放行的操作。没列在这里的一律被拒绝。 / What the execute phase may do; anything else is denied."""
    d = directory
    return [
        "Read", "Grep", "Glob", f"Edit({d}/**)", "Bash(ls:*)",
        f"Bash(uv run --project {d}:*)", f"Bash(uv sync --project {d}:*)",
        f"Bash(bun run --cwd {d}:*)", f"Bash(bun run --cwd {d}/web:*)",
        f"Bash(bun install --cwd {d}:*)", f"Bash(bun install --cwd {d}/web:*)", f"Bash(mkdir -p {d}:*)",
    ]


def _commands_text(directory: str) -> str:
    commands = _commands(directory)
    lines = [f"  - `{' '.join(c)}`" for c in commands] or [
        f"  - `uv sync --project {directory}`、`uv run --project {directory} pytest -q {directory}/tests`（Python）",
        f"  - `bun install --cwd {directory}`、`bun run --cwd {directory} test`（TypeScript）",
    ]
    return "\n".join(lines) + (
        "\n  这些命令必须原样从仓库根目录运行。**不要用 `cd`，不要用 `&&` 连接，不要换成 npm 或 npx**：那样会被拒绝。"
        f"\n  可以在后面加参数（比如只跑一个测试文件），前缀要保持 `uv run --project {directory} …` 或 `bun run --cwd {directory}[/web] …`。"
    )


def _check_scope(job: Job) -> Optional[str]:
    before = set(store.read_json(_dir(job.job_id) / "outside.json", []))
    strayed = sorted(_outside(job.directory) - before)
    return f"它改到了 `{job.directory}/` 外面的文件：{'、'.join(strayed[:6])}。没有开 PR。这些文件需要你自己看一下。" if strayed else None


def _run_tests(job: Job) -> Optional[str]:
    """由程序自己跑测试。返回失败的那一段输出，全过返回 None。 / Run the tests; return the failing output, or None."""
    repo = store.repo_root()
    log = []
    for command in _commands(job.directory):
        _say(job.job_id, f"跑测试：{' '.join(command)}")
        proc = subprocess.run(command, cwd=repo, capture_output=True, text=True, timeout=1800)
        output = (proc.stdout + proc.stderr)[-3000:]
        log.append(f"$ {' '.join(command)}\n{output}")
        job.test_log = "\n\n".join(log)[-8000:]
        save(job)
        if proc.returncode != 0:
            return f"$ {' '.join(command)}\n{output}"
    return None


def _finish(job_id: str) -> None:
    """Claude 结束之后的事：查范围 → 跑测试 →（没过就让它修，最多两轮）→ 开 PR → 标回。

    它自己有没有跑测试、说没说"做完了"，都不决定成败：以程序重跑的测试为准。

    What happens after Claude ends: check the scope, run the tests (letting it repair up to
    twice on failure), open the PR and report back. Whether the agent ran the tests or said
    "done" does not decide the outcome; the tests re-run here do.
    """
    job = get(job_id)
    repo = store.repo_root()
    job.changed = dirty(job.directory)
    stray = _check_scope(job)
    if stray:
        return _fail(job, stray)
    if not job.changed:
        return _fail(job, "Claude 结束了，但没有改任何文件。" + str(job.summary.get("not_done") or ""))

    while True:
        job.phase = "testing"
        save(job)
        failure = _run_tests(job)
        if failure is None:
            break
        if job.repairs >= MAX_REPAIRS:
            return _fail(job, f"测试没过，已经让它修了 {job.repairs} 轮：\n{failure[-1500:]}")
        job.repairs += 1
        job.phase = "running"
        save(job)
        _say(job_id, f"测试没过，把输出交回给 Claude 修（第 {job.repairs} 轮）。")
        prompt = ops._fill("job_repair", what=job.what, plan=job.plan, directory=job.directory, commands=_commands_text(job.directory),
                           changed="\n".join(f"- {f}" for f in job.changed), failure=failure)
        try:
            _claude(job, prompt, "Read,Grep,Glob,Edit,Write,Bash", _allowed(job.directory), LIMIT_SECONDS["running"])
        except JobError as e:
            return _fail(job, f"修的时候出错：{e}")
        job = Job.model_validate({**get(job_id).model_dump(), "cost_usd": job.cost_usd, "denied": job.denied, "repairs": job.repairs})
        if job.phase == "cancelled":
            return
        job.changed = dirty(job.directory)
        stray = _check_scope(job)
        if stray:
            return _fail(job, stray)

    job.phase = "pr"
    save(job)
    zh = str(job.summary.get("title_zh") or job.title).strip()
    en = str(job.summary.get("title_en") or "").strip()
    title = f"{job.directory}: {zh}" + (f" / {en}" if en else "")
    ref_line = f"愿望 {job.ref}" if job.kind == "wish" else f"任务 {job.ref}"
    left = str(job.summary.get("not_done") or "").strip()
    body_zh = f"{job.summary.get('summary_zh') or zh}" + (f"\n\n它说没做的部分：{left}" if left else "") + f"\n\n由 idea-loom 的作业 {job.job_id} 完成（{ref_line}）。方案经仓库主人批准后执行，测试由作业程序在提交前重新跑过。"
    body_en = (f"{job.summary.get('summary_en') or en}\n\nDone by idea-loom job {job.job_id} ({'wish' if job.kind == 'wish' else 'task'} {job.ref}). "
               "The plan was approved by the repository owner before execution, and the job runner re-ran the tests before submitting.")
    env = {**os.environ, "COMMIT_BODY": f"{body_zh}\n\n{body_en}",
           "PR_BODY": f"## 中文\n\n{body_zh}\n\n### 批准的方案\n\n{job.plan}\n\n## English\n\n{body_en}\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}
    _say(job_id, "测试通过，开 PR。")
    proc = subprocess.run([str(repo / "tools" / "pr.sh"), title, job.directory], cwd=repo, env=env, capture_output=True, text=True, timeout=600)
    out = (proc.stdout + proc.stderr).strip()
    job.pr_url = next((line.split("PR: ", 1)[1].strip() for line in out.splitlines() if line.startswith("PR: ")), None)
    if job.pr_url and job.pr_url.rstrip("/").split("/")[-1].isdigit():
        job.pr = int(job.pr_url.rstrip("/").split("/")[-1])
    if proc.returncode != 0 or not job.pr_url:
        return _fail(job, f"PR 没有合并：{out.splitlines()[-1] if out else '没有输出'}")
    job.phase = "merged"
    job.restart_needed = job.directory == "idea-loom" and any("/src/" in f for f in job.changed)
    save(job)
    if job.kind == "wish":
        wishes.add_link(job.ref, "pr", title=zh, url=job.pr_url, pr=job.pr, by="claude-code")
        wishes.set_status(job.ref, "done", note=str(job.summary.get("summary_zh") or ""), pr=job.pr)
    else:
        tasks.set_status(job.ref, "merged", note=str(job.summary.get("summary_zh") or ""), pr=job.pr, pr_url=job.pr_url, by="claude-code")
    _emit(job_id, {"type": "merged", "pr": job.pr, "url": job.pr_url})


def main(argv: list[str]) -> None:
    phase, job_id = argv[0], argv[1]
    try:
        {"plan": run_plan, "execute": run_execute, "finish": _finish}[phase](job_id)
    except Exception as e:  # noqa: BLE001 — 作业不能悄悄死掉 / a job must not die silently
        try:
            _fail(get(job_id), f"作业程序出错：{e}")
        except Exception:  # noqa: BLE001
            raise e


if __name__ == "__main__":
    main(sys.argv[1:])
