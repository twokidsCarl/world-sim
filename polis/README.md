# polis

平行社会模拟器：一群人如何决策、如何传话、如何相互揣度，以及这三件事怎样合起来把一件不存在的事变成真的。

## 模拟什么

有三个场景。虚构的「通和钱庄挤兑」（`rumor_run`）：一座千余口人的县城，更夫夜里看见钱庄后门往外抬箱子，这句话传开、走样，最后挤垮了一家并不亏空的钱庄。

另外两个按史料搭：「丰川信用金库挤兑（1973）」（`toyokawa`）和「东亚银行挤兑（2008）」（`bea`），事件顺序取自 `corpus/cases/`，用来检验模型。丰川参与了校准并影响过模型的改动；东亚银行的设定在第一次运行前定下，原本是样本外检验，结果看过之后不再算。另有三个场景（`bac`、`swedbank`、`kaspi`）是第一轮改模型之前写定的样本外检验，结果见下文「数据从哪来」；结果看过之后它们不再算检验。第二轮改模型之前又写定了两个（`icici`、`fib`）。

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
| `lang=en` / `lang=zh` | 界面语言。不写时用上次选的，再不然看浏览器语言。场景里的人名、谣言的说法和心里话始终是中文原文 |
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

`corpus/` 是模拟的理论依据和将来的校准目标，每条都带出处。正文是中文，每个文件的 `en:` 块里是英文；`uv run polis corpus` 会报出缺英文的条目。出处的卷期页码（`locator`）没有另译。

- `theory/`：12 张理论卡（谣言、阈值、级联、挤兑、从众……），每张写明机制、可观察的推论，以及引擎里哪一处实现了它——留空的就是还没实现。
- `cases/`：12 个案例，五个出自文学与典故，七个是有记录的真实挤兑（1973 年丰川信用金库、2008 年东亚银行；第一轮留作样本外检验的 2004 年 BAC 圣何塞、2011 年 Swedbank 拉脱维亚、2014 年 Kaspi；第二轮留作检验的 2003 年 ICICI、2014 年保加利亚第一投资银行）。
- `facts/`：10 条典型事实，带数值、得出条件和与本模拟情境的差距。

出处的 `verified` 只有在实际打开过能证实它的页面之后才为真，`checked` 写明看的是哪一页、证实了什么；没能核实的如实标为假，不进入校准。文字均为转述，没有收录原作文本。

## 数据从哪来

引擎用到的外部数据有三项，都只用在人口生成上：年龄结构、学历构成、信任（见下）。语料只是文献与史料的转述和书目信息。

- **人口是合成的，其中三样对齐了公开数据**。汇总数、出处和许可都写在 `data/curated/` 各文件的开头；原始文件只在本地的 `data/raw/`，不进仓库，用 `uv run polis curate` 可以从原始文件重新算出汇总数。
  - 年龄结构：联合国《世界人口展望 2024》对应地方和年份的数字（CC BY 3.0 IGO）。
  - 学历构成：Barro–Lee 数据集里离事件最近的一年（版权归作者，这里只引用了每个国家/年份的四个百分比）。
  - 对邻里和对政府的信任：Wellcome Global Monitor 2020，按学历和年龄段分组的平均分。调查是 2020 年做的，事件发生在 1973 到 2014 年之间，年份对不上；该页面公开提供下载，但没有写明数据的许可。
  - 虚构的通和场景是民国县城：年龄和学历用的是能拿到的最早的中国数字（1950 年），信任没有用数据。
  - 其余属性与特质（收入、风险厌恶、从众、推理深度、与银行的往来）的分布都是占位假设，由种子生成。
  - 没有用的：世界价值观调查和中国综合社会调查要本人注册并同意条款，没有接。
- **默认的行为参数是手调的**，调到曲线看起来合理为止。
- **校准只是起步，而且很脆**：`polis calibrate` 用语料里八个目标（取款储户占 3%–9%、熟人跑了自己更可能跑、辟谣有效但消不干净、有可信担保时银行撑得住、三人成虎、丰川的平行世界里至少三成像史料、东亚银行被提走的存款不到 2%、第一轮三起检验案例里至少三成的世界规模对得上）随机搜索十个参数，结果存在 `calibration.json`。五个命中，三个没中：取款储户的比例平均 1.8%（目标下限 2.9%），丰川 25%（下限 30%），第一轮三起案例 21%（下限 30%）。"可信担保"的力度本身也是手设的。
  - 脆在哪里：丰川那一条在校准用的 8 个种子上是 25%，换一批 30 个种子是 3 个世界（10%）；东亚银行在校准的种子上平均 1.5%，换种子是 2.8%；第一轮三起案例在校准的种子上有 21% 的世界规模对得上，换种子后没有一个世界全部相符。人口每换一次数据、目标每加一条，同一个搜索找到的参数和各项得分都明显不同。校准得到的是对这几个种子和这份人口的拟合，不是模型学到了什么。
- **"谁会去取"重新设计过一次**（`mind.py`）。原来的规则是每个知情储户每小时掷一次骰子，日子一长人人都会被掷中，所以挤兑一旦开始几乎人人都去取。现在：
  - 每人有一个整场不变的门槛，动机没过门槛的人等多久也不去（Granovetter 的门槛模型）；与银行往来久、有贷款的人门槛更高（依据是 Iyer 与 Puri）。
  - 有存款保险的场景里，保得住的那部分不算在可能的损失里，去了也不一定取光。上限定在储户存款的 95 分位，这个比例是照 Iyer 与 Puri 的量级手设的。
  - 往来年数、有没有贷款、各人门槛的分布都是占位假设。
- **重新设计之后，拟合过的案例规模对上了，没见过的案例仍然对不上。** `polis canon --held-out` 换一批种子各跑 30 个平行世界。它一共跑过三次：重新设计刚完成时（PR #110）、年龄结构换成数据之后（PR #117）、学历和信任也换成数据之后（PR #132）。每次人口变了都重新校准，但从没有照着这三起案例的结果调过任何东西。下面是第一轮结束时（PR #132）的结果，第二轮的见后面一条：
  - 丰川（参与过校准）：29 个世界金库撑住（重新设计之前 19 个），但担保之前真发生挤兑的只有 3 个世界，27 个世界里玩笑不了了之；五件事全部像史料的只有 1 个。
  - 东亚银行（结果看过，已拿来校准）：30 个世界银行都撑住（重新设计之前 10 个），被提走的存款平均 2.4%、最多 10.6%（重新设计之前平均 50%）；史料是 0.67%。11 个世界发生了挤兑。
  - 三起样本外案例，设定和通过标准在改模型之前就合并了（PR #104）。标准对三者相同：银行不倒、挤兑在史料所记的那一天开始、取走的比例在史料数字的一半到两倍之间、当局表态两天后基本没人再去。

    | 案例 | 史料 | 模拟（30 个世界） | 全部相符（三次依次） |
    |---|---|---|---|
    | BAC 圣何塞 2004 | 两天取走约 1.8% | 10 个世界发生挤兑；取走平均 6.6%（0%–73.5%）；银行都撑住 | 0、0、1 / 30 |
    | Swedbank 拉脱维亚 2011 | 一个周日取走约 1.5% | 6 个世界发生挤兑；取走平均 2.0%（0%–20.5%）；银行都撑住 | 1、1、2 / 30 |
    | Kaspi 2014 | 三天里约一成储户取走约 9% | 没有一个世界发生挤兑；取走最多 0.8% | 0、0、0 / 30 |

  - 逐条检查共 480 次，对上 202 次（前两次都是 197 次），其中多数是"银行没倒""事后平息"这类什么都不发生也能对上的项。平均数有时看上去接近史料，是因为多数世界什么都没发生、少数世界闹得很大，平均下来碰巧落在那里。
  - **被否定的假设**：模型里，人要等熟人印证、看见别人去取，才会行动，所以结果非此即彼——要么不了了之，要么滚成雪崩。真实的三起挤兑都不是这样：一条群发消息在几小时内就让一小部分人各自去取了钱，规模有限而且各不相同。Kaspi 最清楚：国家银行当天就否认了，三天里仍有一成储户去取；模型里同样的否认在六小时后就把事情压没了。也就是说，"当局表态"的预设力度远大于实际，而"消息直接让一部分人行动"这条路模型里几乎没有。
  - 这三起案例的结果既然看过，下次再改模型，它们也不能再算检验，得另找新的。
- **第二轮改动（PR #144 之后）没有让模型对上，两起新案例都是 0 / 30。**
  - 改了什么：① 群发消息成为"公共信号"——收到的人知道别人也收到了，会揣度别人的人不必等熟人来说就估计有人会去取（`mind.expectation` 的 `public`，力度是参数 `Params.public`）；② 辟谣和担保的告示按 `Params.authority` 打折；③ 银行关门的时候柜上不付款。
  - 校准的结论：搜索把 `public` 定在 0（等于关掉第一条），把 `authority` 压到搜索范围的下限 0.2。原因在试的时候就看得到：同样一条群发消息，打开这条路之后模型里东亚银行的反应比 Kaspi 大得多（消息之前传闻已经流传了一天，当局隔了一天才表态），而史料正相反（东亚银行 0.67%，Kaspi 9%）。两头没法同时拟合。
  - 两起新案例的设定和标准先于模型改动合并（PR #144），只跑了这一次：

    | 案例 | 史料 | 模拟（30 个世界） | 全部相符 |
    |---|---|---|---|
    | ICICI 2003 | 三天取走约 1.3% | 1 个世界发生挤兑，而且晚了一天；取走平均 0.2%（0%–3.4%）；银行都撑住 | 0 / 30 |
    | 保加利亚第一投资银行 2014 | 一天流出一成多，一周内一成到两成 | 4 个世界发生挤兑，都不在消息发出的当天；取走平均 0.7%（0%–5.8%）；银行都撑住 | 0 / 30 |

  - 同一次运行里，第一轮的三起（现在算拟合过的）也都是 0 / 30：BAC 17 个世界发生挤兑、取走平均 4.0%；Swedbank 18 个世界、平均 3.4%；Kaspi 仍然没有一个世界发生挤兑。丰川 3 个世界像史料，东亚银行 16 个世界发生挤兑、取走平均 2.8%。
  - **这一轮否定的想法**：光加一条"群发消息让人直接行动"的路、再把当局表态调弱，不够。真实案例的规模相差二十倍（0.67% 到 14%），差别来自事发前的处境——一周前货币贬值、一周前另一家银行刚被接管——这些只写在场景的文字里，数值引擎看不到。模型里决定规模的反而是"消息之前传闻流传了多久""当局隔多久表态"，方向与史料相反。
  - 这两起案例的结果也看过了，再改模型同样要另找新的。入库的那条大模型记录（`samples/`）是按上一版参数生成的，没有重新生成。
- 通和场景的**人物、地名、说法都是本项目原创**；丰川、东亚银行和五个检验场景的事件顺序取自语料里的史料转述，人物是匿名代号或虚构的普通储户，街区、人口、存款和关系网是合成的。

---

# polis

A parallel-society simulator: how a crowd of people decide, how they pass words along, how they second-guess one another, and how these three things together turn something that does not exist into something real.

## What it simulates

There are three scenarios. The first is the fictional "run on Tonghe Bank (通和钱庄)" (`rumor_run`): a county town of a little over a thousand people, where the night watchman sees chests being carried out of the bank's back door; that one sentence spreads, gets distorted, and in the end brings down a bank that was never insolvent.

The other two are built from historical records: the "Toyokawa Shinkin Bank run (1973)" (`toyokawa`) and the "Bank of East Asia run (2008)" (`bea`), with the order of events taken from `corpus/cases/`; they exist to test the model. Toyokawa is used in calibration and shaped changes to the model; the Bank of East Asia settings were fixed before the first run and it was the out-of-sample test until its result had been seen. Three further scenarios (`bac`, `swedbank`, `kaspi`) were fixed as out-of-sample tests before the first round of model changes; for the result see "Where the data comes from" below. Their results having been seen, they no longer count as tests. Two more (`icici`, `fib`) were fixed before the second round.

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
| `lang=en` / `lang=zh` | Interface language. Without it the last choice is used, and failing that the browser's language. People's names, the wordings of the rumour and characters' thoughts always stay in the original Chinese |
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

`corpus/` holds the theoretical basis of the simulation and its future calibration targets; every entry carries its sources. The text is in Chinese, with the English in each file's `en:` block; `uv run polis corpus` reports entries that lack English. Source locators (volume, issue, pages) are not translated separately.

- `theory/`: 12 theory cards (rumour, thresholds, cascades, bank runs, conformity, …), each stating the mechanism, its observable implications, and where in the engine it is implemented — a blank there means it is not implemented yet.
- `cases/`: 12 cases — five from literature and classical allusion, seven documented real bank runs (Toyokawa Shinkin Bank in 1973, Bank of East Asia in 2008; BAC San José in 2004, Swedbank in Latvia in 2011 and Kaspi Bank in 2014, held out in the first round; ICICI Bank in 2003 and Bulgaria's First Investment Bank in 2014, held out in the second).
- `facts/`: 10 stylised facts, each with its values, the conditions under which it was obtained, and how far those are from the setting of this simulation.

A source's `verified` is true only after a page that actually confirms it has been opened, and `checked` records which page was read and what it confirmed; sources that could not be verified are honestly marked false and do not enter calibration. All text is paraphrase; no text from the original works is included.

## Where the data comes from

The engine uses three pieces of external data, all in population synthesis only: age structure, educational attainment and trust (see below). The corpus is only paraphrase of literature and historical sources plus bibliographic information.

- **The population is synthetic, with three things aligned to public data.** Aggregates, sources and licences are stated at the top of each file in `data/curated/`; the raw files live only in the local `data/raw/`, outside the repository, and `uv run polis curate` recomputes the aggregates from them.
  - Age structure: the UN World Population Prospects 2024 figures for the place and year (CC BY 3.0 IGO).
  - Educational attainment: the Barro–Lee dataset, for the year nearest the event (copyright the authors; only four percentages per country-year are quoted here).
  - Trust in neighbours and in the government: Wellcome Global Monitor 2020, as mean scores by education and age group. The survey is from 2020 while the events took place between 1973 and 2014, so the years do not match; the page offers the data for public download but states no licence for it.
  - The fictional Tonghe scenario is a Republican-era county town: its age and education take the earliest Chinese figures available (1950), and its trust uses no data.
  - The distributions of every other attribute and trait (income, risk aversion, conformity, depth of reasoning, ties to the bank) are placeholder assumptions generated from the seed.
  - Not used: the World Values Survey and the Chinese General Social Survey require registering in person and accepting terms, and were not taken up.
- **The default behavioural parameters are hand-tuned**, adjusted until the curves looked reasonable.
- **Calibration is only a beginning, and it is fragile**: `polis calibrate` runs a random search over ten parameters against eight targets from the corpus (3%–9% of depositors withdraw, a person is more likely to run when acquaintances have, corrections work but leave a residue, the bank holds under a credible guarantee, three men make a tiger, at least three in ten parallel Toyokawa worlds resemble the record, under 2% of deposits leave the Bank of East Asia, and in at least three of ten worlds the first round's three test cases match in scale); the result is stored in `calibration.json`. Five are hit and three missed: the share of depositors who withdraw averages 1.8% (the floor is 2.9%), Toyokawa scores 25% (the floor is 30%), and the first round's three cases score 21% (the floor is 30%). The strength of the "credible guarantee" is itself set by hand.
  - How it is fragile: the Toyokawa target scores 25% on the 8 calibration seeds and 3 worlds in 30 (10%) on a fresh set; the Bank of East Asia averages 1.5% on the calibration seeds and 2.8% on fresh ones; the first round's three cases match in scale in 21% of worlds on the calibration seeds, and on fresh seeds not one world meets every criterion. Each time the population took on new data or a target was added, the same search found visibly different parameters and scores. What calibration yields is a fit to these seeds and this population, not something the model has learned.
- **"Who withdraws" has been redesigned once** (`mind.py`). The old rule rolled a die every hour for every depositor who had heard, which catches everybody in the end, so once a run started nearly everyone withdrew. Now:
  - Each person has a threshold that is fixed for the whole run, and someone whose motive stays below it never goes however long they wait (Granovetter's threshold model); long relationships with the bank and loans raise it (the evidence is Iyer and Puri).
  - Where a scenario has deposit insurance, the covered part of a deposit is left out of what can be lost, and those who do go may not take everything. The cap sits at the 95th percentile of deposits, a share set by hand to Iyer and Puri's order of magnitude.
  - The distributions of tenure, of who has a loan, and of individual thresholds are placeholder assumptions.
- **After the redesign the fitted cases match in scale; the unseen ones still do not.** `polis canon --held-out` runs 30 parallel worlds per case on a fresh set of seeds. It has been run three times: when the redesign was finished (PR #110), after the age structure took on data (PR #117), and after education and trust did too (PR #132). The model was recalibrated each time the population changed, but nothing was ever tuned to the results of these three cases. At the end of the first round (PR #132) the results were as follows; the second round's are in the next item:
  - Toyokawa (used in calibration): the bank holds in 29 worlds (19 before the redesign), but a run actually starts before the guarantee in only 3 and the joke goes nowhere in 27; only 1 world matches the record on all five points.
  - Bank of East Asia (result seen, now used in calibration): the bank holds in all 30 worlds (10 before the redesign) and 2.4% of deposits leave on average, 10.6% at most (50% on average before the redesign); the record says 0.67%. A run happens in 11 worlds.
  - Three held-out cases, whose settings and pass criteria were merged before the model was changed (PR #104). The criteria are the same for all three: the bank survives, the run starts on the recorded day, the share withdrawn is between half and twice the recorded figure, and almost nobody still goes two days after the authorities speak.

    | Case | Record | Simulation (30 worlds) | All criteria met (the three runs in turn) |
    |---|---|---|---|
    | BAC San José 2004 | about 1.8% withdrawn over two days | a run in 10 worlds; 6.6% withdrawn on average (0%–73.5%); the bank always holds | 0, 0, 1 / 30 |
    | Swedbank Latvia 2011 | about 1.5% withdrawn on one Sunday | a run in 6 worlds; 2.0% withdrawn on average (0%–20.5%); the bank always holds | 1, 1, 2 / 30 |
    | Kaspi 2014 | about a tenth of depositors withdrew roughly 9% in three days | no run in any world; at most 0.8% withdrawn | 0, 0, 0 / 30 |

  - Of 480 individual checks 202 pass (197 in each of the first two runs), most of them items such as "the bank survives" and "calm afterwards" that also pass when nothing happens at all. Where an average looks close to the record, it is because most worlds see nothing happen and a few see a great deal, which happens to average out there.
  - **The assumption this refutes**: in the model a person acts only after acquaintances corroborate the story and others are seen withdrawing, so outcomes are all or nothing: the rumour fizzles or it avalanches. None of the three real runs looked like that. A mass message made a small share of people go and withdraw, each on their own, within hours; the scale was limited and differed from case to case. Kaspi is the clearest: the National Bank denied the story the same day and a tenth of depositors still withdrew over three days, whereas in the model the same denial ends everything six hours in. So the preset strength of "the authorities speak" is far greater than the real thing, and the path by which a message moves some people directly hardly exists in the model.
  - Now that these three results have been seen, they cannot count as tests the next time the model changes either; new ones will be needed.
- **The second round of changes (after PR #144) did not make the model match; both new cases score 0 / 30.**
  - What changed: (1) a mass message became a "public signal": its recipients know others received it too, and anyone who reasons about others expects some of them at the bank without waiting for an acquaintance to say so (`public` in `mind.expectation`, scaled by the parameter `Params.public`); (2) denials and guarantees are discounted by `Params.authority`; (3) the counter pays nothing while the bank is closed.
  - What calibration concluded: the search set `public` to 0, which switches the first change off, and pushed `authority` to 0.2, the floor of its range. The reason was visible while trying it: with that path open, the same mass message draws a far larger response in the model's Bank of East Asia than in its Kaspi (the rumour had circulated for a day before the message, and the authorities spoke a day later), while the records say the opposite (0.67% at the Bank of East Asia, 9% at Kaspi). The two cannot be fitted together.
  - The two new cases had their settings and criteria merged before the model changed (PR #144) and were run this once:

    | Case | Record | Simulation (30 worlds) | All criteria met |
    |---|---|---|---|
    | ICICI 2003 | about 1.3% withdrawn in three days | a run in 1 world, a day late; 0.2% withdrawn on average (0%–3.4%); the bank always survives | 0 / 30 |
    | First Investment Bank, Bulgaria, 2014 | over a tenth gone in a day, between a tenth and a fifth within a week | a run in 4 worlds, none on the day of the messages; 0.7% withdrawn on average (0%–5.8%); the bank always survives | 0 / 30 |

  - In the same run the first round's three (now fitted) also score 0 / 30: BAC has a run in 17 worlds with 4.0% withdrawn on average, Swedbank in 18 worlds with 3.4%, and Kaspi still has no run in any world. Toyokawa resembles the record in 3 worlds; the Bank of East Asia has a run in 16 worlds with 2.8% withdrawn on average.
  - **The idea this round refutes**: adding a path by which a mass message moves people directly, and weakening the authorities' statement, is not enough. The real cases differ twentyfold in scale (0.67% to 14%), and the difference lies in what came before: a devaluation a week earlier, another bank taken over a week earlier. Those appear only in each scenario's text; the numeric engine cannot see them. What sets the scale in the model is instead how long the rumour circulated before the message and how soon the authorities spoke, which points the opposite way from the records.
  - These two results have now been seen as well, so another change to the model needs new cases again. The model-played record in `samples/` was generated with the previous parameters and has not been regenerated.
- In the Tonghe scenario, **the characters, place names and wording are all original to this project**; in the Toyokawa, Bank of East Asia and five test scenarios the order of events comes from the corpus's paraphrase of the records, the characters are anonymous labels or invented ordinary depositors, and the districts, population, deposits and network of ties are synthetic.
