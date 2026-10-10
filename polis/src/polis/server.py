"""API：列出运行记录，并把记录文件原样交给 UI。"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

from . import trace
from .cli import runs_dir

app = FastAPI(title="polis")


@app.get("/api/runs")
def runs() -> list[dict]:
    return [m.model_dump(by_alias=True) for m in trace.list_runs(runs_dir())]


@app.get("/api/runs/{run_id}/{name}")
def run_file(run_id: str, name: str) -> FileResponse:
    path = runs_dir() / run_id / name
    if name not in trace.FILES or run_id.startswith(".") or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)
