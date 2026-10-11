"""HTTP 接口。界面只通过这里读写。 / The HTTP API; the UI reads and writes only through it."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException

from . import ideas
from .model import IdeaDetail, State

app = FastAPI(title="idea-loom")


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"ok": True}


@app.get("/api/state", response_model=State)
def get_state() -> State:
    return ideas.state()


@app.get("/api/ideas/{idea_id}", response_model=IdeaDetail)
def get_idea(idea_id: str) -> IdeaDetail:
    found = ideas.detail(idea_id)
    if found is None:
        raise HTTPException(404, f"没有编号为 {idea_id} 的 idea")
    return found
