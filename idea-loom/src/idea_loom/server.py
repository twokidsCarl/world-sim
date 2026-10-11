"""HTTP 接口。界面只通过这里读写。 / The HTTP API; the UI reads and writes only through it."""

from __future__ import annotations

from typing import Optional

import json

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel

from . import edits, github, ideas, llm, ops, stats, sync, tasks, trail, wishes
from .assistant import turns
from .model import IdeaDetail, State

app = FastAPI(title="idea-loom")


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
    except (edits.EditError, ops.OpError, wishes.WishError, turns.TurnError, tasks.TaskError) as e:
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


def _port_open(url: Optional[str]) -> bool:
    """子项目的开发服务是不是在跑。 / Whether the subproject's dev server is running."""
    import socket
    from urllib.parse import urlparse

    if not url:
        return False
    parsed = urlparse(url)
    try:
        with socket.create_connection((parsed.hostname or "127.0.0.1", parsed.port or 80), timeout=0.15):
            return True
    except OSError:
        return False


@app.get("/api/projects", response_model=list[ProjectView])
def list_projects() -> list[ProjectView]:
    from . import store

    pool, _, _, _ = ideas.current()
    prs = github.pull_requests()
    out = []
    for p in ideas.load_projects():
        mine = [x for x in prs if x.scope == p.dir]
        merged = [x for x in mine if x.merged_at]
        mentioned = [i.id for i in pool.values() if p.dir in i.projects and i.status in ideas.LIVE]
        out.append(ProjectView(
            dir=p.dir, tagline=p.tagline, level=p.level, ideas=sorted(set(mentioned) | set(p.ideas), key=ideas.sort_key), linked=p.ideas,
            ui_url=p.ui_url, ui_up=_port_open(p.ui_url), prs=len(mine), merged=len(merged),
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
