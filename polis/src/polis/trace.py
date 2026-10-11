"""运行记录：把一次模拟写成 UI 能回放的一组文件，并读回来。"""

from __future__ import annotations

import importlib
import json
from pathlib import Path

import numpy as np

from . import population
from .engine import Sim
from .model import Manifest, Params, Population, Summary
from .protagonist import Director

FILES = ["manifest.json", "population.json", "messages.json", "series.json", "events.jsonl", "frames.bin"]
SERVED = FILES + ["ensemble.json"]  # 后者是实验台按需算出来的


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def default_run_id(p: Params, label: str = "") -> str:
    return f"{p.scenario}-s{p.seed}" + (f"-{label}" if label else "")


def scenario_module(name: str):
    return importlib.import_module(f"polis.scenarios.{name}")


def simulate(
    params: Params,
    root: Path,
    label: str = "",
    run_id: str | None = None,
    parent: str | None = None,
    branch_t: int | None = None,
) -> Manifest:
    """跑一次模拟并写入 root/<run_id>/。"""
    scenario = scenario_module(params.scenario)
    pop = population.build(params, scenario)
    director = Director() if params.llm else None
    result = Sim(pop, params, scenario, director).run()

    status = result.frames[-1, 3]
    manifest = Manifest(
        run_id=run_id or default_run_id(params, label),
        title=scenario.TITLE,
        setting=scenario.SETTING,
        params=params,
        n=len(pop.persons),
        ticks=params.ticks,
        parent=parent,
        branch_t=branch_t,
        summary=Summary(
            # 倒闭之后人人都信了，那不算；看的是倒闭之前谣言自己走到了多远
            peak_believers=max(result.series.believers[: result.failed_at]),
            withdrew=int((status == 3).sum()),
            lost=int((status == 4).sum()),
            failed_at=result.failed_at,
            messages=len(result.messages),
            events=len(result.events),
            llm_calls=director.calls if director else 0,
            llm_failed=director.failed if director else 0,
        ),
    )

    out = root / manifest.run_id
    out.mkdir(parents=True, exist_ok=True)
    (out / "manifest.json").write_text(_dump(manifest.model_dump(by_alias=True)), encoding="utf-8")
    (out / "population.json").write_text(_dump(pop.model_dump(by_alias=True)), encoding="utf-8")
    (out / "messages.json").write_text(_dump([m.model_dump() for m in result.messages]), encoding="utf-8")
    (out / "series.json").write_text(_dump(result.series.model_dump()), encoding="utf-8")
    (out / "events.jsonl").write_text("".join(_dump(e) + "\n" for e in result.events), encoding="utf-8")
    (out / "frames.bin").write_bytes(result.frames.tobytes())
    return manifest


def list_runs(root: Path) -> list[Manifest]:
    return [load_manifest(d) for d in sorted(root.glob("*")) if (d / "manifest.json").exists()]


def load_manifest(run: Path) -> Manifest:
    return Manifest.model_validate_json((run / "manifest.json").read_text(encoding="utf-8"))


def load_population(run: Path) -> Population:
    return Population.model_validate_json((run / "population.json").read_text(encoding="utf-8"))


def load_frames(run: Path) -> np.ndarray:
    m = load_manifest(run)
    return np.frombuffer((run / "frames.bin").read_bytes(), dtype=np.uint8).reshape(m.ticks + 1, len(m.channels), m.n)


def load_events(run: Path) -> list[dict]:
    return [json.loads(line) for line in (run / "events.jsonl").read_text(encoding="utf-8").splitlines()]


def run_only(params: Params):
    """只跑不写，供集成与校准使用。"""
    scenario = scenario_module(params.scenario)
    pop = population.build(params, scenario)
    return pop, Sim(pop, params, scenario).run()
