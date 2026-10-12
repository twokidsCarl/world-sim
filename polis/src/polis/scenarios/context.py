"""事发前人心有多不稳：一个从史料里数出来的量，每个场景一个。
How unsettled people were before the event: one number per scenario, counted from the record.

规则在第三轮模型改动之前写定，写定时引擎还没有用到它。数的是挤兑第一天之前三十天内、同一个国家里有记载的事：
(a) 居民的储蓄普遍直接缩水：货币一次或一天之内贬值一成以上，或者存款被减记；
(b) 一家吸收存款的银行被关闭或接管，储户取不出钱。
每有一条记 1，所以取值是 0、1 或 2。券商被冻结、别国的机构倒闭、股市下跌、三十天以前的事，都不算。
The rule was fixed before the third round of model changes, when the engine did not yet use it. It counts what the
record shows in the same country during the thirty days before the first day of the run:
(a) households at large took a direct loss on their savings: the currency lost a tenth or more in one step or one
    day, or deposits were written down;
(b) a deposit-taking bank was closed or taken over and its depositors could not reach their money.
Each scores 1, so the value is 0, 1 or 2. A brokerage being frozen, an institution failing in another country, a
fall in the stock market, and anything more than thirty days earlier do not count.

这条规则是看过前六起案例的结果之后定的，所以对它们不算检验；只有写定之后才加进来的场景算。
样本外场景的模块写定后不再改动，所以前面几起的取值放在这里；之后新加的场景在自己的模块里写 UNEASE。
The rule was chosen after the results of the first six cases had been seen, so it is no test on them; only scenarios
added after it was fixed count. Held-out scenario modules are not edited once fixed, which is why the earlier cases'
values live here; scenarios added later carry UNEASE in their own module.
"""

from __future__ import annotations

UNEASE = {
    "rumor_run": 0,  # 虚构 / fictional
    "toyokawa": 0,  # 石油危机不在两条之内 / the oil crisis is neither item
    "bea": 0,  # 雷曼倒闭在美国 / Lehman failed in another country
    "bac": 0,  # 被冻结的 Financorp 是券商；Banco Elca 的冻结在 7 月初，超过三十天 / Financorp, frozen days earlier, was a brokerage; Banco Elca was frozen in early July, more than thirty days before
    "swedbank": 1,  # (b) Krajbanka 十一月下旬被接管，约三周前 / (b) Krajbanka was taken over in late November, about three weeks before
    "kaspi": 1,  # (a) 坚戈 2 月 11 日一次贬值约 19% / (a) the tenge was devalued by about 19% in one step on 11 February
    "icici": 0,  # 合作银行倒闭是此前两年里的事；4 月 10 日是股市下跌 / the co-operative failures were spread over two years; 10 April was a stock-market fall
    "fib": 1,  # (b) Corpbank 6 月 20 日前后被接管，储户取不出钱 / (b) Corpbank was taken over around 20 June and its depositors were locked out
}


def unease(scenario) -> int:
    """场景模块自己写了 UNEASE 就用它的，否则查上面的表；都没有算 0。
    A scenario module's own UNEASE wins; otherwise the table above; 0 if neither has it.
    """
    own = getattr(scenario, "UNEASE", None)
    return int(own) if own is not None else UNEASE.get(scenario.__name__.rsplit(".", 1)[-1], 0)
