"""案例库加载：cases/<类别>/<id>.yaml。 / Loads the case library: cases/<category>/<id>.yaml."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml

from .model import Case


def cases_dir() -> Path:
    env = os.environ.get("MINDLOOP_CASES")
    return Path(env) if env else Path(__file__).resolve().parents[2] / "cases"


@lru_cache(maxsize=None)
def _load_all(root: str) -> dict[str, Case]:
    out: dict[str, Case] = {}
    for path in sorted(Path(root).glob("*/*.yaml")):
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        data.setdefault("id", path.stem)
        data.setdefault("category", path.parent.name)
        try:
            case = Case.model_validate(data)
        except Exception as e:  # 让出错的文件一眼可见 / make the faulty file obvious
            raise ValueError(f"案例文件有误 {path}: {e}") from e
        if case.id in out:
            raise ValueError(f"案例 id 重复: {case.id}")
        out[case.id] = case
    return out


def all_cases() -> dict[str, Case]:
    return _load_all(str(cases_dir()))


def get_case(case_id: str) -> Case:
    cases = all_cases()
    if case_id not in cases:
        raise KeyError(f"case_id：没有这个案例 {case_id}（可用: {', '.join(cases)}） / case_id: no such case")
    return cases[case_id].model_copy(deep=True)  # 调用方可以放心改参数 / callers may modify it freely
