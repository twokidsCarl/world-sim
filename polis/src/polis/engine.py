"""引擎：按小时推进的 tick 循环。相同的人口与参数必须产生逐字节相同的记录。
The engine: a tick loop that advances one hour at a time. The same population and parameters must produce a byte-identical record.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import ModuleType
from typing import TYPE_CHECKING

import numpy as np

from . import mind
from .model import AWARE, LOST, QUEUEING, UNAWARE, WITHDREW, Intervention, Message, Params, Population, Series

if TYPE_CHECKING:
    from .protagonist import Context, Director

KINDS = ["kin", "neighbor", "colleague", "friend"]
TIE_NAMES = {"kin": "家人", "neighbor": "邻居", "colleague": "同事", "friend": "朋友"}
VENUE_TRUST = 0.3
VENUE_ATTEND = 0.3
QUEUE_FULL = 0.04  # 队伍排到人口的这个比例，就算全城都看得见 / once the queue reaches this share of the population, the whole town can see it


@dataclass
class Result:
    messages: list[Message]
    events: list[dict]
    frames: np.ndarray  # [ticks + 1, channels, n] uint8
    series: Series
    failed_at: int | None


def _activity(hour: int) -> np.ndarray:
    """各类关系在这个钟点碰面说话的活跃度，顺序同 KINDS。夜里都睡了。
    How likely people joined by each kind of tie are to meet and talk at this hour, in KINDS order. At night everyone is asleep.
    """
    if hour >= 23 or hour < 6:
        return np.zeros(4)
    kin = 1.0 if hour < 8 or hour >= 18 else 0.3
    neighbor = 0.6 if hour < 9 else (0.8 if 17 <= hour < 21 else 0.3)
    colleague = 1.0 if 8 <= hour < 18 else 0.05
    friend = 0.5 if 12 <= hour < 14 else (0.8 if 18 <= hour < 22 else 0.2)
    return np.array([kin, neighbor, colleague, friend])


class Sim:
    def __init__(self, pop: Population, params: Params, scenario: ModuleType, director: "Director | None" = None):
        """director 不为空时，主角的行动与心里话交给大模型；为空时全体都走数值规则。
        With a director, protagonists' actions and thoughts come from the model; without one everybody follows the numeric rules.
        """
        self.pop, self.p, self.sc = pop, params, scenario
        self.director = director
        self.rng = np.random.default_rng([params.seed, 1])
        ps = pop.persons
        n = self.n = len(ps)

        def col(name: str, dtype=float) -> np.ndarray:
            return np.array([getattr(x, name) for x in ps], dtype=dtype)

        self.trust_general = col("trust_general")
        self.trust_institution = col("trust_institution")
        self.risk_aversion = col("risk_aversion")
        self.conformity = col("conformity")
        self.media_use = col("media_use")
        self.education = col("education", int)
        self.depth = col("depth", int)
        self.deposit = col("deposit")
        self.stake = col("stake")
        self.protagonist = col("protagonist", bool)
        self.near_bank = col("district", int) == ps[pop.cast["banker"]].district
        self.banker = pop.cast["banker"]
        # 交给模型的人：除掌柜外的主角 / who the model plays: every protagonist but the banker
        self.directed = self.protagonist.copy() if director else np.zeros(n, dtype=bool)
        self.directed[self.banker] = False
        self.asked: set[int] = set()  # 已经问过第一次的人 / protagonists already asked once
        self.wants_verify: set[int] = set()  # 决定去柜上看、但钱庄还没开门的人 / decided to go and look while the bank was shut
        self.memory: dict[int, list[str]] = {}  # 主角听到过的话 / what each protagonist has been told

        # 有向边：每条关系两个方向各一条 / directed edges: one in each direction for every tie
        a = np.array([t.a for t in pop.ties] + [t.b for t in pop.ties])
        b = np.array([t.b for t in pop.ties] + [t.a for t in pop.ties])
        order = np.lexsort((b, a))
        self.src, self.dst = a[order], b[order]
        self.kind = np.array([KINDS.index(t.kind) for t in pop.ties] * 2)[order]
        self.strength = np.array([t.strength for t in pop.ties] * 2)[order]
        self.wsum = np.maximum(np.bincount(self.dst, weights=self.strength, minlength=n), 1e-9)
        self.degree = np.maximum(np.bincount(self.dst, minlength=n), 1)
        self.members = [np.array([x.idx for x in ps if v.idx in x.venues], dtype=int) for v in pop.venues]

        # 心智状态 / mental state
        self.L0 = mind.logit(np.clip(params.prior + 0.08 * (1 - self.trust_institution), 0.005, 0.5))
        self.L = self.L0.copy()
        self.fear = np.zeros(n)
        self.expect = np.zeros(n)
        self.talk = np.zeros(n)
        self.seen = np.zeros(n)
        self.status = np.full(n, UNAWARE)
        self.held = np.full(n, -1)
        self.heard = np.zeros((n, 2), dtype=int)  # [辟谣, 谣言] 各从几个不同的人那里听过 / [correction, rumour]: how many different people each was heard from
        self.told: dict[tuple[int, int, int], int] = {}  # (谁, 对谁, 哪一类话) 说过几次 / (speaker, listener, side) → times said
        self.zeal = np.ones(n)
        self.verified = np.zeros(n, dtype=bool)
        self.believed = np.zeros(n, dtype=bool)
        self.verified[self.banker] = True
        self.silenced = np.zeros(n, dtype=bool)
        self.closed_until = np.zeros(len(pop.venues), dtype=int)  # 场所关到第几个小时 / the tick until which each venue stays closed

        # 钱庄 / the bank
        self.total = float(self.deposit.sum())
        self.reserve = params.reserve_ratio * self.total
        self.queue: list[int] = []
        self.failed_at: int | None = None

        self.messages: list[Message] = []
        self.events: list[dict] = []
        self.queue_msg = -1
        self.t = 0

    # ---- 记录 / recording ----

    def _emit(self, k: str, **kw) -> None:
        self.events.append({"t": self.t, "k": k} | kw)

    def _message(self, parent: int | None, author: int | None, valence: int, severity: float, text: str) -> int:
        m = Message(id=len(self.messages), parent=parent, t=self.t, author=author, valence=valence,
                    severity=round(severity, 3), text=text)  # fmt: skip
        self.messages.append(m)
        return m.id

    def _think(self, i: int, kind: str, **kw) -> None:
        # 模型扮演的人，听到消息和去排队时的心里话由模型来写
        # For model-played characters the model writes the thought on hearing and on queueing
        if self.directed[i] and kind in ("heard", "queue", "believe", "doubt"):
            return
        if self.protagonist[i]:
            b = float(mind.sigmoid(self.L[i]))
            text = self.sc.thought(kind, depth=int(self.depth[i]), belief=b, expect=float(self.expect[i]), **kw)
            self._emit("thought", a=i, x=text)

    def _frame(self) -> np.ndarray:
        q = lambda x: np.round(np.clip(x, 0, 1) * 255).astype(np.uint8)  # noqa: E731
        return np.stack([q(mind.sigmoid(self.L)), q(self.fear), q(self.expect), self.status.astype(np.uint8)])

    # ---- 一句话从 src 到 dst / one telling, from src to dst ----

    def _tell(self, src: int, dst: int, via: str, trust: float) -> None:
        p = self.p
        m = int(self.held[src])
        msg = self.messages[m]
        # 模型扮演的人说什么由模型定，不替他们走样 / model-played characters choose their own words, so no drift for them
        if msg.valence == 1 and not self.directed[src] and self.rng.random() < p.mutate:
            # 转述走样：越怕说得越重 / drift in the retelling: the more frightened the teller, the harsher the version
            severity = float(np.clip(msg.severity * np.exp(self.rng.normal(0.12 + 0.3 * self.fear[src], 0.25)), 0.4, 2.5))
            text = self.sc.rumor_text(severity, int(self.rng.integers(8)))
            if text != msg.text:
                m = self._message(m, src, 1, severity, text)
                msg = self.messages[m]
                self.held[src] = m
                self._emit("mutate", a=src, m=m)

        was_aware = self.status[dst] != UNAWARE
        p0 = float(mind.sigmoid(self.L[dst]))
        side = (msg.valence + 1) // 2
        repeats = self.told.get((src, dst, side), 0)
        others = int(self.heard[dst, side]) - (repeats > 0)
        if dst != self.banker:  # 掌柜知道库里有多少银子，谁说什么都一样 / the banker knows what is in the vault, so nothing anyone says moves him
            self.L[dst] += mind.tell_delta(msg.valence, msg.severity, trust, repeats, others,
                                           float(self.L[dst]), int(self.education[dst]), p)  # fmt: skip
        self.told[(src, dst, side)] = repeats + 1
        self.heard[dst, side] += repeats == 0
        p1 = float(mind.sigmoid(self.L[dst]))
        self._emit("tell", a=src, b=dst, m=m, via=via, p0=round(p0 * 100), p1=round(p1 * 100))

        if self.directed[dst]:
            who = self.pop.persons[src]
            place = self.pop.venues[int(via[6:])].name if via.startswith("venue:") else TIE_NAMES[via]
            self.memory.setdefault(dst, []).append(f"{who.name}（{place}）说：「{msg.text}」")
        if msg.valence == 1:
            self._talk_new[dst] += 1
            if not self.verified[dst] and (self.held[dst] < 0 or msg.severity > self.messages[self.held[dst]].severity):
                self.held[dst] = m
        elif p1 < 0.15 and self.status[dst] <= AWARE:
            self.held[dst] = m  # 被说服的人会接着替钱庄说话 / someone who has been persuaded goes on to speak up for the bank

        if was_aware:
            self.zeal[src] *= p.stifle  # 对方早知道了，讲的兴致就减一分 / the listener already knew, so the teller loses a little of the urge to tell
        else:
            self.status[dst] = AWARE
            self._think(dst, "heard", src=self.pop.persons[src].name, text=msg.text)

    def _broadcast(self, iv: Intervention) -> None:
        m = self._message(None, iv.actor, iv.valence, iv.strength, iv.text)
        reached = np.flatnonzero(self.rng.random(self.n) < iv.reach)
        confirm = 1.0 + self.p.confirm * iv.valence * np.tanh(self.L[reached] / 2.0)
        self.L[reached] += iv.valence * iv.strength * (0.3 + self.trust_institution[reached]) * confirm
        # 告示也让原本不知情的人知道了有这回事
        # A notice also tells people who had not heard that there is something to hear about
        self.status[reached] = np.maximum(self.status[reached], AWARE)
        if iv.valence < 0:
            # 被说服的人会把辟谣接着往下传；看到告示的人传谣的兴致也按告示的分量减退
            # Those it convinces pass the correction on; everyone it reaches loses appetite for the rumour in proportion to its weight
            won = reached[(mind.sigmoid(self.L[reached]) < 0.3) & (self.status[reached] <= AWARE)]
            self.held[won] = m
            self.zeal[won] = 1.0
            others = np.setdiff1d(reached, won)
            self.zeal[others] *= max(0.0, 1 - iv.strength / 4)
        self._emit("broadcast", a=iv.actor, m=m, x=round(len(reached) / self.n, 3))
        if iv.actor is not None:
            self.held[iv.actor] = m
            self._think(iv.actor, "notice")

    def _intervene(self, iv: Intervention) -> None:
        if iv.kind == "broadcast":
            self._broadcast(iv)
        elif iv.kind == "close_venue":
            v = self.pop.venues[iv.target]
            self.closed_until[v.idx] = iv.t + iv.duration if iv.duration else self.p.ticks + 1
            self._emit("intervene", b=v.idx, x=f"{v.name}被勒令关门" + (f" {iv.duration} 小时" if iv.duration else ""))
        elif iv.kind == "silence":
            self.silenced[iv.target] = True
            self._emit("intervene", a=iv.target, x="被带走问话，不再开口")
        elif iv.kind == "convince":
            i = iv.target
            self.L[i] = mind.logit(0.03)
            self.verified[i] = True
            self.zeal[i] = 1.0
            self.status[i] = max(self.status[i], AWARE)
            parent = int(self.held[i]) if self.held[i] >= 0 else None
            self.held[i] = self._message(parent, i, -1, 1.0, self.sc.REBUTTAL[0])
            self._emit("intervene", a=i, m=int(self.held[i]), x="被请到柜上看了库银，回去替钱庄说话")
        elif iv.kind == "insurance":
            self.stake *= 1 - iv.value
            self._emit("intervene", x=f"官府宣布：存款若有损失，赔付 {round(iv.value * 100)}%")

    # ---- 一个 tick 的各步 / the steps of one tick ----

    def _spread(self, hour: int) -> None:
        p = self.p
        belief = mind.sigmoid(self.L)
        drive = np.where(self.verified, 0.5, mind.share_drive(belief, self.fear, self.stake)) * self.zeal
        drive = np.where((self.held >= 0) & ~self.silenced, drive, 0.0)

        prob = p.share * _activity(hour)[self.kind] * self.strength * drive[self.src]
        for e in np.flatnonzero(self.rng.random(len(prob)) < prob):
            s, d = int(self.src[e]), int(self.dst[e])
            self._tell(s, d, KINDS[self.kind[e]], float(self.strength[e] * (0.4 + 0.6 * self.trust_general[d])))

        for v in self.pop.venues:
            who = self.members[v.idx]
            if not (v.hours[0] <= hour < v.hours[1]) or len(who) < 2 or self.t < self.closed_until[v.idx]:
                continue
            present = who[self.rng.random(len(who)) < VENUE_ATTEND]
            speaking = present[self.rng.random(len(present)) < p.venue_share * drive[present]]
            for s in speaking:
                others = present[present != s]
                for d in self.rng.choice(others, min(p.venue_audience, len(others)), replace=False):
                    self._tell(int(s), int(d), f"venue:{v.idx}", VENUE_TRUST * (0.4 + 0.6 * self.trust_general[d]))

    def _verify(self, pub: float) -> None:
        p = self.p
        belief = mind.sigmoid(self.L)
        ok = (self.status == AWARE) & ~self.verified
        prob = p.verify * (0.4 + self.education / 3 + self.media_use) * (1 - self.conformity) * 4 * belief * (1 - belief)
        for i in np.flatnonzero(ok & ~self.directed & (self.rng.random(self.n) < prob)):
            self._verify_one(int(i), pub)

    def _verify_one(self, i: int, pub: float) -> None:
        """一个人亲自去柜上看。/ One person goes to the counter to see for themselves."""
        p0 = float(mind.sigmoid(self.L[i]))
        # 柜上确实在兑付；但门口队伍越长，这一眼越不能叫人放心
        # The counter is paying out, but the longer the queue outside, the less reassuring the visit
        self.L[i] -= self.p.w_verify * (0.5 + self.trust_institution[i]) * (1 - pub)
        p1 = float(mind.sigmoid(self.L[i]))
        m = None
        if p1 < 0.3:
            self.verified[i] = True
            m = self._message(int(self.held[i]) if self.held[i] >= 0 else None, i, -1, 1.0,
                              self.sc.REBUTTAL[int(self.rng.integers(len(self.sc.REBUTTAL)))])  # fmt: skip
            self.held[i] = m
            self.zeal[i] = 1.0
        self._emit("verify", a=i, m=m, p0=round(p0 * 100), p1=round(p1 * 100))
        self._think(i, "verify")

    def _observe(self, pub: float, awake: bool) -> None:
        p = self.p
        acting = ((self.status == QUEUEING) | (self.status == WITHDREW)).astype(float)
        near = np.bincount(self.dst, weights=self.strength * acting[self.src], minlength=self.n) / self.wsum
        # 钱庄门口的队伍：住在附近的人天天看得见，住得远的要先听说了才会留意
        # The queue outside the bank: people living nearby see it every day; those further off notice it only once they have heard the story
        sight = np.where(self.near_bank, 1.0, np.where(self.status != UNAWARE, 0.35, 0.0))
        seen = np.maximum(near, pub * sight) if awake else self.seen
        self.L += p.w_seen * np.maximum(seen - self.seen, 0)  # 亲眼看见有人去取，比听说更有分量 / seeing someone withdraw counts for more than hearing about it
        self.seen = np.maximum(self.seen, seen)

        noticed = (self.status == UNAWARE) & (seen > 0.12)
        if noticed.any():
            if self.queue_msg < 0:
                self.queue_msg = self._message(0, None, 1, 0.9, self.sc.QUEUE_SEEN)
            self.status[noticed] = AWARE
            self.held[noticed] = self.queue_msg

        self.talk = np.clip(0.85 * self.talk + self._talk_new / self.degree, 0, 1)
        self.expect = mind.expectation(seen, self.talk, self.depth)
        belief = mind.sigmoid(self.L)
        self.fear += 0.3 * (mind.fear_target(belief, self.expect, self.stake, self.risk_aversion) - self.fear)
        self.L += p.forget * (self.L0 - self.L)
        self.L[self.banker] = self.L0[self.banker]

    def _decide(self) -> None:
        belief = mind.sigmoid(self.L)
        ok = (self.status == AWARE) & (self.deposit > 0) & ~self.directed
        hazard = mind.withdraw_hazard(belief, self.expect, self.fear, self.stake, self.risk_aversion, self.conformity, self.p)
        for i in np.flatnonzero(ok & (self.rng.random(self.n) < hazard)):
            self._join_queue(int(i))

    def _join_queue(self, i: int) -> None:
        self.status[i] = QUEUEING
        self.queue.append(i)
        self._emit("queue", a=i)
        self._think(i, "queue")

    def _direct(self, hour: int, pub: float, bank_open: bool) -> None:
        """问模型扮演的主角：刚听说的人立刻问一次，此后每天上午十点（钱庄已开门）再问一次。
        Ask the model-played protagonists: once when they first hear, then at ten every morning, when the bank is open.
        """
        # 夜里想好了要去柜上看的人，等开门了再去 / those who decided overnight to go and look do so once the bank opens
        if bank_open:
            for i in sorted(self.wants_verify):
                if self.status[i] == AWARE:
                    self._verify_one(i, pub)
            self.wants_verify.clear()
        due = [int(i) for i in np.flatnonzero(self.directed & (self.status == AWARE)) if i not in self.asked or hour == 10]
        if not due:
            return
        decisions = self.director.decide([self._context(i) for i in due])
        for i, d in zip(due, decisions):
            self.asked.add(i)
            if d is None:
                # 模型没答上来：这一次按数值规则办 / no answer from the model: fall back to the numeric rule this once
                b = float(mind.sigmoid(self.L[i]))
                h = mind.withdraw_hazard(b, self.expect[i], self.fear[i], self.stake[i], self.risk_aversion[i], self.conformity[i], self.p)
                if self.deposit[i] > 0 and self.rng.random() < h * 8:  # 一天只问一次，所以把一天的机会并在一起 / asked only once a day, so the whole day's chances are pooled into this one draw
                    self._join_queue(i)
                continue
            self._emit("thought", a=i, x=d.thought, via="llm")
            if d.action == "withdraw" and self.deposit[i] > 0:
                self._join_queue(i)
            elif d.action == "verify":
                if bank_open:
                    self._verify_one(i, pub)
                else:
                    self.wants_verify.add(i)
            elif d.action in ("tell", "reassure") and d.say:
                valence = 1 if d.action == "tell" else -1
                parent = int(self.held[i]) if self.held[i] >= 0 else None
                self.held[i] = self._message(parent, i, valence, d.tone if valence == 1 else 1.0, d.say)
                self.zeal[i] = 1.2
                self._emit("mutate", a=i, m=int(self.held[i]))

    def _context(self, i: int) -> "Context":
        from .protagonist import Context

        x = self.pop.persons[i]
        hour = (self.p.start_hour + self.t) % 24
        day = (self.p.start_hour + self.t) // 24 + 1
        return Context(
            setting=self.sc.PUBLIC, bank=self.pop.venues[self.pop.bank].name, clock=f"第 {day} 天 {hour} 点",
            name=x.name, role=x.role, age=x.age, persona=x.persona, deposit=x.deposit, stake=float(self.stake[i]),
            risk_aversion=x.risk_aversion, conformity=x.conformity, trust_institution=x.trust_institution, depth=x.depth,
            belief=float(mind.sigmoid(self.L[i])), fear=float(self.fear[i]), heard=self.memory.get(i, [])[-6:],
            queue=len(self.queue), acquaintances_ran=float(self.seen[i]), can_withdraw=x.deposit > 0,
        )  # fmt: skip

    def _serve(self) -> None:
        for _ in range(min(len(self.queue), max(1, round(self.p.tellers * self.n)))):
            i = self.queue[0]
            if self.deposit[i] > self.reserve:
                self._fail()
                return
            self.queue.pop(0)
            self.reserve -= self.deposit[i]
            self.status[i] = WITHDREW
            self._emit("withdraw", a=i, x=float(self.deposit[i]))
            self._think(i, "withdraw")

    def _fail(self) -> None:
        self.failed_at = self.t
        self.queue.clear()
        lost = (self.deposit > 0) & (self.status != WITHDREW)
        self.status[self.status == UNAWARE] = AWARE
        self.status[lost] = LOST
        self.L[:] = mind.logit(0.99)
        self.zeal[:] = 0
        self._message(None, None, 1, 2.5, self.sc.FAILED)
        self._emit("fail", x=float(round(self.deposit[lost].sum())))
        self._think(self.banker, "failed")
        for i in np.flatnonzero(self.protagonist & lost):
            self._think(int(i), "lost")

    def _crossings(self) -> None:
        now = self.L > 0
        for i in np.flatnonzero(self.protagonist & (now != self.believed) & (self.status == AWARE)):
            self._think(int(i), "believe" if now[i] else "doubt")
        self.believed = now

    # ---- 主循环 / main loop ----

    def run(self) -> Result:
        p = self.p
        witness = self.pop.cast["witness"]
        self.status[witness] = AWARE
        self.L[witness] = mind.logit(self.sc.ORIGIN_BELIEF)
        self.held[witness] = self._message(None, witness, 1, self.sc.ORIGIN_SEVERITY, self.sc.ORIGIN)
        self._emit("seed", a=witness, m=0)
        self._think(witness, "seed")
        self.believed = self.L > 0

        frames = [self._frame()]
        series: dict[str, list] = {k: [] for k in Series.model_fields}
        self._measure(series)

        for t in range(1, p.ticks + 1):
            self.t = t
            hour = (p.start_hour + t) % 24
            awake = 6 <= hour < 23
            bank = self.pop.venues[self.pop.bank]
            self._talk_new = np.zeros(self.n)
            if self.failed_at is None:
                for iv in p.interventions:
                    if iv.t == t:
                        self._intervene(iv)
                pub = min(1.0, len(self.queue) / (QUEUE_FULL * self.n))
                if awake:
                    self._spread(hour)
                    if bank.hours[0] <= hour < bank.hours[1]:
                        self._verify(pub)
                self._observe(pub, awake)
                if awake:
                    if self.director is not None:
                        self._direct(hour, pub, bank.hours[0] <= hour < bank.hours[1])
                    self._decide()
                    self._crossings()
                if bank.hours[0] <= hour < bank.hours[1]:
                    self._serve()
            frames.append(self._frame())
            self._measure(series)

        return Result(self.messages, self.events, np.stack(frames), Series(**series), self.failed_at)

    def _measure(self, s: dict[str, list]) -> None:
        s["aware"].append(int((self.status != UNAWARE).sum()))
        s["believers"].append(int((self.L > 0).sum()))
        s["queue"].append(len(self.queue))
        s["withdrew"].append(int((self.status == WITHDREW).sum()))
        s["reserve"].append(round(self.reserve / self.total, 4))
        s["fear"].append(round(float(self.fear.mean()), 4))
