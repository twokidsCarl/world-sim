"""部署配置：本地什么都不用设，云端靠几个环境变量。

本地：一个进程做所有事（角色 all），模拟在 http://<项目>.localhost:<端口>/。
云端：同一份代码按角色分成几个容器——hub（界面、接口）、play（构建并运行各模拟，不带任何密钥）、
worker（改代码的作业，持有订阅令牌）；模拟在 https://<项目>.<IDEA_LOOM_SIM_DOMAIN>/。

Deployment configuration: nothing to set locally, a few environment variables in the
cloud. Locally one process does everything (role "all") and simulations live at
http://<project>.localhost:<port>/. In the cloud the same code runs as several containers
by role — hub (UI and API), play (builds and runs the simulations, holding no secrets) and
worker (code-changing jobs, holding the subscription token) — and simulations live at
https://<project>.<IDEA_LOOM_SIM_DOMAIN>/.

环境变量 / Environment:
    IDEA_LOOM_ROLE         all | hub | play | worker（缺省 all / default all）
    IDEA_LOOM_SIM_DOMAIN   模拟的子域名挂在哪个域名下，例如 sim.example.com（缺省 localhost）
                           the domain simulations hang under, e.g. sim.example.com (default localhost)
    IDEA_LOOM_PUBLIC_URL   idea-loom 自己对外的地址，例如 https://loom.example.com
                           idea-loom's own public address, e.g. https://loom.example.com
    IDEA_LOOM_PLAY_URL     hub 找 play 的内部地址，例如 http://play:8768 / where hub reaches play internally
    IDEA_LOOM_INTERNAL_TOKEN  hub 和 play 之间内部接口的口令 / shared token for the internal API between hub and play
"""

from __future__ import annotations

import os
from typing import Optional
from urllib.parse import urlparse

ROLES = ("all", "hub", "play", "worker")


def role() -> str:
    value = os.environ.get("IDEA_LOOM_ROLE", "all")
    return value if value in ROLES else "all"


def serves_sims() -> bool:
    return role() in ("all", "play")


def serves_hub() -> bool:
    return role() in ("all", "hub")


def sim_domain() -> str:
    return (os.environ.get("IDEA_LOOM_SIM_DOMAIN") or "localhost").strip(".").lower()


def is_local() -> bool:
    return sim_domain() == "localhost"


def public_url() -> Optional[str]:
    value = os.environ.get("IDEA_LOOM_PUBLIC_URL", "").rstrip("/")
    return value or None


def own_hosts() -> set[str]:
    """idea-loom 自己的主机名。来自这些主机的页面才能调它的接口。

    idea-loom's own host names. Only pages served from these may call its API.
    """
    hosts = {"localhost", "127.0.0.1", "[::1]", "testserver"} if is_local() else set()
    if public_url():
        hosts.add((urlparse(public_url()).hostname or "").lower())
    return hosts - {""}


def sim_origin(name: str, local_port: str) -> str:
    """一个模拟自己的源。本地带端口走 http；云端走 https、不带端口。

    A simulation's own origin: http with a port locally, https without one in the cloud.
    """
    return f"http://{name}.localhost:{local_port}" if is_local() else f"https://{name}.{sim_domain()}"


def play_url() -> Optional[str]:
    value = os.environ.get("IDEA_LOOM_PLAY_URL", "").rstrip("/")
    return value or None


def internal_token() -> str:
    return os.environ.get("IDEA_LOOM_INTERNAL_TOKEN", "")
