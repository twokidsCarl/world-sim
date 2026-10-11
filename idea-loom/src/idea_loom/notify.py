"""推送通知：需要主人拿主意、或者有结果的时候，直接推到他的手机上。

    方案出来了，等批准          作业完成 / 失败
    有访客提了愿望              订阅额度到线，队列暂停了

用的是浏览器自带的 Web Push：主人在界面上点一次"开通知"，浏览器给一个推送地址，存在这里。
没有配置密钥、或者没人订阅时，这里什么都不做。通知只发给主人。

Push notifications: when the owner has to decide something, or a result is in, it goes
straight to their phone — a plan waiting for approval, a job finished or failed, a visitor
sent a wish, the queue paused at the allowance threshold. This uses the browser's own Web
Push: the owner turns notifications on once in the UI, the browser hands over a push
endpoint, and it is stored here. Without keys configured, or with nobody subscribed, this
module does nothing. Notifications go to the owner only.

环境变量 / Environment（用 `idea-loom push keys` 生成一对 / generate a pair with `idea-loom push keys`）:
    IDEA_LOOM_VAPID_PUBLIC    公钥，给浏览器 / the public key, given to the browser
    IDEA_LOOM_VAPID_PRIVATE   私钥，只在服务器上 / the private key, on the server only
    IDEA_LOOM_VAPID_SUBJECT   联系方式（mailto: 或 https:），推送服务要求的 / a contact (mailto: or https:), required by push services
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from . import config, store

MAX_SUBSCRIPTIONS = 10


def public_key() -> str:
    return os.environ.get("IDEA_LOOM_VAPID_PUBLIC", "")


def _private_key() -> str:
    return os.environ.get("IDEA_LOOM_VAPID_PRIVATE", "")


def subject() -> str:
    return os.environ.get("IDEA_LOOM_VAPID_SUBJECT") or config.public_url() or "mailto:owner@localhost"


def configured() -> bool:
    return bool(public_key() and _private_key())


def generate_keys() -> dict[str, str]:
    """生成一对密钥。 / Generate a key pair."""
    from cryptography.hazmat.primitives import serialization
    from py_vapid import Vapid01

    vapid = Vapid01()
    vapid.generate_keys()

    def b64(raw: bytes) -> str:
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    return {
        "public": b64(vapid.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)),
        "private": b64(vapid.private_key.private_numbers().private_value.to_bytes(32, "big")),
    }


def _path() -> Path:
    return store.runs_dir() / "push.json"


def subscriptions() -> list[dict[str, Any]]:
    rows = store.read_json(_path(), [])
    return rows if isinstance(rows, list) else []


def subscribe(subscription: dict[str, Any]) -> int:
    """记下一个浏览器的推送地址。同一个地址只记一次。 / Record a browser's push endpoint, once per endpoint."""
    endpoint = str(subscription.get("endpoint") or "")
    keys = subscription.get("keys") if isinstance(subscription.get("keys"), dict) else {}
    if urlparse(endpoint).scheme != "https" or not keys.get("p256dh") or not keys.get("auth"):
        raise ValueError("这不是一个有效的推送订阅")
    rows = [r for r in subscriptions() if r.get("endpoint") != endpoint]
    rows.append({"endpoint": endpoint, "keys": {"p256dh": str(keys["p256dh"]), "auth": str(keys["auth"])}, "at": time.time()})
    store.write_json(_path(), rows[-MAX_SUBSCRIPTIONS:])
    return len(rows[-MAX_SUBSCRIPTIONS:])


def unsubscribe(endpoint: str) -> int:
    rows = [r for r in subscriptions() if r.get("endpoint") != endpoint]
    store.write_json(_path(), rows)
    return len(rows)


def _deliver(subscription: dict[str, Any], payload: str) -> Optional[int]:
    """发给一个订阅。返回推送服务的状态码；没发出去返回 None。 / Send to one subscription; the push service's status code, or None if it never went out."""
    from pywebpush import WebPushException, webpush

    try:
        webpush(subscription_info={"endpoint": subscription["endpoint"], "keys": subscription["keys"]}, data=payload,
                vapid_private_key=_private_key(), vapid_claims={"sub": subject()}, ttl=24 * 3600, timeout=15)
        return 201
    except WebPushException as e:
        return e.response.status_code if e.response is not None else None
    except Exception:  # noqa: BLE001 — 通知发不出去不能影响正事 / a failed notification must never affect the real work
        return None


def send(title: str, body: str = "", url: str = "/", tag: str = "", wait: bool = False) -> int:
    """给主人的每个设备发一条。返回发了几个。推送服务说订阅已经失效（404/410）的，顺手删掉。

    Send one notification to each of the owner's devices; returns how many were attempted.
    Subscriptions the push service reports as gone (404/410) are removed along the way.
    """
    if not configured():
        return 0
    targets = subscriptions()
    if not targets:
        return 0
    payload = json.dumps({"title": title[:120], "body": body[:300], "url": url if url.startswith("/") else "/", "tag": tag}, ensure_ascii=False)

    def run() -> None:
        gone = [s["endpoint"] for s in targets if _deliver(s, payload) in (404, 410)]
        for endpoint in gone:
            unsubscribe(endpoint)

    if wait:
        run()
    else:
        threading.Thread(target=run, daemon=True, name="push").start()
    return len(targets)
