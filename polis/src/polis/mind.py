"""心智：信念怎么被一句话改变、怎么揣度别人、什么时候去取钱。纯函数，标量与数组通用。"""

from __future__ import annotations

import numpy as np

from .model import Params


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def logit(p):
    return np.log(p / (1.0 - p))


def tell_delta(valence: int, severity: float, trust: float, repeats: int, others: int, L: float, education: int, p: Params) -> float:
    """听到一句话后信念对数几率的变化。

    来源越可信、说法越重，变化越大；同一个人翻来覆去地说（repeats），新增越来越少；
    但已经从别的人那里听过同样的话（others），这一次就更有分量——三人成虎；
    与自己已有倾向一致的话更容易听进去（确认偏误）；读书多的人对谣言打折扣。
    """
    novelty = 1.0 / (1.0 + p.novelty * repeats)
    corroborate = 1.0 + p.corroborate * min(others, 3)
    confirm = 1.0 + p.confirm * valence * np.tanh(L / 2.0)
    skeptic = 1.0 - 0.15 * education if valence > 0 else 1.0
    return float(valence * p.w_tell * severity * trust * novelty * corroborate * confirm * skeptic)


def expectation(seen, talk, depth):
    """我估计身边有多少人会去取钱。

    0 层：只数亲眼看见已经去取的人。
    1 层：跟我说过这事的人多半是信的，信的人会去取。
    2 层：别人也在这样估计，所以估计本身会再推高一截。
    """
    e0 = seen
    e1 = e0 + (1.0 - e0) * 0.6 * talk
    e2 = e1 + (1.0 - e1) * 0.5 * e1
    return np.where(depth == 0, e0, np.where(depth == 1, e1, e2))


def fail_probability(belief, expect, p: Params):
    """我眼中钱庄倒掉的概率：它本来就亏空，或者被大家取垮。"""
    run = sigmoid((expect - p.perceived_reserve) / 0.08)
    return 1.0 - (1.0 - belief) * (1.0 - run)


def withdraw_hazard(belief, expect, fear, stake, risk_aversion, conformity, p: Params):
    """这一小时决定去取钱的概率。"""
    gain = fail_probability(belief, expect, p) * stake * (1.0 + risk_aversion) - p.cost
    u = p.lam * gain + 2.0 * conformity * (expect - 0.2) + 1.5 * (fear - 0.5) + p.bias
    return p.hazard * sigmoid(u)


def fear_target(belief, expect, stake, risk_aversion):
    return np.clip(belief * np.maximum(stake, 0.2) * (0.5 + 0.5 * risk_aversion) + 0.6 * expect, 0.0, 1.0)


def share_drive(belief, fear, stake):
    """想把这事讲给别人的冲动：事情要紧 × 真假难辨，再加上怕。"""
    ambiguity = 4.0 * belief * (1.0 - belief)
    return (np.maximum(stake, 0.25) * (0.4 + ambiguity) + fear) * (belief > 0.08)
