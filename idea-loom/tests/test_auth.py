import time

import pytest
from fastapi.testclient import TestClient

from idea_loom import auth, trail
from idea_loom.play import host
from idea_loom.server import app


@pytest.fixture
def cloud(seeded, monkeypatch):
    """云端模式：配置了主人，接口按身份放行。 / Cloud mode: an owner is configured and routes are gated by role."""
    monkeypatch.setenv("IDEA_LOOM_OWNER", "Carl")
    monkeypatch.setenv("IDEA_LOOM_SESSION_SECRET", "test-secret")
    monkeypatch.setenv("IDEA_LOOM_GITHUB_CLIENT_ID", "cid")
    monkeypatch.setenv("IDEA_LOOM_GITHUB_CLIENT_SECRET", "csecret")
    monkeypatch.setenv("IDEA_LOOM_PUBLIC_URL", "https://loom.example.com")
    monkeypatch.setenv("IDEA_LOOM_SIM_DOMAIN", "sim.example.com")
    monkeypatch.setattr(host, "HUB_API_LIMIT", auth.Limiter(10_000, 60))

    def client(login=None):
        c = TestClient(app, base_url="https://loom.example.com", follow_redirects=False)
        if login:
            c.cookies.set(auth.COOKIE, auth.session_cookie(login, name=login))
        return c

    return client


def test_local_mode_everyone_is_the_owner(seeded):
    c = TestClient(app, base_url="http://localhost:8767")
    assert c.get("/api/me").json() == {"role": "owner", "login": "local", "name": "", "avatar": "", "auth_enabled": False}
    assert c.post("/api/ideas/1.2/discard", json={}).status_code == 200
    assert c.get("/auth/login").status_code == 404


def test_signed_cookie_round_trip_and_tampering(cloud):
    token = auth.session_cookie("Carl", name="Carl Li")
    assert auth.user_from_cookie(token).role == "owner" and auth.user_from_cookie(token).name == "Carl Li"
    assert auth.user_from_cookie(auth.session_cookie("someone")).role == "member"
    assert auth.user_from_cookie(None).role == "guest"
    body, mac = token.rsplit(".", 1)
    assert auth.user_from_cookie(body + "." + "0" * len(mac)).role == "guest"
    forged = auth.sign({"login": "carl", "exp": time.time() - 1})
    assert auth.user_from_cookie(forged).role == "guest"  # 过期了 / expired
    assert auth.user_from_cookie("garbage").role == "guest"


def test_required_roles():
    assert auth.required_role("GET", "/api/state") == "guest"
    assert auth.required_role("GET", "/api/ideas/4.2") == "guest"
    assert auth.required_role("GET", "/api/play") == "guest"
    assert auth.required_role("POST", "/api/trail") == "member"
    for method, path in [("GET", "/api/stats"), ("GET", "/api/wishes"), ("GET", "/api/jobs"), ("GET", "/api/proposals"), ("GET", "/api/assistant"),
                         ("POST", "/api/ideas"), ("POST", "/api/ideas/1.1/edit"), ("POST", "/api/ops/generate"), ("POST", "/api/jobs"),
                         ("POST", "/api/jobs/x/approve"), ("POST", "/api/sync"), ("POST", "/api/assistant/conversations"), ("POST", "/api/review"),
                         ("POST", "/api/play/strata/build"), ("GET", "/api/something-new")]:
        assert auth.required_role(method, path) == "owner", (method, path)


def test_guests_can_read_but_not_change_or_reach_the_model(cloud):
    guest = cloud()
    assert guest.get("/api/me").json()["role"] == "guest"
    assert guest.get("/api/state").status_code == 200 and guest.get("/api/ideas/1.2").status_code == 200
    for method, path in [("get", "/api/stats"), ("get", "/api/wishes"), ("get", "/api/jobs"), ("get", "/api/proposals"), ("get", "/api/assistant/conversations")]:
        r = getattr(guest, method)(path)
        assert r.status_code == 401 and r.json()["detail"] == "请先登录", path
    for path in ["/api/ideas/1.2/discard", "/api/ops/generate", "/api/jobs", "/api/sync", "/api/assistant/conversations", "/api/trail", "/api/review"]:
        assert guest.post(path, json={}).status_code == 401, path
    assert guest.get("/api/ideas/1.2").json()["status"] == "pool"  # 什么都没被改 / nothing was changed


def test_members_are_stopped_at_owner_only_routes(cloud):
    member = cloud("someone")
    assert member.get("/api/me").json() == {"role": "member", "login": "someone", "name": "someone", "avatar": "", "auth_enabled": True}
    assert member.get("/api/state").status_code == 200
    for path in ["/api/ideas/1.2/discard", "/api/ops/generate", "/api/jobs", "/api/assistant/conversations", "/api/play/demo/build"]:
        r = member.post(path, json={})
        assert r.status_code == 403 and r.json()["detail"] == "这一步只有主人能做", path
    assert member.get("/api/stats").status_code == 403


def test_owner_passes(cloud):
    owner = cloud("carl")
    assert owner.get("/api/me").json()["role"] == "owner"
    assert owner.post("/api/ideas/1.2/discard", json={"reason": "试"}).status_code == 200
    assert owner.get("/api/wishes").status_code == 200


def test_trail_is_kept_per_person_from_the_session_not_the_body(cloud):
    action = {"at": "2026-10-11T08:00:00Z", "kind": "play", "url": "/play", "text": "demo/one", "seconds": 30, "card": "demo/one", "user": "carl"}
    assert cloud("someone").post("/api/trail", json={"actions": [action]}).status_code == 200
    assert cloud("carl").post("/api/trail", json={"actions": [{**action, "seconds": 5, "user": "someone"}]}).status_code == 200
    assert [a["seconds"] for a in trail.load()] == [5.0]            # 主人的 / the owner's
    assert [a["seconds"] for a in trail.load("someone")] == [30.0]  # 访客冒充不了主人 / a member cannot pose as the owner
    assert trail.card_history()["demo/one"].seconds == 5.0
    assert trail.card_history(user="someone")["demo/one"].seconds == 30.0


def test_github_sign_in_flow(cloud, monkeypatch):
    c = cloud()
    start = c.get("/auth/login")
    assert start.status_code == 302
    location = start.headers["location"]
    assert location.startswith("https://github.com/login/oauth/authorize?") and "client_id=cid" in location
    assert "redirect_uri=https%3A%2F%2Floom.example.com%2Fauth%2Fcallback" in location
    state = location.split("state=")[1].split("&")[0]
    monkeypatch.setattr(auth, "exchange", lambda code: {"login": "Carl", "name": "Carl Li", "avatar": "https://a/x.png"} if code == "good" else (_ for _ in ()).throw(ValueError("GitHub 登录没有成功")))
    assert c.get("/auth/callback?code=good&state=wrong").status_code == 400      # state 对不上 / state mismatch
    assert c.get(f"/auth/callback?code=bad&state={state}").status_code == 502
    done = c.get(f"/auth/callback?code=good&state={state}")
    assert done.status_code == 302 and done.headers["location"] == "/"
    cookie = done.headers["set-cookie"]
    assert "HttpOnly" in cookie and "Secure" in cookie and "samesite=lax" in cookie.lower()
    assert c.get("/api/me").json() == {"role": "owner", "login": "carl", "name": "Carl Li", "avatar": "https://a/x.png", "auth_enabled": True}
    c.post("/auth/logout")
    assert c.get("/api/me").json()["role"] == "guest"
    fresh = cloud()
    assert fresh.get(f"/auth/callback?code=good&state={state}").status_code == 400  # 没有发起过登录的浏览器 / a browser that never started sign-in


def test_rate_limits(cloud, monkeypatch):
    limiter = auth.Limiter(3, 60)
    assert [limiter.allow("a", now=100 + i) for i in range(4)] == [True, True, True, False]
    assert limiter.allow("b", now=101) and limiter.allow("a", now=200)
    monkeypatch.setattr(host, "HUB_API_LIMIT", auth.Limiter(2, 60))
    guest = cloud()
    assert [guest.get("/api/health").status_code for _ in range(3)] == [200, 200, 429]
