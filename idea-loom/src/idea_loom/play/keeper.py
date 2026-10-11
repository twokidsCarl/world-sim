"""play 角色的常驻循环：定时取远端、给需要的项目构建、停掉空闲的后端。

本地（角色 all）不需要它：那里是有人打开页面时才顺带做这些事。云端的 play 容器没有人去
"顺带"触发，所以自己转。

The standing loop of the play role: fetch the remote on a timer, build what needs
building and stop idle backends. Not needed locally (role "all"), where opening a page
does these things in passing; the cloud's play container has nobody to do so, so it turns
by itself.
"""

from __future__ import annotations

import threading
import time

from . import manifest, snapshot, supervisor

INTERVAL = 60.0
_started = False


def tick() -> dict[str, str]:
    snapshot.fetch(max_age=0)
    supervisor.reap_idle()
    out = {}
    for sim in manifest.load_all()[0]:
        if sim.ready:
            out[sim.name] = snapshot.ensure(sim.name).status
    return out


def start() -> None:
    global _started
    if _started:
        return
    _started = True

    def loop() -> None:
        while True:
            try:
                tick()
            except Exception:  # noqa: BLE001 — 一次失败不能让循环停下 / one failure must not stop the loop
                pass
            time.sleep(INTERVAL)

    threading.Thread(target=loop, daemon=True, name="play-keeper").start()
