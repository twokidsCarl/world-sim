import json

import pytest

import fake_claude
from idea_loom import llm, store

SCHEMA = {"type": "object", "properties": {"x": {"type": "string"}}, "required": ["x"]}


@pytest.fixture
def log(tmp_path, monkeypatch):
    return fake_claude.install(tmp_path, monkeypatch)


def test_prompt_goes_on_stdin_and_runs_in_a_neutral_directory(log):
    assert llm.ask("问题", system="系统") == "你好"
    (call,) = fake_claude.calls(log)
    assert call["stdin"] == "问题"
    assert "问题" not in call["argv"]
    assert call["argv"][:3] == ["-p", "--output-format", "json"]
    assert call["argv"][call["argv"].index("--tools") + 1] == ""
    assert call["argv"][call["argv"].index("--system-prompt") + 1] == "系统"
    assert call["cwd"].endswith("idea-loom-llm")


def test_schema_gives_a_dict_and_checks_required(log, monkeypatch):
    monkeypatch.setenv("FAKE_STRUCTURED", json.dumps({"x": "好"}))
    assert llm.ask("q", schema=SCHEMA) == {"x": "好"}
    monkeypatch.setenv("FAKE_STRUCTURED", json.dumps({"y": 1}))
    with pytest.raises(llm.LLMError, match="缺字段"):
        llm.ask("另一个", schema=SCHEMA)


def test_json_in_the_text_is_used_when_structured_output_is_missing(log, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "result_only")
    monkeypatch.setenv("FAKE_STRUCTURED", json.dumps({"x": "从文字里找到的"}))
    assert llm.ask("q", schema=SCHEMA) == {"x": "从文字里找到的"}


def test_one_retry_after_a_failure_then_gives_up(log, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "fail_once")
    assert llm.ask("q") == "你好"
    assert len(fake_claude.calls(log)) == 2
    monkeypatch.setenv("FAKE_MODE", "always_fail")
    with pytest.raises(llm.LLMError, match="已重试"):
        llm.ask("q2")
    assert len(fake_claude.calls(log)) == 4


def test_timeout_is_not_retried(log, monkeypatch):
    monkeypatch.setenv("FAKE_MODE", "sleep")
    with pytest.raises(llm.LLMError, match="超时"):
        llm.ask("q", timeout=0.5)
    assert len(fake_claude.calls(log)) == 1


def test_cache_hits_skip_the_cli_and_no_cache_skips_both_ways(log):
    assert llm.ask("同一个问题") == "你好"
    assert llm.ask("同一个问题") == "你好"
    assert len(fake_claude.calls(log)) == 1
    llm.ask("生成", use_cache=False)
    llm.ask("生成", use_cache=False)
    assert len(fake_claude.calls(log)) == 3
    assert not any("生成" in p.read_text(encoding="utf-8") for p in llm.cache_dir().glob("*.json"))


def test_every_real_call_is_logged_with_usage(log):
    llm.ask("q", purpose="generate")
    llm.ask("q", purpose="generate")  # 命中缓存，不记 / cache hit, not logged
    rows, _ = store.read_lines(llm.runs_dir() / "llm.jsonl")
    assert len(rows) == 1
    assert rows[0]["purpose"] == "generate" and rows[0]["ok"] is True
    assert rows[0]["cost_usd"] == 0.0123 and rows[0]["output_tokens"] == 20


def test_missing_binary_is_reported(monkeypatch, tmp_path):
    monkeypatch.setenv("IDEA_LOOM_CLAUDE_BIN", str(tmp_path / "nope"))
    monkeypatch.setenv("IDEA_LOOM_CACHE", str(tmp_path / "cache"))
    assert llm.available() is False
    with pytest.raises(llm.LLMError, match="找不到"):
        llm.ask("q")


def test_extract_json_variants():
    assert llm.extract_json('前言 {"a": 1} 后话') == {"a": 1}
    assert llm.extract_json("```json\n[1, 2]\n```") == [1, 2]
    with pytest.raises(ValueError):
        llm.extract_json("没有")
