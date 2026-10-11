"""API：列出运行记录，把记录文件原样交给 UI；实验台的分叉与集成也从这里进。
The API: lists runs and hands their files to the UI unchanged; the lab's branches and ensembles also come in through here.
"""

from __future__ import annotations

import json
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from . import calibrate, corpus, lab, trace
from .cli import CALIBRATION, _responses, runs_dir
from .model import Intervention, Params

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


class SimulateRequest(BaseModel):
    """开一次新的模拟。不调用模型，不写任何文件。/ Start one new simulation. No model is called and nothing is written."""

    model_config = ConfigDict(extra="forbid")

    scenario: Literal["rumor_run", "toyokawa", "bea", "bac", "swedbank", "kaspi", "icici", "fib"] = "rumor_run"
    seed: int = Field(1, ge=0, le=1_000_000)
    n: int = Field(1000, ge=100, le=2000)
    response: Literal["notice", "guarantee", "none"] = "notice"
    calibrated: bool = True


CAVEAT = {
    "zh": "这个模型没有通过样本外检验：五起没参与设计的真实挤兑里，没有一起的规模能稳定对上（见 README「数据从哪来」）。结果只说明模型里会发生什么，不是对真实银行的预测。",
    "en": "This model has not passed its out-of-sample tests: of five real runs that took no part in its design, none is matched in scale with any consistency (see the README, \"Where the data comes from\"). A result says what happens inside the model; it is not a forecast for any real bank.",
}


@app.post("/api/simulate")
def simulate(body: SimulateRequest) -> dict:
    """同样的输入得到同样的输出。返回一次运行的摘要和逐日数字，不含逐人的记录。
    The same input gives the same output. Returns a summary of one run with day-by-day figures, without per-person records.
    """
    sc = trace.scenario_module(body.scenario)
    over = json.loads(CALIBRATION.read_text(encoding="utf-8"))["calibrated"]["params"] if body.calibrated and CALIBRATION.is_file() else {}
    params = Params(scenario=body.scenario, seed=body.seed, n=body.n, **(sc.DEFAULTS | over))
    params.interventions = _responses(sc)[body.response](params.start_hour)
    pop, r = trace.run_only(params)
    total = sum(p.deposit for p in pop.persons)
    day = calibrate.run_day(pop, r, params)
    ends = list(range(24, params.ticks + 1, 24))
    return {
        "input": body.model_dump(),
        "ticks": params.ticks,
        "depositors": sum(p.deposit > 0 for p in pop.persons),
        "failed_at_hour": r.failed_at,
        "runner_share": round(calibrate.runner_share(pop, r), 4),
        "withdrawn_share": round(sum(e["x"] for e in r.events if e["k"] == "withdraw") / total, 4),
        "run_day": None if day != day else int(day),  # nan：没有发生挤兑 / nan means no run happened
        "peak_believers": max(r.series.believers[: r.failed_at] if r.failed_at else r.series.believers),  # 倒闭那一刻人人都信了，不算 / at the moment of failure everyone believes, which is left out
        "by_day": [{"day": i + 1, "aware": r.series.aware[t], "believers": r.series.believers[t], "queue": r.series.queue[t],
                    "withdrew": r.series.withdrew[t], "reserve": r.series.reserve[t]} for i, t in enumerate(ends)],  # fmt: skip
        "record": getattr(sc, "RECORD", None),
        "caveat": CAVEAT,
    }
