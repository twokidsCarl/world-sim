"""API：列出运行记录，把记录文件原样交给 UI；实验台的分叉与集成也从这里进。
The API: lists runs and hands their files to the UI unchanged; the lab's branches and ensembles also come in through here.
"""

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
    path = trace.find(run_id, runs_dir())
    if path is None:
        raise HTTPException(404)
    return path


@app.get("/api/health")
def health() -> dict:
    return {"ok": True}


@app.get("/api/runs")
def runs() -> list[dict]:
    return [m.model_dump(by_alias=True) for m in trace.list_runs(runs_dir())]


@app.get("/api/runs/{run_id}/{name}")
def run_file(run_id: str, name: str):
    run = _run_dir(run_id)
    if name == "ensemble.json":
        # 没算过集成不是错误 / an ensemble that has not been computed is not an error
        cached = lab.ensemble_path(runs_dir(), run_id)
        return json.loads(cached.read_text(encoding="utf-8")) if cached.is_file() else None
    if name not in trace.FILES or not (run / name).is_file():
        raise HTTPException(404)
    return FileResponse(run / name)


@app.get("/api/corpus")
def corpus_all() -> dict:
    """语料全文，每条附带 verified（出处是否全部核实）。/ The full corpus; each entry carries verified (whether all its sources are checked)."""
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
