"""推送通知：用假的发送函数测，不联网。 / Push notifications, tested with a fake delivery function and no network."""

import json

import pytest
from fastapi.testclient import TestClient

from idea_loom import notify, suggestions
from idea_loom.server import app

SUB = {"endpoint": "https://push.example/abc", "keys": {"p256dh": "k1", "auth": "k2"}}


@pytest.fixture
def push(seeded, monkeypatch):
    pair = notify.generate_keys()
    monkeypatch.setenv("IDEA_LOOM_VAPID_PUBLIC", pair["public"])
    monkeypatch.setenv("IDEA_LOOM_VAPID_PRIVATE", pair["private"])
    sent = []
    status = {}

    def deliver(subscription, payload):
        sent.append((subscription["endpoint"], json.loads(payload)))
        return status.get(subscription["endpoint"], 201)

    monkeypatch.setattr(notify, "_deliver", deliver)
    return sent, status


def test_nothing_happens_without_keys_or_subscribers(seeded, monkeypatch):
    monkeypatch.delenv("IDEA_LOOM_VAPID_PUBLIC", raising=False)
    assert notify.configured() is False and notify.send("x") == 0
    client = TestClient(app, base_url="http://localhost:8767")
    assert client.get("/api/push").json() == {"configured": False, "public_key": "", "devices": 0}
    assert client.post("/api/push/subscribe", json={"subscription": SUB}).status_code == 422


def test_generated_keys_are_a_usable_pair():
    from py_vapid import Vapid

    pair = notify.generate_keys()
    assert len(pair["public"]) == 87 and len(pair["private"]) == 43 and Vapid.from_string(pair["private"]) is not None


def test_subscribe_send_and_drop_dead_endpoints(push):
    sent, status = push
    client = TestClient(app, base_url="http://localhost:8767")
    assert client.get("/api/push").json()["configured"] is True
    assert client.post("/api/push/subscribe", json={"subscription": {"endpoint": "http://insecure.example", "keys": SUB["keys"]}}).status_code == 422
    assert client.post("/api/push/subscribe", json={"subscription": SUB}).json() == {"devices": 1}
    assert client.post("/api/push/subscribe", json={"subscription": SUB}).json() == {"devices": 1}      # 同一个地址只记一次 / once per endpoint
    other = {"endpoint": "https://push.example/gone", "keys": SUB["keys"]}
    assert client.post("/api/push/subscribe", json={"subscription": other}).json() == {"devices": 2}
    status["https://push.example/gone"] = 410
    assert notify.send("方案出来了", "看一下", url="https://evil.example", tag="t", wait=True) == 2
    assert [e for e, _ in sent] == ["https://push.example/abc", "https://push.example/gone"]
    assert sent[0][1] == {"title": "方案出来了", "body": "看一下", "url": "/", "tag": "t"}            # 只收站内的地址 / in-site URLs only
    assert [s["endpoint"] for s in notify.subscriptions()] == ["https://push.example/abc"]            # 失效的被删掉 / the dead one is removed
    assert client.post("/api/push/unsubscribe", json={"endpoint": SUB["endpoint"]}).json() == {"devices": 0}


def test_a_visitor_wish_notifies_the_owner(push, monkeypatch):
    sent, _ = push
    notify.subscribe(SUB)
    monkeypatch.setattr(notify.threading, "Thread", lambda target, **kw: type("T", (), {"start": lambda self: target()})())
    suggestions.send("someone", "play 页想按层筛选")
    assert sent[-1][1] == {"title": "有访客提了愿望，等你过目", "body": "someone：play 页想按层筛选", "url": "/wishes", "tag": "suggestions"}


def test_only_the_owner_may_subscribe():
    from idea_loom import auth

    for method, path in [("GET", "/api/push"), ("POST", "/api/push/subscribe"), ("POST", "/api/push/test")]:
        assert auth.required_role(method, path) == "owner"
