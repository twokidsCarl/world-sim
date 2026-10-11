"""定时维护：提交少的时候，自动做一件还技术债的小事。

每小时看一次，三个条件都满足才开一次：过去 24 小时 main 上的提交数低于线、没有别的作业、
闸门没拦。每次只做一件事，从一张轮换的清单里取，并且只碰最近几小时没人提交的子项目。

结果分两档，为的是不让无人值守的改动悄悄进主干：

    甲档  只改了文档（*.md），测试全过     照常开 PR，自动合并
    乙档  改了别的任何东西                 开成草稿 PR，不会自动合并，通知主人；主人在 GitHub 上点
                                           "Ready for review" 才合并

默认是关的（IDEA_LOOM_MAINTENANCE=1 才开）。它走的是作业的同一条路：出方案、动手、程序重跑测试；
只是方案不等人批——打开这个开关就是事先批准了"在一个子项目的目录里做一件清单上的事"。

Scheduled maintenance: when commits are few, automatically do one small piece of technical
debt work. Checked hourly, a run starts only when all three hold: fewer commits on main in
the past 24 hours than the threshold, no other job, and the gates are open. Each run does one
thing from a rotating list and only touches a subproject nobody committed to in the last few
hours. Results come in two tiers so unattended changes never slip into main: tier A, where
only documents (*.md) changed and the tests pass, opens a normal PR that merges
automatically; tier B, anything else, opens a draft PR, which is not merged automatically,
and notifies the owner, who marks it ready for review on GitHub to merge it. It is off by
default (IDEA_LOOM_MAINTENANCE=1 turns it on) and follows the same path as any job — plan,
execute, tests re-run by the program — except that the plan does not wait for approval:
turning the switch on is the approval, given in advance, for doing one listed thing inside
one subproject's directory.

环境变量 / Environment:
    IDEA_LOOM_MAINTENANCE         1 才开 / 1 turns it on
    IDEA_LOOM_MAINTENANCE_BELOW   24 小时内提交数低于它才做，缺省 5 / run only below this many commits in 24 hours, default 5
"""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path
from typing import Any, Optional

from . import ideas, store

QUIET_HOURS = 6
EVERY_SECONDS = 3600.0
TAIL = ("\n\n规矩：一次只做一件小而确定的事，改动要小到两分钟能看完。没有值得改的就什么都不要改——"
        "\"查过了，没有要改的\"是正常的结果，不要为了有产出而改。不改行为的就不要动行为；要改行为的，必须有测试证明原来是错的。")
ITEMS: dict[str, tuple[str, str]] = {
    "docs": ("文档一致性", "检查 `{d}/README.md`（以及它的中英两个版本）和代码对不对得上：命令、文件名、接口、数字、\"还没做\"的清单。"
                      "如果它有 `sim.json`，核对里面的卡片写的地址和参数在代码里是否真的存在。只改文档，把不对的改对。"),
    "review": ("代码审查", "把 `{d}/` 的源码当成一份刚提交的改动来审：找确定的正确性问题（边界、错误处理、并发、资源没释放）。"
                        "找到确定的缺陷就修掉，并补一个能证明它的测试。拿不准的不要改，写在总结的 not_done 里。"),
    "cleanup": ("清理", "找 `{d}/` 里没有被用到的代码、没有被用到的依赖、重复的实现、已经和代码对不上的注释。删掉或改对。不改任何行为。"),
    "tests": ("测试补缺", "找 `{d}/` 里没有测试覆盖的关键路径，补一两个测试。测的是规律（守恒、单调、往返一致），不是快照。不改被测的代码。"),
    "hardening": ("加固", "对 `{d}/` 做一遍安全检查：外来输入有没有校验、路径拼接会不会逃出目录、有没有把密钥或本机路径写进了代码或文档。"
                          "确定的问题就修掉并补测试。"),
    "triage": ("排查", "把 `{d}/` 的全部测试和类型检查跑一遍。有失败的、不稳定的、新出现的警告，找到原因并修掉其中最确定的一个。"),
}


def enabled() -> bool:
    return os.environ.get("IDEA_LOOM_MAINTENANCE", "") == "1"


def below() -> int:
    return int(os.environ.get("IDEA_LOOM_MAINTENANCE_BELOW", "5"))


def _path() -> Path:
    return store.runs_dir() / "worker" / "maintenance.jsonl"


def history() -> list[dict[str, Any]]:
    return store.read_lines(_path())[0]


def record(item: str, directory: str, job_id: str) -> None:
    store.append(_path(), [{"at": time.time(), "item": item, "directory": directory, "job_id": job_id}])


def brief(ref: str) -> tuple[str, str, str]:
    """（目录，标题，交给 Claude 的说明）。ref 是"清单项:目录"。 / (directory, title, brief); ref is "item:directory"."""
    item, _, directory = ref.partition(":")
    if item not in ITEMS or not directory:
        raise ValueError("不认识的维护项")
    name, text = ITEMS[item]
    what = f"这是对子项目 `{directory}` 的一次无人值守的定时维护，项目是「{name}」。\n\n" + text.format(d=directory) + TAIL
    return directory, f"定时维护：{name}（{directory}）", what


def commits(repo: Path, hours: int = 24, directory: Optional[str] = None) -> int:
    args = ["git", "-C", str(repo), "rev-list", "--count", f"--since={hours}.hours", "origin/main"] + (["--", directory] if directory else [])
    out = subprocess.run(args, capture_output=True, text=True).stdout.strip()
    return int(out) if out.isdigit() else 0


def candidates(repo: Path) -> list[str]:
    """最近几小时没人提交的子项目。 / Subprojects nobody committed to in the last few hours."""
    names = sorted({p.dir for p in ideas.load_projects()} | {"idea-loom"})
    return [d for d in names if (repo / d).is_dir() and commits(repo, QUIET_HOURS, d) == 0]


def pick(repo: Path) -> Optional[str]:
    """下一次做什么：清单轮着来，目录挑最久没维护过的。返回"清单项:目录"。

    What to do next: the list rotates and the directory is the one maintained longest ago. Returns "item:directory".
    """
    quiet = candidates(repo)
    if not quiet:
        return None
    past = history()
    item = list(ITEMS)[len(past) % len(ITEMS)]
    last = {row.get("directory"): float(row.get("at") or 0) for row in past}
    return f"{item}:{min(quiet, key=lambda d: (last.get(d, 0.0), d))}"


def due(repo: Path, now: Optional[float] = None) -> Optional[str]:
    """现在为什么不做：返回原因；可以做返回 None。 / Why not now: the reason, or None when a run may start."""
    now = now or time.time()
    if not enabled():
        return "没有打开"
    past = history()
    if past and now - float(past[-1].get("at") or 0) < EVERY_SECONDS:
        return "上一次维护还不到一小时"
    n = commits(repo)
    if n >= below():
        return f"过去 24 小时有 {n} 次提交，不算少"
    return None


def tier(changed: list[str]) -> str:
    """甲档只改了文档；别的都是乙档。 / Tier A changed documents only; anything else is tier B."""
    return "A" if changed and all(f.lower().endswith(".md") for f in changed) else "B"
