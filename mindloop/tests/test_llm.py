import asyncio
import json
import os
import time

import pytest

from fake_claude_helper import calls, install
from mindloop import llm


@pytest.fixture
def fake(tmp_path, monkeypatch):
    return install(tmp_path, monkeypatch)


def test_available_follows_env(fake, monkeypatch):
    assert llm.available()
    monkeypatch.setenv("MINDLOOP_CLAUDE_BIN", "/nonexistent/claude-xyz")
    assert not llm.available()
    with pytest.raises(llm.LLMError):
        llm.ask("hi")


def test_parses_result_and_passes_prompt_on_stdin(fake, monkeypatch):
    monkeypatch.setenv("FAKE_RESULT", "  空城一座  ")
    prompt = "一段很长的提示词 " * 2000 + "'; rm -rf / #"
    assert llm.ask(prompt, system="你是军师") == "空城一座"
    (call,) = calls(fake)
    assert call["stdin"] == prompt  # 提示词走标准输入，原样送达
    argv = call["argv"]
    assert prompt not in argv
    assert argv[0] == "-p"
    assert argv[argv.index("--output-format") + 1] == "json"
    assert argv[argv.index("--model") + 1] == "sonnet"
    assert argv[argv.index("--tools") + 1] == ""
    assert argv[argv.index("--setting-sources") + 1] == ""
    assert argv[argv.index("--system-prompt") + 1] == "你是军师"
    assert "--no-session-persistence" in argv and "--strict-mcp-config" in argv
    assert "--json-schema" not in argv
    assert os.path.realpath(call["cwd"]) != os.path.realpath(os.getcwd())  # 在中性目录里跑


def test_model_env_and_argument(fake, monkeypatch):
    monkeypatch.setenv("MINDLOOP_MODEL", "haiku")
    llm.ask("a")
    llm.ask("b", model="opus")
    models = [c["argv"][c["argv"].index("--model") + 1] for c in calls(fake)]
    assert models == ["haiku", "opus"]


def test_retry_once_after_failure(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "fail_once")
    assert llm.ask("hi") == "你好"
    assert len(calls(fake)) == 2


def test_retry_once_after_garbage(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "garbage_once")
    assert llm.ask("hi") == "你好"
    assert len(calls(fake)) == 2


def test_gives_up_after_one_retry(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "always_fail")
    with pytest.raises(llm.LLMError):
        llm.ask("hi")
    assert len(calls(fake)) == 2


def test_timeout_raises_llmerror(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "sleep")
    monkeypatch.setenv("MINDLOOP_TIMEOUT", "0.5")
    t0 = time.monotonic()
    with pytest.raises(llm.LLMError, match="超时"):
        llm.ask("hi")
    assert time.monotonic() - t0 < 10


def test_cache_hit_does_not_spawn(fake, tmp_path):
    assert llm.ask("同一个问题") == "你好"
    assert llm.ask("同一个问题") == "你好"
    assert len(calls(fake)) == 1
    assert len(list((tmp_path / "cache").glob("*.json"))) == 1
    llm.ask("同一个问题", system="换了系统提示")  # 键里包含 system
    llm.ask("同一个问题", model="opus")  # …和 model
    assert len(calls(fake)) == 3


def test_use_cache_false_bypasses_read_but_writes(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "count")
    assert llm.ask("q") == "你好0"
    assert llm.ask("q", use_cache=False) == "你好1"
    assert len(calls(fake)) == 2
    assert llm.ask("q") == "你好1"  # 新结果已覆盖进缓存
    assert len(calls(fake)) == 2


def test_aask_meta_reports_cache(fake):
    async def go():
        return await llm.aask_meta("q"), await llm.aask_meta("q")

    (v1, c1), (v2, c2) = asyncio.run(go())
    assert (v1, c1, v2, c2) == ("你好", False, "你好", True)


SCHEMA = {"type": "object", "properties": {"answer_index": {"type": "integer"}}, "required": ["answer_index"]}


def test_schema_uses_structured_output(fake, monkeypatch):
    monkeypatch.setenv("FAKE_STRUCTURED", '{"answer_index": 2}')
    assert llm.ask("q", schema=SCHEMA) == {"answer_index": 2}
    argv = calls(fake)[0]["argv"]
    assert json.loads(argv[argv.index("--json-schema") + 1]) == SCHEMA
    assert llm.ask("q", schema=SCHEMA) == {"answer_index": 2}  # 缓存里也是 dict
    assert len(calls(fake)) == 1
    assert llm.ask("q") == "你好"  # 不带 schema 是另一个缓存键
    assert len(calls(fake)) == 2


def test_schema_falls_back_to_json_inside_result(fake, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "result_only")
    monkeypatch.setenv("FAKE_STRUCTURED", '{"answer_index": 1}')
    assert llm.ask("q", schema=SCHEMA) == {"answer_index": 1}


def test_schema_missing_required_field_is_error(fake, monkeypatch):
    monkeypatch.setenv("FAKE_STRUCTURED", '{"something_else": 1}')
    with pytest.raises(llm.LLMError):
        llm.ask("q", schema=SCHEMA)
    assert len(calls(fake)) == 2  # 输出不合要求也重试一次


def test_concurrency_is_limited_and_all_complete(fake, monkeypatch):
    async def go():
        return await asyncio.gather(*(llm.aask(f"q{i}") for i in range(10)))

    assert asyncio.run(go()) == ["你好"] * 10
    assert len(calls(fake)) == 10
    assert llm.CONCURRENCY == 4


def test_extract_json():
    assert llm.extract_json('前言 {"a": [1, 2]} 后记') == {"a": [1, 2]}
    assert llm.extract_json('```json\n{"a": 1}\n```') == {"a": 1}
    with pytest.raises(ValueError):
        llm.extract_json("没有")
