"""HTTP 接口。界面只通过这里读写。 / The HTTP API; the UI reads and writes only through it."""

from __future__ import annotations

from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from . import edits, ideas, sync
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
    except edits.EditError as e:
        raise HTTPException(409, str(e))


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
