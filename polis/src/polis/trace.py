"""运行记录：把一次模拟写成 UI 能回放的一组文件，并读回来。
Run records: write one simulation out as a set of files the UI can replay, and read them back.
"""

from __future__ import annotations

import importlib
import os
import json
from pathlib import Path

import numpy as np

from . import population
from .engine import Sim
from .model import Manifest, Params, Population, Summary
from .protagonist import Director

FILES = ["manifest.json", "population.json", "messages.json", "series.json", "events.jsonl", "frames.bin"]  # 后者是实验台按需算出来的 / the latter is computed on demand by the lab


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
    """跑一次模拟并写入 root/<run_id>/。/ Run one simulation and write it to root/<run_id>/."""
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
            # After a failure everyone believes, which does not count; this measures how far the rumour got on its own before that
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


PROJECT = Path(__file__).resolve().parents[2]


def runs_dir() -> Path:
    """新记录写到哪里：POLIS_RUNS，其次是统一入口给的 WORLD_SIM_STATE，再其次是项目下的 runs/。
    Where new runs are written: POLIS_RUNS, else the WORLD_SIM_STATE directory given by the shared host, else runs/ in the project.
    """
    if os.environ.get("POLIS_RUNS"):
        return Path(os.environ["POLIS_RUNS"])
    if os.environ.get("WORLD_SIM_STATE"):
        return Path(os.environ["WORLD_SIM_STATE"]) / "runs"
    return PROJECT / "runs"


def bundled() -> list[Path]:
    """随项目带着的只读记录：samples/ 在 git 里，built/ 由 `polis prepare` 生成。POLIS_BUNDLED 可以改掉或清空。
    Read-only runs that ship with the project: samples/ is in git and built/ is produced by `polis prepare`.
    POLIS_BUNDLED overrides the list, and an empty value disables it.
    """
    env = os.environ.get("POLIS_BUNDLED")
    dirs = [Path(d) for d in env.split(os.pathsep) if d] if env is not None else [PROJECT / "built", PROJECT / "samples"]
    return [d for d in dirs if d.is_dir()]


def find(run_id: str, root: Path) -> Path | None:
    """一条记录所在的目录：先看可写的 root，再看随项目带着的。/ The directory holding a run: the writable root first, then the bundled ones."""
    if not run_id or run_id.startswith((".", "_")) or "/" in run_id or os.sep in run_id:
        return None
    for d in [root, *bundled()]:
        if (d / run_id / "manifest.json").is_file():
            return d / run_id
    return None


def list_runs(root: Path) -> list[Manifest]:
    """root 和随项目带着的全部记录，同名的以 root 里的为准。/ Every run in root and the bundled directories; root wins on a clash."""
    seen: dict[str, Manifest] = {}
    for d in [root, *bundled()]:
        for run in sorted(d.glob("*")):
            if (run / "manifest.json").exists() and run.name not in seen:
                seen[run.name] = load_manifest(run)
    return [seen[k] for k in sorted(seen)]


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
    """只跑不写，供集成与校准使用。/ Run without writing anything; used by ensembles and calibration."""
    scenario = scenario_module(params.scenario)
    pop = population.build(params, scenario)
    return pop, Sim(pop, params, scenario).run()
