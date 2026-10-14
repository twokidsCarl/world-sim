# idea-loom 想法经纬

想法经纬（idea-loom）是 world-sim 的想法池：生成、查看、归类、合并 idea，分配开发并跟踪进度。

idea-loom (Chinese name 想法经纬, "the warp and weft of ideas") is the idea pool of world-sim: generate, browse, classify and merge ideas, hand them
to development and follow their progress.

它不是模拟，不占阶梯上的位置。它是 idea 的家：`data/` 里的事件日志是事实来源，根目录的
`IDEAS.md` 由它生成。

It is not a simulation and has no place on the ladder. It is where the ideas
live: the event log in `data/` is the source of truth, and the root `IDEAS.md` is
generated from it.

## 现在能做什么 / What works now

- **无尽探索 / Explore**（`/play`）：单列的卡片流，一屏一张，一张卡是某个模拟的一个可以直达的场景。可以直接在里面玩，也可以切到下一张（按钮、上下键或 j / k、在卡片两侧的空白处滚动）。只有当前这张卡在运行，划走就卸载。可以收藏、重来、在新窗口打开完整版、带着这张卡问小助手。
  A single-column feed, one card per screen; a card is one directly reachable scenario of
  a simulation. Play it in place or move to the next (buttons, arrow keys or j / k, or
  scrolling in the margins beside the card). Only the current card runs and it is
  unmounted when you move on. Like it, restart it, open the full UI in a new window, or
  ask the assistant with the card attached.

  推荐顺序是写明的打分：没看过的排前面；你收藏过同一条 idea（或同一层）的往前提；进来几秒就划走、从没停下来看过的往后放；看得越多越靠后；相邻两张尽量不是同一个项目。每张卡可以点开看"为什么推这张"。每张卡看了多久记进操作轨迹，统计页把它算到那条 idea 的注意力上。
  The order is an explicit score: unseen cards first; cards of an idea (or a level) you
  liked move up; cards you left within seconds and never really watched move back; the
  more often seen, the further back; neighbours are kept from the same project where
  possible. Each card can show why it is where it is. Watch time goes into the action
  trail, and the statistics page counts it toward that idea's attention.
- **中 / EN**：界面可以在中文和英文之间切换（左下角）。idea、层、横线、内核有英文的就显示英文；后端给的自由文本（历史、愿望、方案、报错）保持原样。
  The UI switches between Chinese and English (bottom left). Ideas, levels, threads and
  kernels show their English where it exists; free text from the backend (history,
  wishes, plans, errors) stays as written.
- **地图 / Map**：十层 × 五条横线的格子，每格有几条、是哪几条；纵线和两条支线；按内核看。
  The ten levels × five threads grid with what sits in each cell; the verticals
  and the two branches; a view by kernel.
- **想法池 / Pool**：按层、横线、内核、状态、子项目筛选，全文搜索。
  Filter by level, thread, kernel, status and subproject; full-text search.
- **idea 页 / Idea page**：正文（可以复制给 Claude）、位置、血缘、每一次改动的历史；改写、改横线和内核、并入另一条、丢弃、恢复。
  The text (ready to hand to Claude), its position, its lineage and the history of
  every change; rewrite it, change its threads and kernel, merge it into another,
  discard it, restore it.
- **血缘 / Lineage**：想法池一批一批长出来的过程，谁并入了谁。
  How the pool grew batch by batch, and what was merged into what.
- **手写一条 / Write one**：编号由层自动决定，用过的编号不复用。
  The id follows the level; used ids are never reused.
- **同步到仓库 / Sync**：重新生成 `IDEAS.md` 里的三块，用 `tools/pr.sh` 开一个 PR。
  Regenerates the three blocks of `IDEAS.md` and opens a PR through `tools/pr.sh`.

- **生成与候选 / Generate and candidates**：让模型为一个格子、一种内核，或从某一条出发写新的 idea；给还没归类的定位置；在一层或一种内核里查重。在 idea 页上细化，在想法池里勾选几条融合。模型给的都只是候选，接受之前想法池不变。
  Ask the model for new ideas for a cell, a kernel, or starting from an existing
  idea; classify the unclassified; look for duplicates within a level or kernel.
  Refine on the idea page; tick several ideas in the pool to fuse them. Everything
  the model returns is a candidate, and the pool does not change until you accept.

- **英文版 / English edition**：每条 idea 有英文译文（模型翻译，中文是原文；中文改写后英文标为过期，等重新翻译）。同步时同时生成 `IDEAS.md` 和 `IDEAS.en.md`。
  Every idea has an English translation (by a model; the Chinese is the original, and
  a rewrite marks the English stale until it is translated again). A sync regenerates
  both `IDEAS.md` and `IDEAS.en.md`.

- **左侧菜单 / The left menu**：六项——无尽探索、想法、开发、许愿池、自我进化、统计。地图、列表（想法池）、生成与候选、血缘是同一批想法的四种看法，合在「想法」一项下面，页面顶上一排切换；每个视图的地址没变（`/`、`/ideas`、`/inbox`、`/lineage`），旧链接照常能用。「手写一条」是这排切换旁边的按钮。「接入」不占菜单，从「开发」页进。
  Six entries: Explore, Ideas, Work, Wish pool, Self-evolution and Statistics. The map, the list (the idea pool), generate & candidates and lineage are four views of the same ideas, so they share the Ideas entry with a switch at the top of the page; each view keeps its address (`/`, `/ideas`, `/inbox`, `/lineage`), so old links go on working. "Write one" is a button beside that switch. Connect is off the menu and is reached from the Work page.
- **左侧栏可以收窄 / Collapsible navigation**：左下角的 `«` 把导航收成一条窄栏，每页只留一个图标，全名在悬停提示里，`»` 展开；选择记在浏览器里。手机上导航是底部标签栏，不受影响。
  The `«` at the bottom left collapses the navigation to a narrow rail showing one icon per page, with the full name in the hover title; `»` expands it. The choice is remembered in the browser. On a phone the navigation is a bottom tab bar and is unaffected.
- **小助手 / Assistant**：右侧的边栏，随时可以问。每次提问自动带上当前页面的文字提纲、最近的操作和许愿池里已有的愿望；在 idea 页时带上那条 idea。它能读仓库、读本工具的接口、记愿望、提议 idea（进候选）、在页面上圈出元素；它不能改任何东西。窗口窄时变成浮层。
  A sidebar on the right, always there to ask. Each question carries a text outline of
  the current page, your recent actions and the existing wishes, plus the idea when you
  are on an idea page. It can read the repository and this tool's API, record wishes,
  propose ideas (into the candidates) and point at elements on the page; it cannot
  change anything. On a narrow window it floats.
  **看图、画图。** 提问时可以附图（最多 4 张）：点"＋图"选文件、直接粘贴、拖进来，或者点"截这一页"把当前标签页截下来——浏览器会问一次要不要共享，嵌着的模拟也截得到。图留在那条问题下面，重新打开对话也在；接着问的时候，前几问附过的图会再交给小助手（连同这次的一共最多 4 张，近的优先），所以它能接着说那张图。回答里除了文字，还能直接画出条形图、折线图、散点图、表格，以及一张嵌在对话里、可以当场玩的模拟卡片。
  **It reads and draws images.** A question can carry images (up to 4): pick files with "＋Image", paste, drop them in, or "Capture page" to grab the current tab — the browser asks once whether to share it, and embedded simulations are captured too. The images stay under their question, also when the conversation is reopened; on a follow-up the images from earlier questions go to the assistant again (4 in all with this question's, the most recent first), so it can go on talking about them. Besides text, an answer can draw bar, line and scatter charts, tables, and a simulation card embedded in the conversation that can be played on the spot.
  **点选。** 输入框下面的"⌖ 点选"进入点选：鼠标移到页面上的元素会高亮，点一下选中它，拖一个框选中框里的几个；选中的在光标处插入一段引用，比如 `【p3 按钮「改写」】` 或 `【p4–p9 框选的 6 处】`。可以接着点、接着框，Esc 或再点一次按钮退出；点选时页面上的链接和按钮不会动，小助手自己照常能点。选中的元素带一个固定的编号（`p` 开头），发问时页面提纲在它的位置标上这个编号，另外单列一节写清每个是什么、在哪个标题下面、里面有什么，所以小助手不用凭页面大意去猜你指的是哪一个，也能用这个编号把它圈出来。选中的不一定是能点的东西，一段字、一张图、一块区域都行。
  **Picking.** "⌖ Pick" under the input enters pick mode: the element under the pointer is highlighted, a click picks it and a drag picks those inside the box; a reference such as `[p3 button "Rewrite"]` or `[p4–p9, 6 boxed elements]` goes in at the cursor. You can keep clicking and boxing; Esc or the button again leaves. While picking, the page's links and buttons stay still, and the assistant itself works as usual. Each picked element keeps a fixed number (starting with `p`): the outline sent with the question marks it at its place, and a section of its own says what each one is, which heading it sits under and what it contains, so the assistant need not guess from the page which one you mean, and can point at it by that number. A picked element need not be clickable: a paragraph, an image or a region will do.
- **自我进化 / Self-evolution**（`/sessions`，里面的每一个仍叫会话）：网页里的 Claude Code。用官方的 Agent SDK 开一个一直活着的会话——和终端里是同一个 harness：读 `CLAUDE.md` 和记忆、全套工具、能派子 Agent、仓库里的 `/wishes` 这类命令直接能用。它交计划、要改文件、要跑命令、要问你问题的时候，都停下来，在页面上变成一张卡片等你回答（批准 / 提意见；允许 / 这一类以后都允许 / 拒绝并说明；选一个选项或自己写）。它派的子 Agent 收在派它的那一步下面：每一步、在跑还是做完了、最近在用什么工具、做完的结论都看得到；子 Agent 在后台跑时这一轮先说完，顶部显示后台还有几个在跑，它们做完后 Claude Code 自己接着做一轮，界面照样跟上。可以随时接着说（能带图）、打断、切换"先出计划 / 每次问我 / 改文件不用问"。没发出去的话（连同贴进来的图）每个会话各存一份，换会话、刷新页面都还在，发出去才清掉；新开会话那一框和小助手的输入框也一样。左边的会话列表默认只列没结束的（结束指你点了"结束会话"；出错的、歇着的还能接着说，都算没结束），上面有"没结束的 / 已结束 / 全部"三个按钮和各自的数目，以及没结束的里面在干活、等你回答、等你说话、出错各有几个；选了哪个会记住。正打开着的那个会话不管在不在所选的组里都留在列表上。没结束的会话下面一行一个列出它的子 Agent：最近一次你说话之后派的，加上更早派的、还没回来的（最多六个，在跑的优先），每个写着在跑、回来了、失败了，或者进程没了而它没做完；点一下就打开那个会话，翻到派它的那一步并展开。它在干活时，输入框上面有一行和终端里一样的状态：现在在做哪一步（在子 Agent 里的连着那个子 Agent 一起写，没有在跑的工具就是"在想"）和这一步跑了多久、这一轮跑了多久、上一次有动静是多久以前，再是用了多少 token，秒数一直在走；一分半钟没有任何动静，最后这一段变成醒目的颜色——可能只是一条命令跑得久，也可能是卡住了。对话记在 `runs/sessions/`，刷新页面会回放；重启 idea-loom 不会打断它（见下面"会话是独立的进程"）。愿望页上的"在这里和 Claude Code 一起处理"就是开一个这样的会话。**只在本机、只有主人**：它能以你的身份在这台机器上执行命令，所以云端没有这个功能，也只接受从本机来的请求。它用本机 Claude Code 已有的登录（订阅）；环境里有 `ANTHROPIC_API_KEY` 时会按量计费，页面上会说明。会话顶部写着它一共用了多少 token（输入 · 输出 · 缓存，连子 Agent 一起算），干活时边干边涨；作业也一样写在作业的顶部。不显示美元：订阅下美元数没有意义。
  Claude Code in the page. A long-lived session opened with the official Agent SDK — the same harness as in a terminal: it reads `CLAUDE.md` and memory, has every tool, can spawn subagents, and repository commands such as `/wishes` work as they are. When it hands in a plan, wants to edit a file, run a command or ask you something, it stops and a card on the page waits for your answer (approve / send comments; allow / always allow this kind / decline with a reason; pick an option or write your own). Subagents it launches sit under the step that launched them: each of their steps, whether they are running or done, the tool they last used and their conclusion are all visible; when a subagent runs in the background the turn ends first, the top shows how many are still running, and when they finish Claude Code carries on with a turn by itself, which the page follows as well. You can go on talking at any time (images included), interrupt, and switch between "plan first / ask every time / edits without asking". What you have typed but not sent (pasted images included) is kept per session, surviving a switch to another session and a page reload, and cleared once sent; the box for starting a session and the assistant's input box do the same. The session list on the left shows only unfinished sessions by default ("finished" means you chose "End session"; failed and resting sessions can still be continued and count as unfinished). Above it, "Unfinished / Finished / All" carry their counts, along with how many of the unfinished are working, need you, are idle or failed; the choice is remembered. The session that is open stays in the list whichever group is chosen. Under each unfinished session its subagents are listed one per row: those launched since you last spoke, plus earlier ones not back yet (six at most, running ones first), each marked running, back, failed, or stopped when the process went away before it finished; a click opens that session scrolled to the step that launched it, unfolded. While it works, a status line above the input box reads as in a terminal: the step it is on (with the subagent that launched it, if any; "thinking" when no tool is running) and how long that step has run, how long this turn has run, how long since anything last happened, and the tokens used, the times ticking every second; after a minute and a half without any event the last part turns to a warning colour — perhaps only a long command, perhaps stuck. Conversations are kept under `runs/sessions/`: a reload replays them, and restarting idea-loom does not interrupt them (see "sessions are their own processes" below). "Handle it here with Claude Code" on a wish page opens such a session. **Local only and owner only**: it can run commands on this machine as you, so the feature does not exist in the cloud and only requests from this machine are accepted. It uses the existing login of the local Claude Code (your subscription); with `ANTHROPIC_API_KEY` in the environment it bills per token, and the page says so. The top of a session shows how many tokens it has used (input · output · cache, subagents included), rising as it works; a job shows the same at its top. No dollar figures are shown: under a subscription they mean nothing.
  **四种模式，和"自动"到底自动到哪。** 先出计划 / 每次问我 / 改文件不用问 / 自动，开会话时选，中途随时能切；计划卡片上可以直接点"批准，之后自动"。自动模式用的是 Claude Code 自己的安全分类器：常规的事（改文件、跑测试、看状态）直接做，不再一步步停下来。这就是 Claude Code 原样的自动模式，这里不在它上面另加规则：它防的是"擅自做你没要求的事"，你明说要做的事由你自己负责。它有问题要问你、交计划时照样会停。"这一类以后都允许"按命令的每一段记（`git status`、`uv run`、`tools/ci.sh`……），一条用管道和分号串起来的命令，每一段都允许过才不再问；heredoc 的正文是文件内容，不当命令拆。可以选模型（默认 Opus 5.5）和思考的努力程度（默认 high），显示在会话顶部，闲着的时候能换。一轮说完、后台也没有任务在跑，就算**做完了**：会话顶部和左侧列表显示「✓ 做完了 · 几点几分」，和中途停下来等你说话分开。你不在这一页时，它需要你或者做完了，会弹浏览器通知并在标签页标题前加一个记号。有会话在等你回答时，不管你在哪一页，左下角都有一个小气泡，点它直接去那个会话；那个会话自己的视图开着时不弹，回答完就消失。左侧菜单「自我进化」上（收窄时在图标上）显示有几个会话在等你。这些和许愿池的数一起，在打开页面、窗口回到前台、看得见时每 15 秒取一次。
  **Four modes, and how far "auto" goes.** Plan first / ask every time / edits without asking / auto, chosen when a session starts and switchable at any time; a plan card offers "approve; auto from here". Auto uses Claude Code's own safety classifier: routine steps (editing files, running tests, checking status) just happen instead of stopping one by one. This is Claude Code's auto mode as it is, with no rules added on top of it here: it guards against doing things you did not ask for, and what you did ask for is your own call. It still stops for its questions and its plans. "Always allow this kind" goes by each part of a command (`git status`, `uv run`, `tools/ci.sh`…): a command chained with pipes and semicolons is skipped only when every part was allowed before; a heredoc body is file content and is not split into commands. The model (Opus 5.5 by default) and the reasoning effort (high by default) are shown at the top of a session and can be changed while it is idle. When a turn is over and nothing runs in the background it counts as **done**: the top of the session and the list on the left show "✓ Done · hh:mm", kept apart from stopping midway for you to speak. When you are on another page and it needs you or is done, a browser notification appears and the tab title gains a mark. While a session waits for your answer, a small bubble sits at the bottom left of whatever page you are on and clicking it goes straight to that session; none appears while that session's own view is open, and it goes once you answer. "Self-evolution" in the left menu (its icon, when collapsed) shows how many sessions are waiting for you. These are fetched together with the wish pool count: when the page opens, when the window comes back to the front, and every 15 seconds while visible.
  **会话是独立的进程，重启后端不影响它。** 每个会话是一个和后端脱钩的进程（`python -m idea_loom.sessions run <编号>`，Claude Code 是它的子进程）。后端只做两件事：把你的每个操作（说话、回答卡片、打断、切模式、换模型、结束）写成 `runs/sessions/<编号>/inbox/` 下的一个小文件，和读 `events.jsonl`、`meta.json`。所以后端重启时（自己重启，或者在终端里按 Ctrl+C 再启动），正在干活的会话接着干，等你回答的卡片照样能回答。会话进程在三种情况下自己退出：你点了"结束会话"；闲了 30 分钟（`IDEA_LOOM_SESSION_IDLE` 可改，单位秒）；它用的代码比磁盘上的旧、而它正好闲着——所以改了会话自己的代码也不会打断任何一轮，忙着的会话用旧代码把这一轮做完再换。退出后的下一句话会起一个新进程，用存着的 SDK 会话编号接上原来的对话。会话顶部显示进程在不在、用的是不是旧代码。做不到的：机器重启或会话进程自己崩了，正在进行的那一轮会丢（对话仍能接上）。进程的报错在 `runs/sessions/<编号>/runner.log`。
  **Sessions are their own processes; restarting the backend leaves them alone.** Each session is a process detached from the backend (`python -m idea_loom.sessions run <id>`, with Claude Code as its child). The backend does two things only: it writes each of your actions (say, answer a card, interrupt, switch mode, change model, close) as a small file under `runs/sessions/<id>/inbox/`, and it reads `events.jsonl` and `meta.json`. So when the backend restarts (by itself, or after Ctrl+C and a fresh start), a working session keeps working and a waiting card can still be answered. A session process exits by itself in three cases: you close the session; it has been idle for 30 minutes (`IDEA_LOOM_SESSION_IDLE`, in seconds, changes that); or its code is older than what is on disk while it happens to be idle — so changing the sessions' own code interrupts no turn either: a busy session finishes its turn on the old code and is replaced afterwards. The next message after an exit starts a new process that picks the conversation up with the stored SDK session id. The top of a session shows whether its process is up and whether it runs old code. What this cannot do: if the machine restarts or the session process itself crashes, the turn in progress is lost (the conversation can still be picked up). The process's errors are in `runs/sessions/<id>/runner.log`.
- **许愿池 / Wish pool**：对这个工具本身的改进愿望。愿望只从和小助手的对话里来，同一个问题再遇到是给原来那条加一次。未处理时可以改写和撤销，采纳之后冻结。
  Wishes for improving this tool itself. They only come out of conversations with the
  assistant, and meeting the same problem again bumps the existing wish. A wish can be
  edited or withdrawn while open and is frozen once accepted.
  左侧菜单「许愿池」旁边的数是待处理的条数（未处理加已采纳），和愿望页默认那一组一样。它跟着后端走：打开页面、窗口回到前台或重新拿到焦点、看得见时每 15 秒各取一次，打开愿望页时也对一次；页面藏起来时不取。所以在命令行里用 Claude Code 改了状态，不用刷新就跟得上。
  The number beside "Wish pool" in the left menu is the pending count (open plus accepted), the same as the wish page's default group. It follows the backend: fetched when the page opens, when the window comes back to the front or regains focus, every 15 seconds while visible, and whenever the wish page loads; nothing is fetched while the page is hidden. So a status changed by Claude Code from the command line shows up without a reload.
  **编号 wish-N。** 每条愿望按记下的先后从 1 起有一个序号，界面、命令行和小助手都用 `wish-N` 称呼它（`wish-1`、`wish-2`……），撤销了的也保留序号。存的编号没变（`wish-20261012T160005Z-8360` 这种，作业、会话里引用的都是它），序号是读的时候按记录顺序算出来的；记录只追加，所以序号不会变。凡是要编号的地方（命令行的 `show`、`brief`、`accept`、`note`、`link`、`done`、`decline`，`/api/wishes/{id}`，小助手）都认这几种写法，按这个先后认：`wish-N`；完整编号；纯数字 N，但只在不超过总条数时当序号；最后是旧编号的结尾几位（比如 `8360`）。所以纯数字 `1990` 在愿望不到 1990 条时还是指结尾是 1990 的那条旧编号。
  **Numbered wish-N.** Every wish has a sequence number in recording order, from 1, and the UI, the command line and the assistant call it `wish-N` (`wish-1`, `wish-2`…); withdrawn wishes keep theirs. The stored id is unchanged (the `wish-20261012T160005Z-8360` kind, which jobs and sessions refer to); the number is computed from the recording order when the log is read, and as the log is append-only it never changes. Everywhere an id is taken (the command line's `show`, `brief`, `accept`, `note`, `link`, `done`, `decline`, `/api/wishes/{id}`, the assistant) these forms are accepted, tried in this order: `wish-N`; the full id; a bare number N, taken as a number only when it does not exceed the count; and finally the last few characters of an old id (such as `8360`). So a bare `1990`, while there are fewer than 1990 wishes, still means the old id ending in 1990.
  **计划中。** Claude Code 正在给一条愿望出计划时，列表和详情页的状态旁边标"计划中"（虚线框，悬停看是谁、从什么时候起）。它不是一个状态，是一个认领标记：`wishes brief <编号>`（也就是带编号的 `/wishes`）自动认领它拿到的未处理和已采纳的愿望，所以主人一运行命令标记就出现；不带编号的清单不认领。也可以手动 `wishes claim <编号>... [--by] [--note]`，`wishes release <编号>...` 放下。采纳、不做、做完、撤销或放下都会清掉它，过了 6 小时也自动失效，丢下的会话不会一直占着。
  **Planning.** While Claude Code is planning a wish, the list and the detail page show "Planning" beside its status (a dashed badge; hover for who and since when). It is not a status but a claim: `wishes brief <ids>` (that is, `/wishes` with ids) claims the open and accepted wishes it fetches, so the marker appears the moment the owner runs the command; the bare list claims nothing. A claim can also be made by hand with `wishes claim <id>... [--by] [--note]` and dropped with `wishes release <id>...`. Accepting, declining, finishing, withdrawing or releasing clears it, and it lapses after 6 hours, so an abandoned session does not hold on to it.
  **处理愿望用 Claude Code 的 `/wishes`。** 在这个仓库里开着的 Claude Code 会话里运行：不带编号，它把全部待处理的愿望取来、读代码、给你一个分诊（先做哪几条、哪几条是一回事、哪几条不该做）；带编号（`wish-N`，可以给好几个），它先出计划，你批准之后才动手，做完用 `tools/pr.sh` 提交并把结果标回许愿池。愿望页上有一键复制的命令。网页里的自动作业还在，收在愿望页的折叠里，只适合很小、很明确的改动。
  **Wishes are handled with `/wishes` in Claude Code.** Run it in a Claude Code session opened in this repository: without an id it fetches every pending wish, reads the code and gives you a triage (which to do first, which are the same thing, which should not be done); with ids (`wish-N`, several allowed) it plans first and acts only after you approve, then submits through `tools/pr.sh` and reports the result back to the pool. The wish page has the command ready to copy. The automatic job in the web UI remains, folded away on the wish page, and suits only very small, clear-cut changes.
- **观察 / Watching**：记下你换页、点了什么、每页停留多久（只算窗口在前台且最近有操作的时间），存在本机 `runs/trail.jsonl`，不进 git，不记输入的文字。来回跳、连续报错、原地反复点时，小助手的按钮亮一个点问要不要解释这一页，同一页只问一次。
  Records navigation, clicks and the dwell time on each page (foreground time with
  recent activity only) in `runs/trail.jsonl` on this machine, never in git and never
  including typed text. When you bounce between two pages, hit repeated errors or click
  around in place, the assistant button lights a dot offering to explain the page, once
  per page.

- **开发 / Work**：把一条 idea 交给一个子项目（写一个新目录名就是开新项目），任务看板分待开工、方案待批、进行中、已合并。每个子项目的进度读自 GitHub：按 PR 标题冒号前的项目名归类。idea 页上能看到它对应的项目和任务；子项目的开发服务在跑时，可以直接在 idea 页里嵌着用。
  Hand an idea to a subproject (a new directory name starts a new one); the board has
  todo, plan ready, running and merged. Each subproject's progress is read from GitHub,
  assigning PRs by the project name before the colon in the title. The idea page shows
  its projects and tasks, and embeds a subproject's UI when its dev server is running.
- **统计 / Statistics**：
  - 每个项目：模型输出的 token、Claude Code 在跑的时间、合并的 PR、代码行数，以及每行代码、每个 PR 用了多少 token。
    Per project: model output tokens, Claude Code running time, merged PRs, lines of
    code, and tokens per line and per PR.
  - Claude Code 的每次运行：每个会话跑了多久、说了几句话、调了多少次工具、输出多少，中间停了几次、最后停在什么时候。两条记录相隔五分钟以上算停下。
    Every Claude Code run: how long each session ran, how many prompts and tool calls,
    how much output, how many times it stopped and when it last stopped. A gap of five
    minutes or more between two records counts as a stop.
  - 你的注意力：在每条 idea、每一格、每个页面上停了多久，哪些 idea 从没打开过，候选留下了多少。
    Your attention: time spent per idea, per cell and per page, which ideas were never
    opened, and how many candidates were kept.
  - 模型调用：idea-loom 自己的调用（`runs/llm.jsonl`）和这个仓库里 Claude Code 的会话并排，再加一行合计，都按 token（输入、输出、缓存读、缓存写）算，不写美元。网页里的会话也会被 Claude Code 记进自己的会话记录，所以按会话编号认出来，只算在 Claude Code 那一行。
    Model calls: idea-loom's own calls (`runs/llm.jsonl`) beside Claude Code's sessions in
    this repository, plus a total row, all in tokens (input, output, cache read, cache
    write) rather than dollars. In-page sessions are also kept in Claude Code's own
    transcripts, so they are recognised by session id and counted in the Claude Code row only.

  token 和运行情况读的是本机 `~/.claude/projects` 下属于这个仓库的会话记录，只在本机算，只显示汇总数字。从根目录启动的会话，大部分记录落在哪个子目录就归哪个；说不清的列为"未归属"，可以在 `data/sessions.json` 里按会话编号指定：`{"<会话编号>": "<项目目录>"}`。

  Tokens and runs come from the transcripts under `~/.claude/projects` that belong to
  this repository; they are computed on this machine and only aggregates are shown. A
  session started at the root is assigned to the subdirectory most of its records fall
  in; anything unclear is listed as unassigned and can be pinned in `data/sessions.json`
  as `{"<session id>": "<project dir>"}`.

- **作业 / Jobs**：在愿望页或任务上点"开工"，从界面触发 Claude Code。
  Press "start" on a wish or a task to trigger Claude Code from the UI.

  ```
  出方案中 → 方案待批 →（你批准）→ 执行中 → 测试 → PR → 已合并
                      ↘ 提意见重写 / 不做          ↘ 失败（可以还原）
  ```

  - 出方案时 Claude 只有读文件的工具，方案显示在界面里；你可以批准、提意见让它重写，或标为不做。批准之前不改任何文件。
    While planning, Claude only has read tools and the plan is shown in the UI; you can
    approve it, send feedback for a rewrite, or decline. Nothing is changed before approval.
  - 批准后另起一次：它只能改这次作业所属的目录（愿望是 `idea-loom/`，任务是那个子项目的目录），可以跑该目录的测试命令，不能运行 git 和 gh。没有明确允许的操作一律被拒绝。
    After approval a second run starts: it may only edit the job's directory
    (`idea-loom/` for a wish, the subproject's directory for a task) and run that
    directory's test commands, never git or gh. Anything not explicitly allowed is denied.
  - 它结束后由程序自己：把测试重跑一遍 → 调用 `tools/pr.sh`（只提交这个目录）→ 合并后把愿望标为已做完、任务标为已合并。
    When it finishes the runner itself re-runs the tests, calls `tools/pr.sh` (which
    submits this directory only), and after the merge marks the wish done or the task merged.
  - 以程序重跑的测试为准，不以 Claude 自己说"做完了"为准。测试没过会把输出交回给它修，最多两轮。它被拒绝的操作会记下来显示在作业的"经过"里。
    The tests re-run by the runner decide the outcome, not the agent's own "done". Failing
    output is handed back to it for repair, twice at most. Operations it was denied are
    recorded and shown in the job's log.
  - 失败的作业如果已经改了文件，可以点"接着做"直接从跑测试走到开 PR，不用重来；也可以一键还原。
    A failed job that already changed files can be continued from the tests to the PR
    without starting over, or reverted in one click.
  - 云端：出方案只读，同一个目录可以并行；动手阶段同目录排队，前一个合并后后一个才开工（从最新的 main 切分支，带着前一个的改动），页面显示"排队中：等《…》做完"。同一项已有未结束的作业时不能再开。本地（就地改，或没有 worker）同一个目录仍然同时只跑一个作业；开工前该目录的代码必须没有未提交的改动，这样失败或取消后可以一键还原。
    Cloud: planning is read-only, so one directory can plan in parallel; execution queues per
    directory and the next job starts only after the previous one has merged (branching from
    the latest main, so it carries the earlier changes), shown as "queued: waiting for …". An
    item that already has an unfinished job cannot be started again. Locally (in place, or
    without a worker) a directory still runs one job at a time, and its code must have no
    uncommitted changes before a job starts, so a failed or cancelled job can be reverted with
    one click.
  - 每个阶段在独立的进程里跑，状态写在 `runs/jobs/` 下，后端重启不影响它。
    Each phase runs in its own process with its state under `runs/jobs/`, unaffected by a
    backend restart.

  已知的边界：目录限制管的是 Claude 的写文件工具（用真实 CLI 验证过），而且 PR 只包含这个目录。但测试命令会执行这个目录里的代码，那些代码在技术上能写到本机的别处；工作目录是多个会话共用的，别的目录随时有人在改，所以程序没法靠比较文件变化来发现这种情况。PR 合并前没有人工审查——你审的是方案。

  A known limit: the directory restriction applies to Claude's file-writing tools (checked
  against the real CLI), and the PR only ever contains that directory. But the test
  commands execute code from that directory, which could technically write elsewhere on
  this machine; the working tree is shared and other directories change all the time, so
  the runner cannot detect that by comparing files. No human reviews the PR before it
  merges — what you review is the plan.
- **推进 / Advance**：在开发页对一个子项目点"推进"，模型读它的 README 和最近的 PR，提议下一个里程碑，建成一个待开工的任务。
  Press "advance" on a subproject and the model reads its README and recent PRs, proposes
  the next milestone and files it as a todo task.
- **回看 / Review**：每攒够 300 条操作，后台就自己回看一次（记操作的接口顺手检查，最多一分钟查一次，不让请求等；同一时间只跑一次；没有模型可用时不跑，失败了一小时后再试）。模型读一遍操作轨迹，提出最多五条愿望，给每条打 1–5 分的重要程度和一句理由；4 分及以上的直接记进许愿池（来源 review），其余的丢掉。它会拿到许愿池里已有的全部标题和以前丢掉的，免得重复。每次回看记在 `runs/reviews.jsonl`，许愿池页列出最近十次：记了什么、丢了什么、为什么；丢掉的点"还是记进许愿池"就能捞回来。页上的"现在回看"立刻在后台跑一次。
  Every 300 actions the backend reviews by itself (the trail route checks along the way, at
  most once a minute, without making the request wait; one review at a time; none without
  a model, and an hour's pause after a failure). The model reads the action trail, proposes
  up to five wishes and gives each an importance from 1 to 5 with a one-line reason; those
  at 4 or above go straight into the wish pool (source "review") and the rest are dropped.
  It is given every title already in the pool and the earlier dropped ones, so it does not
  repeat them. Each review is logged in `runs/reviews.jsonl` and the wish page lists the
  last ten: what was recorded, what was dropped and why; "Record it anyway" rescues a
  dropped one. "Review now" on the page runs one in the background straight away.

## 运行 / Run

需要 [uv](https://docs.astral.sh/uv/) 和 [bun](https://bun.sh)；用模型的功能还需要本机装有并登录了 `claude` 命令行（不需要 API key）。

Needs [uv](https://docs.astral.sh/uv/) and [bun](https://bun.sh); the model-backed
features also need the `claude` CLI installed and logged in on this machine (no API key).

日常使用只要一个命令 / For everyday use, one command:

```sh
uv run idea-loom serve        # 然后打开 / then open  http://localhost:8767
```

它启动时自己判断界面要不要构建（还没构建过，或者界面的代码比上次构建新），需要就先构建。已经有一个在运行时，它会直接告诉你地址而不是报端口被占。

On start it decides by itself whether the UI needs building (never built, or the UI code is
newer than the last build) and builds it first if so. When one is already running it tells
you the address instead of failing on the port.

**改了代码不用手动重启。** `serve` 是一个看守进程：它占住端口，把后端作为子进程起起来（见 `serving.py`）。后端每两秒看一眼：界面的源码变了、静了几秒，就边服务边重新构建界面；后端的代码变了（作业合并后同步回来的、会话里改的都算），就等一个安全的时刻——小助手没在回答、没有正在处理的请求——先在另一个进程里试着导入新代码，导入得了才退出，看守在同一个端口上起一个用新代码的后端。端口一直由看守占着，重启那一两秒里的请求只是排队。会话和作业是独立的进程，不受影响；新代码导入不了就不重启，等代码再变。代码变了还没重启时，会话页和作业里有一个"立即重启"按钮（`POST /api/restart`，只在本机），走的是同一条路。打开着的页面看到后端重启过或界面重新构建过，会自己刷新；有输入框里打了字还没发出去时先不刷新，顶上说明，发出去或清空后再刷新。看守自己（`serving.py` 里 `keep` 那部分）改了，要手动重启一次才生效。云端的容器直接跑 uvicorn，不经过看守，不会自己重启。

**Changed code needs no manual restart.** `serve` is a keeper process: it holds the port and
starts the backend as a child (see `serving.py`). The backend looks every two seconds: when
the UI sources have changed and been left alone for a few seconds it rebuilds the UI while
still serving; when the backend code has changed (synced back after a job's merge, or edited
in a session) it waits for a safe moment — no assistant answer in progress and no request
being handled — tries importing the new code in another process, and only if that works
exits, whereupon the keeper starts a backend with the new code on the same port. The keeper
holds the port throughout, so requests during the second or two of a restart just wait.
Sessions and jobs are their own processes and are unaffected; new code that does not import
is not restarted into, and it waits for the code to change again. While changed code is not
yet running, the session page and the job panel offer a "Restart now" button
(`POST /api/restart`, local only) that takes the same path. Open pages reload themselves
when they see that the backend restarted or the UI was rebuilt; while a field holds typed
text not yet sent they hold off and say so at the top, and reload once it is sent or
cleared. A change to the keeper itself (the `keep` part of `serving.py`) needs one manual
restart. Cloud containers run uvicorn directly, without the keeper, and never restart
themselves.

这一个进程同时托管所有模拟，见下面"统一入口"。开发 idea-loom 自己时，另开一个终端跑 `cd web && bun install && bun run dev`（http://localhost:5187，带热更新，接口转给 8767）。

That one process also hosts every simulation; see "the single entry point" below. When
developing idea-loom itself, run `cd web && bun install && bun run dev` in a second
terminal (http://localhost:5187, with hot reload, proxying the API to 8767).

## 统一入口 / The single entry point

各子项目开发时用自己的服务器和端口；使用时不用启动它们，idea-loom 托管全部。

Subprojects use their own servers and ports while being developed; for use none of them
needs starting, because idea-loom hosts them all.

- **每个模拟一个子域名 / One subdomain per simulation**：`http://<项目>.localhost:8767/`。它是独立的源：有自己的本地存储，脚本碰不到 idea-loom 的页面；项目里从根开始的路径（`/api/…`、`/assets/…`）不用改。
  A separate origin: its own local storage, no script access to idea-loom's pages, and
  the project's root-relative paths work unchanged.
- **跑的是 main 上的版本 / It runs what is on main**：对每个项目，从 `origin/main` 取出它的目录（不碰工作目录），在 `runs/play/<项目>/` 下构建。版本号是那个目录在 main 上的 tree 哈希；合并了新 PR 就重新构建，构建期间和构建失败时继续用上一个成功的版本。
  Each project's directory is extracted from `origin/main` (the working tree is never
  touched) and built under `runs/play/<project>/`. The version is that directory's tree
  hash on main; a merged PR triggers a rebuild, and the last good build stays in use
  while a new one builds or if it fails.
  构建失败后会自己按 5 分钟、15 分钟、1 小时（封顶）的间隔重试，版本再变就马上重来；界面上没有“重新构建”按钮。
  A failed build retries by itself after 5 minutes, 15 minutes, then every hour, and
  at once when the version changes again; the UI has no rebuild button.
- **后端按需启动 / Backends start on demand**：需要后端的项目，第一次访问它的 `/api/*` 时在一个空闲端口上启动（用那个项目自己的环境），请求转发过去，十分钟没人用就停掉。
  A project's backend is started on a free port (in that project's own environment) the
  first time its `/api/*` is requested, proxied to, and stopped after ten idle minutes.
- **来源检查 / Origin check**：idea-loom 自己的接口拒绝来自模拟源的请求，模拟页面里的脚本调不了它。
  idea-loom's own API refuses requests from a simulation's origin.
- **名片 / Card files**：每个项目怎么托管、有哪些卡片，写在它根目录的 `sim.json`（格式和各项目要遵守的嵌入约定见根目录 `CLAUDE.md`）。项目还没提交 `sim.json` 时，用 `data/play/<项目>.json` 里的临时名片。
  How a project is hosted and which cards it offers is declared in the `sim.json` at its
  root (the format and the embed contract are in the root `CLAUDE.md`). Until a project
  commits one, the interim file `data/play/<project>.json` is used.

```sh
uv run idea-loom play status          # 每个模拟的构建状态 / build state of every simulation
uv run idea-loom play build [项目]     # 取 main 的快照并构建 / snapshot main and build
```

`.localhost` 的子域名只在本机有效。放到云端时，域名和进程的分工由几个环境变量决定（见 `src/idea_loom/config.py`），容器和反向代理的配置在仓库根目录的 [`deploy/`](../deploy)。

The `.localhost` subdomains only work on this machine. In the cloud the domain and the
split into processes are set by a few environment variables (see
`src/idea_loom/config.py`); the containers and the reverse proxy are configured under
[`deploy/`](../deploy) at the repository root.

本地不用登录，你就是主人。云端设了 `IDEA_LOOM_OWNER`（主人的 GitHub 用户名）之后用 GitHub 登录认人，分三档：游客能看能玩，登录的访客再加上记自己的观看和收藏，其余只有主人能做。哪个接口要什么身份集中写在 `src/idea_loom/auth.py`，没列出的默认只有主人能用。

Locally nobody signs in and you are the owner. In the cloud, once `IDEA_LOOM_OWNER` (the
owner's GitHub login) is set, GitHub sign-in tells people apart in three roles: a guest can
browse and play, a signed-in member can also record their own watching and likes, and
everything else is the owner's. Which role each route needs is written in one place,
`src/idea_loom/auth.py`; anything unlisted is owner-only.

环境变量（都可以不设）/ Environment (all optional)：`IDEA_LOOM_MODEL`（缺省 `sonnet`，生成、细化、翻译用 / default `sonnet`, for generate, refine, translate）、`IDEA_LOOM_ASSISTANT_MODEL`（小助手 / the assistant）、`IDEA_LOOM_JOB_MODEL`（作业 / jobs）。

**作业在自己的工作区里做。** 从界面交给 Claude 的作业不在这个目录里就地改：它从最新的 `main` 开一个分支和一棵单独的工作树（放在仓库目录外面的缓存目录下），在里面改、跑测试，然后推分支、开 PR。这样它和同时在这个目录里工作的别的会话互不干扰。合并之后，它的改动会同步回这个目录；别人同时改过的同一个文件做三方合并，合不了的保留原样并在作业里写明。提交时遇到一闪而过的错误（git 的锁、网络超时）会自动重试。`IDEA_LOOM_JOBS_INPLACE=1` 回到原来就地改的做法。

**Jobs work in their own workspace.** A job handed to Claude from the UI does not edit this
directory in place: it cuts a branch and a separate worktree from the latest `main` (under the
cache directory, outside the repository), edits and runs the tests there, then pushes the
branch and opens the PR. It and the other sessions working in this directory no longer
interfere. After the merge its changes are synced back here; a file someone else changed
meanwhile is three-way merged, and what cannot be merged is left as it was and stated in the
job. Passing errors while submitting (git locks, network timeouts) are retried automatically.
`IDEA_LOOM_JOBS_INPLACE=1` restores editing in place.

## 给 AI Agent / For AI agents

仓库里的数据和计算可以直接接给外面的 AI Agent，三个出口，都从各项目 `sim.json` 的 `agent` 一节生成（还没有这一节的项目用 `data/agent/<项目>.json` 里的临时说明）：

The data and computations in the repository can be handed straight to outside AI agents
through three outlets, all generated from the `agent` section of each project's `sim.json`
(projects without one use the interim description in `data/agent/<project>.json`):

| 出口 / Outlet | 地址 / Where |
|---|---|
| 文档 / Documents | `/llms.txt`、`/llms-full.txt`；仓库根目录的 `AGENTS.md` / the root `AGENTS.md` |
| HTTP | `/api/v1/catalog`、`/ideas`、`/datasets/{项目}/{数据集}`、`/capabilities/…`、`/run/{项目}/{能力}`、`/proposals/idea|wish` |
| MCP | 远程 / remote `POST /mcp`；本机 / local `uv run idea-loom mcp`（根目录的 `.mcp.json` 已配好 / configured by the root `.mcp.json`） |

- 读数据和跑计算不要令牌。提议要带 `propose` 权限的令牌（「开发」页右上角的"接入外面的 Agent"，地址是 `/connect`，或 `uv run idea-loom agent token <名字> --propose`），而且只进"待你过目"的队列：愿望放行后进许愿池，idea 放行后进候选。全程不调用模型。
  Reading and computing need no token. Proposing needs a token with the `propose` scope ("Connect outside agents" at the top right of the Work page, at `/connect`, or `uv run idea-loom agent token <name> --propose`) and only reaches the review queue: an accepted wish enters the wish pool, an accepted idea becomes a candidate. No model is called anywhere.
- 数据集从 `origin/main` 上的文件里读；每次返回都带许可、出处和版本。
  Datasets are read from the files on `origin/main`; every reply carries the licence, the provenance and the version.
- 计算转给项目自己的后端：输入按声明的 JSON Schema 校验，时间和返回大小有上限，同时最多跑四个。
  Computations go to the project's own backend: the input is validated against the declared JSON Schema, time and reply size are capped, and at most four run at once.
- `uv run idea-loom agent check` 是验收：起一个看不到仓库、只有这套工具的 `claude`，让它做五个固定的任务，打印每个任务调了哪些工具。它会真的调用模型（一轮约 0.5 美元）。
  `uv run idea-loom agent check` is the acceptance test: it starts a `claude` that cannot see the repository and has only these tools, gives it five fixed tasks and prints which tools each one called. It really calls the model (about $0.50 a round).

## 测试 / Test

```sh
uv run pytest                       # 后端 / backend
cd web && bun run test && bun run typecheck
```

`tests/test_import.py` 是导入往返测试：从 `IDEAS.md` 的 git 历史导入再生成，结果必须和现在的
`IDEAS.md` 一致。它需要 world-sim 的 git 历史，没有时自动跳过。

`tests/test_import.py` is the import round trip: importing from the git history
of `IDEAS.md` and rendering again must give what `IDEAS.md` holds today. It needs
the world-sim git history and skips itself without it.

## 数据 / Data

| 文件 / File | 内容 / Content |
|---|---|
| `data/ideas.jsonl` | idea 的事件，只追加；当前状态由它折叠得出 / idea events, append-only; the current state is folded from them |
| `data/frame.json` | 层、横线、内核 / levels, threads, kernels |
| `data/projects.json` | 子项目和它们对应的层 / subprojects and their levels |
| `data/wishes.jsonl` | 愿望的事件 / wish events |
| `data/tasks.jsonl` | 开发任务的事件 / development task events |
| `data/play/*.json` | 还没有自己的 `sim.json` 的项目的临时名片（现在是空的：五个项目都有自己的了）/ interim card files for projects without their own `sim.json` (empty now: all five have their own) |

`runs/`（不进 git）里是模型的提议 `proposals.jsonl`、每次调用的用量 `llm.jsonl`（输入、输出、缓存读、缓存写的 token；会话每轮一行，带着 Claude Code 的会话编号）、操作轨迹 `trail.jsonl`、回看记录 `reviews.jsonl`、小助手的对话 `assistant/` 和作业 `jobs/`。

`runs/` (not in git) holds the model's proposals in `proposals.jsonl`, the usage of
every call in `llm.jsonl` (input, output, cache-read and cache-write tokens; one row per
session turn, with Claude Code's session id), the action trail in `trail.jsonl`, the review log in `reviews.jsonl`, the assistant's
conversations under `assistant/` and the jobs under `jobs/`.

以上是本地的存法。设了 `IDEA_LOOM_DB`（云端）之后，`ideas`、`wishes`、`tasks`、`trail`、`proposals`、`llm`、`suggestions`、`reviews` 这八条日志改存进一个 SQLite 文件的事件表，读写的接口不变（`store.py`）；仓库里的文件变成导出的记录。`uv run idea-loom db import` 把现有的文件并进数据库（可以反复做，不会重复），`db export <目录>` 导出成和原来逐字节相同的文件，`db status` 看每条日志有多少事件。

That is how things are stored locally. With `IDEA_LOOM_DB` set (the cloud), the eight logs
`ideas`, `wishes`, `tasks`, `trail`, `proposals`, `llm`, `suggestions` and `reviews` go into an event table in one
SQLite file instead, behind the same read and write interface (`store.py`), and the files
in the repository become an exported record. `uv run idea-loom db import` merges the
existing files into the database (repeatable, never duplicating), `db export <dir>` writes
files byte-identical to the originals, and `db status` shows how many events each log has.

愿望和任务的数据进 git，也就是公开的——这是定下来的做法。访客提的、还没经主人放行的愿望不在其内，它们只在运行目录（云端是数据库）里。

Wish and task data are in git and therefore public; this is the settled choice. Wishes sent
by visitors that the owner has not yet let through are not included: they stay in the runs
directory (the database in the cloud).

事件有这几种 / Event kinds：`created`、`edited`、`moved`、`status`、`merged_into`、`discarded`、
`restored`、`noted`。编号永不复用，合并和丢弃的条目留在日志里。

Ids are never reused; merged and discarded entries stay in the log.

数据的来源是这个仓库自己：`uv run idea-loom import` 顺着 `IDEAS.md` 的提交历史把每条 idea
的来历还原成事件。没有第三方数据。

The data comes from this repository itself: `uv run idea-loom import` walks the
commit history of `IDEAS.md` and reconstructs each idea's history as events.
There is no third-party data.

## 命令 / Commands

```sh
uv run idea-loom status             # 现在有多少条 / how many ideas
uv run idea-loom render             # 输出 IDEAS.md 的三块 / print the generated blocks
uv run idea-loom render --write     # 写回 IDEAS.md / write them into IDEAS.md
uv run idea-loom translate          # 把还没有英文的译成英文 / translate what has no English yet
uv run idea-loom sync               # 生成并开 PR / regenerate and open a PR
uv run idea-loom import --force     # 重新导入 / re-import from git history
uv run idea-loom schema             # 数据契约的 JSON Schema / JSON Schema of the contract
uv run idea-loom db status          # 数据库存法时：每条日志有多少事件（另有 import、export）/ with the database: events per log (also import, export)
uv run idea-loom wishes list        # 许愿池（给处理愿望的 Claude Code 用）/ the wish pool, for a Claude Code session
uv run idea-loom wishes accept wish-3 # 另有 show、brief、claim、release、note、link、done、decline / also show, brief, claim, release, note, link, done, decline
cd web && bun run gen:types         # 重新生成前端类型 / regenerate the TS types
```

## 结构 / Layout

```
src/idea_loom/
  model.py      数据契约 / data contract
  store.py      只追加的事件日志：文件或数据库 / append-only event logs: files or the database
  ideas.py      折叠、血缘、覆盖表、内核计数 / fold, lineage, coverage, kernel counts
  markdown.py   读 IDEAS.md / parse IDEAS.md
  importer.py   从 git 历史导入 / import from git history
  render.py     生成 IDEAS.md 的三块 / render the generated blocks
  llm.py        claude -p 封装，带缓存和用量记录 / claude -p wrapper with cache and usage log
  ops.py        生成、细化、融合、归类、查重 / generate, refine, fuse, classify, dedupe
  prompts/      提示词 / prompts
  tasks.py      开发任务 / development tasks
  github.py     读合并请求 / read pull requests
  stats.py      统计 / statistics
  config.py     部署配置：域名、角色 / deployment configuration: domain, roles
  auth.py       登录与权限：三档身份、签名的会话、限流 / sign-in and roles: three roles, the signed session, rate limits
  cloud.py      云端启动：克隆仓库、第一次取数据 / cloud start-up: clone the repository, seed the data once
  play/         统一入口：名片、快照与构建、后端进程、按主机名分发 / the single entry point: card files, snapshots and builds, backend processes, routing by host
  jobs.py       作业：出方案、批准、执行、测试、PR / jobs: plan, approve, execute, test, PR
  worker.py     云端跑作业的进程：队列、每个作业的工作区、推分支开 PR / the process that runs jobs in the cloud: the queue, per-job workspaces, pushing and opening PRs
  maintenance.py 定时维护：提交少时自动做一件小事，结果分两档 / scheduled maintenance: one small thing when commits are few, in two tiers
  chains.py     连续推进：事先批准一个子项目接下来的几步 / chains: steps of a subproject approved in advance
  sessions.py   网页里的 Claude Code：用 Agent SDK 开的长会话，计划、权限确认和提问都等主人在页面上回答 / Claude Code in the page: long sessions on the Agent SDK, with plans, permissions and questions awaiting the owner in the page
  gates.py      闸门：每天的上限、订阅额度的暂停线 / gates: the daily cap and the allowance pause
  calls.py      云端：hub 把模型调用交给 worker（只给数据，不给命令）/ in the cloud: the hub hands model calls to the worker (data only, never a command)
  review.py     回看操作轨迹 / review of the action trail
  wishes.py     许愿池 / the wish pool
  notify.py     推送通知：方案待批、作业结果、访客的愿望、队列暂停 / push notifications: plans to approve, job results, visitors' wishes, queue pauses
  agentapi/     给外来 Agent 的那一层：说明、目录、数据集、计算、文档、MCP、令牌、验收 / the layer for outside agents: descriptions, catalogue, datasets, runs, documents, MCP, tokens, acceptance
  suggestions.py 访客和 Agent 提的愿望与 idea：待主人过目的队列 / wishes from visitors: the queue the owner looks over
  trail.py      操作轨迹 / the action trail
  assistant/    小助手：提示词、回合、事件流、工具服务 / the assistant: prompt, turns, event stream, tool server
  edits.py      手动改动，先检查再写事件 / manual changes, validated then appended
  sync.py       同步到仓库 / sync to the repository
  server.py     HTTP 接口 / HTTP API
  serving.py    serve 的看守：代码变了自己重启、界面变了自己构建 / the keeper of serve: restarts on code changes, rebuilds on UI changes
  cli.py        命令行 / command line
web/            React + Vite + zustand
```
