"""心智：信念怎么被一句话改变、怎么揣度别人、什么时候去取钱。纯函数，标量与数组通用。
The mind: how one telling changes a belief, how people guess what others will do, and when they go to withdraw. Pure functions that work on scalars and arrays alike.
"""

from __future__ import annotations

import numpy as np

from .model import Params


def sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def logit(p):
    return np.log(p / (1.0 - p))


def tell_delta(valence: int, severity: float, trust: float, repeats: int, others: int, L: float, education: int, p: Params) -> float:
    """听到一句话后信念对数几率的变化。
    The change in the log-odds of belief after being told something.

    来源越可信、说法越重，变化越大；同一个人翻来覆去地说（repeats），新增越来越少；
    但已经从别的人那里听过同样的话（others），这一次就更有分量——三人成虎；
    与自己已有倾向一致的话更容易听进去（确认偏误）；读书多的人对谣言打折扣。
    The more trusted the source and the harsher the claim, the larger the change. The same person
    saying it again (repeats) adds less each time, but having already heard it from other people
    (others) makes this telling weigh more: three men make a tiger. Claims that agree with the
    listener's existing leaning go in more easily (confirmation bias), and the better educated
    discount rumours.
    """
    novelty = 1.0 / (1.0 + p.novelty * repeats)
    corroborate = 1.0 + p.corroborate * min(others, 3)
    confirm = 1.0 + p.confirm * valence * np.tanh(L / 2.0)
    skeptic = 1.0 - 0.15 * education if valence > 0 else 1.0
    return float(valence * p.w_tell * severity * trust * novelty * corroborate * confirm * skeptic)


def expectation(seen, talk, depth):
    """我估计身边有多少人会去取钱。
    My estimate of how many of the people around me will withdraw.

    0 层：只数亲眼看见已经去取的人。
    1 层：跟我说过这事的人多半是信的，信的人会去取。
    2 层：别人也在这样估计，所以估计本身会再推高一截。
    Level 0: count only the people I have seen withdraw.
    Level 1: those who told me about it mostly believe it, and believers will withdraw.
    Level 2: others are making the same estimate, which pushes the estimate itself up further.
    """
    e0 = seen
    e1 = e0 + (1.0 - e0) * 0.6 * talk
    e2 = e1 + (1.0 - e1) * 0.5 * e1
    return np.where(depth == 0, e0, np.where(depth == 1, e1, e2))


def urgency(severity):
    """手里这个说法有多催人：「好像有点危险」不催人，「明天就关门」催人立刻动。
    How pressing the version one holds is: "it may be in trouble" presses nobody, "it shuts tomorrow" presses everyone.

    从 0.1 到 1 线性上升，严重度 1.6 封顶。这条线是手设的，依据是丰川事件里说法升级与挤兑同日发生。
    Rises linearly from 0.1 to 1, capped at severity 1.6. The line is set by hand, on the evidence that in the
    Toyokawa record the escalation of the wording and the run happened on the same day.
    """
    return np.clip((severity - 0.4) / 1.2, 0.1, 1.0)


def fail_probability(belief, expect, p: Params):
    """我眼中钱庄倒掉的概率：它本来就亏空，或者被大家取垮。
    The probability, as I see it, that the bank fails: either it was insolvent all along, or the withdrawals bring it down.
    """
    run = sigmoid((expect - p.perceived_reserve) / 0.08)
    return 1.0 - (1.0 - belief) * (1.0 - run)


def withdraw_hazard(belief, urgent, expect, fear, stake, risk_aversion, conformity, p: Params):
    """这一小时决定去取钱的概率。/ The probability of deciding to withdraw during this hour.

    信了还不够，还得觉得事情迫在眉睫（urgent）：信一个含糊的说法，人只会多打听，不会去排队。
    Believing is not enough; it has to feel imminent. Someone who believes a vague version asks around rather than queues.
    """
    gain = fail_probability(belief * urgent, expect, p) * stake * (1.0 + risk_aversion) - p.cost
    u = p.lam * gain + 2.0 * conformity * (expect - 0.2) + 1.5 * (fear - 0.5) + p.bias
    # 估下来不值得跑一趟的人不会去：没有这一条，全城知情之后总有人"无缘无故"去取，再把别人带动起来
    # Nobody goes when the trip is not worth it by their own estimate. Without this, once the whole town has heard,
    # a trickle of people withdraw for no reason and set others off
    worth = np.clip(gain / 0.05, 0.0, 1.0)
    return p.hazard * sigmoid(u) * worth


def fear_target(belief, urgent, expect, stake, risk_aversion):
    return np.clip(belief * urgent * np.maximum(stake, 0.2) * (0.5 + 0.5 * risk_aversion) + 0.6 * expect, 0.0, 1.0)


def share_drive(belief, urgent, fear, stake):
    """想把这事讲给别人的冲动：事情要紧 × 真假难辨，再加上怕。
    The urge to tell someone else: how much it matters × how hard it is to tell true from false, plus fear.

    "要紧"既看自己押了多少，也看这个说法本身有多催人：一句含糊的疑问不值得逢人就讲。
    "Matters" depends on one's own stake and on how pressing the version is: a vague question is not worth telling everyone.
    """
    ambiguity = 4.0 * belief * (1.0 - belief)
    return (np.maximum(stake, 0.25) * urgent * (0.4 + ambiguity) + fear) * (belief > 0.08)


def reach(belief, intimate):
    """这句话会不会对这个人说：拿不准的时候只找亲近的人问，信了才逢人便讲。
    Whether one says it to this person: when unsure people ask only those close to them; once convinced they tell anyone.
    """
    return np.where(intimate, 1.0, 0.3 + 0.7 * belief)
