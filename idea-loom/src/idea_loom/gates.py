"""闸门：无人值守时不让作业把订阅额度用光。

两道：每天最多开工几个作业；订阅额度用到线就暂停，等这个窗口过去。
额度的使用率是 claude 命令在每次运行的事件流里自己报的（rate_limit_event），这里只是记下最近一次。

Gates, so that unattended jobs cannot use up the subscription allowance. There are two: a
cap on how many jobs may start per day, and a pause once the allowance reaches a threshold,
lasting until that window resets. The utilisation is reported by the claude command itself
in every run's event stream (rate_limit_event); this module only records the latest.

环境变量 / Environment:
    IDEA_LOOM_JOBS_PER_DAY   每天最多开工几个作业，缺省 6 / jobs that may start per day, default 6
    IDEA_LOOM_USAGE_PAUSE    使用率到多少就暂停（0 到 1），缺省 0.8 / the utilisation at which to pause (0 to 1), default 0.8
"""

from __future__ import annotations

import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from . import store


def _dir() -> Path:
    return store.runs_dir() / "worker"


def per_day() -> int:
    return int(os.environ.get("IDEA_LOOM_JOBS_PER_DAY", "6"))


def pause_at() -> float:
    return float(os.environ.get("IDEA_LOOM_USAGE_PAUSE", "0.8"))


def note_usage(info: dict[str, Any]) -> None:
    """记下 claude 报的额度情况。 / Record the allowance state the claude command reported."""
    windows = info.get("unifiedWindows") if isinstance(info.get("unifiedWindows"), dict) else {}
    store.write_json(_dir() / "usage.json", {
        "at": time.time(), "status": str(info.get("status") or ""), "resets_at": info.get("resetsAt"),
        "windows": {name: {"utilization": w.get("utilization"), "resets_at": w.get("resetsAt")} for name, w in windows.items() if isinstance(w, dict)},
    })


def usage() -> dict[str, Any]:
    return store.read_json(_dir() / "usage.json", {})


def note_start(job_id: str) -> None:
    store.append(_dir() / "starts.jsonl", [{"at": time.time(), "job_id": job_id}])


def started_today(now: Optional[float] = None) -> int:
    today = datetime.fromtimestamp(now or time.time()).date()
    return sum(1 for row in store.read_lines(_dir() / "starts.jsonl")[0] if datetime.fromtimestamp(float(row.get("at") or 0)).date() == today)


def paused(now: Optional[float] = None) -> Optional[str]:
    """现在该不该停：返回原因，可以继续就返回 None。只看还没过去的窗口。

    Whether to hold off now: the reason, or None if work may go on. Only windows that have not reset yet count.
    """
    now = now or time.time()
    seen = usage()
    for name, window in (seen.get("windows") or {}).items():
        used, resets = window.get("utilization"), window.get("resets_at")
        if isinstance(used, (int, float)) and isinstance(resets, (int, float)) and resets > now and used >= pause_at():
            until = datetime.fromtimestamp(resets).strftime("%m-%d %H:%M")
            return f"订阅额度（{name}）已经用了 {used:.0%}，到线（{pause_at():.0%}）暂停，{until} 之后继续"
    if seen.get("status") == "rejected" and isinstance(seen.get("resets_at"), (int, float)) and seen["resets_at"] > now:
        return f"订阅额度用完了，{datetime.fromtimestamp(seen['resets_at']).strftime('%m-%d %H:%M')} 之后继续"
    return None


def may_start(now: Optional[float] = None) -> Optional[str]:
    """能不能再开工一个作业：不能就返回原因。 / Whether another job may start; the reason if not."""
    reason = paused(now)
    if reason:
        return reason
    if started_today(now) >= per_day():
        return f"今天已经开工了 {started_today(now)} 个作业，到了每天的上限（{per_day()}），明天继续"
    return None
