"""由引擎出题、给标准答案的「递归心智」选择题。

generate：对每个可运行案例和若干层数，出自包含、已匿名化的选择题（甲/乙、S1/M1/X1…），
          标准答案 = 引擎在该层的选择；只保留答案概率领先第二名 ≥ margin 的题。
run     ：让模型（经 claude -p）作答并计分。
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Iterable, Optional

import numpy as np

from . import llm, recursion, runner
from .cases import all_cases
from .model import Signaling, Simultaneous

MARGIN = 0.2
MAX_CELLS = 60  # 收益表太大的案例写不成一道题，跳过
SYSTEM = "你是严谨的博弈论解题者。按题目给出的规则一步步推演（不要凭印象），然后只给出答案的序号。"
ANSWER_SCHEMA = {
    "type": "object",
    "properties": {"answer_index": {"type": "integer"}},
    "required": ["answer_index"],
    "additionalProperties": False,
}


def parse_depths(spec: str) -> list[int]:
    """'0..4' → [0,1,2,3,4]；'0,2,4' → [0,2,4]。"""
    out: list[int] = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if ".." in part:
            lo, hi = part.split("..", 1)
            out.extend(range(int(lo), int(hi) + 1))
        else:
            out.append(int(part))
    if not out or min(out) < 0 or max(out) > runner.MAX_DEPTH:
        raise ValueError(f"层数应在 0..{runner.MAX_DEPTH} 之间: {spec!r}")
    return sorted(set(out))


def _num(x: float) -> str:
    return f"{float(x):g}"


def _pct(x: float) -> str:
    return f"{float(x) * 100:g}%"


def _labels(prefix: str, n: int) -> list[str]:
    return [f"{prefix}{i + 1}" for i in range(n)]


def _margin(row: np.ndarray) -> tuple[int, float]:
    order = np.argsort(row)[::-1]
    return int(order[0]), float(row[order[0]] - row[order[1]]) if len(row) > 1 else 1.0


def _signaling_preamble(g: Signaling) -> tuple[str, list[str], list[str], list[str]]:
    S, M, X = _labels("S", len(g.states)), _labels("M", len(g.messages)), _labels("X", len(g.actions))
    lines = [
        "有两个人：甲和乙。只有甲知道真实情况，乙不知道。",
        "真实情况是以下之一（括号内是乙事先认为的可能性）：" + "、".join(f"{s}（{_pct(p)}）" for s, p in zip(S, g.prior)) + "。",
        f"甲从这些信号里选一个发给乙：{'、'.join(M)}。乙看到信号后，从这些行动里选一个：{'、'.join(X)}。",
        "各信号的字面含义（数值在 0 到 1 之间，越大表示这个信号字面上越符合该情况）：",
        *[f"- {m}：" + "，".join(f"{s} 为 {_num(v)}" for s, v in zip(S, row)) for m, row in zip(M, g.literal)],
    ]
    if any(m.cost for m in g.messages):
        lines.append("发信号的代价（从甲的得分里扣）：" + "，".join(f"{m} 扣 {_num(msg.cost)}" for m, msg in zip(M, g.messages)) + "。")
    lines.append("得分（只取决于真实情况和乙的行动）：")
    for i, s in enumerate(S):
        cells = "；".join(f"乙选 {x} → 甲得 {_num(g.u_a[i][k])}，乙得 {_num(g.u_b[i][k])}" for k, x in enumerate(X))
        lines.append(f"- 真实情况为 {s} 时：{cells}")
    lines += [
        "两人「想到第几层」按下面的规则定义：",
        "- 第 0 层的甲不揣摩乙：在每种情况下，按各信号对该情况的字面符合程度成比例地选信号（最符合的最常选）。",
        "- 第 0 层的乙不揣摩甲，纯按字面理解信号：看到某个信号后，认为各情况的可能性正比于「事先的可能性 × 该信号对该情况的字面符合程度」，再选自己期望得分最高的行动。",
        "- 第 k 层（k≥1）的甲认为乙是第 k-1 层，选让自己期望得分（扣除代价后）最高的信号。",
        "- 第 k 层（k≥1）的乙认为甲是第 k-1 层，用贝叶斯法则由信号推断真实情况，再选自己期望得分最高的行动；"
        "如果看到的是按这个假设本不该出现的信号，就按字面含义理解它。",
        "- 每个人基本上都选期望得分最高的选项，得分差距越大越确定。",
    ]
    return "\n".join(lines), S, M, X


def _simultaneous_preamble(g: Simultaneous) -> tuple[str, list[str], list[str]]:
    A, B = _labels("A", len(g.actions_a)), _labels("B", len(g.actions_b))
    sal_a = np.asarray(g.salience_a, float) / np.sum(g.salience_a)
    sal_b = np.asarray(g.salience_b, float) / np.sum(g.salience_b)
    lines = [
        "有两个人：甲和乙。两人同时各选一项，选的时候互相看不到对方的选择。",
        f"甲的选项：{'、'.join(A)}。乙的选项：{'、'.join(B)}。",
        "得分：",
    ]
    for i, a in enumerate(A):
        for k, b in enumerate(B):
            lines.append(f"- 甲选 {a}、乙选 {b}：甲得 {_num(g.u_a[i][k])}，乙得 {_num(g.u_b[i][k])}")
    lines += [
        "两人「想到第几层」按下面的规则定义：",
        "- 第 0 层的人不揣摩对方，凭直觉选。第 0 层的甲选各项的可能性："
        + "、".join(f"{a} {_pct(round(p, 4))}" for a, p in zip(A, sal_a))
        + "；第 0 层的乙："
        + "、".join(f"{b} {_pct(round(p, 4))}" for b, p in zip(B, sal_b))
        + "。",
        "- 第 k 层（k≥1）的人认为对方是第 k-1 层，选让自己期望得分最高的一项。",
        "- 每个人基本上都选期望得分最高的选项，得分差距越大越确定。",
    ]
    return "\n".join(lines), A, B


def case_items(case_id: str, depths: Iterable[int], margin: float = MARGIN) -> list[dict]:
    case, _, lam = runner.prepare(runner.Params(case_id=case_id))
    g = case.game
    depths = sorted(set(depths))
    lad = recursion.ladder(g, max(depths), lam)
    items: list[dict] = []

    def add(role: str, d: int, row: int, question: str, options: list[str], policy_row: np.ndarray) -> None:
        gold, gap = _margin(policy_row)
        if gap < margin:
            return
        items.append(
            {
                "id": f"{case.id}-{role}{d}-r{row}",
                "case_id": case.id,
                "depth": d,
                "role": role,
                "question": question,
                "options": options,
                "answer_index": gold,
                "margin": round(gap, 4),
            }
        )

    if isinstance(g, Signaling):
        if len(g.states) * len(g.actions) > MAX_CELLS or len(g.states) * len(g.messages) > MAX_CELLS:
            return []
        pre, S, M, X = _signaling_preamble(g)
        for d in depths:
            for t, s in enumerate(S):
                q = f"{pre}\n\n问题：真实情况是 {s}，甲想到第 {d} 层。甲最可能发出哪个信号？"
                add("a", d, t, q, M, lad["a"][d].policy[t])
            for m, sig in enumerate(M):
                belief = f"（也就是说，乙认为甲想到了第 {d - 1} 层）" if d >= 1 else ""
                q = f"{pre}\n\n问题：乙想到第 {d} 层{belief}。乙看到信号 {sig} 后，最可能采取哪个行动？"
                add("b", d, m, q, X, lad["b"][d].policy[m])
    else:
        if len(g.actions_a) * len(g.actions_b) > MAX_CELLS:
            return []
        pre, A, B = _simultaneous_preamble(g)
        for d in depths:
            for role, who, opts in (("a", "甲", A), ("b", "乙", B)):
                q = f"{pre}\n\n问题：{who}想到第 {d} 层时，最可能选哪一项？"
                add(role, d, 0, q, opts, lad[role][d].policy[0])
    return items


def generate(depths: Iterable[int] = range(5), margin: float = MARGIN, case_ids: Optional[list[str]] = None) -> list[dict]:
    depths = list(depths)
    ids = case_ids if case_ids is not None else [cid for cid, c in all_cases().items() if c.runnable]
    items: list[dict] = []
    for cid in ids:
        items.extend(case_items(cid, depths, margin))
    return items


def write_jsonl(items: list[dict], path: str | Path) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for it in items:
            f.write(json.dumps(it, ensure_ascii=False) + "\n")


def read_jsonl(path: str | Path) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def item_prompt(item: dict) -> str:
    opts = "\n".join(f"{i}. {o}" for i, o in enumerate(item["options"]))
    return f"{item['question']}\n\n选项：\n{opts}\n\n请给出 answer_index：你所选选项前面的序号（从 0 开始）。"


async def arun(items: list[dict], model: Optional[str] = None, use_cache: bool = True) -> dict:
    """逐题作答并计分。调用失败或答非所问都算错（另记入 errors）。"""

    async def one(item: dict) -> Optional[int]:
        try:
            ans = await llm.aask(item_prompt(item), system=SYSTEM, model=model, schema=ANSWER_SCHEMA, use_cache=use_cache)
            return int(ans["answer_index"])
        except (llm.LLMError, KeyError, TypeError, ValueError):
            return None

    answers = await asyncio.gather(*(one(it) for it in items))
    by_depth: dict[int, dict] = {}
    rows = []
    for it, ans in zip(items, answers):
        ok = ans is not None and ans == it["answer_index"]
        d = by_depth.setdefault(int(it["depth"]), {"n": 0, "correct": 0})
        d["n"] += 1
        d["correct"] += int(ok)
        rows.append({"id": it["id"], "depth": it["depth"], "answer_index": it["answer_index"], "model_answer": ans, "correct": ok})
    for d in by_depth.values():
        d["accuracy"] = d["correct"] / d["n"]
    n, correct = len(items), sum(r["correct"] for r in rows)
    return {
        "model": model or llm.default_model(),
        "n": n,
        "correct": correct,
        "accuracy": correct / n if n else 0.0,
        "chance": float(np.mean([1 / len(it["options"]) for it in items])) if n else 0.0,
        "errors": sum(a is None for a in answers),
        "by_depth": dict(sorted(by_depth.items())),
        "items": rows,
    }


def run(items: list[dict], model: Optional[str] = None, use_cache: bool = True) -> dict:
    return llm.run_sync(arun(items, model, use_cache))
