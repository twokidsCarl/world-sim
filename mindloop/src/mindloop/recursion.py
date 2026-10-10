"""接地引擎：把「我猜你猜我」算成矩阵。

每个人的每一层都是一张策略表 policy[row][col]：
- 信号博弈 a（说话者）：row = 隐藏状态 θ，col = 话语 m
- 信号博弈 b（听者）  ：row = 话语 m，col = 行动；另带 belief[m][θ]
- 同时博弈           ：只有一行，col = 自己的行动

第 0 层不动脑筋（字面 / 直觉）；第 d 层针对「对方的第 d-1 层」做软最优回应。
一个想到第 d 层的人，脑中是一座塔：自己(d) ⊃ 对方(d-1) ⊃ 自己(d-2) ⊃ … ⊃ 第 0 层。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .model import Signaling, Simultaneous, other

Game = Signaling | Simultaneous
TREMBLE = 1e-3  # 听者对「不该出现的话」保留一点字面理解
PIN_SHARPNESS = 0.98


@dataclass
class Level:
    role: str  # 这一层模拟的是谁：'a' 或 'b'
    level: int
    policy: np.ndarray  # [rows][cols]
    rows: list[str]
    cols: list[str]
    belief: Optional[np.ndarray] = None  # 仅信号博弈的听者：[M][Θ]
    pinned: dict[int, int] = field(default_factory=dict)  # 被用户钉住的行 -> 列

    def choice(self, row: int = 0) -> int:
        return int(np.argmax(self.policy[row]))

    def to_dict(self) -> dict:
        return {
            "role": self.role,
            "level": self.level,
            "rows": self.rows,
            "cols": self.cols,
            "policy": np.round(self.policy, 4).tolist(),
            "choice": [self.choice(r) for r in range(len(self.rows))],
            "belief": None if self.belief is None else np.round(self.belief, 4).tolist(),
            "pinned": {str(k): v for k, v in self.pinned.items()},
        }


def _softmax(u: np.ndarray, lam: float) -> np.ndarray:
    z = lam * (u - u.max(axis=-1, keepdims=True))
    e = np.exp(z)
    return e / e.sum(axis=-1, keepdims=True)


def _normalize(x: np.ndarray) -> np.ndarray:
    s = x.sum(axis=-1, keepdims=True)
    return np.where(s > 0, x / np.where(s > 0, s, 1), 1.0 / x.shape[-1])


def _labels(game: Game, role: str) -> tuple[list[str], list[str]]:
    if isinstance(game, Signaling):
        msgs = [m.text for m in game.messages]
        return (list(game.states), msgs) if role == "a" else (msgs, list(game.actions))
    return ["·"], list(game.actions_a if role == "a" else game.actions_b)


def _listener(game: Signaling, likelihood: np.ndarray | None, lam: float, level: int) -> Level:
    """likelihood[θ][m] = 听者以为说话者在 θ 下说 m 的概率；None = 只按字面理解。"""
    lit = np.asarray(game.literal, float).T  # [Θ][M]
    prior = np.asarray(game.prior, float)[:, None]
    if likelihood is None:
        joint = prior * lit
    else:
        joint = prior * ((1 - TREMBLE) * likelihood + TREMBLE * _normalize(lit))
    belief = _normalize(joint.T)  # [M][Θ]
    eu = belief @ np.asarray(game.u_b, float)  # [M][A]
    rows, cols = _labels(game, "b")
    return Level("b", level, _softmax(eu, lam), rows, cols, belief=belief)


def level0(game: Game, role: str, lam: float = 1.0) -> Level:
    rows, cols = _labels(game, role)
    if isinstance(game, Simultaneous):
        sal = np.asarray(game.salience_a if role == "a" else game.salience_b, float)
        return Level(role, 0, _normalize(sal[None, :]), rows, cols)
    lit = np.asarray(game.literal, float).T  # [Θ][M]
    if role == "a":  # 字面说话者：说字面上最贴切的话
        return Level("a", 0, _normalize(lit), rows, cols)
    return _listener(game, None, lam, 0)  # 字面听者：先验 × 字面相容度


def respond(game: Game, role: str, opp: Level, lam: float, level: int) -> Level:
    """role 针对对方的策略 opp 做软最优回应。"""
    rows, cols = _labels(game, role)
    if isinstance(game, Simultaneous):
        q = opp.policy[0]
        u = np.asarray(game.u_a, float) @ q if role == "a" else q @ np.asarray(game.u_b, float)
        return Level(role, level, _softmax(u[None, :], lam), rows, cols)
    if role == "a":
        cost = np.array([m.cost for m in game.messages], float)
        eu = np.asarray(game.u_a, float) @ opp.policy.T - cost[None, :]  # [Θ][M]
        return Level("a", level, _softmax(eu, lam), rows, cols)
    return _listener(game, opp.policy, lam, level)


def _apply_pins(lv: Level, pins: dict) -> Level:
    for row, col in pins.items():
        row, col = int(row), int(col)
        if 0 <= row < lv.policy.shape[0] and 0 <= col < lv.policy.shape[1]:
            n = lv.policy.shape[1]
            lv.policy[row] = (1 - PIN_SHARPNESS) / n
            lv.policy[row, col] += PIN_SHARPNESS
            lv.pinned[row] = col
    return lv


def tower(game: Game, owner: str, depth: int, lam: dict[str, float], pins: dict | None = None) -> list[Level]:
    """owner 想到第 depth 层时脑中的整座塔，返回 [第0层, …, 第depth层]。

    第 j 层模拟的人：与 depth 同奇偶则是 owner 自己，否则是对方。
    pins = {层号: {行: 列}}，用户把某一层的结论钉死，外层据此重算。
    """
    pins = pins or {}
    role = owner if depth % 2 == 0 else other(owner)
    lv = _apply_pins(level0(game, role, lam[role]), pins.get(0, pins.get("0", {})))
    out = [lv]
    for j in range(1, depth + 1):
        role = other(role)
        lv = _apply_pins(respond(game, role, lv, lam[role], j), pins.get(j, pins.get(str(j), {})))
        out.append(lv)
    return out


def outcome(game: Game, top_a: Level, top_b: Level, forced_a: int | None = None, forced_b: int | None = None) -> dict:
    """两个人各自按自己的最高层行动，实际发生了什么。"""
    if isinstance(game, Simultaneous):
        ia = top_a.choice() if forced_a is None else forced_a
        ib = top_b.choice() if forced_b is None else forced_b
        pa, pb = top_a.policy[0], top_b.policy[0]
        ua, ub = np.asarray(game.u_a, float), np.asarray(game.u_b, float)
        return {
            "kind": "simultaneous",
            "choice_a": ia,
            "choice_b": ib,
            "payoff_a": float(ua[ia, ib]),
            "payoff_b": float(ub[ia, ib]),
            "expected_a": float(pa @ ua @ pb),
            "expected_b": float(pa @ ub @ pb),
        }
    t = game.true_state
    m = top_a.choice(t) if forced_a is None else forced_a
    act = top_b.choice(m) if forced_b is None else forced_b
    guess = int(np.argmax(top_b.belief[m]))
    ua, ub = np.asarray(game.u_a, float), np.asarray(game.u_b, float)
    best_b = int(np.argmax(ub[t]))
    return {
        "kind": "signaling",
        "true_state": t,
        "choice_a": m,
        "choice_b": act,
        "belief_b": np.round(top_b.belief[m], 4).tolist(),
        "guess_state": guess,
        "guessed_right": guess == t,
        "b_acted_right": bool(ub[t, act] >= ub[t, best_b] - 1e-9),
        "payoff_a": float(ua[t, act] - game.messages[m].cost),
        "payoff_b": float(ub[t, act]),
    }


# ---------- 整条阶梯：层数一路加深会怎样 ----------


def ladder(game: Game, depth: int, lam: dict[str, float]) -> dict[str, list[Level]]:
    """a 和 b 的第 0…depth 层。X[d] = respond(Y[d-1])。"""
    a, b = [level0(game, "a", lam["a"])], [level0(game, "b", lam["b"])]
    for d in range(1, depth + 1):
        a.append(respond(game, "a", b[d - 1], lam["a"], d))
        b.append(respond(game, "b", a[d - 1], lam["b"], d))
    return {"a": a, "b": b}


def _entropy(p: np.ndarray) -> float:
    p = p[p > 0]
    return float(-(p * np.log2(p)).sum())


def pair_metrics(game: Game, la: Level, lb: Level) -> dict:
    """a 用 la、b 用 lb 时的期望指标（对隐藏状态取先验平均）。"""
    if isinstance(game, Simultaneous):
        pa, pb = la.policy[0], lb.policy[0]
        ua, ub = np.asarray(game.u_a, float), np.asarray(game.u_b, float)
        n = min(len(pa), len(pb))
        return {
            "eu_a": float(pa @ ua @ pb),
            "eu_b": float(pa @ ub @ pb),
            "match": float(sum(pa[i] * pb[i] for i in range(n))),
        }
    prior = np.asarray(game.prior, float)
    S, L = la.policy, lb.policy  # [Θ][M], [M][A]
    joint = prior[:, None] * S
    pm = joint.sum(axis=0)
    mi = _entropy(prior) + _entropy(pm) - _entropy(joint.flatten())
    cost = np.array([m.cost for m in game.messages], float)
    ua, ub = np.asarray(game.u_a, float), np.asarray(game.u_b, float)
    act = S @ L  # [Θ][A]
    guess = np.argmax(lb.belief, axis=1)  # [M]
    acc = float(sum(joint[t, m] for t in range(len(prior)) for m in range(S.shape[1]) if guess[m] == t))
    lit = np.asarray(game.literal, float).T
    lit = lit / np.maximum(lit.max(axis=1, keepdims=True), 1e-12)
    return {
        "eu_a": float((prior[:, None] * act * ua).sum() - (joint * cost[None, :]).sum()),
        "eu_b": float((prior[:, None] * act * ub).sum()),
        "accuracy": acc,
        "info_bits": max(mi, 0.0),
        "honesty": float((joint * lit).sum()),
    }


def _signature(la: Level, lb: Level) -> tuple:
    return (tuple(np.argmax(la.policy, axis=1)), tuple(np.argmax(lb.policy, axis=1)))


def analyze(game: Game, depth: int, lam: dict[str, float]) -> dict:
    """层数加深后的走向：收敛到某个结论，还是来回翻转。"""
    lad = ladder(game, depth, lam)
    sigs = [_signature(lad["a"][d], lad["b"][d]) for d in range(depth + 1)]
    period, start = None, None
    for p in range(1, depth // 2 + 1):
        tail = range(max(p, depth - 2 * p + 1), depth + 1)
        if all(sigs[d] == sigs[d - p] for d in tail):
            period = p
            start = next(s for s in range(depth + 1 - p) if all(sigs[d] == sigs[d + p] for d in range(s, depth + 1 - p)))
            break
    verdict = "converged" if period == 1 else "cycle" if period else "unsettled"
    flips = {
        r: [d for d in range(1, depth + 1) if tuple(np.argmax(lad[r][d].policy, axis=1)) != tuple(np.argmax(lad[r][d - 1].policy, axis=1))]
        for r in ("a", "b")
    }
    return {
        "verdict": verdict,
        "period": period,
        "settles_at": start,
        "flips": flips,
        "levels": [
            {"d": d, "a": lad["a"][d].to_dict(), "b": lad["b"][d].to_dict(), "metrics": pair_metrics(game, lad["a"][d], lad["b"][d])}
            for d in range(depth + 1)
        ],
    }


def equilibrium(game: Game, lam: dict[str, float], iters: int = 3000) -> dict:
    """无限层的极限：带阻尼地互相回应直到不动（logit 均衡的近似）。"""
    a, b = level0(game, "a", lam["a"]), level0(game, "b", lam["b"])
    resid = 1.0
    for i in range(1, iters + 1):
        na, nb = respond(game, "a", b, lam["a"], -1), respond(game, "b", a, lam["b"], -1)
        step = max(1.0 / (i + 1), 0.02)
        resid = float(max(np.abs(na.policy - a.policy).max(), np.abs(nb.policy - b.policy).max()))
        a.policy = (1 - step) * a.policy + step * na.policy
        b.policy = (1 - step) * b.policy + step * nb.policy
        b.belief = nb.belief
        if resid < 1e-7:
            break
    return {"a": a.to_dict(), "b": b.to_dict(), "residual": resid, "metrics": pair_metrics(game, a, b)}


def equivalent_depth(game: Game, role: str, lam: dict[str, float], row: int, col: int, max_depth: int = 12) -> list[int]:
    """用户亲自选了 col——这相当于想了哪几层？"""
    lad = ladder(game, max_depth, lam)
    return [d for d in range(max_depth + 1) if lad[role][d].choice(row) == col]
