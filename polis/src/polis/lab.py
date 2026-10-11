"""实验台：在一条记录上加干预分叉重跑；同一设定换种子看分布。
The lab: branch a run by adding interventions and re-running it; vary the seed under the same settings to see the distribution.

引擎是确定性的，所以分叉不需要存档点：用同样的种子从头重跑，干预之前的每一帧都与父记录相同。
The engine is deterministic, so branching needs no checkpoints: re-running from the start with the same seed gives frames identical to the parent's up to the intervention.
"""

from __future__ import annotations

import hashlib
import json
import warnings
from pathlib import Path

import numpy as np

from . import trace
from .model import Intervention, Manifest


def branch(root: Path, parent_id: str, added: list[Intervention]) -> Manifest:
    where = trace.find(parent_id, root)
    if where is None:
        raise ValueError(f"没有这条记录：{parent_id}")
    parent = trace.load_manifest(where)
    if not added:
        raise ValueError("分叉至少要有一条干预")
    for iv in added:
        if not 1 <= iv.t <= parent.ticks:
            raise ValueError(f"干预时刻 {iv.t} 不在 1..{parent.ticks} 之内")
        limit = {"close_venue": len(trace.load_population(where).venues), "silence": parent.n, "convince": parent.n}.get(iv.kind)
        if limit is not None and not (iv.target is not None and 0 <= iv.target < limit):
            raise ValueError(f"{iv.kind} 需要一个有效的对象")
    interventions = sorted(parent.params.interventions + added, key=lambda iv: iv.t)
    params = parent.params.model_copy(update={"interventions": interventions})
    digest = hashlib.sha256(json.dumps([iv.model_dump() for iv in interventions], sort_keys=True).encode()).hexdigest()[:6]
    root_id = parent_id.split("~")[0]
    return trace.simulate(params, root, run_id=f"{root_id}~{digest}", parent=parent_id, branch_t=min(iv.t for iv in added))


def ensemble_path(root: Path, run_id: str) -> Path:
    """集成结果放在可写目录里，不放进记录自己的目录：随项目带着的记录是只读的。
    Ensemble results live in the writable directory rather than inside the run, because bundled runs are read-only.
    """
    return root / "_ensemble" / f"{run_id}.json"


def ensemble(root: Path, run_id: str, k: int = 20) -> dict:
    """同一设定跑 k 个种子，给出各时刻的分位带和倒闭次数。结果有缓存。
    Run k seeds under the same settings and return the quantile bands at each tick and the number of failures. The result is cached.
    """
    path = ensemble_path(root, run_id)
    if path.exists():
        cached = json.loads(path.read_text(encoding="utf-8"))
        if cached["k"] == k:
            return cached
    m = trace.load_manifest(trace.find(run_id, root))
    seeds = list(range(1, k + 1))
    series = {"believers": [], "withdrew": [], "reserve": []}
    failed_at = []
    for seed in seeds:
        _, r = trace.run_only(m.params.model_copy(update={"seed": seed}))
        failed_at.append(r.failed_at)
        for name in series:
            values = np.array(getattr(r.series, name), dtype=float)
            if name == "believers" and r.failed_at is not None:
                values[r.failed_at :] = np.nan  # 倒闭之后人人都信，不计入分布 / after a failure everyone believes, so those ticks are left out of the distribution
            series[name].append(values)
    out = {"k": k, "seeds": seeds, "failed": sum(f is not None for f in failed_at), "failed_at": failed_at, "bands": {}}
    for name, runs in series.items():
        with warnings.catch_warnings():  # 全部种子都已倒闭的时刻没有值，记为空 / ticks at which every seed has failed have no value and are recorded as null
            warnings.simplefilter("ignore", RuntimeWarning)
            lo, mid, hi = np.nanquantile(np.array(runs), [0.1, 0.5, 0.9], axis=0)
        out["bands"][name] = {"lo": _clean(lo), "mid": _clean(mid), "hi": _clean(hi)}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return out


def _clean(a: np.ndarray) -> list[float | None]:
    return [None if np.isnan(v) else round(float(v), 4) for v in a]
