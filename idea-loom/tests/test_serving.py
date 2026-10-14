"""后端自己重启：什么时候重启、看守怎么接着做、接口和计数。

The backend restarting itself: when to restart, what the keeper does next, the endpoint and the request count.
"""

from __future__ import annotations

import asyncio
import signal

import pytest
from fastapi.testclient import TestClient

from idea_loom import serving
from idea_loom.server import app

NOW = 1_000_000.0


def test_nothing_to_do_while_the_code_is_current():
    assert serving.decide(stale=False, requested=False, newest=NOW - 100, now=NOW, busy=None) == ("idle", None)
    # 进程里有事也一样：不重启就不用等。 / Work in the process makes no difference: nothing to wait for without a restart.
    assert serving.decide(stale=False, requested=False, newest=NOW - 100, now=NOW, busy="x") == ("idle", None)


def test_stale_code_restarts_once_it_has_settled_and_nothing_is_in_flight():
    assert serving.decide(stale=True, requested=False, newest=NOW - 60, now=NOW, busy=None) == ("restart", None)


def test_code_still_being_edited_waits():
    """刚改过的代码可能还会接着改（一个会话正在一处一处改），等它静下来。 / Code just changed may change again (a session editing it file by file); wait for quiet."""
    action, why = serving.decide(stale=True, requested=False, newest=NOW - 1, now=NOW, busy=None)
    assert action == "wait" and why


def test_work_in_the_process_holds_the_restart():
    assert serving.decide(stale=True, requested=False, newest=NOW - 60, now=NOW, busy="小助手正在回答") == ("wait", "小助手正在回答")
    assert serving.decide(stale=False, requested=True, newest=NOW - 60, now=NOW, busy="1 个请求") == ("wait", "1 个请求")


def test_restart_now_skips_the_settling_but_not_the_work_in_flight():
    assert serving.decide(stale=False, requested=True, newest=NOW - 60, now=NOW, busy=None) == ("restart", None)
    assert serving.decide(stale=True, requested=True, newest=NOW - 1, now=NOW, busy=None) == ("restart", None)


def test_after_exit():
    assert serving.after_exit(serving.RESTART_EXIT, 3) == "restart"
    for clean in (0, -signal.SIGINT, -signal.SIGTERM, 130):
        assert serving.after_exit(clean, 3) == "stop"
    # 刚起来就崩：多半是新代码坏了，等它再变。跑了一阵才崩：再起一个。
    # A crash right after start most likely means broken new code: wait for it to change. A crash after a while: start again.
    assert serving.after_exit(1, 2) == "wait"
    assert serving.after_exit(1, 3600) == "restart"


def test_busy_counts_assistant_answers_and_requests(monkeypatch):
    from idea_loom.assistant import turns

    monkeypatch.setattr(turns, "_by_conversation", {})
    monkeypatch.setattr(serving, "_in_flight", 0)
    assert serving._busy() is None
    monkeypatch.setattr(serving, "_in_flight", 2)
    assert "2" in (serving._busy() or "")
    monkeypatch.setattr(turns, "_by_conversation", {"c1": object()})
    assert "assistant" in (serving._busy() or "")


def _run(middleware, content_type: bytes, seen: list[int]):
    async def inner(scope, receive, send):
        seen.append(serving._in_flight)
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", content_type)]})
        seen.append(serving._in_flight)
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    async def send(_message):
        return None

    async def receive():
        return {"type": "http.request"}

    asyncio.run(middleware(inner)({"type": "http"}, receive, send))


def test_in_flight_counts_a_request_until_it_is_answered(monkeypatch):
    monkeypatch.setattr(serving, "_in_flight", 0)
    seen: list[int] = []
    _run(serving.InFlight, b"application/json", seen)
    assert seen == [1, 1]
    assert serving._in_flight == 0


def test_an_event_stream_stops_counting_once_it_starts(monkeypatch):
    """事件流一直开着：开始回答就不算在处理了，否则永远等不到重启。 / Event streams stay open: once answering they no longer count, or a restart would wait forever."""
    monkeypatch.setattr(serving, "_in_flight", 0)
    seen: list[int] = []
    _run(serving.InFlight, b"text/event-stream", seen)
    assert seen == [1, 0]
    assert serving._in_flight == 0


@pytest.fixture
def local(seeded, monkeypatch):
    monkeypatch.delenv("IDEA_LOOM_ROLE", raising=False)
    monkeypatch.delenv("IDEA_LOOM_SIM_DOMAIN", raising=False)
    monkeypatch.setattr(serving, "_requested", False)
    monkeypatch.setattr(serving, "_waiting", None)
    return TestClient(app, base_url="http://localhost:8767")


def test_restart_needs_the_keeper(local, monkeypatch):
    """不是 idea-loom serve 起的后端没法自己重启，要说清楚。 / A backend not started by idea-loom serve cannot restart itself, and says so."""
    monkeypatch.setattr(serving, "_server", None)
    r = local.post("/api/restart")
    assert r.status_code == 409 and "idea-loom serve" in r.json()["detail"]
    health = local.get("/api/health").json()
    assert health["self_restart"] is False and health["restart_waiting"] is None


def test_restart_now_asks_the_watcher(local, monkeypatch):
    from idea_loom.assistant import turns

    monkeypatch.setattr(serving, "_server", object())
    monkeypatch.setattr(turns, "_by_conversation", {"c1": object()})
    r = local.post("/api/restart")
    assert r.status_code == 200
    assert r.json()["restarting"] is True and "assistant" in r.json()["waiting"]
    assert serving._requested is True
    assert local.get("/api/health").json()["self_restart"] is True


def test_restart_is_local_only(local, monkeypatch):
    monkeypatch.setattr(serving, "_server", object())
    monkeypatch.setenv("IDEA_LOOM_ROLE", "hub")
    assert local.post("/api/restart").status_code == 404
    assert local.get("/api/health").json()["self_restart"] is False
    assert serving._requested is False
