"""HTTP 接口。界面只通过这里读写。 / The HTTP API; the UI reads and writes only through it."""

from __future__ import annotations

from typing import Optional

import json

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from . import edits, github, ideas, jobs, llm, ops, review, stats, sync, tasks, trail, wishes
from .assistant import turns
from .play import host as play_host
from .play import manifest as play_manifest
from .play import snapshot as play_snapshot
from .play import supervisor as play_supervisor
from .model import IdeaDetail, State

app = FastAPI(title="idea-loom")
app.add_middleware(play_host.HostRouter)


class CreateBody(BaseModel):
    title: str
    body: str
    level: str
    threads: list[str] = []
    kernel: Optional[str] = None


class EditBody(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None


class MoveBody(BaseModel):
    threads: Optional[list[str]] = None
    kernel: Optional[str] = None
    clear_kernel: bool = False


class MergeBody(BaseModel):
    target: str
    reason: str = ""


class ReasonBody(BaseModel):
    reason: str = ""


class StatusBody(BaseModel):
    status: str


class SyncBody(BaseModel):
    title: Optional[str] = None


def _detail(idea_id: str) -> IdeaDetail:
    found = ideas.detail(idea_id)
    if found is None:
        raise HTTPException(404, f"没有编号为 {idea_id} 的 idea")
    return found


def _do(fn, *args, **kw):
    try:
        return fn(*args, **kw)
    except (edits.EditError, ops.OpError, wishes.WishError, turns.TurnError, tasks.TaskError, jobs.JobError) as e:
        raise HTTPException(409, str(e))
    except llm.LLMError as e:
        raise HTTPException(502, f"模型调用失败：{e}")


class GenerateBody(BaseModel):
    target: ops.Target = ops.Target()
    n: int = 3


class RefineBody(BaseModel):
    idea_id: str
    n: int = 3
    hint: str = ""


class FuseBody(BaseModel):
    idea_ids: list[str]


class ClassifyBody(BaseModel):
    idea_ids: Optional[list[str]] = None


class DedupeBody(BaseModel):
    level: Optional[str] = None
    kernel: Optional[str] = None


class AcceptBody(BaseModel):
    as_new: bool = False
    title: Optional[str] = None
    body: Optional[str] = None


class Proposals(BaseModel):
    proposals: list[ops.Proposal]
    open: int
    model_ready: bool


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"ok": True}


@app.get("/api/state", response_model=State)
def get_state() -> State:
    return ideas.state()


@app.get("/api/ideas/{idea_id}", response_model=IdeaDetail)
def get_idea(idea_id: str) -> IdeaDetail:
    return _detail(idea_id)


@app.post("/api/ideas", response_model=IdeaDetail)
def create_idea(body: CreateBody) -> IdeaDetail:
    new_id = _do(edits.create, title=body.title, body=body.body, level=body.level, threads=body.threads, kernel=body.kernel)
    return _detail(new_id)


@app.post("/api/ideas/{idea_id}/edit", response_model=IdeaDetail)
def edit_idea(idea_id: str, body: EditBody) -> IdeaDetail:
    _do(edits.edit, idea_id, title=body.title, body=body.body)
    return _detail(idea_id)


@app.post("/api/ideas/{idea_id}/move", response_model=IdeaDetail)
def move_idea(idea_id: str, body: MoveBody) -> IdeaDetail:
    _do(edits.move, idea_id, threads=body.threads, kernel=body.kernel, clear_kernel=body.clear_kernel)
    return _detail(idea_id)


@app.post("/api/ideas/{idea_id}/merge", response_model=IdeaDetail)
def merge_idea(idea_id: str, body: MergeBody) -> IdeaDetail:
    _do(edits.merge, idea_id, body.target, reason=body.reason)
    return _detail(idea_id)


@app.post("/api/ideas/{idea_id}/discard", response_model=IdeaDetail)
def discard_idea(idea_id: str, body: ReasonBody) -> IdeaDetail:
    _do(edits.discard, idea_id, reason=body.reason)
    return _detail(idea_id)


@app.post("/api/ideas/{idea_id}/restore", response_model=IdeaDetail)
def restore_idea(idea_id: str) -> IdeaDetail:
    _do(edits.restore, idea_id)
    return _detail(idea_id)


@app.post("/api/ideas/{idea_id}/status", response_model=IdeaDetail)
def status_idea(idea_id: str, body: StatusBody) -> IdeaDetail:
    _do(edits.set_status, idea_id, body.status)
    return _detail(idea_id)


@app.get("/api/sync", response_model=sync.SyncStatus)
def sync_status() -> sync.SyncStatus:
    return sync.status()


@app.post("/api/sync", response_model=sync.SyncResult)
def sync_run(body: SyncBody) -> sync.SyncResult:
    return sync.run(body.title)


@app.get("/api/proposals", response_model=Proposals)
def list_proposals() -> Proposals:
    items = ops.load()
    return Proposals(proposals=items, open=sum(p.status == "open" for p in items), model_ready=llm.available())


@app.post("/api/ops/generate", response_model=list[ops.Proposal])
def op_generate(body: GenerateBody) -> list[ops.Proposal]:
    return _do(ops.generate, body.target, body.n)


@app.post("/api/ops/refine", response_model=list[ops.Proposal])
def op_refine(body: RefineBody) -> list[ops.Proposal]:
    return _do(ops.refine, body.idea_id, body.n, body.hint)


@app.post("/api/ops/fuse", response_model=ops.Proposal)
def op_fuse(body: FuseBody) -> ops.Proposal:
    return _do(ops.fuse, body.idea_ids)


@app.post("/api/ops/classify", response_model=list[ops.Proposal])
def op_classify(body: ClassifyBody) -> list[ops.Proposal]:
    return _do(ops.classify, body.idea_ids)


@app.post("/api/ops/dedupe", response_model=list[ops.Proposal])
def op_dedupe(body: DedupeBody) -> list[ops.Proposal]:
    return _do(ops.dedupe, body.level, body.kernel)


@app.post("/api/proposals/{proposal_id}/accept", response_model=ops.Proposal)
def accept_proposal(proposal_id: str, body: AcceptBody) -> ops.Proposal:
    return _do(ops.accept, proposal_id, as_new=body.as_new, title=body.title, body=body.body)


@app.post("/api/proposals/{proposal_id}/dismiss", response_model=ops.Proposal)
def dismiss_proposal(proposal_id: str) -> ops.Proposal:
    return _do(ops.dismiss, proposal_id)


class EnglishBody(BaseModel):
    title_en: str
    body_en: str


@app.post("/api/ops/translate")
def op_translate(body: ClassifyBody) -> dict[str, object]:
    done = _do(ops.translate, body.idea_ids)
    return {"translated": done}


@app.post("/api/ideas/{idea_id}/english", response_model=IdeaDetail)
def english_idea(idea_id: str, body: EnglishBody) -> IdeaDetail:
    _do(edits.set_english, idea_id, title_en=body.title_en, body_en=body.body_en)
    return _detail(idea_id)


# ---------- 许愿池 / wish pool ----------


class WishEditBody(BaseModel):
    title: Optional[str] = None
    kind: Optional[str] = None
    stuck: Optional[str] = None
    suggestion: Optional[str] = None


@app.get("/api/wishes", response_model=wishes.WishList)
def list_wishes(status: Optional[str] = None) -> wishes.WishList:
    return wishes.listing(status)


@app.get("/api/wishes/{wish_id}", response_model=wishes.WishDetail)
def get_wish(wish_id: str) -> wishes.WishDetail:
    try:
        return wishes.get(wish_id)
    except wishes.WishError as e:
        raise HTTPException(404, str(e))


@app.post("/api/wishes/{wish_id}/edit", response_model=wishes.WishDetail)
def edit_wish(wish_id: str, body: WishEditBody) -> wishes.WishDetail:
    _do(wishes.edit, wish_id, title=body.title, kind=body.kind, stuck=body.stuck, suggestion=body.suggestion)
    return wishes.get(wish_id)


@app.post("/api/wishes/{wish_id}/withdraw", response_model=wishes.WishDetail)
def withdraw_wish(wish_id: str) -> wishes.WishDetail:
    _do(wishes.withdraw, wish_id)
    return wishes.get(wish_id)


@app.post("/api/wishes/{wish_id}/restore", response_model=wishes.WishDetail)
def restore_wish(wish_id: str) -> wishes.WishDetail:
    _do(wishes.restore, wish_id)
    return wishes.get(wish_id)


# ---------- 操作轨迹 / action trail ----------


class TrailBody(BaseModel):
    actions: list[trail.Action]


@app.post("/api/trail")
def post_trail(body: TrailBody) -> dict[str, int]:
    return {"saved": trail.append(body.actions)}


# ---------- 小助手 / assistant ----------


@app.get("/api/assistant")
def assistant_status() -> dict[str, object]:
    ready = llm.available()
    return {"ready": ready, "not_ready_reason": None if ready else "这台机器上找不到 claude 命令",
            "open_wishes": wishes.listing().counts["open"]}


@app.get("/api/assistant/conversations")
def assistant_conversations() -> list[dict[str, object]]:
    return turns.conversations()


@app.post("/api/assistant/conversations")
def assistant_new() -> dict[str, str]:
    return {"id": turns.new_conversation()}


@app.get("/api/assistant/conversations/{conversation_id}")
def assistant_conversation(conversation_id: str) -> dict[str, object]:
    return _do(turns.conversation, conversation_id)


def _sse(conversation_id: str, turn: int, after: int) -> StreamingResponse:
    def lines():
        yield f"event: turn\ndata: {json.dumps({'turn': turn})}\n\n"
        for event in turns.follow(conversation_id, turn, after):
            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(lines(), media_type="text/event-stream", headers={"cache-control": "no-cache", "x-accel-buffering": "no"})


@app.post("/api/assistant/conversations/{conversation_id}/turns")
def assistant_ask(conversation_id: str, body: turns.TurnRequest) -> StreamingResponse:
    turn = _do(turns.start, conversation_id, body)
    return _sse(conversation_id, turn, 0)


@app.get("/api/assistant/conversations/{conversation_id}/turns/{turn}/events")
def assistant_events(conversation_id: str, turn: int, after: int = 0) -> StreamingResponse:
    return _sse(conversation_id, turn, after)


@app.post("/api/assistant/conversations/{conversation_id}/stop")
def assistant_stop(conversation_id: str) -> dict[str, bool]:
    return {"stopped": turns.stop(conversation_id)}


@app.post("/internal/assistant/tools/{name}", response_class=PlainTextResponse)
async def assistant_tool(name: str, request: Request, x_assistant_turn: str = Header(default="")) -> PlainTextResponse:
    """只给小助手的工具服务用：必须带着正在进行的回合的令牌。

    For the assistant's tool server only: it must carry the token of a turn in progress.
    """
    try:
        args = await request.json()
    except ValueError:
        args = {}
    try:
        import anyio

        return PlainTextResponse(await anyio.to_thread.run_sync(turns.call_tool, name, x_assistant_turn, args if isinstance(args, dict) else {}))
    except turns.ToolError as e:
        return PlainTextResponse(str(e), status_code=403)


# ---------- 子项目、任务、统计 / subprojects, tasks, statistics ----------


class ProjectView(BaseModel):
    dir: str
    tagline: str
    level: Optional[str]
    ideas: list[str]  # 明确关联的，加上正文里提到它的 / explicitly linked plus those that mention it
    linked: list[str]
    ui_url: Optional[str]
    ui_up: bool
    prs: int
    merged: int
    last_merged_at: Optional[str]
    recent: list[github.PullRequest]
    has_readme: bool


class TaskBody(BaseModel):
    project: str
    title: str
    brief: str = ""
    idea_id: Optional[str] = None


class TaskStatusBody(BaseModel):
    status: str
    note: str = ""


class LinkBody(BaseModel):
    idea_id: str
    linked: bool = True


def _play_port(request: Request) -> str:
    """idea-loom 自己监听的端口。不能用请求的 Host 头：经开发服务器转发过来时，那是开发服务器的端口。

    The port idea-loom itself listens on. Not the request's Host header: behind the dev
    server's proxy that would be the dev server's port.
    """
    import os

    server = request.scope.get("server")
    return os.environ.get("IDEA_LOOM_PORT") or str(server[1] if server and server[1] else request.url.port or 80)


@app.get("/api/projects", response_model=list[ProjectView])
def list_projects(request: Request) -> list[ProjectView]:
    from . import store

    hosted = {s.name for s in play_manifest.load_all()[0] if s.ready}
    port = _play_port(request)

    def playable(name: str) -> bool:
        state = play_snapshot.status(name)
        return state.status == "ready" or bool(state.serving)

    pool, _, _, _ = ideas.current()
    prs = github.pull_requests()
    out = []
    for p in ideas.load_projects():
        mine = [x for x in prs if x.scope == p.dir]
        merged = [x for x in mine if x.merged_at]
        mentioned = [i.id for i in pool.values() if p.dir in i.projects and i.status in ideas.LIVE]
        out.append(ProjectView(
            dir=p.dir, tagline=p.tagline, level=p.level, ideas=sorted(set(mentioned) | set(p.ideas), key=ideas.sort_key), linked=p.ideas,
            # 界面的地址是它在统一入口里的子域名，不再探测开发服务器的端口。
            # The UI address is its subdomain on the single entry point; dev-server ports are no longer probed.
            ui_url=f"http://{p.dir}.localhost:{port}" if p.dir in hosted else None, ui_up=p.dir in hosted and playable(p.dir),
            prs=len(mine), merged=len(merged),
            last_merged_at=max((x.merged_at for x in merged if x.merged_at), default=None), recent=list(reversed(mine))[:8],
            has_readme=(store.repo_root() / p.dir / "README.md").exists(),
        ))
    return out


@app.post("/api/projects/{project_dir}/link")
def link_project(project_dir: str, body: LinkBody) -> dict[str, bool]:
    _do(tasks.link_project, project_dir, body.idea_id, body.linked)
    return {"ok": True}


@app.get("/api/tasks", response_model=list[tasks.Task])
def list_tasks() -> list[tasks.Task]:
    return tasks.listing()


@app.post("/api/tasks", response_model=tasks.Task)
def create_task(body: TaskBody) -> tasks.Task:
    task_id = _do(tasks.create, project=body.project, title=body.title, brief=body.brief, idea_id=body.idea_id)
    return tasks.get(task_id)


@app.post("/api/tasks/{task_id}/status", response_model=tasks.Task)
def task_status(task_id: str, body: TaskStatusBody) -> tasks.Task:
    _do(tasks.set_status, task_id, body.status, note=body.note)
    return tasks.get(task_id)


@app.get("/api/stats", response_model=stats.Stats)
def get_stats(refresh: bool = False) -> stats.Stats:
    return stats.compute(force=refresh)


# ---------- 作业：触发 Claude Code / jobs: triggering Claude Code ----------


class JobStartBody(BaseModel):
    kind: str
    ref: str


class TextBody(BaseModel):
    text: str = ""


class JobView(BaseModel):
    job: jobs.Job
    events: list[dict[str, object]]


@app.get("/api/jobs", response_model=list[jobs.Job])
def list_jobs() -> list[jobs.Job]:
    return jobs.listing()


@app.post("/api/jobs", response_model=jobs.Job)
def start_job(body: JobStartBody) -> jobs.Job:
    return _do(jobs.start, body.kind, body.ref)


@app.get("/api/jobs/{job_id}", response_model=JobView)
def get_job(job_id: str, after: int = 0) -> JobView:
    job = _do(jobs.get, job_id)
    return JobView(job=jobs.reap(job), events=jobs.events(job_id, after))


@app.post("/api/jobs/{job_id}/approve", response_model=jobs.Job)
def approve_job(job_id: str) -> jobs.Job:
    return _do(jobs.approve, job_id)


@app.post("/api/jobs/{job_id}/revise", response_model=jobs.Job)
def revise_job(job_id: str, body: TextBody) -> jobs.Job:
    return _do(jobs.revise, job_id, body.text)


@app.post("/api/jobs/{job_id}/decline", response_model=jobs.Job)
def decline_job(job_id: str, body: TextBody) -> jobs.Job:
    return _do(jobs.decline, job_id, body.text)


@app.post("/api/jobs/{job_id}/cancel", response_model=jobs.Job)
def cancel_job(job_id: str) -> jobs.Job:
    return _do(jobs.cancel, job_id)


@app.post("/api/jobs/{job_id}/resume", response_model=jobs.Job)
def resume_job(job_id: str) -> jobs.Job:
    return _do(jobs.resume, job_id)


@app.post("/api/jobs/{job_id}/revert")
def revert_job(job_id: str) -> dict[str, list[str]]:
    return {"reverted": _do(jobs.revert, job_id)}


# ---------- 回看与推进 / review and advance ----------


class WishFromReview(BaseModel):
    title: str
    kind: str
    stuck: str = ""
    suggestion: str = ""


@app.get("/api/review", response_model=review.ReviewStatus)
def review_status() -> review.ReviewStatus:
    return review.status()


@app.post("/api/review", response_model=list[review.Suggestion])
def review_run() -> list[review.Suggestion]:
    try:
        return _do(review.run)
    except ValueError as e:
        raise HTTPException(409, str(e))


@app.post("/api/wishes", response_model=wishes.WishDetail)
def record_wish_from_review(body: WishFromReview) -> wishes.WishDetail:
    """只给"回看"用：把一条你接受了的提议记进许愿池。 / For the review only: record a suggestion you accepted."""
    wish_id = _do(wishes.record, title=body.title, kind=body.kind, stuck=body.stuck, suggestion=body.suggestion, by="review",
                  question="（回看操作轨迹时提出的）")
    return wishes.get(wish_id)


@app.post("/api/projects/{project_dir}/advance", response_model=tasks.Task)
def advance_project(project_dir: str) -> tasks.Task:
    """推进：让模型读这个子项目的 README 和最近的合并请求，提议下一个里程碑，建成一个待开工的任务。

    Advance: the model reads the subproject's README and recent PRs, proposes the next
    milestone, and it becomes a todo task.
    """
    from . import store

    project = next((p for p in ideas.load_projects() if p.dir == project_dir), None)
    if project is None:
        raise HTTPException(404, "没有这个子项目")
    readme = store.repo_root() / project_dir / "README.md"
    text = readme.read_text(encoding="utf-8")[:9000] if readme.exists() else "（还没有 README）"
    recent = [p for p in github.pull_requests() if p.scope == project_dir][-15:]
    pool, _, _, _ = ideas.current()
    linked = [pool[i] for i in project.ideas if i in pool]
    prompt = (f"子项目 `{project_dir}`（{project.tagline}）。\n\n它的 README：\n{text}\n\n最近合并的 PR（从早到晚）：\n"
              + ("\n".join(f"- #{p.number} {p.title}" for p in recent) or "（还没有）")
              + ("\n\n它对应的 idea：\n" + "\n\n".join(ops.idea_text(i) for i in linked) if linked else "")
              + "\n\n请提议它的下一个里程碑：一件一次能做完、做完能看出差别的事。title 一句话；brief 三五句，说清做什么、做到什么算完、不做什么。用中文。")
    schema = {"type": "object", "properties": {"title": {"type": "string"}, "brief": {"type": "string"}}, "required": ["title", "brief"]}
    value = _do(llm.ask, prompt, system="你在帮一个人决定一个模拟项目下一步做什么。只依据给你的材料，不要编造项目里没有的东西。", schema=schema, use_cache=False, purpose="advance")
    task_id = _do(tasks.create, project=project_dir, title=str(value["title"]), brief=str(value["brief"]), idea_id=linked[0].id if linked else None)
    return tasks.get(task_id)


# ---------- 统一入口：托管的模拟 / the single entry point: hosted simulations ----------


class SimView(BaseModel):
    name: str
    title: play_manifest.Text
    level: Optional[str]
    ready: bool
    source: str
    origin: str  # 这个模拟自己的源，例如 http://strata.localhost:8767 / the simulation's own origin
    status: str  # 最新版本的构建状态 / build state of the newest version
    playable: bool  # 有一个构建成功的版本可以用（可能是上一个）/ some good build can be served (possibly the previous one)
    stale: bool
    version: str
    log: str
    built_at: Optional[str]
    has_api: bool
    api_running: bool
    cards: int


class CardView(BaseModel):
    key: str  # <项目>/<卡片编号> / <project>/<card id>
    sim: str
    sim_title: play_manifest.Text
    level: Optional[str]
    id: str
    title: play_manifest.Text
    hint: play_manifest.Text
    idea: Optional[str]
    url: str  # 完整地址 / the full address
    status: str


class PlayView(BaseModel):
    sims: list[SimView]
    cards: list[CardView]
    problems: list[play_manifest.Problem]
    history: dict[str, trail.CardHistory]


@app.get("/api/play", response_model=PlayView)
def play_view(request: Request) -> PlayView:
    """所有托管的模拟和它们的卡片。读这个接口会顺带：取一次远端、给需要的项目启动构建、停掉空闲的后端。

    All hosted simulations and their cards. Reading this also fetches the remote, starts
    builds that are needed and stops idle backends.
    """
    play_snapshot.fetch()
    play_supervisor.reap_idle()
    sims, problems = play_manifest.load_all()
    pool, _, _, _ = ideas.current()
    port = _play_port(request)
    sim_views, cards = [], []
    for sim in sims:
        state = play_snapshot.ensure(sim.name) if sim.ready else play_snapshot.status(sim.name)
        origin = f"http://{sim.name}.localhost:{port}"
        sim_views.append(SimView(
            name=sim.name, title=sim.title, level=sim.level, ready=sim.ready, source=sim.source, origin=origin, status=state.status,
            playable=state.status == "ready" or bool(state.serving), stale=state.stale, version=state.version[:12], log=state.log[-2000:], built_at=state.built_at, has_api=sim.api is not None,
            api_running=play_supervisor.running(sim.name) is not None, cards=len(sim.cards),
        ))
        if not sim.ready:
            continue
        for card in sim.cards:
            cards.append(CardView(key=f"{sim.name}/{card.id}", sim=sim.name, sim_title=sim.title, level=sim.level, id=card.id, title=card.title,
                                  hint=card.hint, idea=card.idea if card.idea in pool else None, url=origin + card.url, status="ready" if state.status == "ready" or state.serving else state.status))
    return PlayView(sims=sim_views, cards=cards, problems=problems, history=trail.card_history())


@app.post("/api/play/{name}/build")
def play_build(name: str) -> dict[str, str]:
    if name not in play_manifest.names():
        raise HTTPException(404, "没有这个模拟")
    play_supervisor.stop(name)
    return {"status": play_snapshot.ensure(name, force=True).status}
