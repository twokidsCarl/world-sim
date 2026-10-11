"""测试只看自己造的记录，不看随项目带着的。/ Tests see only the runs they create, not the ones that ship with the project."""

import pytest


@pytest.fixture(autouse=True)
def no_bundled_runs(monkeypatch):
    monkeypatch.setenv("POLIS_BUNDLED", "")
    monkeypatch.delenv("WORLD_SIM_STATE", raising=False)
