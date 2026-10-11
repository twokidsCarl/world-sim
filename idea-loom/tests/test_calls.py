"""hub 把模型调用交给 worker：用假 claude 测。 / The hub hands model calls to the worker; tested with a fake claude."""

import json
import threading
import time

import pytest

import fake_claude as fc
from idea_loom import calls, gates, llm, store, worker
from idea_loom.assistant import turns
from test_assistant import PAGE, wait_done


@pytest.fixture
def serving(monkeypatch, tmp_path):
    """一个在后台替 hub 做模型调用的 worker。 / A worker serving the hub's model calls in the background."""
    monkeypatch.setenv("IDEA_LOOM_ROLE", "hub")
    monkeypatch.setenv("GH_TOKEN", "push-credential")
    monkeypatch.setenv("IDEA_LOOM_WORK", str(tmp_path / "work"))
    (tmp_path / "work" / "repo").mkdir(parents=True)
    monkeypatch.setattr(worker, "ensure_clone", lambda: None)
    stop = threading.Event()
    w = worker.Worker()

    def loop():
        while not stop.is_set():
            w.serve_calls()
            time.sleep(0.02)

    threads = []

    def start():
        w.serve_calls()  # 先报到一次 / check in once first
        threads.append(threading.Thread(target=loop, daemon=True))
        threads[-1].start()

    yield start
    # 等它真的停了再还原环境，否则它会在测试之后写到真实的运行目录里。
    # Wait until it has really stopped before the environment is restored, or it would write into the real runs directory after the test.
    stop.set()
    for t in threads + w.calls:
        t.join(timeout=10)


def test_without_a_worker_the_hub_says_so_at_once(tmp_path, monkeypatch, seeded, serving):
    fc.install(tmp_path, monkeypatch)
    assert llm.available() is False
    with pytest.raises(llm.LLMError, match="worker 没有在运行"):
        llm.ask("你好", use_cache=False)
    cid = turns.new_conversation()
    with pytest.raises(turns.TurnError, match="worker 没有在运行"):
        turns.start(cid, turns.TurnRequest(question="在吗？", page=PAGE))
    assert fc.calls(tmp_path / "calls.jsonl") == []


def test_a_model_call_on_the_hub_is_run_by_the_worker(tmp_path, monkeypatch, seeded, serving):
    log = fc.install(tmp_path, monkeypatch)
    monkeypatch.setenv("FAKE_STRUCTURED", json.dumps({"title": "沙堆"}))
    serving()
    assert llm.available() is True
    schema = {"type": "object", "properties": {"title": {"type": "string"}}, "required": ["title"]}
    assert llm.ask("给一个标题", system="你是编辑", schema=schema, use_cache=False, purpose="generate") == {"title": "沙堆"}
    (call,) = fc.calls(log)
    argv = call["argv"]
    assert call["stdin"] == "给一个标题" and argv[argv.index("--system-prompt") + 1] == "你是编辑" and argv[argv.index("--tools") + 1] == ""
    assert [r["purpose"] for r in store.read_lines(store.runs_dir() / "llm.jsonl")[0]] == ["generate"]


def test_a_slip_carries_data_only_and_cannot_choose_the_command(tmp_path, monkeypatch, seeded, serving):
    log = fc.install(tmp_path, monkeypatch)
    w = worker.Worker()
    slip = calls.submit("llm", {"prompt": "x", "model": "sonnet", "argv": ["/bin/sh", "-c", "touch pwned"], "binary": "/bin/sh", "cwd": str(tmp_path)})
    odd = calls.root() / "0-odd"
    odd.mkdir()
    store.write_json(odd / "request.json", {"kind": "shell", "prompt": "touch pwned"})
    assert w.serve_calls() == 2
    for d in (slip, odd):
        for _ in range(200):
            if (d / "done.json").exists():
                break
            time.sleep(0.02)
    (call,) = fc.calls(log)                                  # 只跑了 claude，命令是 worker 自己拼的 / only claude ran, with the worker's own command
    assert "/bin/sh" not in call["argv"] and "touch pwned" not in " ".join(call["argv"]) and not (tmp_path / "pwned").exists()
    assert "不认识的调用" in calls.outcome(odd)["error"] and w.serve_calls() == 0


def test_an_assistant_turn_on_the_hub_streams_back_from_the_worker(tmp_path, monkeypatch, seeded, serving):
    soon = time.time() + 600
    limit = {"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "resetsAt": soon, "unifiedWindows": {"five_hour": {"utilization": 0.41, "resetsAt": soon}}}}
    log = fc.install_stream(tmp_path, monkeypatch, [limit, fc.text_delta("这一条"), fc.tool_use("t1", "Read", {"file_path": "x"}), fc.tool_result("t1"), fc.text_delta("讲的是临界。"), fc.result()])
    serving()
    cid = turns.new_conversation()
    turn = turns.start(cid, turns.TurnRequest(question="这一页讲什么？", page=PAGE, idea_id="1.2"))
    events = wait_done(cid, turn)
    assert [e["type"] for e in events] == ["started", "text", "step", "step", "text", "done"] and events[-1]["text"] == "这一条讲的是临界。"
    (call,) = fc.calls(log)
    assert "这一页讲什么？" in call["stdin"] and call["has_push_token"] is False and call["scrub"] == "1"
    mcp = json.loads(call["argv"][call["argv"].index("--mcp-config") + 1])
    assert mcp["mcpServers"]["loom"]["env"]["IDEA_LOOM_TURN_TOKEN"]             # 工具回调用这一轮的令牌 / tool callbacks use this turn's token
    assert gates.usage()["windows"]["five_hour"]["utilization"] == 0.41         # 额度照样记 / the allowance is still recorded


def test_stopping_a_turn_on_the_hub_stops_it_on_the_worker(tmp_path, monkeypatch, seeded, serving):
    fc.install_stream(tmp_path, monkeypatch, [fc.text_delta("慢慢说"), {"type": "sleep", "seconds": 20}, fc.result()])
    serving()
    cid = turns.new_conversation()
    turn = turns.start(cid, turns.TurnRequest(question="讲长一点", page=PAGE))
    for _ in range(200):
        if any(e["type"] == "text" for e in turns.events(cid, turn)):
            break
        time.sleep(0.02)
    started = time.time()
    assert turns.stop(cid) is True
    assert wait_done(cid, turn)[-1]["type"] == "stopped" and time.time() - started < 5


def test_a_relayed_turn_that_cannot_run_says_why(tmp_path, monkeypatch, seeded, serving):
    fc.install_stream(tmp_path, monkeypatch, [fc.text_delta("不会走到这里"), fc.result()])
    monkeypatch.setattr(worker, "ensure_clone", lambda: (_ for _ in ()).throw(RuntimeError("取不到 main")))
    serving()
    cid = turns.new_conversation()
    last = wait_done(cid, turns.start(cid, turns.TurnRequest(question="在吗？", page=PAGE)))[-1]
    assert last["type"] == "failed" and "取不到 main" in last["message"]
