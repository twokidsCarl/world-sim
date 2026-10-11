"""跑一次计算：校验输入，转给这个项目自己的后端，带着版本和耗时返回。

项目的后端由统一入口按需启动（和玩的页面用的是同一个）。这里只做三件事：按能力声明的
JSON Schema 校验输入；限制时间和返回的大小；把结果包上"是哪个版本算的、花了多久"。

Run one computation: validate the input, hand it to the project's own backend, and return
with the version and the time taken. The backend is started on demand by the single entry
point (the same one the play page uses). Only three things happen here: the input is
validated against the JSON Schema the capability declares, time and reply size are bounded,
and the result is wrapped with which version computed it and how long it took.
"""

from __future__ import annotations

import re
import threading
import time
from typing import Any
from urllib.parse import quote, urlparse

import httpx
import jsonschema

from .. import config
from . import datasets
from .spec import Capability

MAX_REPLY_BYTES = 1_000_000
MAX_AT_ONCE = 4
_slots = threading.BoundedSemaphore(MAX_AT_ONCE)


class RunError(Exception):
    """没跑成。status 是给调用方的状态码，hint 告诉 Agent 怎么改。 / The run failed; status is the code for the caller and hint tells an agent what to change."""

    def __init__(self, status: int, error: str, hint: str = "") -> None:
        super().__init__(error)
        self.status, self.error, self.hint = status, error, hint


def validate(cap: Capability, payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise RunError(422, "输入要是一个 JSON 对象", "Send the input as a JSON object in the request body.")
    errors = sorted(jsonschema.Draft202012Validator(cap.input).iter_errors(payload), key=lambda e: list(e.path))
    if errors:
        first = errors[0]
        where = ".".join(str(p) for p in first.path) or "(the input object)"
        allowed = ", ".join(cap.input.get("properties", {}))
        raise RunError(422, f"输入不对：{where}: {first.message}", f"Allowed fields: {allowed}. A working example: {cap.example}")
    return payload


def _target(project: str, port: str) -> tuple[str, str]:
    """（往哪儿发，Host 头写什么）。本地发给自己，云端发给 play。 / (where to send, what Host header to use): to ourselves locally, to play in the cloud."""
    host = urlparse(config.sim_origin(project, port)).netloc
    return (config.play_url() or f"http://127.0.0.1:{port}"), host


def run(project: str, cap: Capability, payload: Any, port: str = "8767", client: httpx.Client | None = None) -> dict[str, Any]:
    data = dict(validate(cap, payload))
    path = cap.http.path
    for name in re.findall(r"\{(\w+)\}", path):
        if name not in data:
            raise RunError(422, f"缺少 {name}", f"A working example: {cap.example}")
        path = path.replace("{" + name + "}", quote(str(data.pop(name)), safe=""))
    base, host = _target(project, port)
    limit = max(10.0, cap.seconds * 3)
    if not _slots.acquire(timeout=5):
        raise RunError(429, "同时在跑的计算太多了，过几秒再试", "Retry after a few seconds.")
    started = time.monotonic()
    own = client is None
    client = client or httpx.Client(timeout=httpx.Timeout(limit, connect=5.0))
    try:
        if cap.http.method == "GET":
            response = client.get(base + path, params=data, headers={"host": host})
        else:
            response = client.post(base + path, json=data, headers={"host": host})
    except httpx.TimeoutException:
        raise RunError(504, f"超过 {limit:g} 秒还没算完，已经停掉", "Use a smaller input.") from None
    except httpx.HTTPError as e:
        raise RunError(502, f"连不上 {project} 的后端：{e}", "The project's backend may still be building; retry in a minute.") from None
    finally:
        _slots.release()
        if own:
            client.close()
    seconds = round(time.monotonic() - started, 3)
    if len(response.content) > MAX_REPLY_BYTES:
        raise RunError(413, f"结果有 {len(response.content)} 字节，超过了上限 {MAX_REPLY_BYTES}", "Ask for less: a smaller input or fewer levels.")
    try:
        body = response.json()
    except ValueError:
        body = response.text[:2000]
    if response.status_code >= 400:
        detail = body.get("detail") if isinstance(body, dict) else body
        status = response.status_code if response.status_code in (400, 404, 422) else 502
        raise RunError(status, f"{project} 的后端说：{detail}", f"Describe it with GET /api/v1/capabilities/{project}/{cap.id}. A working example: {cap.example}")
    return {"project": project, "capability": cap.id, "version": datasets.version(), "deterministic": cap.deterministic, "seconds": seconds,
            "input": payload, "result": body}
