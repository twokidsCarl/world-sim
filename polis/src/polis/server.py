"""API：列出运行记录，把记录文件原样交给 UI；实验台的分叉与集成也从这里进。"""

from __future__ import annotations

import json

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import corpus, lab, trace
from .cli import CALIBRATION, runs_dir
from .model import Intervention

app = FastAPI(title="polis")


def _run_dir(run_id: str):
    path = runs_dir() / run_id
    if run_id.startswith(".") or "/" in run_id or not (path / "manifest.json").is_file():
        raise HTTPException(404)
    return path


@app.get("/api/runs")
def runs() -> list[dict]:
    return [m.model_dump(by_alias=True) for m in trace.list_runs(runs_dir())]


@app.get("/api/runs/{run_id}/{name}")
def run_file(run_id: str, name: str):
    path = _run_dir(run_id) / name
    if name == "ensemble.json" and not path.is_file():
        return None  # 还没算过集成，不是错误
    if name not in trace.SERVED or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


@app.get("/api/corpus")
def corpus_all() -> dict:
    """语料全文，每条附带 verified（出处是否全部核实）。"""
    entries, _ = corpus.check()
    return {kind: [e.model_dump() | {"verified": e.verified} for e in items] for kind, items in entries.items()}


@app.get("/api/calibration")
def calibration() -> dict | None:
    return json.loads(CALIBRATION.read_text(encoding="utf-8")) if CALIBRATION.is_file() else None


class BranchRequest(BaseModel):
    interventions: list[Intervention]


@app.post("/api/runs/{run_id}/branch")
def branch(run_id: str, body: BranchRequest) -> dict:
    _run_dir(run_id)
    try:
        return lab.branch(runs_dir(), run_id, body.interventions).model_dump(by_alias=True)
    except ValueError as e:
        raise HTTPException(422, str(e))


@app.post("/api/runs/{run_id}/ensemble")
def ensemble(run_id: str, k: int = 20) -> dict:
    _run_dir(run_id)
    if not 2 <= k <= 50:
        raise HTTPException(422, "k 要在 2 到 50 之间")
    return lab.ensemble(runs_dir(), run_id, k)
