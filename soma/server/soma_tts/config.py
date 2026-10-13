"""状态目录和模型清单。 / The state directory and the model registry."""

from __future__ import annotations

import json
import os
import re
import tempfile
from functools import lru_cache
from pathlib import Path

# 本文件所在的包目录的上一级就是 soma/server；不依赖当前目录。
# The parent of this package directory is soma/server; nothing here depends on the current directory.
SERVER_DIR = Path(__file__).resolve().parent.parent
REGISTRY = SERVER_DIR / "models.json"
SAMPLE_RATE = 24000


def state_dir(explicit: str | None = None) -> Path:
    """运行时可以写的目录。 / The directory this service may write to.

    顺序：明确给出的参数；环境变量 WORLD_SIM_STATE；当前目录在 idea-loom 的快照（…/src-<版本>/…）里时取它旁边的 state/；
    否则是临时目录下的固定名字（开发用）。没有被替换的占位符（字面的 "{state}"）当作没给。
    Order: an explicit argument; the WORLD_SIM_STATE environment variable; when the current directory is inside an
    idea-loom snapshot (…/src-<version>/…), the state/ directory next to it; otherwise a fixed name under the system
    temporary directory (for development). An unsubstituted placeholder (a literal "{state}") counts as not given.
    """
    for value in (explicit, os.environ.get("WORLD_SIM_STATE")):
        if value and "{" not in value:
            return Path(value).expanduser().resolve()
    for parent in Path.cwd().resolve().parents:
        if re.fullmatch(r"src-[0-9a-f]{6,40}", parent.name) and parent.parent.is_dir():
            return parent.parent / "state"
    return Path(tempfile.gettempdir()) / "world-sim-soma-tts"


def models_dir(state: Path) -> Path:
    return state / "tts-models"


def cache_dir(state: Path) -> Path:
    return state / "tts-cache"


@lru_cache(maxsize=1)
def registry() -> dict:
    with REGISTRY.open(encoding="utf-8") as fh:
        return json.load(fh)


def model_for(lang: str) -> dict:
    return next(m for m in registry()["models"] if m["lang"] == lang)


def languages() -> list[str]:
    return [m["lang"] for m in registry()["models"]]


def missing_files(state: Path, model: dict) -> list[str]:
    """清单里还没下载的文件（只看是否存在和大小；sha256 在下载时校验）。
    Files of the registry not yet present (existence and size only; sha256 is verified at download time)."""
    root = models_dir(state) / model["id"]
    return [f["path"] for f in model["files"] if not (root / f["path"]).is_file() or (root / f["path"]).stat().st_size != f["bytes"]]
