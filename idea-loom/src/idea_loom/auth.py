"""登录与权限：谁是主人，谁是访客，谁只是路过。

本地不用登录：没有配置主人的 GitHub 账号时，所有请求都当作主人（和原来一样）。
云端配置了 IDEA_LOOM_OWNER 之后，用 GitHub 登录认人：

    游客   没登录。能看（地图、想法池、idea、血缘）、能玩。
    访客   登录了但不是主人。再加上记自己的观看和收藏。
    主人   IDEA_LOOM_OWNER 那个账号。其余全部：会改动的、会调用模型的、统计、作业。

会话是一个签了名的 cookie，服务器这边不存会话，所以重启不掉登录。
模型只为主人调用：这既是成本控制，也是订阅条款的要求（不能用个人订阅替别的用户转发请求）。

Sign-in and roles: who is the owner, who is a member, who is just passing by. Locally
nobody signs in: without an owner's GitHub account configured, every request counts as
the owner (as before). In the cloud, with IDEA_LOOM_OWNER set, GitHub sign-in tells people
apart: a guest (not signed in) can browse and play; a member (signed in, not the owner)
can also record their own watching and likes; the owner can do everything else — anything
that changes data or calls the model, statistics, jobs. The session is a signed cookie
with nothing stored on the server, so a restart does not sign anyone out. The model is
only ever called for the owner, both to control cost and because the subscription terms
forbid routing other users' requests through personal plan credentials.

环境变量 / Environment:
    IDEA_LOOM_OWNER                 主人的 GitHub 用户名；不设就是本地模式 / the owner's GitHub login; unset means local mode
    IDEA_LOOM_GITHUB_CLIENT_ID      GitHub OAuth 应用 / the GitHub OAuth app
    IDEA_LOOM_GITHUB_CLIENT_SECRET
    IDEA_LOOM_SESSION_SECRET        给 cookie 签名用的密钥 / the key that signs the cookie
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Literal, Optional

from pydantic import BaseModel

from . import config

Role = Literal["guest", "member", "owner"]
RANK: dict[str, int] = {"guest": 0, "member": 1, "owner": 2}
COOKIE = "loom_session"
STATE_COOKIE = "loom_oauth_state"
SESSION_SECONDS = 30 * 24 * 3600


class User(BaseModel):
    role: Role
    login: str = ""
    name: str = ""
    avatar: str = ""
    agent: str = ""  # 带着令牌来的 Agent 的名字 / the name of an agent that came with a token
    scopes: list[str] = []
    auth_enabled: bool = False  # 假就是本地模式：不用登录，人人是主人 / false means local mode: no sign-in, everyone is the owner


def owner_login() -> str:
    return os.environ.get("IDEA_LOOM_OWNER", "").strip().lower()


def enabled() -> bool:
    return bool(owner_login())


def _secret() -> bytes:
    value = os.environ.get("IDEA_LOOM_SESSION_SECRET", "")
    if not value:
        raise RuntimeError("配置了 IDEA_LOOM_OWNER 就必须配置 IDEA_LOOM_SESSION_SECRET")
    return value.encode("utf-8")


def sign(payload: dict[str, Any]) -> str:
    body = base64.urlsafe_b64encode(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).decode("ascii").rstrip("=")
    mac = hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{body}.{mac}"


def unsign(token: str) -> Optional[dict[str, Any]]:
    """验签并检查没过期。任何不对都返回 None。 / Verify the signature and the expiry; anything wrong gives None."""
    try:
        body, mac = token.rsplit(".", 1)
        expected = hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(mac, expected):
            return None
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
    except (ValueError, RuntimeError, UnicodeError):
        return None
    if not isinstance(payload, dict) or float(payload.get("exp", 0)) < time.time():
        return None
    return payload


def user_from_cookie(cookie: Optional[str]) -> User:
    if not enabled():
        return User(role="owner", login="local", auth_enabled=False)
    payload = unsign(cookie) if cookie else None
    if not payload or not payload.get("login"):
        return User(role="guest", auth_enabled=True)
    login = str(payload["login"]).lower()
    return User(role="owner" if login == owner_login() else "member", login=login, name=str(payload.get("name") or login),
                avatar=str(payload.get("avatar") or ""), auth_enabled=True)


def session_cookie(login: str, name: str = "", avatar: str = "") -> str:
    return sign({"login": login.lower(), "name": name, "avatar": avatar, "exp": time.time() + SESSION_SECONDS})


# ---------- 哪个接口要什么身份 / which route needs which role ----------

# 游客能读的。没列在这里的 GET，以及所有会改动的请求，默认只有主人能用。
# What a guest may read. Any GET not listed here, and every request that changes something,
# is owner-only by default.
GUEST_GET = [
    r"^/api/health$", r"^/api/me$", r"^/api/state$", r"^/api/ideas/[^/]+$", r"^/api/play$", r"^/api/projects$", r"^/api/tasks$",
    # 给外来的 Agent 的那一层：只读的全部对所有人开放。 / The layer for outside agents: everything read-only is open to all.
    r"^/api/v1/catalog$", r"^/api/v1/ideas(/[^/]+)?$", r"^/api/v1/cards$", r"^/api/v1/datasets/[^/]+/[^/]+(/schema)?$", r"^/api/v1/capabilities/[^/]+/[^/]+$",
]
# 登录的访客另外能做的。 / What a signed-in member may do in addition.
MEMBER = [
    ("POST", r"^/api/trail$"),
    ("GET", r"^/api/suggestions/mine$"),   # 自己提过的愿望 / the wishes one has sent
    ("POST", r"^/api/suggestions$"),       # 提一条，进待主人过目的队列；不调用模型 / send one into the owner's queue; no model call
]
_GUEST_GET = [re.compile(p) for p in GUEST_GET]
_MEMBER = [(m, re.compile(p)) for m, p in MEMBER]


# 没登录也能发的 POST：只有"跑一次有界的计算"。 / The only POST open without signing in: running one bounded computation.
_GUEST_POST = [re.compile(r"^/api/v1/run/[^/]+/[^/]+$")]
# 提议：登录的访客，或者带着有 propose 权限的令牌的 Agent。 / Proposals: a signed-in member, or an agent whose token has the propose scope.
_PROPOSE = re.compile(r"^/api/v1/proposals/(idea|wish)$")


def user_from_request(cookie: Optional[str], authorization: Optional[str]) -> User:
    """先看令牌，再看登录的 cookie。令牌不给登录身份，只给 Agent 的名字和权限。

    A token is looked at first, then the sign-in cookie. A token grants no signed-in role, only the agent's name and scopes.
    """
    user = user_from_cookie(cookie)
    if authorization and authorization.lower().startswith("bearer "):
        from .agentapi import tokens

        found = tokens.lookup(authorization[7:].strip())
        if found:
            user.agent, user.scopes = found["name"], found["scopes"]
    return user


def required_role(method: str, path: str) -> Role:
    if method in ("GET", "HEAD") and any(p.match(path) for p in _GUEST_GET):
        return "guest"
    if method == "POST" and any(p.match(path) for p in _GUEST_POST):
        return "guest"
    if any(m == method and p.match(path) for m, p in _MEMBER):
        return "member"
    return "owner"


def allowed(user: User, method: str, path: str) -> bool:
    if method == "POST" and _PROPOSE.match(path):
        return RANK[user.role] >= RANK["member"] or "propose" in user.scopes
    return RANK[user.role] >= RANK[required_role(method, path)]


# ---------- GitHub 登录 / GitHub sign-in ----------


def client_id() -> str:
    return os.environ.get("IDEA_LOOM_GITHUB_CLIENT_ID", "")


def callback_url() -> str:
    return f"{config.public_url() or ''}/auth/callback"


def authorize_url(state: str) -> str:
    query = urllib.parse.urlencode({"client_id": client_id(), "redirect_uri": callback_url(), "state": state, "scope": "read:user", "allow_signup": "false"})
    return f"https://github.com/login/oauth/authorize?{query}"


def new_state() -> str:
    return secrets.token_urlsafe(24)


def _post_json(url: str, data: dict[str, str]) -> dict[str, Any]:
    request = urllib.request.Request(url, data=urllib.parse.urlencode(data).encode("utf-8"), headers={"accept": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def _get_json(url: str, token: str) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"accept": "application/vnd.github+json", "authorization": f"Bearer {token}", "user-agent": "idea-loom"})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.loads(response.read().decode("utf-8"))


def exchange(code: str) -> dict[str, str]:
    """用 GitHub 给的一次性代码换出这个人是谁。只取用户名、显示名和头像，不留 GitHub 的令牌。

    Exchange GitHub's one-time code for who this person is. Only the login, display name
    and avatar are kept; GitHub's token is not stored.
    """
    try:
        token = _post_json("https://github.com/login/oauth/access_token", {
            "client_id": client_id(), "client_secret": os.environ.get("IDEA_LOOM_GITHUB_CLIENT_SECRET", ""), "code": code, "redirect_uri": callback_url(),
        }).get("access_token")
        if not token:
            raise ValueError("GitHub 没有给令牌")
        profile = _get_json("https://api.github.com/user", str(token))
    except (OSError, ValueError, urllib.error.URLError) as e:
        raise ValueError(f"GitHub 登录没有成功：{e}") from e
    login = str(profile.get("login") or "")
    if not login:
        raise ValueError("GitHub 没有给用户名")
    return {"login": login, "name": str(profile.get("name") or login), "avatar": str(profile.get("avatar_url") or "")}


# ---------- 限流 / rate limiting ----------


class Limiter:
    """每个键一个滑动窗口。只在一个进程里有效，够一台主机用。

    A sliding window per key. Valid within one process, which is enough for one host.
    """

    def __init__(self, limit: int, seconds: float) -> None:
        self.limit, self.seconds = limit, seconds
        self.hits: dict[str, list[float]] = {}

    def allow(self, key: str, now: Optional[float] = None) -> bool:
        now = now or time.time()
        recent = [t for t in self.hits.get(key, []) if now - t < self.seconds]
        if len(recent) >= self.limit:
            self.hits[key] = recent
            return False
        recent.append(now)
        self.hits[key] = recent
        if len(self.hits) > 20000:  # 别让它无限长大 / do not let it grow without bound
            self.hits = {k: v for k, v in self.hits.items() if v and now - v[-1] < self.seconds}
        return True
