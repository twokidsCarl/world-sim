"""测试的公共部分。需要模型的测试在模型没下载、或没装 model 这组依赖时跳过。
Shared test setup. Tests that need the model are skipped when it is not downloaded or the `model` extra is not installed.

模型在哪儿找：环境变量 SOMA_TTS_TEST_STATE；否则是开发时惯用的 soma/data/raw/tts（已被 .gitignore 忽略）。
Where the model is looked for: the SOMA_TTS_TEST_STATE environment variable, else the usual development location
soma/data/raw/tts (ignored by .gitignore).
"""

from __future__ import annotations

import importlib.util
import os
import tempfile
from pathlib import Path

import pytest

# 导入服务之前先把状态目录指到一个空的临时目录，测试不碰真实的状态。
# Point the state directory at an empty temporary directory before the service is imported; tests leave real state alone.
os.environ["WORLD_SIM_STATE"] = tempfile.mkdtemp(prefix="soma-tts-test-")

from soma_tts import config  # noqa: E402


def _model_state() -> Path | None:
    given = os.environ.get("SOMA_TTS_TEST_STATE")
    candidate = Path(given) if given else config.SERVER_DIR.parent / "data" / "raw" / "tts"
    if not candidate.is_dir() or importlib.util.find_spec("torch") is None or importlib.util.find_spec("kokoro") is None:
        return None
    if any(config.missing_files(candidate, m) for m in config.registry()["models"]):
        return None
    return candidate


MODEL_STATE = _model_state()


def pytest_collection_modifyitems(config, items):  # noqa: ARG001
    if MODEL_STATE is not None:
        return
    skip = pytest.mark.skip(reason="模型没有下载或没装 model 这组依赖 / the model is not downloaded or the `model` extra is not installed")
    for item in items:
        if "model" in item.keywords:
            item.add_marker(skip)


@pytest.fixture(scope="session")
def engine():
    from soma_tts.engine import Engine

    e = Engine(MODEL_STATE)
    e.start()
    return e
