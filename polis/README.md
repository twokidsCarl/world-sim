# polis

平行社会模拟器：一群人如何决策、如何传话、如何相互揣度，以及这三件事怎样合起来把一件不存在的事变成真的。

## 模拟什么

有三个场景。虚构的「通和钱庄挤兑」（`rumor_run`）：一座千余口人的县城，更夫夜里看见钱庄后门往外抬箱子，这句话传开、走样，最后挤垮了一家并不亏空的钱庄。

另外两个按史料搭：「丰川信用金库挤兑（1973）」（`toyokawa`）和「东亚银行挤兑（2008）」（`bea`），事件顺序取自 `corpus/cases/`，用来检验模型。丰川参与了校准并影响过模型的改动；东亚银行的设定在第一次运行前定下，原本是样本外检验，结果看过之后不再算。另有三个场景（`bac`、`swedbank`、`kaspi`）是改模型之前写定的样本外检验，已经跑过一次，结果见下文「数据从哪来」。

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
uv run polis prepare                    # 生成统一入口的卡片要用的几次运行，写入 built/
uv run polis corpus                     # 检查语料，列出出处还没核实的条目
cd web && bun install && bun run dev    # 回放界面，http://localhost:5186
```

`runs/` 不入库，按上面的命令重新生成即可。

## 直达链接与统一入口

界面的状态可以写在地址里，所以每个场景都有一个能直接打开的链接：

| 参数 | 作用 |
|---|---|
| `run=<记录名>` | 打开哪一次运行；不写则打开通和场景的第一条 |
| `t=<小时>` | 停在哪一刻 |
| `person=<角色键或下标>` | 选中谁，例如 `person=widow` |
| `tab=lab` | 直接进实验台 |
| `view=library` | 直接打开依据页 |
| `embed=1` | 嵌入模式：只留城和时间轴，进来就播放；点了人或进了实验台才出现右侧面板 |
| `play=1` / `play=0` | 强制播放或不播放 |

页面隐藏时播放和渲染循环会停下，回来再继续。

`sim.json` 是给仓库统一入口（`idea-loom`）看的名片：怎么构建、怎么起后端、有哪几张卡片。卡片要用的运行不在 git 里，由 `uv run polis prepare` 按种子生成到 `built/`；主角由模型扮演的那一次生成它需要调用模型，所以它的记录直接放在 `samples/` 里。

记录从三处读：可写的运行目录、`built/`、`samples/`，后两处只读。可写目录依次取环境变量 `POLIS_RUNS`、`WORLD_SIM_STATE` 下的 `runs/`、项目下的 `runs/`；分叉和集成的结果都写在那里。

## 怎么测试

```sh
uv run pytest
cd web && bun run test && bun run typecheck
```

`src/polis/model.py` 是引擎与界面之间的唯一数据契约。改了它之后在 `web/` 下执行 `bun run gen:types`，重新生成 `web/src/contract/` 里的 JSON Schema 和 TypeScript 类型。

## 语料

`corpus/` 是模拟的理论依据和将来的校准目标，每条都带出处：

- `theory/`：12 张理论卡（谣言、阈值、级联、挤兑、从众……），每张写明机制、可观察的推论，以及引擎里哪一处实现了它——留空的就是还没实现。
- `cases/`：10 个案例，五个出自文学与典故，五个是有记录的真实挤兑（1973 年丰川信用金库、2008 年东亚银行，以及留作样本外检验的 2004 年 BAC 圣何塞、2011 年 Swedbank 拉脱维亚、2014 年 Kaspi）。
- `facts/`：10 条典型事实，带数值、得出条件和与本模拟情境的差距。

出处的 `verified` 只有在实际打开过能证实它的页面之后才为真，`checked` 写明看的是哪一页、证实了什么；没能核实的如实标为假，不进入校准。文字均为转述，没有收录原作文本。

## 数据从哪来

引擎目前没有使用任何外部数据；语料只是文献与史料的转述和书目信息。

- **人口是合成的**：属性与特质的分布是占位假设，由种子生成，没有对齐任何调查。
- **默认的行为参数是手调的**，调到曲线看起来合理为止。
- **校准只是起步**：`polis calibrate` 用语料里七个目标（取款储户占 3%–9%、熟人跑了自己更可能跑、辟谣有效但消不干净、有可信担保时银行撑得住、三人成虎、丰川的平行世界里至少三成像史料、东亚银行被提走的存款不到 2%）随机搜索八个参数，结果存在 `calibration.json`。六个命中；取款储户的比例在校准用的 8 个种子上平均 1.6%，没到 3%。目标少、参数多，得到的是"与这几条事实大体不矛盾"的一组参数；"可信担保"的力度本身也是手设的。
- **"谁会去取"重新设计过一次**（`mind.py`）。原来的规则是每个知情储户每小时掷一次骰子，日子一长人人都会被掷中，所以挤兑一旦开始几乎人人都去取。现在：
  - 每人有一个整场不变的门槛，动机没过门槛的人等多久也不去（Granovetter 的门槛模型）；与银行往来久、有贷款的人门槛更高（依据是 Iyer 与 Puri）。
  - 有存款保险的场景里，保得住的那部分不算在可能的损失里，去了也不一定取光。上限定在储户存款的 95 分位，这个比例是照 Iyer 与 Puri 的量级手设的。
  - 往来年数、有没有贷款、各人门槛的分布都是占位假设。
- **重新设计之后，拟合过的案例规模对上了，没见过的案例仍然对不上。** `polis canon --held-out` 换一批种子各跑 30 个平行世界，只跑了这一次：
  - 丰川（参与过校准）：29 个世界金库撑住（改之前 19 个）。但担保之前真发生挤兑的只有 3 个世界，27 个世界里玩笑不了了之；五件事全部像史料的仍然只有 1 个。校准用的种子上这个比例是 37.5%，换了种子就掉回去，说明那是对种子的过拟合。
  - 东亚银行（结果看过，已拿来校准）：30 个世界银行都撑住（改之前 10 个），被提走的存款平均 2.7%、最多 8.8%（改之前平均 50%）；史料是 0.67%。但只有 10 个世界发生了挤兑。
  - 三起样本外案例，设定和通过标准在改模型之前就合并了（PR #104）。标准对三者相同：银行不倒、挤兑在史料所记的那一天开始、取走的比例在史料数字的一半到两倍之间、当局表态两天后基本没人再去。

    | 案例 | 史料 | 模拟（30 个世界） | 全部相符 |
    |---|---|---|---|
    | BAC 圣何塞 2004 | 两天取走约 1.8% | 11 个世界发生挤兑；取走平均 15.1%（0%–80%）；4 个世界银行倒闭 | 0 / 30 |
    | Swedbank 拉脱维亚 2011 | 一个周日取走约 1.5% | 12 个世界发生挤兑；取走平均 4.6%（0%–25.1%）；银行都撑住 | 1 / 30 |
    | Kaspi 2014 | 三天里约一成储户取走约 9% | 没有一个世界发生挤兑；取走最多 1.1% | 0 / 30 |

  - 逐条检查共 480 次，对上 197 次，其中多数是"银行没倒""事后平息"这类什么都不发生也能对上的项。
  - **被否定的假设**：模型里，人要等熟人印证、看见别人去取，才会行动，所以结果非此即彼——要么不了了之，要么滚成雪崩。真实的三起挤兑都不是这样：一条群发消息在几小时内就让一小部分人各自去取了钱，规模有限而且各不相同。Kaspi 最清楚：国家银行当天就否认了，三天里仍有一成储户去取；模型里同样的否认在六小时后就把事情压没了。也就是说，"当局表态"的预设力度远大于实际，而"消息直接让一部分人行动"这条路模型里几乎没有。
  - 这三起案例的结果既然看过，下次再改模型，它们也不能再算检验，得另找新的。
- 通和场景的**人物、地名、说法都是本项目原创**；丰川、东亚银行和三个样本外场景的事件顺序取自语料里的史料转述，人物是匿名代号或虚构的普通储户，街区、人口、存款和关系网是合成的。

---

# polis

A parallel-society simulator: how a crowd of people decide, how they pass words along, how they second-guess one another, and how these three things together turn something that does not exist into something real.

## What it simulates

There are three scenarios. The first is the fictional "run on Tonghe Bank (通和钱庄)" (`rumor_run`): a county town of a little over a thousand people, where the night watchman sees chests being carried out of the bank's back door; that one sentence spreads, gets distorted, and in the end brings down a bank that was never insolvent.

The other two are built from historical records: the "Toyokawa Shinkin Bank run (1973)" (`toyokawa`) and the "Bank of East Asia run (2008)" (`bea`), with the order of events taken from `corpus/cases/`; they exist to test the model. Toyokawa is used in calibration and shaped changes to the model; the Bank of East Asia settings were fixed before the first run and it was the out-of-sample test until its result had been seen. Three further scenarios (`bac`, `swedbank`, `kaspi`) were fixed as out-of-sample tests before the model was changed and have now been run once; for the result see "Where the data comes from" below.

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
uv run polis prepare                    # generate the runs behind the shared host's cards, into built/
uv run polis corpus                     # check the corpus and list entries whose sources are not yet verified
cd web && bun install && bun run dev    # replay interface, http://localhost:5186
```

`runs/` is not committed; regenerate it with the commands above.

## Deep links and the shared host

The UI's state can be written into the address, so every scene has a link that opens it directly:

| Parameter | Effect |
|---|---|
| `run=<run id>` | Which run to open; without it, the first run of the Tonghe scenario |
| `t=<hour>` | The moment to stop at |
| `person=<cast key or index>` | Who is selected, e.g. `person=widow` |
| `tab=lab` | Go straight to the lab |
| `view=library` | Open the evidence page |
| `embed=1` | Embed mode: stage and timeline only, playing on arrival; the side panel appears once a person is picked or the lab is opened |
| `play=1` / `play=0` | Force playing or not playing |

Playback and the render loop stop while the page is hidden and resume on return.

`sim.json` is the project's card for the repository's shared host (`idea-loom`): how to build it, how to start the backend, and which cards it offers. The runs behind the cards are not in git; `uv run polis prepare` generates them from their seeds into `built/`. The run with model-played protagonists needs model calls to produce, so its record is committed under `samples/`.

Runs are read from three places: the writable runs directory, `built/` and `samples/`, the last two read-only. The writable directory is `POLIS_RUNS`, else `runs/` under `WORLD_SIM_STATE`, else `runs/` in the project; forks and ensembles are written there.

## How to test

```sh
uv run pytest
cd web && bun run test && bun run typecheck
```

`src/polis/model.py` is the only data contract between the engine and the interface. After changing it, run `bun run gen:types` under `web/` to regenerate the JSON Schema and TypeScript types in `web/src/contract/`.

## Corpus

`corpus/` holds the theoretical basis of the simulation and its future calibration targets; every entry carries its sources:

- `theory/`: 12 theory cards (rumour, thresholds, cascades, bank runs, conformity, …), each stating the mechanism, its observable implications, and where in the engine it is implemented — a blank there means it is not implemented yet.
- `cases/`: 10 cases — five from literature and classical allusion, five documented real bank runs (Toyokawa Shinkin Bank in 1973, Bank of East Asia in 2008, and three held out as tests: BAC San José in 2004, Swedbank in Latvia in 2011, Kaspi Bank in 2014).
- `facts/`: 10 stylised facts, each with its values, the conditions under which it was obtained, and how far those are from the setting of this simulation.

A source's `verified` is true only after a page that actually confirms it has been opened, and `checked` records which page was read and what it confirmed; sources that could not be verified are honestly marked false and do not enter calibration. All text is paraphrase; no text from the original works is included.

## Where the data comes from

The engine currently uses no external data at all; the corpus is only paraphrase of literature and historical sources plus bibliographic information.

- **The population is synthetic**: the distributions of attributes and traits are placeholder assumptions, generated from the seed and not aligned with any survey.
- **The default behavioural parameters are hand-tuned**, adjusted until the curves looked reasonable.
- **Calibration is only a beginning**: `polis calibrate` runs a random search over eight parameters against seven targets from the corpus (3%–9% of depositors withdraw, a person is more likely to run when acquaintances have, corrections work but leave a residue, the bank holds under a credible guarantee, three men make a tiger, at least three in ten parallel Toyokawa worlds resemble the record, and under 2% of deposits leave the Bank of East Asia); the result is stored in `calibration.json`. Six are hit; the share of depositors who withdraw averages 1.6% on the 8 calibration seeds, short of 3%. With few targets and many parameters this is a parameter set that is "broadly not contradicted by these few facts"; the strength of the "credible guarantee" is itself set by hand.
- **"Who withdraws" has been redesigned once** (`mind.py`). The old rule rolled a die every hour for every depositor who had heard, which catches everybody in the end, so once a run started nearly everyone withdrew. Now:
  - Each person has a threshold that is fixed for the whole run, and someone whose motive stays below it never goes however long they wait (Granovetter's threshold model); long relationships with the bank and loans raise it (the evidence is Iyer and Puri).
  - Where a scenario has deposit insurance, the covered part of a deposit is left out of what can be lost, and those who do go may not take everything. The cap sits at the 95th percentile of deposits, a share set by hand to Iyer and Puri's order of magnitude.
  - The distributions of tenure, of who has a loan, and of individual thresholds are placeholder assumptions.
- **After the redesign the fitted cases match in scale; the unseen ones still do not.** `polis canon --held-out` ran 30 parallel worlds per case on a fresh set of seeds, once:
  - Toyokawa (used in calibration): the bank holds in 29 worlds (19 before). But a run actually starts before the guarantee in only 3 worlds and the joke goes nowhere in 27; still only 1 world matches the record on all five points. On the calibration seeds that share was 37.5%; it falls back on fresh seeds, which means it was fitted to the seeds.
  - Bank of East Asia (result seen, now used in calibration): the bank holds in all 30 worlds (10 before) and 2.7% of deposits leave on average, 8.8% at most (50% on average before); the record says 0.67%. But a run happens in only 10 worlds.
  - Three held-out cases, whose settings and pass criteria were merged before the model was changed (PR #104). The criteria are the same for all three: the bank survives, the run starts on the recorded day, the share withdrawn is between half and twice the recorded figure, and almost nobody still goes two days after the authorities speak.

    | Case | Record | Simulation (30 worlds) | All criteria met |
    |---|---|---|---|
    | BAC San José 2004 | about 1.8% withdrawn over two days | a run in 11 worlds; 15.1% withdrawn on average (0%–80%); the bank fails in 4 | 0 / 30 |
    | Swedbank Latvia 2011 | about 1.5% withdrawn on one Sunday | a run in 12 worlds; 4.6% withdrawn on average (0%–25.1%); the bank always holds | 1 / 30 |
    | Kaspi 2014 | about a tenth of depositors withdrew roughly 9% in three days | no run in any world; at most 1.1% withdrawn | 0 / 30 |

  - Of 480 individual checks 197 pass, most of them items such as "the bank survives" and "calm afterwards" that also pass when nothing happens at all.
  - **The assumption this refutes**: in the model a person acts only after acquaintances corroborate the story and others are seen withdrawing, so outcomes are all or nothing: the rumour fizzles or it avalanches. None of the three real runs looked like that. A mass message made a small share of people go and withdraw, each on their own, within hours; the scale was limited and differed from case to case. Kaspi is the clearest: the National Bank denied the story the same day and a tenth of depositors still withdrew over three days, whereas in the model the same denial ends everything six hours in. So the preset strength of "the authorities speak" is far greater than the real thing, and the path by which a message moves some people directly hardly exists in the model.
  - Now that these three results have been seen, they cannot count as tests the next time the model changes either; new ones will be needed.
- In the Tonghe scenario, **the characters, place names and wording are all original to this project**; in the Toyokawa, Bank of East Asia and three held-out scenarios the order of events comes from the corpus's paraphrase of the records, the characters are anonymous labels or invented ordinary depositors, and the districts, population, deposits and network of ties are synthetic.
