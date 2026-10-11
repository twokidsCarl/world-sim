"""HTTP 接口。界面只通过这里读写。 / The HTTP API; the UI reads and writes only through it."""

from __future__ import annotations

import time

from typing import Optional

import json
from contextlib import asynccontextmanager

from fastapi import Body, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse, RedirectResponse, StreamingResponse
from pydantic import BaseModel

from . import auth, config, edits, github, notify, suggestions, ideas, jobs, llm, ops, review, stats, sync, tasks, trail, wishes
from .assistant import turns
from .play import host as play_host
from .play import manifest as play_manifest
from .play import snapshot as play_snapshot
from .play import supervisor as play_supervisor
from .model import IdeaDetail, State

@asynccontextmanager
async def _lifespan(_app: FastAPI):
    if config.role() == "play":
        from . import cloud
        from .play import keeper

        cloud.ensure_clone()
        cloud.seed_data()  # play 有自己的数据目录，过渡期的名片从这里读 / play has its own data directory and reads the interim card files from it
        keeper.start()
    elif config.role() == "hub":
        import threading

        from . import cloud

        threading.Thread(target=cloud.keep_importing, daemon=True, name="seed-data").start()
    yield


app = FastAPI(title="idea-loom", lifespan=_lifespan)
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
def post_trail(body: TrailBody, request: Request) -> dict[str, int]:
    user = current_user(request)
    for action in body.actions:
        action.user = "" if user.role == "owner" else user.login  # 以登录的身份为准，不信请求里带的 / trust the session, not the request body
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
            ui_url=config.sim_origin(p.dir, port) if p.dir in hosted else None, ui_up=p.dir in hosted and playable(p.dir),
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


@app.get("/api/worker")
def worker_status() -> dict[str, object]:
    """队列、在跑的作业、今天开工了几个、额度有没有到暂停线。 / The queue, running jobs, how many started today, and whether the allowance pause is on."""
    from . import worker

    return worker.status()


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
    from . import chains

    try:
        task_id = _do(chains.propose, project_dir)
    except ValueError as e:
        raise HTTPException(404, str(e))
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
    if config.serves_sims():
        play_snapshot.fetch()
        play_supervisor.reap_idle()
    sims, problems = play_manifest.load_all()
    pool, _, _, _ = ideas.current()
    port = _play_port(request)
    sim_views, cards = [], []
    for sim in sims:
        state = play_snapshot.ensure(sim.name) if sim.ready and config.serves_sims() else play_snapshot.status(sim.name)
        origin = config.sim_origin(sim.name, port)
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
    user = current_user(request)
    # 每个人看到的是自己的观看记录；游客没有。 / Everyone sees their own watch history; a guest has none.
    history = {} if user.role == "guest" else trail.card_history(user="" if user.role == "owner" else user.login)
    return PlayView(sims=sim_views, cards=cards, problems=problems, history=history)


def _rebuild(name: str) -> str:
    play_supervisor.stop(name)
    return play_snapshot.ensure(name, force=True).status


@app.post("/api/play/{name}/build")
def play_build(name: str) -> dict[str, str]:
    if name not in play_manifest.names():
        raise HTTPException(404, "没有这个模拟")
    if config.serves_sims():
        return {"status": _rebuild(name)}
    # hub 自己不构建：转给 play。 / The hub does not build; it asks the play role.
    import urllib.error
    import urllib.request

    if not config.play_url():
        raise HTTPException(503, "没有配置 play 的内部地址")
    request = urllib.request.Request(f"{config.play_url()}/internal/play/build/{name}", data=b"{}", method="POST",
                                     headers={"x-internal-token": config.internal_token(), "content-type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise HTTPException(502, f"play 没有回应：{e}")


@app.post("/internal/play/build/{name}")
def internal_play_build(name: str, x_internal_token: str = Header(default="")) -> dict[str, str]:
    """只给 hub 调。 / For the hub only."""
    import hmac

    if not config.serves_sims() or not config.internal_token() or not hmac.compare_digest(x_internal_token, config.internal_token()):
        raise HTTPException(403, "不接受")
    if name not in play_manifest.names():
        raise HTTPException(404, "没有这个模拟")
    return {"status": _rebuild(name)}


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"ok": "true", "role": config.role()}


@app.get("/internal/tls-ask")
def tls_ask(domain: str = "") -> dict[str, bool]:
    """反向代理在为一个主机名申请证书之前来问：这是不是我们的。只对 idea-loom 自己的主机名和已知的模拟答是。

    The reverse proxy asks this before requesting a certificate for a host name. It says
    yes only for idea-loom's own host names and for known simulations.
    """
    host = domain.lower()
    if host in config.own_hosts() or play_host.sim_name(host) in set(play_manifest.names()):
        return {"ok": True}
    raise HTTPException(404, "不是这里的主机名")


# ---------- 登录 / sign-in ----------


def current_user(request: Request) -> auth.User:
    user = request.scope.get("state", {}).get("user")
    return user if isinstance(user, auth.User) else auth.user_from_cookie(request.cookies.get(auth.COOKIE))


@app.get("/api/me", response_model=auth.User)
def me(request: Request) -> auth.User:
    return current_user(request)


def _cookie_kwargs() -> dict[str, object]:
    return {"httponly": True, "secure": not config.is_local(), "samesite": "lax", "path": "/"}


@app.get("/auth/login")
def auth_login() -> RedirectResponse:
    if not auth.enabled() or not auth.client_id():
        raise HTTPException(404, "这里没有开启登录")
    state = auth.new_state()
    response = RedirectResponse(auth.authorize_url(state), status_code=302)
    response.set_cookie(auth.STATE_COOKIE, auth.sign({"state": state, "exp": time.time() + 600}), max_age=600, **_cookie_kwargs())
    return response


@app.get("/auth/callback")
def auth_callback(request: Request, code: str = "", state: str = "") -> RedirectResponse:
    if not auth.enabled():
        raise HTTPException(404, "这里没有开启登录")
    saved = auth.unsign(request.cookies.get(auth.STATE_COOKIE) or "")
    # state 要和发起登录时存在 cookie 里的一样，否则可能是别人伪造的回调。
    # The state must match the one stored in the cookie when sign-in began, or the callback may be forged.
    if not code or not saved or not state or saved.get("state") != state:
        raise HTTPException(400, "登录的回调不对，请重新登录")
    try:
        who = auth.exchange(code)
    except ValueError as e:
        raise HTTPException(502, str(e))
    response = RedirectResponse("/", status_code=302)
    response.delete_cookie(auth.STATE_COOKIE, path="/")
    response.set_cookie(auth.COOKIE, auth.session_cookie(**who), max_age=auth.SESSION_SECONDS, **_cookie_kwargs())
    return response


@app.post("/auth/logout")
def auth_logout() -> RedirectResponse:
    response = RedirectResponse("/", status_code=303)
    response.delete_cookie(auth.COOKIE, path="/")
    return response


# ---------- 访客提的愿望 / wishes from visitors ----------


class SuggestionBody(BaseModel):
    title: str
    stuck: str = ""
    where_url: str = ""
    where_title: str = ""


class DismissBody(BaseModel):
    note: str = ""


def _suggest(fn, *args, **kw):
    try:
        return fn(*args, **kw)
    except suggestions.SuggestionError as e:
        raise HTTPException(422, str(e))


@app.post("/api/suggestions", response_model=suggestions.Suggestion)
def send_suggestion(body: SuggestionBody, request: Request) -> suggestions.Suggestion:
    """登录的访客提一条愿望。只存下来等主人过目，不调用模型。 / A signed-in visitor sends a wish. It is only stored for the owner to look over; no model is called."""
    user = current_user(request)
    return _suggest(suggestions.send, user.login, body.title, body.stuck, body.where_url, body.where_title)


@app.get("/api/suggestions/mine", response_model=list[suggestions.Suggestion])
def my_suggestions(request: Request) -> list[suggestions.Suggestion]:
    return suggestions.listing(by=current_user(request).login)


@app.get("/api/suggestions", response_model=list[suggestions.Suggestion])
def all_suggestions() -> list[suggestions.Suggestion]:
    return suggestions.listing()


@app.post("/api/suggestions/{suggestion_id}/accept", response_model=suggestions.Suggestion)
def accept_suggestion(suggestion_id: str) -> suggestions.Suggestion:
    return _suggest(suggestions.accept, suggestion_id)


@app.post("/api/suggestions/{suggestion_id}/dismiss", response_model=suggestions.Suggestion)
def dismiss_suggestion(suggestion_id: str, body: DismissBody) -> suggestions.Suggestion:
    return _suggest(suggestions.dismiss, suggestion_id, body.note)


# ---------- 推送通知 / push notifications ----------


class PushBody(BaseModel):
    subscription: dict


class PushOffBody(BaseModel):
    endpoint: str


@app.get("/api/push")
def push_state() -> dict[str, object]:
    return {"configured": notify.configured(), "public_key": notify.public_key(), "devices": len(notify.subscriptions())}


@app.post("/api/push/subscribe")
def push_subscribe(body: PushBody) -> dict[str, int]:
    if not notify.configured():
        raise HTTPException(422, "这里还没有配置推送的密钥")
    try:
        return {"devices": notify.subscribe(body.subscription)}
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.post("/api/push/unsubscribe")
def push_unsubscribe(body: PushOffBody) -> dict[str, int]:
    return {"devices": notify.unsubscribe(body.endpoint)}


@app.post("/api/push/test")
def push_test() -> dict[str, int]:
    return {"sent": notify.send("idea-loom", "通知是通的。 / Notifications work.", url="/work", tag="test")}


# ---------- 连续推进 / chains ----------


class ChainBody(BaseModel):
    directory: str
    steps: int


@app.post("/api/chains")
def approve_chain(body: ChainBody) -> dict[str, int]:
    """给一个子项目事先批准"接下来最多做几步"；0 是停。 / Approve in advance at most this many more steps for a subproject; 0 stops it."""
    from . import chains

    try:
        return chains.approve(body.directory, body.steps)
    except ValueError as e:
        raise HTTPException(422, str(e))


# ---------- 给外来的 AI Agent：/api/v1 / for outside AI agents: /api/v1 ----------
#
# 这一层是稳定的、有版本的，和上面给界面用的接口分开。只读和有界的计算对所有人开放；
# 错误一律是 {"error", "hint"}，hint 告诉 Agent 怎么把请求改对。
# This layer is stable and versioned, separate from the routes above that serve the UI. Reading
# and bounded computation are open to everyone; every error is {"error", "hint"}, the hint
# telling an agent how to fix its request.

from fastapi.responses import JSONResponse  # noqa: E402

from .agentapi import catalog as agent_catalog  # noqa: E402
from .agentapi import datasets as agent_datasets  # noqa: E402
from .agentapi import docs as agent_docs  # noqa: E402


def _port(request: Request) -> str:
    server = request.scope.get("server") or ("", 8767)
    return str(server[1])


def _base(request: Request) -> str:
    return config.public_url() or f"http://localhost:{_port(request)}"


def _agent_error(status: int, error: str, hint: str = "") -> JSONResponse:
    return JSONResponse({"error": error, "hint": hint or "GET /api/v1/catalog lists what exists."}, status_code=status)


@app.get("/api/v1/catalog")
def v1_catalog(request: Request) -> dict:
    return agent_catalog.catalog(_port(request))


@app.get("/api/v1/ideas")
def v1_ideas(q: str = "", level: str = "", thread: str = "", kernel: str = "", project: str = "", status: str = "", limit: int = 50, after: int = 0, full: bool = False):
    try:
        return agent_catalog.search_ideas(q, level, thread, kernel, project, status, limit, max(0, after), full)
    except ValueError as e:
        return _agent_error(422, str(e), "limit is 1 to 200; page with after=<next>.")


@app.get("/api/v1/ideas/{idea_id}")
def v1_idea(idea_id: str):
    try:
        return agent_catalog.get_idea(idea_id)
    except agent_catalog.NotFound as e:
        return _agent_error(404, str(e), "Search with GET /api/v1/ideas?q=words; ids look like 4.2, 纵 1, 造 3.")


@app.get("/api/v1/cards")
def v1_cards(request: Request, project: str = "", idea: str = ""):
    return {"cards": agent_catalog.cards(project, idea, _port(request))}


@app.get("/api/v1/datasets/{project}/{dataset_id}/schema")
def v1_dataset_schema(project: str, dataset_id: str):
    try:
        return agent_datasets.describe(project, agent_catalog.dataset(project, dataset_id))
    except agent_catalog.NotFound as e:
        return _agent_error(404, str(e))
    except agent_datasets.DatasetError as e:
        return _agent_error(503, str(e), "The dataset's files could not be read on main; try again later or report it.")


@app.get("/api/v1/datasets/{project}/{dataset_id}")
def v1_dataset(project: str, dataset_id: str, request: Request, q: str = "", key: str = "", fields: str = "", limit: int = agent_datasets.DEFAULT_LIMIT, after: int = 0):
    try:
        ds = agent_catalog.dataset(project, dataset_id)
        return agent_datasets.query(project, ds, q=q, key=key, where=request.query_params.getlist("where"), fields=fields, limit=limit, after=after)
    except agent_catalog.NotFound as e:
        return _agent_error(404, str(e))
    except agent_datasets.DatasetError as e:
        return _agent_error(422, str(e), f"GET /api/v1/datasets/{project}/{dataset_id}/schema shows the fields, the key and a sample record.")


@app.get("/api/v1/capabilities/{project}/{capability_id}")
def v1_capability(project: str, capability_id: str):
    try:
        return agent_catalog.describe_capability(project, capability_id)
    except agent_catalog.NotFound as e:
        return _agent_error(404, str(e))


@app.get("/llms.txt", response_class=PlainTextResponse)
def llms_txt(request: Request) -> PlainTextResponse:
    return PlainTextResponse(agent_docs.llms_txt(_base(request)), media_type="text/markdown; charset=utf-8")


@app.get("/llms-full.txt", response_class=PlainTextResponse)
def llms_full(request: Request) -> PlainTextResponse:
    return PlainTextResponse(agent_docs.llms_full(_base(request)), media_type="text/markdown; charset=utf-8")


@app.post("/api/v1/run/{project}/{capability_id}")
def v1_run(project: str, capability_id: str, request: Request, payload: dict = Body(default_factory=dict)):
    """跑一次有界的计算。 / Run one bounded computation."""
    from .agentapi import run as agent_run

    try:
        return agent_run.run(project, agent_catalog.capability(project, capability_id), payload, _port(request))
    except agent_catalog.NotFound as e:
        return _agent_error(404, str(e))
    except agent_run.RunError as e:
        return _agent_error(e.status, e.error, e.hint)


class ProposeIdeaBody(BaseModel):
    title: str
    body: str
    level: str
    why: str = ""
    threads: list[str] = []
    kernel: Optional[str] = None


class ProposeWishBody(BaseModel):
    title: str
    stuck: str = ""


def _proposer(request: Request) -> str:
    user = current_user(request)
    return f"agent:{user.agent}" if user.agent else (user.login or "owner")


@app.post("/api/v1/proposals/idea")
def v1_propose_idea(body: ProposeIdeaBody, request: Request):
    """提一条 idea：进待主人过目的队列，不直接进想法池，也不调用模型。 / Propose an idea: it enters the owner's review queue, not the pool, and no model is called."""
    try:
        item = suggestions.send(_proposer(request), body.title, idea=body.model_dump(exclude={"title"}))
    except suggestions.SuggestionError as e:
        return _agent_error(422, str(e), "Fields: title, body (about three short lines), level (L1…L10, 纵, 造, 规), why; optional threads (A–E) and kernel.")
    return {"queued": item.id, "status": item.status, "note": "It is waiting for the owner to look at it. / 等主人过目。"}


@app.post("/api/v1/proposals/wish")
def v1_propose_wish(body: ProposeWishBody, request: Request):
    try:
        item = suggestions.send(_proposer(request), body.title, body.stuck)
    except suggestions.SuggestionError as e:
        return _agent_error(422, str(e), "Fields: title (one sentence), stuck (optional).")
    return {"queued": item.id, "status": item.status, "note": "It is waiting for the owner to look at it. / 等主人过目。"}


def _loopback(request: Request):
    """MCP 的工具在进程里直接走 /api/v1，带上调用方的令牌和地址。 / MCP tools go through /api/v1 in-process, carrying the caller's token and address."""
    import httpx

    headers = {k: v for k, v in (("authorization", request.headers.get("authorization")), ("cookie", request.headers.get("cookie"))) if v}
    host = request.headers.get("host", "localhost")
    client_addr = (request.client.host, request.client.port) if request.client else ("127.0.0.1", 0)

    async def api(method: str, path: str, params, body):
        transport = httpx.ASGITransport(app=app, client=client_addr)
        async with httpx.AsyncClient(transport=transport, base_url=f"http://{host}", headers=headers, timeout=130) as client:
            response = await client.request(method, path, params=params, json=body)
        try:
            return response.status_code, response.json()
        except ValueError:
            return response.status_code, response.text

    return api


@app.post("/mcp")
async def mcp_endpoint(request: Request):
    """远程的 MCP（Streamable HTTP，无状态）：每个 POST 是一条 JSON-RPC 消息，回一个 JSON。

    Remote MCP (Streamable HTTP, stateless): each POST carries one JSON-RPC message and gets one JSON reply.
    """
    from .agentapi import mcp as agent_mcp

    try:
        message = await request.json()
    except ValueError:
        return JSONResponse({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}, status_code=400)
    api = _loopback(request)
    if isinstance(message, list):
        replies = [r for r in [await agent_mcp.handle(m, api) for m in message] if r is not None]
        return JSONResponse(replies) if replies else Response(status_code=202)
    reply = await agent_mcp.handle(message, api)
    return JSONResponse(reply) if reply is not None else Response(status_code=202)


@app.get("/mcp")
def mcp_get() -> Response:
    # 这个服务不主动推消息，所以没有 GET 的事件流。 / This server pushes nothing, so there is no GET event stream.
    return Response(status_code=405, headers={"allow": "POST"})


# ---------- Agent 的令牌（只有主人）/ agent tokens (owner only) ----------


class TokenBody(BaseModel):
    name: str
    scopes: list[str] = ["read"]


@app.get("/api/agent-tokens")
def list_agent_tokens() -> list[dict]:
    from .agentapi import tokens

    return tokens.listing()


@app.post("/api/agent-tokens")
def create_agent_token(body: TokenBody) -> dict:
    from .agentapi import tokens

    try:
        return tokens.create(body.name, body.scopes)
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.post("/api/agent-tokens/{token_id}/revoke")
def revoke_agent_token(token_id: str) -> dict:
    from .agentapi import tokens

    return {"revoked": tokens.revoke(token_id)}
