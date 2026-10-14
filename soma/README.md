# soma

三维人体解剖浏览器，面向医学生。world-sim 阶梯上的 L4：器官怎么合成一个活着的整体。

长期目标是外科训练用的模拟人：解剖结构在医学上可信，组织有物理性质，身体对疼痛有反应。现在完成的是第一步——把一个完整的人体拆成三千多个可以单独查看的部件，并标出它们之间的关系。

> 仅供教学使用，不是临床依据。几何来自公开数据集，源数据自身声明仍含错误；中文名称、功能关系和体表图都还没有经过医学专业人员审校。

[English version below](#english)

## 现在能做什么

- 男女两个体型。男性 3,352 个独立部件：骨、肌肉、血管段、器官、神经、韧带、淋巴结、皮下脂肪，按系统分组；女性 3,373 个（见下文，精度低得多）。
- 按系统显示或隐藏、调透明度；从皮肤到骨骼逐层剥离。
- 点选部件，查看中/英/拉丁名、FMA 编号、所属层级、相邻结构。
- 肌肉的起点、止点、神经支配、血供等关系，每条带出处，可点击跳转；神经列出它支配的结构，可一次全选。
- 体表图：皮节（31 区）和皮神经分布区（49 区）画在皮肤上，可以从皮肤区域跳到支配它的神经，也可以反过来。
- 每个部件标明几何的来源和许可，可按来源着色或筛选，一眼分清哪些是实测、哪些是推算或手绘。
- 隔离、只看相邻结构、爆炸视图、任意轴向剖切。
- 两棵层级树（分类 is-a、结构 part-of）和按名称或编号搜索。
- 男女切换保留视角和选中的结构；对照视图把两个体型的同一系统并排显示，视角联动。
- 表情与口形：21 种情绪表情（6 种基本、15 种复合）、25 个动作单元、17 个说话的口形，可与疼痛表情叠加；也可以选一段音频，让口形跟着声音走。
- "数据来源与声明"里有"标定对照"：关节、肌肉力臂、节段比例、器官体积和表情位移与外部开放模型逐项相比的表。
- 每个体型带一份"使用前请注意"，首次加载时显示。

### 对照视图、触屏和 WebGL2

- **对照视图**：姿势、呼吸、体型、疼痛表情、情绪表情和口形在左右两个窗格里同时生效。体型按"相对各自默认值的偏移"套到另一副身体上，并限制在它的可用范围内。
- **皮肤不透明时**隐藏哪些部件由每副人体的 `display.json` 给出（现在是外耳和深部的上、下唇，皮肤自己已经有这些形状；对照窗格用它自己那副人体的清单）；它们仍在结构树里，选中即可显示。眉毛跟皮肤一起画成不透明，用示意性的深色：它只比皮肤高出零点几毫米，半透明时几乎看不见。"显示"页有"皮肤不透明"开关。
- **触屏**：单指旋转、双指平移和捏合缩放、点按选取；手机上顶栏分两行，详情是底部抽屉。嵌入页里第一次触摸画布之后才接管手势，之前竖向滑动仍然滚动页面。只在设备模拟里验证过，没有在真机上测过。
- **WebGL2 回退**：每个系统里不透明的部件合成一次绘制（三千多次降到一百多次）；`?chunks=0` 可关掉用于对照。改变身高时相机跟随身体。

### 体型

"姿势"页的"体型"一节有四个滑块：身高、BMI、腿长比例、体型分布。BMI 只改变皮肤和皮下脂肪（肌肉、骨、内脏不变，内脏脂肪和乳房没有模拟）；身高和比例通过各关节的节段缩放实现。每个滑块只能在这副身体上可用的范围内移动，到头时会写明原因（例如男性不能低于 BMI 21.5，否则肌肉穿出皮肤）。回归公式来自人群测量数据，给出的是平均体型，不是对某个人的预测。

已知问题：缩短身高或改变比例时，皮下脂肪最多会穿出皮肤约 12 mm；"体型分布"的效果很弱；女性模型的默认 BMI 在数据中有 22.0 和 23.7 两个值，读数只是近似。

### 疼痛反应（表情与发声）

左侧"疼痛"面板演示疼痛行为：设定强度（0–10）和起病方式，点"触发"，面部动作单元按时间过程出现并消退，未静音时同时发声，张口与声音同步。"保持表情"把表情停在所设强度；"每次触发都出声"（默认关）让低强度时也发声；"单个动作单元"可以逐个演示 AU。

这是疼痛**行为**的计算模型，用于教学：被模拟的身体没有主观体验；"强度 → 表情"的数值是本项目的假设；声音是演员按指令表演的录音（没有录音包时改用参数合成）。表情由模型里的表情肌驱动（`tools/face/`、`data/curated/face/`）：闭眼时上睑沿眼球表面滑下，张口时露出牙和舌。

**施加刺激。** "疼痛"页顶部的刺激工具：选种类（针刺、钝压、捏夹、热、冷）、量值、时长、是否重复、刺激是否被固定；打开"在皮肤上施加"后点一下皮肤按设定时长施加，按住不动则施加到松手。摆了姿势或改了体型也可以。模拟人的反应包括：皮肤上的疼痛分布层、从皮肤到神经根的通路和沿它走的 Aδ / C 两个标记、退缩反射、表情和（打开声音后的）发声，以及监护条上的心率、血压、呼吸、瞳孔、皮肤电导。解释面板按九个步骤说明原因，每个数字都标明是有出处、是假设还是算出来的。监护条上的数是群体平均的效应量，不能用来推断疼痛。模型在 `src/painmodel/`，数据表和来源在 `data/curated/pain/`。

**有真实开口的皮肤。** 眼和口是真正的开口：皮肤不透明时，透过它们能看到眼球、牙、牙龈和舌（这些是解剖部件，不管所在系统开没开都会画出来）。口腔深处近黑色的壁（口腔袋）和睑缘向里卷的一圈是为开口构造的，不是解剖：口腔袋不能选取，也不上体表图。皮肤不透明时隐藏的部件由管线给出（外耳和深部的上唇、下唇，皮肤自己已经有）。选中皮肤，结构信息里列出它由哪几片拼成；"构造物"单独用一种颜色和虚线标出，不是解剖来源。疼痛页默认看皮肤。

**皱纹细节。** 皮肤不透明时，面部按表情强度叠加一层法线细节（眉间、鱼尾、下睑、鼻根、鼻唇沟、口角）；皱纹是程序化生成的，条数和尺寸是假设。

声音素材的许可见下文"疼痛声音包"。嵌入模式默认静音，任何声音都需要用户点击才会播放。

### 表情与口形

左侧"表情"面板：

- **情绪表情。** 21 种（高兴、悲伤、恐惧、愤怒、惊讶、厌恶 6 种基本情绪，加 15 种复合情绪），每种是一组面部动作单元（AU），带一个 0–1 的强度滑块。每种情绪用到哪些 AU 取自 Du、Tao、Martinez 2014；**各 AU 的强度是本项目的假设**。模拟人没有情绪，这只是把已发表的原型摆出来。
- **单个动作单元。** 25 个 AU 各一个滑块（0–5，对应 FACS 的 A–E 级），与"疼痛"页里的是同一组。
- **口形（视位）。** 22 个说话的口形（英语 17 个，加普通话专用的 5 个：撮口 ü、卷舌 zh ch sh r、龈腭 j q x、卷舌元音 er、软腭擦音 h），点一下保持、再点一下松开：双唇音合唇、唇齿音下唇碰上齿、圆唇、展唇、开口等；舌有五个示意姿势（舌尖、舌面前部、舌根上抬，舌放低，卷舌）。方法取自 JALI（Edwards 等 2016）。每个口形有两套数值，用"风格"开关选：
  - **正常**：朗读时的开度。**下颌开度是按实测标定的**：电磁发音仪量到的切牙开度，三位英语说话人的均值（USC-TIMIT 一位，CC BY 4.0；MOCHA-TIMIT 两位，**该语料只许研究、教育和个人使用，这里只用了本项目自己算的汇总量，没有带语料本身**）。开口的 a 切牙只分开约 5 毫米，多数辅音 1–3 毫米。部分舌位取自实测的线圈高度。**假设的部分**：唇的动作强度（只按实测的唇开度核对过次序）、舌尖的接触、把"说话时下颌的最高位置"当作闭口；普通话专用的 5 个口形没有任何实测数据。
  - **夸张**：校准之前的那套大口形（开口的 a 张到最大角的一半），**全部是假设**，好处是各口形分得开。
  - 开关在"缺省"时，口形按钮用夸张、说话用正常。每个数值的来历写在 `data/curated/face/visemes.json` 的 `calibration` 和各视位的 `provenance` 里。
- **说一句话（由音素带动口形）。** 一段带音素时间线的声音，口形由"现在在发哪个音"决定，不是从声音里猜的：音素 → 视位（`data/curated/face/phonemes-en.json`、`visemes-zh.json`）→ 协同发音（JALI 的习惯；普通话按音节分组，圆唇不跨音节）→ 口形，和声音走同一个时钟。面板上显示正在说的词和音。
  - 随仓库带了 12 句示范（英语、普通话各 6 句，`public/voice/tts-demo/`），**不需要后端**。
  - 语音合成后端在的时候（见"运行"），可以自己输入一句英语或普通话，选声音和语速；后端的拒绝信息和提示原样显示。**声音是机器合成的**（Kokoro-82M，Apache-2.0），界面上写明。
  - 同一段声音可以切换"按音素"（准确）和"按声音分析"（近似），对比两者的差别。
  - 没有用户手势时（由链接或卡片打开）浏览器不让出声：口形按页面时钟无声地走（嵌入时循环），点"声音"后带声音从头播一遍。
- **由音频带动口形。** 选择或拖入一个音频文件，在页面内解码并分析，点"播放"后口形跟着声音走，面板上有一条开口、圆唇、闭合的轨迹。文件不会上传。**从声音推出的口形只是近似**：开口度较可靠，圆唇一般，闭唇较弱（只当作一般的闭合），唇齿音（f、v）检测不出来。

疼痛、情绪和说话由同一个驱动合成（规则在 `tools/face/model.ts` 的 `blendFace`）：情绪和疼痛在同一个 AU 上取较大者；上半脸（眉、眼）只来自这组 AU；说话时表情的下半脸减弱到四成，再与口形在每个通道上取较大者；下颌取两者中较大的；闭唇的口形优先于张口的表情。下颌已经被姿势面板或反射张开时，闭唇和口角按总的下颌角来算，所以双唇音照样合上（总角不超过约 8.7° 时；再大唇就够不着了）。口形有三个来源，优先级从高到低：音素时间线、对音频的分析、保持的口形。

由音素带动时另有两处处理（`src/face/visemeTrack.ts`）：双唇音紧挨着唇齿音时（five more），闭唇和"下唇碰上齿"两个约束会同时接近满值，这里让大的那个胜出，否则唇合不上；闭唇时把"唇成漏斗状"（AU22）减掉，它会把合着的唇顶开约 1 毫米。已知的不足：闭唇按 120 毫秒消退，夹在两个双唇音之间的短元音（"妈妈"）张不开。

### 肌肉活动

"姿势"页的"肌肉活动"开关有两层，可信程度不同：

- **长度变化（几何，可靠）。** 每条肌肉的作用线在当前姿势下比静止姿势短了（暖色）或长了（冷色）多少。它不说明肌肉是否在用力。
- **负荷（估计）。** 身体静止、只受重力（可加手持重物）时，保持这个姿势所需的肌肉激活度：由皮肤围出的体积和组织密度算节段质量，沿骨架累加出各关节的重力力矩，由作用线求力臂（−∂长度/∂角度），最大肌力 = 肌肉体积 / 纤维长度 × 比张力，再求"激活度平方和最小"的分配（静力优化）。站立时体重由足底接触点承担；仰卧 / 俯卧时没动过的肢体由床面托住。肌肉给不出的力矩作为残差逐关节列出。
- **简化和假设。** 没有惯性、没有协同收缩、没有韧带的被动力（只有关节到头时算被动承担）；作用线是直线（股四头肌经髌骨、踝和腕的长肌腱各加一个经过点），不绕过骨；胸椎和肋当作刚性胸廓，肩带和距下关节不参与平衡，腰椎、颈椎各按一段平衡；比张力 61 N/cm² 和 247 / 333 条肌肉的纤维长度比例是假设。所以能看的是谁在用力，百分数本身不可信；力臂不可靠的肌肉在列表里带 ⚠。
- **检验。** 九个有已知答案的姿势 × 两副人体，只判名次和符号：16 / 18 通过（屈肘托前臂、手持 2 kg、举过头时肱三头肌接手、浅蹲、踮脚、前倾、躯干前屈、仰卧直腿抬高）；肩外展 90° 时冈上肌不亮，两副人体都不通过，原因是直线作用线在抬臂后没有外展力臂。屈肘力矩与 de Leva 节段参数算出的 m·g·d 之比为 0.88（男）、0.72（女）。数字见 `data/curated/activity/validation.json`。

数据由 `bun tools/activity/build.ts male`（female 同理）生成到 `public/anatomy/<人体>/activity.json`，参数和出处在 `data/curated/activity/`；绑定或几何重新生成之后要重跑，否则界面只显示长度变化。

### 标定对照

"数据来源与声明"对话框里的"查看对照表"打开一个只读视图：`data/curated/calibration/` 下的十张表（节段比例、活动范围、肱骨角度、肌肉附着点和力臂、器官体积、表情位移、面部控制的覆盖、量具自检）。每张表先给出容差内外各多少行、差得最多的几行，以及参照的名称、版本、许可和网址，可按人体筛选，整张表点开才显示。这些表（合计近 1 MB）是单独的代码块，打开时才下载。**它们是把外部的开放模型和已发表的统计当作量具所做的对照，不是临床人员的审核**；参照本身也是模型或群体平均，不是真值，容差是本项目定的。

## 运行

需要 [Bun](https://bun.sh)。

```sh
bun install
bun run dev        # http://localhost:5183
```

仓库里已经带了生成好的解剖数据（`public/anatomy/`），克隆后可以直接看。

**语音合成后端（可选）。** `server/` 是一个 FastAPI 服务（`POST /api/tts`、`GET /api/tts/voices`、`GET /api/health`），用开源模型 Kokoro-82M（英语 v1.0，普通话 v1.1-zh，都是 Apache-2.0）把一句话合成 24 kHz 的声音，并给出音素时间线。经统一入口（idea-loom）使用时它按需启动，不用管。开发时自己启动：

```sh
cd server
uv run --extra model python -m soma_tts.fetch --state <状态目录>      # 第一次：下载模型（约 0.6 GB，逐个校验 sha256），不进 git
WORLD_SIM_STATE=<状态目录> uv run --extra model uvicorn soma_tts.server:app --host 127.0.0.1 --port <端口>
cd .. && SOMA_API_PORT=<端口> bun run dev                              # 开发服务器把 /api 转给它
```

没有后端时界面照常能用："表情"面板里没有输入框，说明合成需要本机的服务，随附的 12 句示范和"选择音频文件"都还在；说话的卡片用的是随附的片段。

### 地址参数

视图状态都写在地址的查询参数里，所以任何一个画面都可以用一个链接直接打开。参数都可省略，省略即默认值；无效的值会被忽略并在控制台给出警告。

| 参数 | 取值示例 | 含义 |
|---|---|---|
| `body` | `male`（默认）、`female` | 体型 |
| `embed` | `1` | 嵌入模式：只留舞台和必要控件，不弹对话框 |
| `tab` | `d`、`t`、`p`、`n`、`e` | 左侧面板：显示、结构树、姿势、疼痛、表情 |
| `sys` | `ske,ner:60` | 可见的系统，可带不透明度百分数；未列出的隐藏。代码：`int mus ske cv ner res dig uri rep end lym oth` |
| `peel` | `2` | 剥离层数 |
| `iso` | `FMA7088,FJ1234` | 隔离显示：部件编号或概念编号（概念展开为其下全部部件） |
| `hide` | 同 `iso` | 隐藏 |
| `sel` | `FMA9611` 或 `FJ3259,FJ3260` | 选中：一个概念编号，或若干部件编号 |
| `adj` | `1` | 显示相邻结构 |
| `focus` | `1` | 加载后把相机对准所选（或隔离、可见）的结构 |
| `cam` | `px,py,pz,tx,ty,tz` | 相机位置与目标，单位米 |
| `cut` | `a620`、`c500f`、`s250` | 剖切：轴（`a` 横断、`c` 冠状、`s` 矢状）+ 位置千分比 + 可选的 `f` 翻转 |
| `xp` | `40` | 爆炸视图百分数 |
| `pose` | `squat` 或 `elbow_L.0:90,elbow_R.0:90` | 姿势：预设名，或"关节.自由度:角度"（度，相对静止姿势） |
| `breath` | `1` | 呼吸演示 |
| `map` | `d`、`n` | 体表图：皮节、皮神经分布区 |
| `reg` | `14,15` | 体表图中高亮的区域下标 |
| `see` | `1` | 显示体表图时皮肤半透明，露出其下的神经 |
| `src` | `1` | 按数据来源着色 |
| `cmp` | `ske` | 对照视图及其显示的系统 |
| `shape` | `h1.80,b28,l0,c0` | 体型：h 身高（米）、b BMI、l 腿长比例（SD）、c 体型分布（SD）；只写不在默认值的项，超出可用范围的值会被截断 |
| `stim` | `heat,48,8@forearm_L` | 施加刺激：`种类,量值,秒数[,x次数/频率][,held][,热斜率取法]@部位`。量值：针刺毫牛，钝压和捏夹牛，热和冷摄氏度。部位：`fingertip palm handback forearm cheek shin sole` 加 `_L`/`_R`，或静止姿势下的坐标（毫米）`p-182,1034,28` |
| `pain` | `7` | 把疼痛表情保持在该强度（0–10）；不会自动出声 |
| `au` | `4:3,43:5` | 手动设定面部动作单元，编号:强度（0–5）；与 `pain`、`expr` 逐项取较大者 |
| `expr` | `happy`、`fearful:0.6` | 情绪表情：表情 id，可带强度（0–1，省略为 1）。id：`happy sad fearful angry surprised disgusted`，以及 `happily_surprised happily_disgusted sadly_fearful sadly_angry sadly_surprised sadly_disgusted fearfully_angry fearfully_surprised fearfully_disgusted angrily_surprised angrily_disgusted disgustedly_surprised appalled hatred awed` |
| `vis` | `PBM` | 保持一个口形（视位）。id：`SIL PBM FV TH TDN L SZ SH KG R W UW OW IY EH AA AX`，以及普通话专用的 `YU ZHCHSH JQX ER HX` |
| `say` | `zh-03` | 说一句示范片段：`en-01`…`en-06`、`zh-01`…`zh-06`。口形按音素时间线走；没有用户手势时无声地播，界面上有“声音”按钮。合成用的自由文字不进地址 |
| `style` | `normal`、`clear` | 说话的风格：正常朗读（按实测标定）或夸张。省略时保持的口形用夸张、说话用正常 |
| `skin` | `1` | 不透明皮肤视图 |
| `act` | `len`、`load` | 肌肉活动：`len` 作用线长度变化（几何），`load` 抵抗重力所需的激活度（估计） |
| `load` | `2`、`2L`、`2R` | `act=load` 时手持的重物（千克）；`L` / `R` 只一只手，省略为两手各持 |
| `grav` | `supine`、`prone` | `act=load` 时的重力方向：仰卧、俯卧；省略为站立 |
| `renderer` | `webgl` | 强制用 WebGL2 后端 |

例：`/?body=male&sys=ske,ner&sel=FMA9611&focus=1`。完整定义见 `src/state/urlState.ts`。

## 测试

```sh
bunx vitest run    # 管线、知识层、体表图、图查询、显示规则
bunx tsc --noEmit
```

针对生成数据的测试检查的是不变量和解剖事实：每个部件恰好出现在一个 GLB 里，邻接关系对称，左股骨在身体左侧；18 项神经解剖标志（尺神经过内上髁后方、坐骨神经出梨状肌下孔、腓总神经绕腓骨颈等）；关键感觉点落在自己的皮节里；子宫在膀胱与直肠之间。

## 结构

```
src/anatomy/types.ts   数据契约：离线工具写，界面读
src/                   界面（React + three.js WebGPURenderer）
tools/pipeline/        几何管线：分类、分层、简化、邻接、配准、推导，输出 GLB
tools/knowledge/       知识层：名称和功能关系，按概念编号对齐
tools/skinmaps/        体表图：皮节与皮神经分布区
tools/zanatomy/        Z-Anatomy 与 Open3DModel 的读取和导入包
tools/register/        女性体型的锚点数据
tools/fixture/         开发用的合成数据集
data/curated/          提交进仓库的精编数据
public/anatomy/        生成的运行时数据
```

几何和知识分开来源：形状和位置只取自体数据重建的网格或由它们推导，名称和关系取自本体库、百科和开放资料。两边靠 FMA（Foundational Model of Anatomy）编号对上。

每个部件带来源标记：`scanned`（源数据原样）、`warped`（经配准变形得到）、`curated`（人工建模，或由本项目从相邻结构推导）。

## 重新生成数据

原始数据不在仓库里（`data/raw/` 被忽略），需要先下载。

```sh
# BodyParts3D 4.0：把 LATEST/ 下的表格和两个 zip 下载到 data/raw/bodyparts3d/ 并解压
#   https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/
bun run pipeline                 # 生成 public/anatomy/male/
bun run pipeline:female          # 生成 public/anatomy/female/，需要先有男性输出和女性锚点包（tools/register/run_anchors.sh）
bun tools/knowledge/run.ts       # 名称和关系；加 --refresh 重新查询 Wikidata
bun tools/skinmaps/run.ts male   # 体表图；female 同理
```

顺序有依赖：知识层和体表图读取几何管线的输出，女性体型读取男性体型的输出。

## 数据来源与许可

代码之外，本目录下的解剖数据（`public/anatomy/`、`data/curated/`）整体以 **CC BY-SA 4.0** 发布。

| 来源 | 用在哪里 | 许可 |
|---|---|---|
| [BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html) 4.0 | 男性体型的几何（2,220 个部件）与两棵层级树 | CC BY 4.0（"BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International"）。注意：该数据说明页写的是 CC BY 4.0，而 4.0 版 OBJ 文件头里写的是 CC BY-SA 2.1 日本版；两种表述都如实列在这里，两者都允许本项目的用法 |
| [Blender Studio Human Base Meshes](https://www.blender.org/download/demo-files/) v1.4.1 | 两个体型皮肤上分开的脚趾（美术建模的写实前足，按趾骨配准后移植），标记为 `curated` | CC0 |
| BodyParts3D 3.0 | 4.0 里没有的 79 个部件：肺叶、腹壁肌、背阔肌、咀嚼肌和表情肌。经配准变形，标记为 `warped` | CC BY-SA 2.1 JP |
| [Z-Anatomy](https://github.com/Z-Anatomy) | 颅神经和躯干神经、脊神经根、脊髓、韧带、筋膜、关节囊、淋巴结群、甲状腺、腮腺。手工建模，标记为 `curated` | CC BY-SA 4.0（"Z-Anatomy - The libre 3D atlas of anatomy"） |
| [AnatomyTool Open3DModel](https://anatomytool.org/open3dmodel) | 四肢神经（右侧建模，左侧为镜像）、膝关节交叉韧带和半月板。手工建模，标记为 `curated` | CC BY-SA 4.0 |
| soma（推导） | 皮下脂肪、脏胸膜、心包囊：由本项目从相邻结构计算得出，标记为 `curated` | CC BY-SA 4.0 |
| [Visible Human Project](https://www.nlm.nih.gov/research/visible/visible_human.html) 女性 CT | 女性体型的骨骼和部分器官，由 TotalSegmentator 与 MOOSE 分割 | NLM 使用条款；Courtesy of the U.S. National Library of Medicine |
| [HRA](https://humanatlas.io) 女性参考器官 | 乳腺，以及子宫动静脉、卵巢系膜、卵巢悬韧带、膀胱子宫陷凹。重新建模过的几何，标记为 `curated` | CC BY 4.0 |
| Wu 等 2015 女性盆底（[doi:10.1371/journal.pone.0132226](https://doi.org/10.1371/journal.pone.0132226)，更正 [10.1371/journal.pone.0140736](https://doi.org/10.1371/journal.pone.0140736)） | 女性体型的盆底肌、肛门和尿道括约肌、会阴体、阴蒂和前庭球、阴道、子宫、输卵管、卵巢、直肠，共 51 个部件。来自另一位女性的标本，放大并按骨配准，标记为 `curated` | CC BY 4.0 |
| [丹佛大学 Visible Human 女性下肢模型](https://doi.org/10.1038/s41597-022-01905-2) | 女性体型的下肢肌肉、膝关节韧带、关节软骨、跗骨，共 100 个部件 | CC BY 4.0 |
| [FMA](http://si.washington.edu/projects/fma) 5.1.0 | 新增部件在分类树里的位置 | 见其发布页 |
| [Wikidata](https://www.wikidata.org) | 名称、功能关系、编号对照 | CC0 |
| [Wikipedia](https://en.wikipedia.org) 肌肉信息框 | 部分肌肉的起止点和神经支配，每条带修订版链接 | CC BY-SA 4.0 |
| ISNCSCI 关键感觉点、Lee 等 2008、Gray 1918 | 体表图的定义依据（只取事实，逐条注明） | 见 `data/curated/skinmaps/` |

名称数据里约三分之二的中文名是按术语表机器生成的，没有出处；`names.json` 的 `zhSource` 字段逐条标明了来源，全部条目的状态都是 `unreviewed`。

### 疼痛声音包（禁止商用，与解剖数据分开）

`public/voice/vivae-pain/` 是一个**独立的集合**，许可是 **CC BY-NC 4.0（仅限非商业使用）**，不属于上面 CC BY-SA 4.0 的解剖数据集，也不属于 MIT 许可的代码。

- 内容：VIVAE 语料库（Holz、Larrouy-Maestri、Poeppel，[doi:10.5281/zenodo.4066235](https://doi.org/10.5281/zenodo.4066235)）里"身体疼痛"类的 185 条录音，重采样到 24 kHz，另加本项目做的逐条分析。这些是按指令表演出来的发声，不是真实疼痛时的录音。署名、许可和改动清单在该目录的 `ATTRIBUTION.txt` 和 `LICENSE.txt` 里。
- 用法：`src/voice/` 在运行时加载它，在录音基础上做变化（换录音、小幅变调变速、连成持续性发声、由女声推出男声）。目录不存在时自动改用参数化合成器。
- **商业用途的构建或部署不得带这个目录。** 用 `SOMA_COMMERCIAL=1 bunx vite build` 构建：产物里不带 `voice/vivae-pain/`（`voice/tts-demo/` 的许可允许商用，照常保留），界面改用参数合成的声音，也不显示录音的署名。默认构建不变（带录音包）。
- `data/curated/voice/calibration.json` 只含由该语料统计出的汇总量，不含音频。

### 语音合成：模型、示范片段和口形的标定数据

- **模型**不进 git：Kokoro-82M v1.0（英语）和 Kokoro-82M-v1.1-zh（普通话），hexgrad，Apache-2.0。来源、固定的提交、读到的许可条款和每个文件的 sha256 在 `server/models.json`。
- **示范片段** `public/voice/tts-demo/`：12 句**机器合成**的声音和它们的音素时间线，由上面的模型生成，本项目没有附加限制；署名和生成方式见该目录的 `ATTRIBUTION.txt`、`LICENSE.txt`。没有真人录音。
- **口形的标定数据**：`data/curated/reference/articulation-summary.json` 是本项目从两个发音语料算出的汇总量（各音的切牙开度、唇开度、线圈高度的均值）。USC-TIMIT 是 CC BY 4.0；**MOCHA-TIMIT 只许研究、教育和个人使用，未经许可不得商用**，仓库里没有它的原始数据，依赖它的数值在 `visemes.json` 里标了 `calibratedAgainstNonCommercialData`。

## 已知的缺口

完整的清单在每个体型数据的 `cautions` 字段里。主要的几条：

- 神经是手工绘制的示意性几何，粗细不是实测，位置经配准后误差中位数约 2 mm、下肢更大；约五分之一的中心线点被从骨和肌腹里推出过。
- 没有的神经：膈神经、颈丛、肋下神经、内脏神经、自主神经丛、喉神经。
- 没有壁胸膜、淋巴管、黄韧带、颅内脑膜；心包只是心脏的外包络；降结肠包含乙状结肠；脊髓是程序化生成的表面，止于 L2/L3。
- 皮下脂肪是从皮肤内壁和深层结构之间推导出来的，厚度按 3 mm 量化。
- 男性现在有空腔器官的“腔”（19 个部件，id 为 `LUMEN_…`）：消化道从口到肛门连成一条，另有膀胱、输尿管、输精管和精囊的腔。它们**不是扫描出来的**，是由器官外表面向内缩一个文献（或假设）的壁厚推出来的；旁边的 `lumen-filling.bin` 给出每个顶点随充盈度的位移。构造的部分：从唇到牙的一段、腭帆（一张构造的薄片，数据里没有软腭）、从直肠下端到皮肤的肛管末段。已知的局限：小肠的腔只占可用空间的约 55–59%，因为源数据里的肠段互相重叠；咽腔在食管上方约 20 mm 处就止住了；胃静止时的形状是假设；男性名为“Urethra”的部件有 12 mm 一段穿在阴茎海绵体的部件里。姿势下腔取壁上最近点的权重随壁运动，壁的权重变化急的地方个别顶点仍会出壁几毫米。女性还没有这些腔。
- 男性皮肤是拼成的，逐片标在数据里（选中皮肤可见）：按他的内部结构拟合的参数化体表（Meta MHR，Apache-2.0），不是他本人的皮肤；他自己扫描皮肤上的阴茎和阴囊皮肤，连同阴囊颈部和会阴缝（移植片；它与拟合体表之间的过渡面是构造的，阴囊后方的会阴顶是几块大平面）；CC0 写实人体网格的脚趾（不是他的脚，第 3–5 趾被拉长约 1.3–1.5 倍；第 2–5 趾近趾尖处有一圈浅台阶）；眼和口是剪开的真实开口，睑缘内沿和口腔袋是为此构造的，不是解剖。脐和乳头是从他的扫描皮肤转过来的浅浮雕，网格太粗，几乎看不出。腋窝从肱骨约 45% 处以下是打开的，其上手臂与腋襞本来相贴，皮肤在腋襞处有 15–27 cm² 互相遮挡并有小台阶。头显得又宽又高；眼球的颜色是示意性的。大幅度姿势下（肩外展 90°、前屈 160°、深蹲）皮肤仍有明显拉伸和皱缩。皮肤包不在仓库里，由 `tools/bodyshape/` 和 `tools/skinopen/` 的脚本生成到 `data/raw/bodyshape/out/`。
- 体表图的边界有 1–3 厘米的锯齿。体表图是构造出来的教学用图，皮节因人而异，已发表的图互相矛盾。
- 表情和口形：情绪原型的强度和视位的数值是假设；没有眼球转动和单侧动作；舌只有四个示意姿势；下颌张到最大开口的一半以上时口角处仍有小的折叠（全开时约 35 mm²）；姿势面板或反射张开下颌时，界面还没有把这个角度传给口形（双唇音闭不严）；由音频得到的口形是近似的，唇齿音检测不出来，也没有在真人语音上系统地验证过。眉毛是贴到皮肤上的薄壳（内表面在皮肤下 0.5 毫米），头发仍是一个半透明的壳。
- 男性的静止姿势被改过两次：肩带（原始扫描是仰卧耸肩，锁骨下降约 10°、肩胛骨沿胸廓转动，两肩关节中心间距 338 mm，没有达到 350 mm 的目标）；上肢在冠状面外展 6.5°，以便形成腋窝（肩胛骨保持不动是建模上的选择，没有打开过出处）。跨越肩部的肌肉、血管由 `scanned` 改标为 `warped`。
- 女性体型比男性粗糙得多：
  - 骨架来自 Visible Human 女性供体（59 岁、肥胖、六节腰椎），已按标准比例缩放到身高 1.606 m、五节腰椎，所以她的部件都不标为 `scanned`。踝仍偏高约 16 mm；左右肘关节的屈伸轴相差 22.5°（她两侧肱骨远端不同），屈肘时两前臂不对称；脚骨和手指是修正过的男性骨。
  - 大部分软组织是男性的结构配准到她的骨上，并按标准女性体表调整过分布；男性来源的肌肉体积不低于有出处的女/男比值（Janssen 等 2000）。上肢外展 7.5°。
  - 下肢的肌肉和膝关节韧带是她自己的（丹佛数据）。神经长度有 2.0% 在她的肌肉内，其中 1.8% 是止于肌肉的运动支，解释不了的 0.07%。
  - 盆底、阴道、子宫、附件和直肠来自另一位女性的标本（Wu 等 2015）。结构之间仍有少量穿插（最差的一对 3.8%）；膀胱（她自己的，空虚）与子宫之间有 16.6 mm 空隙；九条盆腔韧带只有三条（左右宫骶韧带、右主韧带）按两端重新配准放回，其余在现有器官之间没有位置。
  - 没有外阴形态：会阴处的皮肤是抬高过的平滑闭合面。标本的皮肤没能移植：收窄后的移植片边缘离她现在的皮肤中位数 11.6 mm（上限 5 mm），把皮肤抬到那里会让股薄肌露出皮肤。也没有尿道腔、卵巢和阴道血管、自主神经丛。
  - 皮肤同样是拼成的：标准女性体型（身高 1.606 m、BMI 21.6）的参数化体表，在肌肉仍超出处放宽，按体积算的 BMI 约 23.7；头部用按她的颅骨和已发表的软组织厚度定出的面容，只保证盖住骨头，所以有九块面肌略露出皮肤（最多约 2–3 mm）。**面容仍偏男性、偏年长**（下颌宽，嘴唇薄，头发和眉毛是男性的部件）。眼和口是真实开口；脚趾来自 CC0 网格，第 2–5 趾近趾尖处有一圈浅台阶；原先露在脚趾之间和大腿根部的筋膜薄片已收进皮肤（薄层结构露出面积由 253 降到约 10 cm²，余下的在腋襞）。乳房每侧约 334 mL（中国女性的参考值），腺体部件缩到约 0.5 倍放入；脐是构造的。
  - 她的肋间神经是从男性变形来的；第 7–11 条出骨性胸廓以后的一段已按她自己的剑突和脐重排（T7 止于剑突尖下方，T10 止于脐；T8、T9、T11 的高度是等间隔插值，不是出处给的）。体表图上脐现在落在 T10；剑突处仍不对（左 T5、右 T7，教科书 T6–T7），右侧 T12 皮节分成两块。模型里没有肋下神经。
  - 右前臂和右手在 CT 里被裁切，用的是左侧镜像。

## 接下来

1. 女性面容（女性的头发和眉毛、下颌、嘴唇）；女性外阴；腋窝的两层皮碰撞求解；让神经和筋膜等薄结构与新皮肤、分开的脚趾相容。
2. 软组织物理：四面体化，XPBD，先在一个部位验证。
3. 手术操作：切开、牵拉、出血、缝合。

---

<a id="english"></a>

# soma (English)

A 3D human anatomy browser for medical students. Level L4 on the world-sim ladder: how organs add up to one living body.

The long-term goal is a simulated patient for surgical training: anatomy that is medically credible, tissue with physical properties, a body that responds to pain. What exists now is the first step — a whole body taken apart into more than three thousand parts that can be inspected one by one, with the relations between them.

> For teaching only; not a clinical reference. The geometry comes from public datasets whose own release notes say they still contain errors. Chinese names, functional relations and skin maps have not been reviewed by a medical professional.

## What it does

- Two bodies. Male: 3,352 separate parts — bones, muscles, vessel segments, organs, nerves, ligaments, lymph nodes, subcutaneous fat — grouped by system. Female: 3,373 (far less accurate; see below).
- Show, hide and fade systems; peel layers from skin to skeleton.
- Select a part to see its Chinese / English / Latin names, FMA id, place in the hierarchies and adjacent structures.
- Origin, insertion, innervation, blood supply and other relations, each with its source, clickable; a nerve lists what it supplies and can select all of it at once.
- Skin maps: dermatomes (31 regions) and cutaneous-nerve territories (49 regions) painted on the skin; jump from a skin region to the nerve that supplies it and back.
- Every part states where its geometry came from and under which licence; colour or filter by provenance to tell measured from inferred or drawn.
- Isolate, show neighbours, exploded view, section plane on any axis.
- Two hierarchies (is-a and part-of) and search by name or id.
- Switching between male and female keeps the camera and the selection; the compare view shows one system of both bodies side by side with linked cameras.
- Expression and mouth shapes: 21 emotion expressions (6 basic, 15 compound), 25 action units and 17 mouth shapes of speech, which combine with the pain expression; an audio file can also drive the mouth.
- "Attribution & disclaimer" holds a "Calibration" view: tables comparing joints, muscle moment arms, segment proportions, organ volumes and expression displacement with open external models, item by item.
- Each body carries a list of cautions, shown on first load.

### Compare view, touch and WebGL2

- **Compare view**: pose, breathing, body shape, the pain expression, emotion expressions and mouth shapes apply in both panes. Shape is carried to the other body as offsets from its own defaults, within its valid range.
- **While the skin is opaque**, the parts to hide come from each body's `display.json` (at present the external ear and the deep upper and lower lip, shapes the skin has itself; the compare pane uses its own body's list); they stay in the tree and selecting one shows it. The eyebrows are drawn opaque with the skin, in an illustrative dark colour: they stand only a fraction of a millimetre proud of it and all but vanish when see-through. The Display tab has an "Opaque skin" switch.
- **Touch**: one finger orbits, two fingers pan and pinch-zoom, a tap picks; on phones the top bar takes two rows and details open as a bottom sheet. In an embed the canvas takes over gestures only after it is first touched; before that a vertical swipe still scrolls the page. Verified in device emulation only, not on a real device.
- **WebGL2 fallback**: opaque parts of each system are drawn in one call (from over three thousand draws to about a hundred); `?chunks=0` switches this off for comparison. The camera follows the body when stature changes.

### Body shape

The "Body shape" section of the Pose tab has four sliders: stature, BMI, relative leg length and mass distribution. BMI changes only the skin and the fat under it (muscles, bones and viscera stay; visceral fat and the breasts are not modelled); stature and proportions are realised by per-joint segment scales. Each slider moves only within the range valid on this body and states the reason at its limit (the male, for example, cannot go below BMI 21.5 because muscle would come through the skin). The regressions come from population surveys and give average builds, not a prediction for a person.

Known problems: when the body is shortened or re-proportioned, subcutaneous fat comes through the skin by up to about 12 mm; "mass distribution" has only a weak effect; the female body's default BMI has two values in the data (22.0 and 23.7), so its readout is approximate.

### Pain response (expression and voice)

The "Pain" panel on the left demonstrates pain behaviour: set an intensity (0–10) and an onset, press Trigger, and the facial action units rise and fade over time, with a vocalisation unless muted and the mouth in step with the sound. "Hold" keeps the expression at the set intensity; "Always vocalise" (off by default) makes a sound at low intensities too; "Single action units" shows one AU at a time.

This is a computational model of pain **behaviour** for teaching: the simulated body has no subjective experience; the intensity-to-expression numbers are assumptions of this project; the sounds are recordings acted on instruction (or parametric synthesis when the pack is absent). The expression is driven by the facial muscles of the model (`tools/face/`, `data/curated/face/`): the upper lid slides down over the globe to close the eye, and an opened mouth shows teeth and tongue.

**Applying a stimulus.** The stimulus tool at the top of the Pain tab: pick the kind (pinprick, pressure, pinch, heat, cold), magnitude, duration, repeats and whether the stimulus is held; with "Apply on the skin" on, a click applies it for the set duration and pressing and holding applies it until release. It works on a posed or reshaped body. The response is shown as a pain map on the skin, the pathway from skin to nerve root with the Aδ and C markers travelling along it, the withdrawal reflex, the expression and (with sound on) the voice, and a monitor with heart rate, blood pressure, respiration, pupil and skin conductance. The explanation panel gives the reason in nine steps and marks every number as sourced, assumed or computed. The monitor shows group-average effect sizes that cannot be used to infer pain. The model is in `src/painmodel/`, its tables and sources in `data/curated/pain/`.

**A skin with real openings.** Eyes and mouth are real openings: with the skin opaque, the eyeballs, teeth, gingiva and tongue are seen through them (anatomical parts, drawn whatever their systems' switches say). The near-black wall deep in the mouth (the oral pouch) and the rim turned in at the lid margins were constructed for the openings and are not anatomy: the pouch cannot be picked and takes no skin-map colour. The parts hidden under an opaque skin come from the pipeline (the external ear and the deep upper and lower lip, which the skin has itself). Select the skin and its details list the pieces it is assembled from; "construction" has its own colour and a dashed mark and is not an anatomical provenance. The Pain tab defaults to the skin view.

**Wrinkle detail.** While the skin is opaque, the face gets a layer of normal detail blended by expression (glabella, crow's feet, lower lid, nasal root, nasolabial fold, lip corner); the wrinkles are procedural and their counts and sizes are assumptions.

For the licence of the sound material see "Pain sound pack" below. Embed mode is muted by default and any sound needs a click.

### Expression and mouth shapes

The "Expression" panel on the left:

- **Emotion expressions.** 21 of them (the six basic ones — happy, sad, fearful, angry, surprised, disgusted — and 15 compound ones), each a set of facial action units (AUs) with a strength slider from 0 to 1. Which AUs make up each emotion is from Du, Tao & Martinez 2014; **the intensity of each AU is an assumption of this project**. The simulated body has no emotions; published prototypes are merely posed.
- **Single action units.** A slider for each of the 25 AUs (0–5, FACS levels A–E), the same set as in the Pain tab.
- **Mouth shapes (visemes).** 22 mouth shapes of speech (17 for English plus 5 for Mandarin only: rounded front ü, retroflex zh ch sh r, alveolo-palatal j q x, the rhotic vowel er and the velar fricative h); click to hold, click again to release: lips sealed for bilabials, lower lip to the upper teeth for labiodentals, rounded, spread, open; the tongue has five schematic poses (tip, front and back raised, lowered, retroflex). The method is from JALI (Edwards et al. 2016). Every shape has two sets of numbers, chosen with the "Style" switch:
  - **Normal**: the openings of read speech. **The jaw openings are calibrated against measurements**: incisor openings from electromagnetic articulography, the mean of three English speakers (one from USC-TIMIT, CC BY 4.0; two from MOCHA-TIMIT, **a corpus licensed for research, educational and individual use only — only aggregates computed by this project are used and the corpus itself is not included**). An open a parts the incisors by only about 5 mm and most consonants by 1–3 mm. Some tongue weights come from measured coil heights. **What is assumed**: the lip action intensities (checked against the measured lip aperture for order only), contact of the tongue tip, and equating the highest jaw position reached in speech with a closed mouth; the 5 Mandarin-only shapes have no measurements behind them at all.
  - **Clear**: the wide shapes from before calibration (an open a at half the jaw's range), **assumptions throughout**; their merit is that the shapes can be told apart.
  - With the switch on "Default" the shape buttons use Clear and speech uses Normal. Where each number comes from is recorded under `calibration` and each viseme's `provenance` in `data/curated/face/visemes.json`.
- **Say something (phoneme-driven).** Audio that comes with a phoneme timeline; the mouth shape is set by which sound is being made, not guessed from the audio: phonemes → visemes (`data/curated/face/phonemes-en.json`, `visemes-zh.json`) → co-articulation (the JALI habits; Mandarin is grouped by syllable, so rounding does not cross a syllable boundary) → mouth shape, on the same clock as the audio. The panel shows the word and sound being spoken.
  - 12 demo sentences ship with the repository (6 English, 6 Mandarin, `public/voice/tts-demo/`) and **need no backend**.
  - With the speech-synthesis backend present (see "Run") you can type an English or Mandarin sentence and choose a voice and a speed; the backend's refusals and warnings are shown verbatim. **The audio is machine-synthesized** (Kokoro-82M, Apache-2.0), and the UI says so.
  - The same audio can be switched between "By phonemes" (accurate) and "By audio analysis" (approximate) to see the difference.
  - Without a user gesture (opened by a link or a card) browsers allow no sound: the mouth runs silently on the page clock (looping when embedded), and "Sound" replays it from the start with audio.
- **Speak from audio.** Choose or drop an audio file; it is decoded and analysed in the page, and after pressing Play the mouth follows the sound, with a strip showing opening, rounding and closure. The file is never uploaded. **Mouth shapes derived from sound are approximate**: opening is fairly reliable, rounding moderate, lip closure weak (treated as a generic closure), and labiodentals (f, v) are not detected.

Pain, emotion and speech are composed by one driver (the rule is `blendFace` in `tools/face/model.ts`): emotion and pain take the larger value of each AU; the upper face (brows, eyes) comes from that set alone; while speaking the expression's lower face is attenuated to four tenths and then combined with the mouth shape by taking the larger value per channel; the jaw is the larger of the two; a lip closure wins over an open-mouthed expression. When the pose panel or a reflex has already opened the jaw, lip seal and corner shaping are computed for the total jaw angle, so a bilabial still closes (while the total stays within about 8.7°; beyond that the lips cannot reach). The mouth shape has three sources, in falling precedence: a phoneme timeline, an analysis of audio, a held shape.

Phoneme-driven speech adds two treatments (`src/face/visemeTrack.ts`): where a bilabial touches a labiodental ("five more") the closure and lower-lip-to-teeth constraints both approach full value, and the larger one is made to win, as the lips would not close otherwise; and with the lips sealed the funnel (AU22) is taken off, because it pushes sealed lips apart by about 1 mm. A known shortcoming: the closure decays over 120 ms, so a short vowel between two bilabials (妈妈, "mama") does not open up.

### Muscle activity

The "Muscle activity" switch of the Pose tab has two layers of different standing:

- **Length change (geometry, reliable).** How much shorter (warm) or longer (cool) each muscle's line of action is in the current pose than at rest. It says nothing about effort.
- **Load (an estimate).** The activations needed to hold the pose with the body still under gravity (optionally with a load in the hand): segment masses from the volume the skin encloses and tissue densities, gravitational joint torques summed along the skeleton, moment arms from the lines of action (−∂length/∂angle), maximum force = muscle volume / fibre length × specific tension, then the sharing with the least sum of squared activations (static optimisation). Standing, body weight is carried at the sole contact points; supine or prone, limbs that were not moved rest on the couch. Torque the muscles cannot deliver is listed per joint as the residual.
- **Simplifications and assumptions.** No inertia, no co-contraction, no passive ligament force (only a joint at the end of its range is held passively); lines of action are straight (the quadriceps through the patella, and one via point each for the long tendons at ankle and wrist) and do not wrap round bone; the thoracic spine and ribs are a rigid cage, the shoulder girdle and subtalar joint are not balanced, the lumbar and cervical spine are each balanced as one stretch; the specific tension of 61 N/cm² and the fibre-length ratio of 247 of 333 muscles are assumptions. Read who works, not the percentages; muscles with unreliable moment arms carry ⚠ in the list.
- **Validation.** Nine poses with known answers on both bodies, judged by ranks and signs only: 16 of 18 pass (holding the forearm, holding 2 kg, triceps taking over overhead, shallow squat, tiptoe, forward lean, trunk flexion, supine straight leg raise); at 90° of abduction supraspinatus stays dark on both bodies, because a straight line has no abduction moment arm once the arm is raised. Elbow torque over m·g·d from de Leva's segment parameters is 0.88 (male) and 0.72 (female). Numbers are in `data/curated/activity/validation.json`.

The data is written by `bun tools/activity/build.ts male` (likewise female) to `public/anatomy/<body>/activity.json`, with parameters and sources under `data/curated/activity/`; rerun it after the rig or the geometry is rebuilt, otherwise the UI shows length change only.

### Calibration

"Open the calibration tables" in the "Attribution & disclaimer" dialog opens a read-only view of the ten tables under `data/curated/calibration/` (segment proportions, range of motion, humeral angles, muscle attachments and moment arms, organ volumes, expression displacement, coverage of facial controls, and an instrument check). Each table first shows how many rows fall within and outside tolerance, the largest disagreements, and each reference's name, version, licence and URL; rows can be filtered by body and the full table appears on demand. The tables (close to 1 MB together) are separate chunks fetched when the view opens. **They are comparisons with open external models and published statistics used as measuring instruments, not validation by a clinician**; the references are models or population averages themselves, not ground truth, and the tolerances were set by this project.

## Run

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev        # http://localhost:5183
```

The generated anatomy data (`public/anatomy/`) is in the repository, so a fresh clone runs as is.

**The speech-synthesis backend (optional).** `server/` is a FastAPI service (`POST /api/tts`, `GET /api/tts/voices`, `GET /api/health`) that synthesizes one sentence into 24 kHz audio with a phoneme timeline, using the open model Kokoro-82M (v1.0 for English, v1.1-zh for Mandarin, both Apache-2.0). Through the single entry point (idea-loom) it is started on demand and needs no attention. To start it yourself while developing:

```sh
cd server
uv run --extra model python -m soma_tts.fetch --state <state dir>      # first time: download the models (about 0.6 GB, each sha256 verified); not in git
WORLD_SIM_STATE=<state dir> uv run --extra model uvicorn soma_tts.server:app --host 127.0.0.1 --port <port>
cd .. && SOMA_API_PORT=<port> bun run dev                              # the dev server proxies /api to it
```

Without the backend the UI still works: the Expression panel has no text box and says that synthesis needs the local service, while the 12 shipped demo sentences and "choose an audio file" remain; the speech cards use the shipped clips.

### URL parameters

The whole view state lives in the query string, so any view can be opened by one link. Every parameter is optional and absent means the default; invalid values are ignored with a console warning.

| Parameter | Example values | Meaning |
|---|---|---|
| `body` | `male` (default), `female` | Which body |
| `embed` | `1` | Embed mode: stage and essential controls only, no dialogs |
| `tab` | `d`, `t`, `p`, `n`, `e` | Left panel: display, tree, pose, pain, expression |
| `sys` | `ske,ner:60` | Visible systems, each optionally with an opacity percent; unlisted ones are hidden. Codes: `int mus ske cv ner res dig uri rep end lym oth` |
| `peel` | `2` | Peel depth |
| `iso` | `FMA7088,FJ1234` | Isolate: part ids or concept ids (a concept expands to all its parts) |
| `hide` | as `iso` | Hide |
| `sel` | `FMA9611` or `FJ3259,FJ3260` | Selection: one concept id, or several part ids |
| `adj` | `1` | Show adjacent structures |
| `focus` | `1` | Frame the selected (or isolated, or visible) structures on load |
| `cam` | `px,py,pz,tx,ty,tz` | Camera position and target, in metres |
| `cut` | `a620`, `c500f`, `s250` | Section: axis (`a` axial, `c` coronal, `s` sagittal) + position per mille + optional `f` to flip |
| `xp` | `40` | Explode percent |
| `pose` | `squat` or `elbow_L.0:90,elbow_R.0:90` | Pose: a preset name, or `joint.dof:degrees` relative to rest |
| `breath` | `1` | Breathing demonstration |
| `map` | `d`, `n` | Skin map: dermatomes, cutaneous nerve territories |
| `reg` | `14,15` | Highlighted region indices of the skin map |
| `see` | `1` | Draw the skin see-through under a skin map, to reveal the nerves beneath |
| `src` | `1` | Colour by data source |
| `cmp` | `ske` | Compare view and the system it shows |
| `shape` | `h1.80,b28,l0,c0` | Body shape: h stature (m), b BMI, l leg length (SD), c mass distribution (SD); only non-default items are written and values outside the valid range are clamped |
| `stim` | `heat,48,8@forearm_L` | Apply a stimulus: `kind,magnitude,seconds[,xCount/Hz][,held][,heat reading]@site`. Magnitude: mN for pinprick, N for pressure and pinch, °C for heat and cold. Site: `fingertip palm handback forearm cheek shin sole` with `_L`/`_R`, or a rest-pose position in millimetres, `p-182,1034,28` |
| `pain` | `7` | Hold the pain expression at this level (0–10); never plays sound by itself |
| `au` | `4:3,43:5` | Manual facial action units, number:intensity (0–5); combined with `pain` and `expr` by maximum |
| `expr` | `happy`, `fearful:0.6` | Emotion expression: an expression id, optionally with a strength (0–1; 1 when omitted). Ids: `happy sad fearful angry surprised disgusted`, and `happily_surprised happily_disgusted sadly_fearful sadly_angry sadly_surprised sadly_disgusted fearfully_angry fearfully_surprised fearfully_disgusted angrily_surprised angrily_disgusted disgustedly_surprised appalled hatred awed` |
| `vis` | `PBM` | Hold one mouth shape (viseme). Ids: `SIL PBM FV TH TDN L SZ SH KG R W UW OW IY EH AA AX`, and the Mandarin-only `YU ZHCHSH JQX ER HX` |
| `say` | `zh-03` | Say a demo clip: `en-01`…`en-06`, `zh-01`…`zh-06`. The mouth follows the phoneme timeline; without a user gesture it plays silently and the UI shows a “Sound” button. Free text for synthesis never goes into the URL |
| `style` | `normal`, `clear` | Style of speech: normal read speech (calibrated against measurements) or exaggerated. When omitted, held shapes use clear and speech uses normal |
| `skin` | `1` | Opaque-skin view |
| `act` | `len`, `load` | Muscle activity: `len` length change of the lines of action (geometry), `load` activation needed against gravity (an estimate) |
| `load` | `2`, `2L`, `2R` | With `act=load`, the load held in the hand (kg); `L` / `R` one hand, both when omitted |
| `grav` | `supine`, `prone` | With `act=load`, the gravity direction: supine, prone; standing when omitted |
| `renderer` | `webgl` | Force the WebGL2 backend |

Example: `/?body=male&sys=ske,ner&sel=FMA9611&focus=1`. The full definition is in `src/state/urlState.ts`.

## Test

```sh
bunx vitest run    # pipeline, knowledge layer, skin maps, graph queries, display rules
bunx tsc --noEmit
```

The tests on generated data check invariants and anatomical facts: every part appears in exactly one GLB, adjacency is symmetric, the left femur is on the body's left; 18 nerve landmarks (ulnar nerve behind the medial epicondyle, sciatic nerve leaving below piriformis, common fibular nerve round the fibular neck, …); key sensory points lie in their own dermatome; the uterus sits between bladder and rectum.

## Layout

```
src/anatomy/types.ts   data contract: offline tools write it, the UI reads it
src/                   UI (React + three.js WebGPURenderer)
tools/pipeline/        geometry: classification, layers, simplification, adjacency, registration, derived parts, GLB output
tools/knowledge/       names and functional relations, aligned by concept id
tools/skinmaps/        dermatomes and cutaneous-nerve territories
tools/zanatomy/        reading Z-Anatomy and Open3DModel, building the import package
tools/register/        anchor data for the female body
tools/fixture/         synthetic dataset for development
data/curated/          curated data checked into the repository
public/anatomy/        generated runtime data
```

Geometry and knowledge come from separate sources: shape and position only from meshes reconstructed from volume data, or derived from those; names and relations from ontologies, encyclopaedias and open literature. FMA (Foundational Model of Anatomy) ids join the two.

Each part carries a provenance: `scanned` (as in the source), `warped` (moved by non-rigid registration), `curated` (artist-modelled, or derived by this project from neighbouring structures).

## Regenerating the data

Raw data is not in the repository (`data/raw/` is ignored) and must be downloaded first.

```sh
# BodyParts3D 4.0: download the tables and both zips under LATEST/ into data/raw/bodyparts3d/ and extract
#   https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/
bun run pipeline                 # writes public/anatomy/male/
bun run pipeline:female          # writes public/anatomy/female/; needs the male output and the female anchor package (tools/register/run_anchors.sh)
bun tools/knowledge/run.ts       # names and relations; --refresh re-queries Wikidata
bun tools/skinmaps/run.ts male   # skin maps; likewise for female
```

Order matters: the knowledge layer and skin maps read the geometry pipeline's output, and the female body reads the male body's output.

## Sources and licences

Apart from the code, the anatomy data in this directory (`public/anatomy/`, `data/curated/`) is released as a whole under **CC BY-SA 4.0**.

| Source | Used for | Licence |
|---|---|---|
| [BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html) 4.0 | Geometry of the male body (2,220 parts) and both hierarchies | CC BY 4.0 ("BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International"). Note: the dataset's description page says CC BY 4.0 while the headers of the 4.0 OBJ files say CC BY-SA 2.1 Japan; both statements are recorded here, and both permit this project's use |
| [Blender Studio Human Base Meshes](https://www.blender.org/download/demo-files/) v1.4.1 | Separate toes on both skins (an artist-made realistic forefoot, registered to the toe bones and grafted), marked `curated` | CC0 |
| BodyParts3D 3.0 | 79 parts missing from 4.0: lung lobes, abdominal wall muscles, latissimus dorsi, muscles of mastication and facial expression. Registered into place, marked `warped` | CC BY-SA 2.1 JP |
| [Z-Anatomy](https://github.com/Z-Anatomy) | Cranial and trunk nerves, spinal roots, spinal cord, ligaments, fasciae, joint capsules, lymph node groups, thyroid, parotid. Artist-modelled, marked `curated` | CC BY-SA 4.0 ("Z-Anatomy - The libre 3D atlas of anatomy") |
| [AnatomyTool Open3DModel](https://anatomytool.org/open3dmodel) | Limb nerves (right side modelled, left mirrored), cruciate ligaments and menisci. Artist-modelled, marked `curated` | CC BY-SA 4.0 |
| soma (derived) | Subcutaneous fat, visceral pleura, pericardial sac: computed by this project from neighbouring structures, marked `curated` | CC BY-SA 4.0 |
| [Visible Human Project](https://www.nlm.nih.gov/research/visible/visible_human.html) female CT | Skeleton and some organs of the female body, segmented with TotalSegmentator and MOOSE | NLM terms; Courtesy of the U.S. National Library of Medicine |
| [HRA](https://humanatlas.io) female reference organs | Mammary glands, plus uterine artery and vein, mesovarium, suspensory ligament of ovary, uterovesical pouch. Remodelled geometry, marked `curated` | CC BY 4.0 |
| Wu et al. 2015 female pelvic floor ([doi:10.1371/journal.pone.0132226](https://doi.org/10.1371/journal.pone.0132226), correction [10.1371/journal.pone.0140736](https://doi.org/10.1371/journal.pone.0140736)) | The female body's pelvic floor muscles, anal and urethral sphincters, perineal body, clitoris and vestibular bulbs, vagina, uterus, uterine tubes, ovaries and rectum: 51 parts. From another woman's specimen, enlarged and fitted by bone, marked `curated` | CC BY 4.0 |
| [University of Denver Visible Human Female lower extremity](https://doi.org/10.1038/s41597-022-01905-2) | The female body's leg muscles, knee ligaments, articular cartilage and tarsal bones: 100 parts | CC BY 4.0 |
| [FMA](http://si.washington.edu/projects/fma) 5.1.0 | Placement of added parts in the is-a hierarchy | see its release page |
| [Wikidata](https://www.wikidata.org) | Names, functional relations, id crosswalks | CC0 |
| [Wikipedia](https://en.wikipedia.org) muscle infoboxes | Origin, insertion and innervation of some muscles, each with a revision link | CC BY-SA 4.0 |
| ISNCSCI key sensory points, Lee et al. 2008, Gray 1918 | Basis of the skin map definitions (facts only, cited per entry) | see `data/curated/skinmaps/` |

About two thirds of the Chinese names are machine-generated from a term lexicon and have no source; `zhSource` in `names.json` says where each came from, and every entry is `unreviewed`.

### Pain sound pack (non-commercial, separate from the anatomy data)

`public/voice/vivae-pain/` is a **separate collection** under **CC BY-NC 4.0 (non-commercial use only)**. It is not part of the CC BY-SA 4.0 anatomy dataset above and not part of the MIT-licensed code.

- Contents: the 185 physical-pain recordings of the VIVAE corpus (Holz, Larrouy-Maestri, Poeppel, [doi:10.5281/zenodo.4066235](https://doi.org/10.5281/zenodo.4066235)), resampled to 24 kHz, plus a per-clip analysis made by this project. They are vocalisations performed on instruction, not recordings of real pain. Attribution, licence and the list of changes are in `ATTRIBUTION.txt` and `LICENSE.txt` in that directory.
- Use: `src/voice/` loads it at run time and varies the recordings (clip choice, small pitch and time changes, sequences for sustained pain, a male voice derived from the female recordings). Without the directory it falls back to the parametric synthesizer.
- **A build or deployment for commercial use must not include this directory.** Build with `SOMA_COMMERCIAL=1 bunx vite build`: `dist/` then has no `voice/vivae-pain/` (`voice/tts-demo/` allows commercial use and stays), the app uses the parametric voice and the recordings' attribution is not shown. The default build is unchanged (it includes the pack).
- `data/curated/voice/calibration.json` holds only aggregates computed from the corpus, no audio.

### Speech synthesis: models, demo clips and the data behind the mouth shapes

- **The models** are not in git: Kokoro-82M v1.0 (English) and Kokoro-82M-v1.1-zh (Mandarin) by hexgrad, Apache-2.0. Source, pinned commit, the licence clauses as read and the sha256 of every file are in `server/models.json`.
- **The demo clips** in `public/voice/tts-demo/`: 12 **machine-synthesized** sentences with their phoneme timelines, generated with the models above; this project adds no restriction. Attribution and how they were made are in `ATTRIBUTION.txt` and `LICENSE.txt` in that directory. None is a recording of a person.
- **The data behind the mouth shapes**: `data/curated/reference/articulation-summary.json` holds aggregates this project computed from two articulatory corpora (mean incisor opening, lip aperture and coil heights per sound). USC-TIMIT is CC BY 4.0; **MOCHA-TIMIT is for research, educational and individual use only and not for commercial use without permission** — none of its raw data is in the repository, and the values depending on it are marked `calibratedAgainstNonCommercialData` in `visemes.json`.

## Known gaps

The full list is in each body's `cautions`. The main ones:

- Nerves are hand-drawn schematic geometry: calibre is not measured, position after registration is off by about 2 mm (median), more in the lower limb; about a fifth of centreline points were pushed out of bone and muscle bellies.
- Missing nerves: phrenic, cervical plexus, subcostal, splanchnic, autonomic plexuses, laryngeal.
- No parietal pleura, lymphatic vessels, ligamenta flava or cranial meninges; the pericardium is only an envelope of the heart; the descending colon includes the sigmoid; the spinal cord is a procedurally generated surface ending at L2/L3.
- Subcutaneous fat is derived from the space between the skin's inner wall and the deep structures; thickness is quantised to 3 mm.
- The male body now has the lumina of its hollow organs (19 parts with `LUMEN_…` ids): one continuous alimentary lumen from mouth to anus, and the lumina of bladder, ureters, deferent ducts and seminal vesicles. They are **not scanned**: each is derived from the organ's outer surface moved inward by a wall thickness from the literature (or an assumed one); `lumen-filling.bin` beside them holds a per-vertex displacement with filling. Construction: the stretch from the lips to the teeth, the velum (a constructed sheet; the data has no soft palate) and the tail of the anal canal from the lower end of the rectum to the skin. Known limits: the small-bowel lumen holds only about 55–59% of the available space, because the source's bowel pieces overlap; the pharyngeal cavity stops about 20 mm above the oesophagus; the resting shape of the stomach is an assumption; the male part named "Urethra" runs inside the corpus cavernosum part for 12 mm. In a pose a lumen follows its wall by taking the weights at the closest wall point; where the wall's own weights change sharply a few vertices still leave it by some millimetres. The female body does not have lumina yet.
- The male skin is assembled from pieces, each recorded in the data (select the skin to see them): a parametric body surface (Meta MHR, Apache-2.0) fitted to his internals, not his own skin; the penile and scrotal skin of his own scanned skin, with the neck of the scrotum and the perineal raphe (a graft; the blend surface between it and the fitted surface is constructed, and behind the scrotum the roof of the perineum is a few large flat facets); toes from a CC0 realistic body mesh (not his feet; toes 3–5 stretched about 1.3–1.5×; a shallow ring step near the tips of toes 2–5); eyes and mouth are real openings cut into the surface, with lid rims and an oral pouch constructed for them, which are not anatomy. Navel and nipples are low reliefs carried over from his scanned skin and barely visible at this mesh density. The axilla is open from about 45% of the humerus down; above that arm and axillary folds lie together, and 15–27 cm² of skin is covered at the folds, with small steps. The head looks broad and high; eye colours are illustrative. In large poses (90° abduction, 160° flexion, deep squat) the skin still stretches and crumples visibly. The skin package is not in the repository; scripts in `tools/bodyshape/` and `tools/skinopen/` write it to `data/raw/bodyshape/out/`.
- Skin map boundaries are jagged at 1–3 cm. The skin maps are constructed teaching maps; dermatomes vary between people and published maps disagree.
- Expression and mouth shapes: the intensities of the emotion prototypes and the viseme numbers are assumptions; there is no eye rotation and no one-sided action; the tongue has four schematic poses only; beyond half of the widest jaw opening small folds remain at the mouth corners (about 35 mm² at full opening); when the pose panel or a reflex opens the jaw the interface does not yet pass that angle to the mouth shapes (a bilabial then does not close fully); mouth shapes from audio are approximate, labiodentals are not detected, and nothing has been validated systematically on real speech. The eyebrows are a thin shell fitted onto the skin (its inner face 0.5 mm below the surface), and the hair is still a see-through shell.
- The male rest posture was changed twice: the shoulder girdle (the scan is supine with shrugged shoulders; clavicles lowered by about 10°, scapulae turned round the rib cage, glenohumeral centres 338 mm apart, short of the 350 mm target), and both upper limbs abducted 6.5° in the coronal plane so that an axilla exists (keeping the scapula fixed is a modelling choice with no opened source). Muscles and vessels spanning the shoulder changed from `scanned` to `warped`.
- The female body is far coarser than the male:
  - The skeleton is from the Visible Human Female donor (59 years old, obese, six lumbar vertebrae), rescaled to standard proportions at 1.606 m with five lumbar vertebrae, so none of her parts is marked `scanned`. The ankle is still about 16 mm too high; the flexion axes of her two elbows differ by 22.5° (her distal humeri differ), so the forearms do not move symmetrically; foot bones and fingers are corrected male bones.
  - Most soft tissue is male structure registered onto her bones and redistributed toward a standard female body surface; muscles of male origin are kept at or above a sourced female/male volume ratio (Janssen et al. 2000). Upper limbs abducted 7.5°.
  - Leg muscles and knee ligaments are her own (Denver data). 2.0% of nerve length lies inside her muscles, 1.8% of it motor branches ending in muscle and 0.07% unexplained.
  - Pelvic floor, vagina, uterus, adnexa and rectum come from another woman's specimen (Wu et al. 2015). Some interpenetration remains (worst pair 3.8%); there is a 16.6 mm gap between the bladder (her own, empty) and the uterus; of nine pelvic ligaments only three (both uterosacral, right cardinal) were re-fitted by their two ends, the others have no room between the present organs.
  - No vulvar anatomy: the perineal skin is a raised, smooth closed surface. The specimen's skin could not be grafted: the rim of the narrowed patch lies a median 11.6 mm from her present skin (limit 5 mm), and raising the skin to meet it would put the gracilis outside the skin. Also missing: urethral lumen, ovarian and vaginal vessels, autonomic plexuses.
  - Her skin is assembled likewise: a parametric surface of standard female shape (1.606 m, BMI 21.6) relaxed where muscle still lay outside, volume BMI about 23.7; the head follows a face derived from her skull and published soft-tissue depths with cover over bone only, so nine facial muscles lie slightly outside the skin (up to about 2–3 mm). **The face still reads male and older** (wide jaw, thin lips, and the hair and eyebrow parts are male). Eyes and mouth are real openings; toes come from a CC0 mesh, with a shallow ring step near the tips of toes 2–5; the sheets of fascia that showed between the toes and at the root of the thighs are now inside the skin (thin structures outside went from 253 to about 10 cm², the rest at the axillary folds). Breasts are about 334 mL a side (a Chinese reference figure) with the gland parts scaled to about 0.5; the navel is constructed.
  - Her intercostal nerves are warped from the male; the stretch of nerves 7–11 beyond the bony thorax has been re-laid to her own xiphoid and navel (T7 ends just below the xiphoid tip, T10 at the navel; the levels of T8, T9 and T11 are evenly interpolated, not sourced). On the skin maps the umbilicus now lies in T10; the xiphoid is still off (left T5, right T7; textbook T6–T7) and the right T12 dermatome is in two pieces. The model has no subcostal nerve.
  - The right forearm and hand were clipped in the CT and are a mirrored left.

## Next

1. The female face (female hair and eyebrows, jaw, lips); the female vulva; a two-sheet collision solve for the axillae; making thin structures such as nerves and fasciae consistent with the new skins and the separate toes.
2. Soft-tissue physics: tetrahedral meshes, XPBD, validated on one region first.
3. Surgical actions: incision, retraction, bleeding, suturing.
