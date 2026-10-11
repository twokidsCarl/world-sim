# polis

平行社会模拟器：一群人如何决策、如何传话、如何相互揣度，以及这三件事怎样合起来把一件不存在的事变成真的。

## 模拟什么

有三个场景。虚构的「通和钱庄挤兑」（`rumor_run`）：一座千余口人的县城，更夫夜里看见钱庄后门往外抬箱子，这句话传开、走样，最后挤垮了一家并不亏空的钱庄。

另外两个按史料搭：「丰川信用金库挤兑（1973）」（`toyokawa`）和「东亚银行挤兑（2008）」（`bea`），事件顺序取自 `corpus/cases/`，用来检验模型。丰川参与了校准并影响过模型的改动；东亚银行的设定在第一次运行前定下，只作样本外检验。

- **人**：人口属性、五项稳定特质（信人、信官面文章、怕吃亏、随大流、读报听讯）、随时间变化的心智状态（信念、恐惧、估计多少人会去取钱），以及揣度他人的层数（0–2 层）。
- **社会**：家人、邻居、同事、朋友四种关系，加上茶馆、菜场、庙、学堂这些会碰面的场所。
- **引擎**：按小时推进。全体人口由数值模型决策，相同的种子和参数产生逐字节相同的记录。
- **界面**：回放整个过程——城市舞台、时间轴、每个人的心智与经历。

- **依据页**：界面右上角「依据」，列出全部理论卡、案例、事实及其出处核实情况，以及校准结果。
- **实验台**：在回放的任意时刻加一条干预（告示、担保、新谣言、关场所、带走或说服某个人、存款保险），分叉重跑，与原来那条世界线并排比较；或同一设定换 20 个种子看分布。
- **模型扮演主角**：`--llm` 时，除掌柜外的主角在刚听说时和此后每天上午各被问一次，由大模型按人物的身份、处境和听到的话决定怎么想、怎么办、对人说什么；信念和恐惧仍由数值引擎计算。调用走本机的 `claude` 命令，结果按提示词缓存，同一次模拟重跑不会再调用。

还没有做的：用调查数据生成人口。

## 怎么运行

需要 [uv](https://docs.astral.sh/uv/) 和 [bun](https://bun.sh/)。

```sh
uv run polis run --seed 1               # 跑一次，记录写入 runs/
uv run polis run -s 1 -r none           # 同一座城，无人回应；-r guarantee 是官银号出面担保
uv run polis run -s 1 -c -r guarantee   # -c 用校准过的参数
uv run polis calibrate                  # 对照语料里的事实，报告偏差并搜索参数
uv run polis run toyokawa -c            # 丰川场景，按史料的回应时间；bea 是东亚银行场景
uv run polis canon                      # 对照原作与史料，逐条看模拟对上了没有
uv run polis run -s 1 -c -r none --llm  # 主角交给大模型扮演（约 30 次调用，一分钟左右）
uv run polis list                       # 已有的记录
uv run polis serve                      # API，端口 8766
uv run polis corpus                     # 检查语料，列出出处还没核实的条目
cd web && bun install && bun run dev    # 回放界面，http://localhost:5186
```

`runs/` 不入库，按上面的命令重新生成即可。

## 怎么测试

```sh
uv run pytest
cd web && bun run test && bun run typecheck
```

`src/polis/model.py` 是引擎与界面之间的唯一数据契约。改了它之后在 `web/` 下执行 `bun run gen:types`，重新生成 `web/src/contract/` 里的 JSON Schema 和 TypeScript 类型。

## 语料

`corpus/` 是模拟的理论依据和将来的校准目标，每条都带出处：

- `theory/`：12 张理论卡（谣言、阈值、级联、挤兑、从众……），每张写明机制、可观察的推论，以及引擎里哪一处实现了它——留空的就是还没实现。
- `cases/`：7 个案例，五个出自文学与典故，两个是有记录的真实挤兑（1973 年丰川信用金库、2008 年东亚银行）。
- `facts/`：10 条典型事实，带数值、得出条件和与本模拟情境的差距。

出处的 `verified` 只有在实际打开过能证实它的页面之后才为真，`checked` 写明看的是哪一页、证实了什么；没能核实的如实标为假，不进入校准。文字均为转述，没有收录原作文本。

## 数据从哪来

引擎目前没有使用任何外部数据；语料只是文献与史料的转述和书目信息。

- **人口是合成的**：属性与特质的分布是占位假设，由种子生成，没有对齐任何调查。
- **默认的行为参数是手调的**，调到曲线看起来合理为止。
- **校准只是起步**：`polis calibrate` 用语料里六个目标（取款储户占 3%–9%、熟人跑了自己更可能跑、辟谣有效但消不干净、有可信担保时银行撑得住、三人成虎、丰川的平行世界里至少三成像史料）随机搜索七个参数，结果存在 `calibration.json`。前五个命中；丰川那一条在校准用的 8 个种子上是 25%，没到三成。目标少、参数多，得到的是"与这几条事实大体不矛盾"的一组参数；"可信担保"的力度本身也是手设的。
- **模型还不能复现真实的挤兑**。`polis canon` 换一批种子各跑 30 个平行世界：
  - 丰川（参与过校准）：19 个世界金库撑住、11 个倒闭；五件事全部像史料的只有 1 个。一半的世界里玩笑不了了之，这本身说得通，但不该有三分之一的世界以倒闭收场。
  - 东亚银行（样本外）：时间对得上（平均第 2.2 天起挤兑，担保后两天内平息），规模完全对不上——模拟里平均提走存款的 50%，20 个世界银行倒闭；史料里银行公布的是 0.67%，银行没倒。
  - 两个案例指向同一个毛病：挤兑一旦开始，模型里几乎人人都去取；现实里即使在高峰也只是少数人。
  - 这一轮为此改过的规则：说法含糊时不催人行动也不值得逢人便讲、拿不准时只问亲近的人、估下来不值得跑一趟的人不去、担保可以带来现银。它们让丰川从"第 3 天必倒"变成"多数世界不倒"，但没有解决规模问题。
- 通和场景的**人物、地名、说法都是本项目原创**；丰川和东亚银行场景的事件顺序取自语料里的史料转述，人物是匿名代号或虚构的普通储户，街区、人口、存款和关系网是合成的。

---

# polis

A parallel-society simulator: how a crowd of people decide, how they pass words along, how they second-guess one another, and how these three things together turn something that does not exist into something real.

## What it simulates

There are three scenarios. The first is the fictional "run on Tonghe Bank (通和钱庄)" (`rumor_run`): a county town of a little over a thousand people, where the night watchman sees chests being carried out of the bank's back door; that one sentence spreads, gets distorted, and in the end brings down a bank that was never insolvent.

The other two are built from historical records: the "Toyokawa Shinkin Bank run (1973)" (`toyokawa`) and the "Bank of East Asia run (2008)" (`bea`), with the order of events taken from `corpus/cases/`; they exist to test the model. Toyokawa is used in calibration and shaped changes to the model; the Bank of East Asia settings were fixed before the first run and serve only as the out-of-sample test.

- **People**: demographic attributes, five stable traits (trust in other people, trust in official statements, loss aversion, conformity, attention to newspapers and news), a mental state that changes over time (belief, fear, an estimate of how many others will go to withdraw), and a depth of reasoning about others (0–2 levels).
- **Society**: four kinds of ties — family, neighbours, colleagues, friends — plus the venues where people run into each other: the teahouse, the market, the temple, the school.
- **Engine**: advances hour by hour. The whole population is decided by a numerical model; the same seed and parameters produce a byte-for-byte identical record.
- **Interface**: replays the whole process — the town stage, the timeline, and each person's mind and history.

- **Evidence page**: "依据" (Evidence) at the top right of the interface lists every theory card, case and fact together with the verification status of its sources, and the calibration results.
- **Lab**: at any moment of the replay, add an intervention (a public notice, a guarantee, a new rumour, closing a venue, taking a person away or persuading them, deposit insurance), fork and re-run, and compare side by side with the original world line; or keep the same setup and run 20 different seeds to see the distribution.
- **LLM plays the cast**: with `--llm`, each cast member other than the bank's manager is asked once on first hearing the rumour and once every morning thereafter, and a large language model decides — from the character's identity, situation and what they have heard — what to think, what to do and what to tell others; belief and fear are still computed by the numerical engine. Calls go through the local `claude` command and results are cached by prompt, so re-running the same simulation makes no further calls.

Not done yet: generating the population from survey data.

## How to run

Requires [uv](https://docs.astral.sh/uv/) and [bun](https://bun.sh/).

```sh
uv run polis run --seed 1               # one run; the record is written to runs/
uv run polis run -s 1 -r none           # same town, nobody responds; -r guarantee has the official bank step in with a guarantee
uv run polis run -s 1 -c -r guarantee   # -c uses the calibrated parameters
uv run polis calibrate                  # compare against the facts in the corpus, report deviations and search parameters
uv run polis run toyokawa -c            # Toyokawa scenario, with the response timing from the historical record; bea is the Bank of East Asia scenario
uv run polis canon                      # check the simulation item by item against the original story and the historical record
uv run polis run -s 1 -c -r none --llm  # hand the cast to an LLM (about 30 calls, roughly one minute)
uv run polis list                       # existing records
uv run polis serve                      # API, port 8766
uv run polis corpus                     # check the corpus and list entries whose sources are not yet verified
cd web && bun install && bun run dev    # replay interface, http://localhost:5186
```

`runs/` is not committed; regenerate it with the commands above.

## How to test

```sh
uv run pytest
cd web && bun run test && bun run typecheck
```

`src/polis/model.py` is the only data contract between the engine and the interface. After changing it, run `bun run gen:types` under `web/` to regenerate the JSON Schema and TypeScript types in `web/src/contract/`.

## Corpus

`corpus/` holds the theoretical basis of the simulation and its future calibration targets; every entry carries its sources:

- `theory/`: 12 theory cards (rumour, thresholds, cascades, bank runs, conformity, …), each stating the mechanism, its observable implications, and where in the engine it is implemented — a blank there means it is not implemented yet.
- `cases/`: 7 cases — five from literature and classical allusion, two documented real bank runs (Toyokawa Shinkin Bank in 1973, Bank of East Asia in 2008).
- `facts/`: 10 stylised facts, each with its values, the conditions under which it was obtained, and how far those are from the setting of this simulation.

A source's `verified` is true only after a page that actually confirms it has been opened, and `checked` records which page was read and what it confirmed; sources that could not be verified are honestly marked false and do not enter calibration. All text is paraphrase; no text from the original works is included.

## Where the data comes from

The engine currently uses no external data at all; the corpus is only paraphrase of literature and historical sources plus bibliographic information.

- **The population is synthetic**: the distributions of attributes and traits are placeholder assumptions, generated from the seed and not aligned with any survey.
- **The default behavioural parameters are hand-tuned**, adjusted until the curves looked reasonable.
- **Calibration is only a beginning**: `polis calibrate` runs a random search over seven parameters against six targets from the corpus (3%–9% of depositors withdraw, a person is more likely to run when acquaintances have, corrections work but leave a residue, the bank holds under a credible guarantee, three men make a tiger, and at least three in ten parallel Toyokawa worlds resemble the record); the result is stored in `calibration.json`. The first five are hit; the Toyokawa one reaches 25% on the 8 calibration seeds, short of three in ten. With few targets and many parameters this is a parameter set that is "broadly not contradicted by these few facts"; the strength of the "credible guarantee" is itself set by hand.
- **The model cannot yet reproduce a real bank run.** `polis canon` runs 30 parallel worlds per case on a fresh set of seeds:
  - Toyokawa (used in calibration): the bank holds in 19 worlds and fails in 11; only 1 world matches the record on all five points. The joke going nowhere in half the worlds is plausible in itself, but a third of worlds should not end in failure.
  - Bank of East Asia (out of sample): the timing matches (the run starts on day 2.2 on average and subsides within two days of the guarantee) and the scale does not match at all — the simulation withdraws 50% of deposits on average and the bank fails in 20 worlds; in the record the bank reported 0.67% and did not fail.
  - Both cases point to the same defect: once a run starts, nearly everyone in the model goes to withdraw; in reality only a minority does, even at the peak.
  - Rules changed in this round because of it: a vague version neither presses people to act nor is worth telling everyone, people who are unsure ask only those close to them, nobody goes when the trip is not worth it by their own estimate, and a guarantee can bring cash. These took Toyokawa from "always fails on day 3" to "holds in most worlds" but did not fix the scale.
- In the Tonghe scenario, **the characters, place names and wording are all original to this project**; in the Toyokawa and Bank of East Asia scenarios the order of events comes from the corpus's paraphrase of the records, the characters are anonymous labels or invented ordinary depositors, and the districts, population, deposits and network of ties are synthetic.
