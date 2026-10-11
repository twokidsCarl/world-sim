# strata

从微观规则到涌现。只模拟最底层的规则，所有更高层级的描述都从微观数据实时算出，并把已知理论叠在实测曲线上，让"More is Different"（Anderson 1972）可以被检验，而不只是被观看。

English version below / 英文版见下文。

## 模拟什么

五个底座，在界面右上角切换：

- **分子动力学**：牛顿定律加一条可编辑的两体势（Mie n–m、Morse、纯排斥），二维或三维周期盒。维度是一个旋钮，标为“改变普适类”：换维度后速率分布的形状、第二维里系数、密堆积的配位数（6 对 12）都随之改变。三维画面可只看中间一片薄层。由粒子数据算出：
  - 微观：能量与动量守恒仪表。CPU 后端另有整数坐标的逐位可逆积分器（Levesque–Verlet）：点“倒放”后一位不差地回到起点，而普通浮点积分器因混沌放大舍入误差回不去。
  - 动理：速率分布对麦克斯韦–玻尔兹曼分布，径向分布函数 g(r) 对低密度极限。
  - 热力学：温度、压强对理论：低密度下是第二维里系数；二维 12-6 势、截断半径不小于 4σ 时，是 Homes 等 (2025) 发表的状态方程加截断修正。
  - 流体：把粒子按网格分箱成密度、流速、温度场（Irving–Kirkwood 构造的最简情形，场的质量和动量与粒子严格相等）。上下热壁加驱动力时，流速剖面对照 Navier–Stokes 的抛物线，并由流量反推粘度。页头的“敲一下”激发盒子里最长的一列驻波，由这个密度模的振荡频率得到声速，对照维里展开到 B₂ 的绝热声速。
  - 两亲分子：把粒子用弹簧串成两到四个珠子的短链，第一个是头，其余是尾；尾与尾相吸，头与任何珠子之间只留对势排斥的那一半（在势阱最低点截断并上移）。没有溶剂粒子。温度够低时分子自己聚成尾朝里、头朝外的小团；右侧给出落单分子的比例、平均聚集数和聚集数的分布。
  - 管道里可以放一个固定的圆盘障碍物，也可以加重力并让下壁比上壁热：前者在流速够大时圆盘背后出现回流和摆动的尾迹，后者在浮力够强时出现 Rayleigh–Bénard 对流卷。流速场和横向流速场用以 0 为中心的蓝–白–红色图画出。
  - 涡量场（由分箱的平均流速差分得到）。
  - 鼠标停在 g(r) 图上时，舞台上以一个粒子为圆心画出对应半径的圆：图上的峰就是圆上挤着的邻居。
  - 长波极限：最长波处的 S(k) 的时间平均，对照涨落–压缩率关系 T/(∂P/∂ρ)（只在已发表状态方程适用时有理论值）。
  - 三维下的 Steinhardt 键取向序 q₆ 及其近邻平均 q̄₆（理想面心立方、六方密堆、体心立方、简单立方、二十面体的值都对上了文献），可按 q̄₆ 给粒子着色，看到晶粒和晶界。
  - 输运系数的第二个来源（仅 CPU 后端）：由均方位移的斜率得自扩散系数，由平衡态切应力涨落的 Green–Kubo 积分得粘度，分别与“方程发现”拟合出的扩散系数和管道流反推的粘度对照。
  - 结构因子 S(k) = |ρ_k|² / N，由密度沿 x 和 y 的傅里叶模得到：理想气体为 1，液体有一个宽峰，晶体在倒格矢处有尖锐的 Bragg 峰。
  - 元：B 粒子从一条带开始扩散时，记录浓度剖面的时间序列，用弱形式稀疏回归（SINDy）在 5 个候选项里拟合它服从的方程，并用发现的方程把最早的剖面推演到现在与实测对照；再用动态模态分解（DMD）独立估计各模态的衰减率。
  - 结构：局域与全局六角序参量 ψ₆，可按它给粒子着色，看到晶粒、晶界和缺陷。
  - 两种粒子：对称的相互作用强度矩阵，异种吸引弱时低温分相。另有“打破作用力与反作用力”旋钮：一旦打开，能量和动量守恒仪表被划掉，速率分布也偏离麦克斯韦分布。
  - 基本常量面板：改精细结构常数和电子/质子质量比，按标度关系换算这盒粒子的真实尺寸、温度、时间，并给出 de Boer 参数作为经典近似是否可信的仪表。
- **Ising 自旋**：近邻与次近邻耦合加外场，四子格 Metropolis 更新。由自旋数据算出：维度是一个旋钮，标为“改变普适类”：三维用奇偶两个子格更新、2×2×2 的块自旋，画正中间的一个截面。
  - 热力学：磁化强度与能量对 Onsager–Yang 精确解。
  - 元：块自旋多数表决的重整化金字塔，以及磁化强度和近邻关联随尺度的流向；Binder 累积量（临界点上与晶格大小无关）。另有实验性的“有效信息随尺度的变化”：每一层把格点的局部状态取为（自旋，四邻之和），统计一次扫描前后的转移，算出有效信息。
  - 测试里用 Wolff 团簇更新定量检验临界行为：不同大小晶格的 Binder 曲线在精确的 Tc 相交，Tc 处磁化强度按 L^(−1/8) 衰减；加上次近邻耦合后 Tc 移动四成，交点处的累积量不变。三维同样检验：Binder 曲线交于 4.504（文献 4.5115），临界点磁化强度的指数 −0.510（文献约 −0.518，二维是 −0.125）。

- **Potts 模型**：二维正方晶格，每个格点取 q 种状态之一（q 从 2 到 8），相邻两格同态时能量降低 1；奇偶两个子格 Metropolis 更新，GPU 与 CPU 逐位一致。状态数 q 是标为“改变普适类”的旋钮；温度旋钮以该 q 的相变温度 Tc = 1/ln(1 + √q) 为单位。
  - 热力学：能量、序参量、各状态所占的比例。相变点上能量有严格值：q ≤ 4 时是 −(1 + 1/√q)；q > 4 时相变是一级的，有序相和无序相各有一个能量，相差一份潜热（Baxter 的公式，q = 8 时是 0.486）。
  - 元：2×2 相对多数粗粒化的金字塔，序参量和同态近邻比例随尺度的流向；Binder 累积量。
  - 测试：q = 2 时能量对 Ising 的 Onsager 精确解（温度加倍）；q = 3 在相变点上，能量随晶格增大趋近严格值（L = 64 时差 0.018），序参量按 L^(−2/15) 衰减（L = 16、32、64，实测指数与 2/15 相差不到 0.015；Ising 是 1/8）；q = 8 在相变点上从有序和无序出发分别停在两个能量上，与严格值各差不到 0.04。

- **引力 N 体**：三维软化牛顿引力，直接对所有天体对求和，蛙跳积分。这是独立场景，不与分子动力学共用一个盒子。由天体数据算出：
  - 微观：能量与动量守恒。
  - 热力学：束缚部分的位力比 2K / |Σ m x·a| 对位力定理的 1。
  - 结构：束缚比例、半质量半径、径向密度（Plummer 初始状态下对 Plummer 模型）。径向量都以势阱最深处为中心。

- **引力成团（粒子网格法）**：周期盒子里最多二十六万个等质量粒子，只受引力。密度用云在格中（CIC）分配到网格上，快速傅里叶变换解泊松方程，势的中心差分给出加速度，再插值回粒子；蛙跳积分。均匀背景被减掉，只有密度的涨落产生引力。引力常数 G 是标为“仅改变数值”的旋钮：它只改变时间的尺度。由粒子数据算出：
  - 微观：动量守恒；能量的相对变化（从纯增长模出发时总能量为零）。
  - 流体：沿 x 的基频密度模的幅度，对一个平面波在壳层交叉之前的 Zel’dovich 严格解 2 J₁(A₀ e^{γt})，γ = √(4πG)；网格上密度涨落的均方根，随机初始条件下对线性理论 e^{γt}。
  - 结构：最高密度与平均密度之比。
  - 测试：三维 FFT 对直接傅里叶求和；单个密度波的加速度对解析值乘上网格的已知折扣；两个粒子在几个格距外的引力对平方反比律（6% 以内）；平面波的增长率实测 3.527，√(4π) = 3.545（计入网格折扣后是 3.522），到壳层交叉时刻的九成为止与 Zel’dovich 解相差不超过 1.1%。

分子动力学的舞台上可以拖出一个矩形选区（三维要先把视角切到“正视”）：温度、速率分布、g(r)、六角序、配位数会同时画出选区内的取值（橙色线），用来比较晶粒内部与晶界、液滴与蒸气。在舞台上单击清除选区。

每个可调参数都带标签，说明它是改变普适类、仅改变数值、状态变量还是数值方法。每个带理论的量旁边实时标出“吻合”或“偏离”。

页面底部有引导实验（一头亲水一头疏水的分子自己聚成小团、一个密度波自己塌成一张薄片、几乎均匀的物质自己长出丝和团块、Potts 模型多一种状态相变就从连续变成不连续、同一个 Ising 模型换一个维度、三维过冷液体里等一个晶核、流过圆盘、圆盘尾迹的脱落频率、从下面加热出现对流卷、对流从多强的重力开始、敲一下量声速、同一条势换一个维度、把时间倒过来、冷却液体直到结晶、粒子在管道里流成抛物线、三维里的管道流、让机器从粒子数据里发现扩散方程、冷的天体团坍缩后自己找到平衡、Ising 淬火穿过临界温度）：每一步改参数、运行一段，再用实测值检验一句预期。也可以用 `/?scenario=micelles`、`/?scenario=pancake`、`/?scenario=web`、`/?scenario=pottsOrder`、`/?scenario=isingDimension`、`/?scenario=nucleation`、`/?scenario=wake`、`/?scenario=shedding`、`/?scenario=convection`、`/?scenario=convectionOnset`、`/?scenario=sound`、`/?scenario=dimension`、`/?scenario=reverse`、`/?scenario=freeze`、`/?scenario=poiseuille`、`/?scenario=poiseuille3d`、`/?scenario=diffusion`、`/?scenario=collapse` 或 `/?scenario=quench` 直接启动，结果写入 `window.__strataScenario`。

地址栏还可以直接选底座和旋钮取值：`?substrate=md|ising|potts|gravity|mesh`，其余与旋钮同名的参数设置该旋钮（超出范围的值被截到范围内），例如 `/?substrate=ising&dim=3&T=4.51`、`/?substrate=md&fractionB=0.5&epsAB=0.3&temperature=0.6&thermostat=1`。有 `?scenario=` 时这些参数被忽略。加上 `?embed=1` 只留舞台、暂停与重置，以及正在播放的引导实验，供 world-sim 的统一入口（idea-loom）把它嵌进卡片；卡片列表在 `sim.json`。页面看不见时模拟循环停下，回来再继续。没有 WebGPU 时落到 CPU 参考实现，并在画面上说明；在跨源的 iframe 里实测 WebGPU 可用（`localhost` 的页面嵌 `strata.localhost`）。

## 运行

需要 [Bun](https://bun.sh)。WebGPU 可用时自动使用 GPU 后端（Chrome 113 以上），否则退回 CPU 参考实现。

```sh
bun install
bun run dev        # http://localhost:5188
```

页头最右的按钮在“跟随系统 / 浅色 / 深色”之间切换配色。`/?bench` 会依次跑四种负载（二维 10 万粒子、三维 13 万粒子、Ising 1024²、引力 16384 个天体）并报告各自的帧率，结果存入 `window.__strataBench` 和 localStorage；它只在标签页处于前台时计时。加上 `?perf` 会在右下角显示帧率、帧间隔、主线程耗时、每秒步数和 GPU 每批耗时（来自 timestamp query），同样的数字写入 `window.__strataPerf`；页面在后台时浏览器会降帧，读数会标为无效。

## 测试

```sh
bun run test       # CPU 参考实现的解析与统计测试
bun run typecheck
```

GPU 内核没有独立的单元测试，而是逐个对照 f64 的 CPU 参考实现。启动开发服务器后打开 `http://localhost:5188/?harness`，结果同时写入 `window.__strataHarness`。

## 结构

```
src/core/         底座、派生量、调度器的接口；计数器式随机数
src/substrates/   md/、ising/、potts/、gravity/ 与 mesh/：参数表、CPU 参考实现（ref）、WGSL 内核、后端
src/levels/       每个底座的层级阶梯：派生量及其理论对照，以及基于时间序列的分析
src/analysis/     小型线性代数、DMD、弱形式 SINDy
src/theory/       麦克斯韦分布、维里系数、Onsager 精确解、Plummer 模型、Potts 模型的严格结果、Jeans 增长率与 Zel’dovich 解、常量到单位的标度关系
src/scenarios/    引导实验（数据）
src/render/       WebGPU 粒子与晶格渲染
src/plot/         Canvas2D 绘图
src/harness/      GPU 与 CPU 交叉校验
tests/            analytic/（解析）与 slow/（统计）
```

CPU 参考实现先写，是规范；WGSL 内核是它的优化，并用同一份势表、同一个整数哈希。

## 已知边界

- 分子动力学最多两种粒子，粒子之间没有化学键（所以只有分相，没有胶束和膜）。
- 三维下有壁面（垂直于 y 的两面热壁，x 和 z 周期）、驱动力和两壁温差，但没有重力、圆盘障碍物、条带初始分布和六角序参量。场和剖面是沿 z 平均的；剖面里的温度只用 x、y 两个速度分量。三维的选区要先把视角切到“正视”再拖，它是那个矩形沿 z 贯穿整个盒子的柱体；选区里的 g(r) 和全体一样只算到一个元胞宽。引导实验里五万五千个粒子、管宽 43σ、ρ = 0.7：流速剖面与抛物线吻合，由流量反推的粘度约 1.07（T ≈ 1.31，没有恒温器，流动还在缓慢加速），没有独立的对照。配位数分不清稠密液体和晶体（过冷液体约 11.3，结晶后 11.6），判别晶体用近邻平均的 Steinhardt q̄₆，阈值取 0.3（液体约 0.18，完美面心立方 0.575）；它不区分面心立方、六方密堆和体心立方。三维的 g(r) 只算到一个元胞宽（约 2.5 到 3σ）。
- 三维结晶是均匀成核，何时出现晶核是随机的。一次实测（16384 个粒子，ρ = 0.95，从 2.5 淬火到 0.5）：晶体比例在约 1.5 万步内停在 0.03 到 0.06，之后上升，8 万步时到 0.92。别的随机种子下潜伏期可能长得多，引导实验的最后一步因此可能不通过。
- 输运系数的独立对照只在 CPU 后端（“计算后端”选 CPU 参考）。自扩散系数：ρ = 0.6、T = 2 时由均方位移得 0.505，“方程发现”在 GPU 上另一套粒子数下拟合出 0.47 到 0.53。粘度：ρ = 0.7、T = 1 时 Green–Kubo 积分累计 300 个时间单位后在 1.6 到 1.9（随积分上限变化），管道流由流量反推的是 1.4 到 1.5，两者相差一到三成。Green–Kubo 收敛很慢：只用 60 个时间单位时，九次估计从 1.0 到 2.6 不等。二维的输运系数本来就随时间和盒子大小对数增长，不是严格的常数。
- 帧率只在一台机器上量过（Apple M4 Max，Chrome 154，120 Hz 屏幕，`/?bench`，前台标签页）：四种负载都是每秒 120 帧，帧间隔中位 8.3 ms、95% 分位 9.2 到 9.3 ms，主线程每帧 0.7 到 1.0 ms。GPU 每批耗时：二维 10 万粒子 2.4 ms（8 步），三维 13 万粒子 10.5 ms（8 步），Ising 1024² 0.9 ms（8 步），引力 16384 个天体 4.2 ms（1 步）。三维那一项略超 10 ms 的预算，也超过 120 Hz 下的一帧：上一批没算完时引擎不再提交新的一批，所以画面仍是 120 帧，模拟推进降到每秒 635 步（其余两个八步的负载是 960 到 980）。渲染耗时没有单独量，只知道它没有把帧间隔撑大。别的显卡上没有数据。
- 两亲分子是一个粗粒化的隐式溶剂模型，只做了二维、周期边界：溶剂的作用折算成“尾相吸、头只排斥”两条规则，弹簧的劲度系数（100）和平衡长度（1σ）是定死的；成键的珠子之间还有对势的排斥，所以平均键长约 1.1σ。聚集体没有理论线。引导实验里（三珠分子、ρ = 0.15、ε_尾尾 = 3）：T = 3 时 62% 的分子落单，T = 0.7 时落单的不到 1%，平均聚集数约 10（两次运行 10.2 和 10.6），四万步之内还在缓慢增大，没有验证它是否已到平衡，也没有测临界胶束浓度。聚集体的统计在 GPU 后端上要回读全部位置。只有胶束，没有做膜（二维里的“双层”只是一条带子）。
- 绕流和对流都是定性验收，没有逐点的理论线。绕流：十一万多个粒子、圆盘直径 60σ、流速约为声速的一半（可压缩），圆盘背风面的时间平均流速为 −0.17 ± 0.03（来流 1.23），下游尾迹周期性地左右摆动：圆盘后三个半径处的横向流速振荡的频率在两次运行里是 f = 0.0065 和 0.0070（周期 154 和 143），正弦拟合解释了 92% 和 96% 的起伏，斯特劳哈尔数 St = fD/U = 0.34 和 0.38（U = 1.15 和 1.10 是管道的平均流速；按圆盘两侧缝隙里的流速算约为 0.25 到 0.29）。两次运行的长度不同（26 万步和 37 万步），流速还在缓慢下降。管道只有四个直径宽、流动可压缩、没有恒温器时流体被粘性加热到 T ≈ 1.7，这个值不必等于无界不可压流动的约 0.2；流速减半时（雷诺数约二十）没有显著回流。对流：下壁温度是上壁的十倍，重力 0.06 时竖直流速的起伏是热噪声的五倍，出现约四对对流卷；重力 0.02 时约为 1.5 倍，没有清晰的卷。对重力分六档扫描（0.01 到 0.06），对流强度在两次运行里依次为 0.12、0.12、0.18、0.31、0.48、0.66 和 0.11、0.11、0.22、0.45、0.67、0.57（热噪声估计 0.07 到 0.10）：两次都是重力 0.02 及以下停在噪声水平、0.03 起抬头，所以起始点在 0.02 与 0.03 之间；起始点以上两次相差可达 0.15（每档只跑三四万步，对流卷还没有完全稳定），增长的函数形式定不下来。对应的瑞利数只能给量级：层厚 156σ、α ΔT ≈ 1.6，粘度和热扩散率在这个状态（ρ = 0.3、T ≈ 5 的气体）没有测量，用动理论估计（ν ≈ 3、κ ≈ 4，可能差好几倍），得 Ra 约 10⁴，与教科书上刚性壁面的 1708 同一量级到高一个量级。温差是平均温度的一倍多，远在 Boussinesq 近似之外，不该指望两者相等。
- “温度 T”只算相对于质心的运动，整体平移的动能不计入；但有剪切的流动（管道流）里，各层流速不同，这部分仍算在内，读数略偏高，局域的温度看流体层的温度剖面。
- 场的回读在管道几何下约 180KB（192×48 格），超过了最初自定的 64KB。实测每次归约因此多花约 0.2 毫秒（11.6 万粒子，每秒归约约十次），所以保留了这个分辨率。
- 压强与已发表状态方程的对照只适用于二维、单组分的 12-6 势，且截断半径不小于 4σ（默认是 2.5σ，此时只画低密度的维里线）。截断修正是平均场估计。
- 声速只在稀薄气体里做了对照（维里展开到 B₂ 的绝热声速）；稠密流体没有独立的理论值可比。波长必须远大于平均自由程才算声波，这需要足够大的盒子（密度 0.15、1840 个粒子的方盒子就不够）。结构因子只沿 x 和 y 取样，大盒子里每隔几个波矢取一个，尖锐的 Bragg 峰可能落在取样点之间。
- 基本常量面板只做标度换算，以氩为基准；它不改变约化单位下的动力学。
- 压强的理论线只展开到第二维里系数，仅在低密度有效；稠密时与实测不符是预期的。
- 临界点附近 Metropolis 更新平衡极慢，大晶格可能长时间达不到平衡；界面上实时的 Binder 累积量因此只在小晶格上可信。Wolff 更新只用于测试，不是被模拟的动力学。
- 有效信息是实验性的：数值依赖局部状态的取法，而且各层用的是同一个时间步（一次扫描），粗的层本来就变得慢，这本身会抬高它的读数。它没有理论值可对照。实测（512²）：临界温度下从 0.60 升到 2.08 比特，T = 3.5 时在 0.1 到 0.4 之间，T = 1.5 时趋于 0。
- Potts 模型只有二维、只有最近邻耦合、没有外场。相变点附近 Metropolis 更新平衡极慢：引导实验里 q = 3、L = 256 跑八万次扫描后，两种出发点的能量是 −1.569 和 −1.588（严格值 −1.577），还在涨落；q = 4 有对数修正，序参量的实测指数是 −0.10（L = 16 到 128），与 1/8 差两成，没有写成断言。q > 4 时两相在相变点上的共存是亚稳的：小晶格（128 以下）会在两相之间跳，引导实验因此用 512。序参量取的是“占比最大的状态”，不是按状态分量定义的矢量序参量。
- 三维 Ising 只有最近邻耦合，没有次近邻耦合，也没有“有效信息”那张卡片；它没有精确解，磁化强度和能量不画理论线，临界温度与指数取文献里的数值结果。测试用的晶格很小（8 到 32），Binder 交点处的累积量是 0.490，比文献的大晶格值 0.465 高，这是小晶格的修正。
- 方程发现只做了扩散这一种情形。SINDy 的稀疏阈值取 0.2（分箱的粒子数据每箱有百分之几的噪声，取 0.1 会留下拟合噪声的小项）；浓度趋于均匀后信号被噪声淹没，拟合会失效。DMD 的衰减率与扩散方程的预言只在量级上吻合，而且随记录长度变化很大：一次运行里，两个最慢模态与预言之比在 1.2 万步时是 3.5 和 1.4，到 4 万步时是 0.99 和 1.42。试过前向–后向 DMD：在加了噪声的合成数据上它把最慢衰减率的平均误差从 264% 降到 81%，但在真实粒子数据上并不更准（4 万步时 0.86 和 1.62）。可见主要误差不是噪声带来的偏差，而是初始台阶里高阶模混进了前几个模态。界面仍用标准 DMD。
- 粒子网格法的力在两三个格距以下被抹平，比这更小的结构不可信；最高密度的读数因此受网格限制（平面波塌成的薄片实测只有平均密度的 6 到 8 倍，而理论上那里是发散的）。背景是静态的（没有宇宙膨胀），所以增长是指数的而不是幂律的，长出的丝和团块只是定性的图像，不能和观测的星系分布比。粒子从规则格点出发，薄片里能看见格点留下的条纹。能量只是近似守恒（引导实验里漂移约 0.5%）。随机初始条件只含波数不超过 4 的模。GPU 上分配用定点整数，与 CPU 参考实现在舍入上有差别（初始加速度相差不到 0.2%）。
- 引力是 O(N²) 直接求和，最多 16384 个天体；没有气体、辐射和核反应，所以只有无碰撞的坍缩与弛豫，没有恒星。
- 冷坍缩后“全体的 2K/|U|”不会回到 1：约两成天体被抛出带走动能，而且软化势下 |U| 不等于力的位力。位力定理的检验只对束缚部分、用力的位力来做。
- 逐位可逆积分器只在 CPU 后端，不支持恒温器、壁面和驱动力；GPU 后端的“倒放”只是把速度反号，回不到起点。
- GPU 后端用 f32：能量仪表有约 1e-4 ε 每粒子的噪声底。

## 数据来源

没有外部数据。理论对照来自公开文献：Onsager (1944)、Yang (1952)、Kadanoff (1966)、Verlet (1967)、Irving & Kirkwood (1950)。

---

# strata (English)

From microscopic rules to emergence. Only the lowest-level rules are simulated; every higher-level description is computed in real time from the microscopic data, and the known theory is overlaid on the measured curves, so that "More is Different" (Anderson 1972) can be tested, not just watched.

## What is simulated

Five substrates, switched at the top right of the interface:

- **Molecular dynamics**: Newton's laws plus an editable pair potential (Mie n–m, Morse, purely repulsive), in a 2D or 3D periodic box. The dimension is a knob, labelled "changes the universality class": on changing the dimension, the shape of the speed distribution, the second virial coefficient and the coordination number of close packing (6 versus 12) all change with it. The 3D view can be restricted to a thin slice through the middle. Computed from the particle data:
  - Microscopic: energy and momentum conservation gauges. The CPU backend additionally has a bit-reversible integrator on integer coordinates (Levesque–Verlet): after clicking "play backwards" it returns to the starting point bit for bit, whereas the ordinary floating-point integrator cannot get back, because chaos amplifies the rounding error.
  - Kinetic: the speed distribution against the Maxwell–Boltzmann distribution, and the radial distribution function g(r) against its low-density limit.
  - Thermodynamic: temperature, and pressure against theory: the second virial coefficient at low density, and, for the 2D 12-6 potential with a cutoff of at least 4 σ, the published equation of state of Homes et al. (2025) plus a cutoff correction.
  - Hydrodynamic: the particles are binned on a grid into density, flow-velocity and temperature fields (the simplest case of the Irving–Kirkwood construction; the mass and momentum of the fields are exactly equal to those of the particles). With hot walls at top and bottom and a driving force, the flow-velocity profile is compared with the Navier–Stokes parabola, and the viscosity is inferred from the flow rate. A "knock" button launches the longest standing wave in the box; the oscillation frequency of that density mode gives the speed of sound, compared with the adiabatic sound speed of the virial expansion to B₂.
  - Amphiphiles: particles joined by springs into short chains of two to four beads, the first a head and the rest tails; tails attract each other, while a head keeps only the repulsive half of the pair potential with any bead (cut at the bottom of the well and shifted up). There are no solvent particles. When cold enough the molecules gather by themselves into small clusters with tails inside and heads outside; the cards give the fraction of single molecules, the mean aggregation number and the distribution of aggregation numbers.
  - A fixed disc obstacle can be placed in the channel, and gravity can be added with the lower wall hotter than the upper one: with the former, at high enough flow speed, backflow and a swaying wake appear behind the disc; with the latter, when buoyancy is strong enough, Rayleigh–Bénard convection rolls appear. The flow-velocity and cross-flow fields are drawn with a blue–white–red map centred on 0.
  - The vorticity field (by differencing the binned mean velocity).
  - While the pointer is over the g(r) plot, a circle of that radius is drawn on the stage around one particle: a peak in the plot is the neighbours crowding on the circle.
  - Long-wavelength limit: the time average of S(k) at the longest wave, against the fluctuation–compressibility relation T/(∂P/∂ρ) (a theoretical value exists only where the published equation of state applies).
  - In 3D, the Steinhardt bond-orientational order q₆ and its neighbour average q̄₆ (the values for ideal fcc, hcp, bcc, simple cubic and the icosahedron all match the literature); particles can be coloured by q̄₆ to show grains and grain boundaries.
  - A second source for transport coefficients (CPU backend only): the self-diffusion coefficient from the slope of the mean-square displacement, and the viscosity from the Green–Kubo integral of equilibrium shear-stress fluctuations, to compare with the diffusion coefficient fitted by equation discovery and with the viscosity inferred from channel flow.
  - Structure factor S(k) = |ρ_k|² / N from the Fourier modes of the density along x and y: 1 for an ideal gas, a broad peak for a liquid, sharp Bragg peaks for a crystal.
  - Meta: when the B particles start diffusing from a stripe, the time series of the concentration profile is recorded, and weak-form sparse regression (SINDy) fits the equation it obeys among 5 candidate terms; the discovered equation is then used to evolve the earliest profile to the present for comparison with the measurement. Dynamic mode decomposition (DMD) is then used to estimate the decay rate of each mode independently.
  - Structure: the local and global hexatic order parameter ψ₆; particles can be coloured by it, showing grains, grain boundaries and defects.
  - Two species: a symmetric matrix of interaction strengths; when the unlike-species attraction is weak, the system phase-separates at low temperature. There is also a "break action and reaction" knob: once it is turned on, the energy and momentum conservation gauges are struck out, and the speed distribution also deviates from the Maxwell distribution.
  - Fundamental constants panel: change the fine-structure constant and the electron/proton mass ratio, convert the real size, temperature and time of this box of particles by scaling relations, and get the de Boer parameter as a gauge of whether the classical approximation can be trusted.
- **Ising spins**: nearest-neighbour and next-nearest-neighbour couplings plus an external field, with four-sublattice Metropolis updates. Computed from the spin data: The dimension is a knob, tagged "changes the universality class": in 3D the update runs on the two parity sublattices, block spins are 2×2×2, and the middle slice is drawn.
  - Thermodynamic: magnetization and energy against the exact Onsager–Yang solution.
  - Meta: the renormalization pyramid of block spins by majority vote, and the flow of the magnetization and the nearest-neighbour correlation with scale; the Binder cumulant (independent of lattice size at the critical point). There is also an experimental "effective information against scale": at each level the local state of a site is taken to be (spin, sum of its four neighbours), transitions across one sweep are counted, and the effective information is computed from them.
  - In the tests, Wolff cluster updates are used to check the critical behaviour quantitatively: the Binder curves of lattices of different sizes cross at the exact Tc, and at Tc the magnetization decays as L^(−1/8); with a next-nearest-neighbour coupling added, Tc shifts by forty percent while the cumulant at the crossing is unchanged. The same is checked in 3D: the Binder curves cross at 4.504 (literature 4.5115), and the magnetisation exponent at the critical point is −0.510 (literature about −0.518; in 2D it is −0.125).

- **Potts model**: a 2D square lattice where each site takes one of q states (q from 2 to 8) and the energy drops by 1 for each pair of neighbours in the same state; Metropolis updates on two interleaved sublattices, bit-for-bit identical on GPU and CPU. The number of states q is a knob tagged "changes the universality class"; the temperature knob is in units of that q's transition temperature Tc = 1/ln(1 + √q).
  - Thermodynamic: energy, order parameter, and the fraction of sites in each state. At the transition the energy has an exact value: −(1 + 1/√q) for q ≤ 4; for q > 4 the transition is first order, and the ordered and disordered phases each have their own energy, a latent heat apart (Baxter's formula; 0.486 for q = 8).
  - Meta: the pyramid of 2×2 plurality coarsenings, and the flow of the order parameter and the like-neighbour fraction with scale; the Binder cumulant.
  - Tests: at q = 2 the energy against Onsager's exact Ising solution (at twice the temperature); at q = 3 on the transition, the energy approaches the exact value as the lattice grows (0.018 away at L = 64) and the order parameter decays as L^(−2/15) (L = 16, 32, 64; the measured exponent is within 0.015 of 2/15; Ising has 1/8); at q = 8 on the transition, ordered and disordered starts settle at two energies, each within 0.04 of its exact value.

- **Gravitational N-body**: 3D softened Newtonian gravity, direct summation over all pairs of bodies, leapfrog integration. This is a separate scene; it does not share a box with the molecular dynamics. Computed from the body data:
  - Microscopic: energy and momentum conservation.
  - Thermodynamic: the virial ratio 2K / |Σ m x·a| of the bound part against the value 1 of the virial theorem.
  - Structure: bound fraction, half-mass radius, radial density (against the Plummer model when the initial state is Plummer). All radial quantities are centred on the deepest point of the potential well.

- **Gravitational clustering (particle mesh)**: up to 260,000 equal-mass particles in a periodic box, under gravity alone. The density is deposited on a grid by cloud-in-cell (CIC), Poisson's equation is solved by fast Fourier transform, accelerations come from central differences of the potential and are interpolated back to the particles; leapfrog integration. The uniform background is subtracted, so only density fluctuations gravitate. The gravitational constant G is a knob tagged "changes values only": it only sets the time scale. Computed from the particle data:
  - Micro: momentum conservation; the relative change in energy (the total energy is zero when starting in the pure growing mode).
  - Fluid: the amplitude of the fundamental density mode along x, against the exact Zel'dovich solution 2 J₁(A₀ e^{γt}) for one plane wave before shell crossing, γ = √(4πG); the rms density contrast on the grid, against linear theory e^{γt} for random initial conditions.
  - Structure: the ratio of the highest density to the mean.
  - Tests: the 3D FFT against a direct Fourier sum; the acceleration of a single density wave against its analytic value times the known mesh factor; the attraction of two particles several cells apart against the inverse-square law (within 6%); a plane wave's measured growth rate of 3.527 against √(4π) = 3.545 (3.522 once the mesh factor is included), staying within 1.1% of the Zel'dovich solution up to nine tenths of the shell-crossing time.

On the molecular dynamics stage you can drag a rectangle (in 3D, switch the view to "front" first) to select a region: temperature, the speed distribution, g(r), hexatic order and the coordination number are then also drawn for the particles inside it (orange lines), to compare the inside of a grain with a grain boundary, or a droplet with its vapour. Click on the stage to clear the region.

Every adjustable parameter carries a label saying whether it changes the universality class, only changes numerical values, is a state variable, or is a numerical method. Next to every quantity that has a theory, "agrees" or "deviates" is shown in real time.

At the bottom of the page there are guided experiments (molecules with a water-loving head and water-hating tails gathering into small clusters by themselves, a density wave collapsing into a sheet by itself, nearly uniform matter growing filaments and clumps by itself, a Potts model whose transition turns from continuous to discontinuous with more states, the same Ising model in a different dimension, waiting for a nucleus in a supercooled 3D liquid, flow past a disc, the shedding frequency of the disc's wake, heating from below until convection rolls appear, how strong gravity must be for convection to start, knocking the gas to measure the speed of sound, the same potential in a different dimension, running time backwards, cooling a liquid until it crystallizes, particles flowing in a channel with a parabolic profile, the same channel flow in 3D, letting the machine discover the diffusion equation from particle data, a cold cluster of bodies collapsing and then finding equilibrium by itself, an Ising quench through the critical temperature): each step changes parameters, runs for a while, and then tests a one-sentence expectation against the measured value. They can also be started directly with `/?scenario=micelles`, `/?scenario=pancake`, `/?scenario=web`, `/?scenario=pottsOrder`, `/?scenario=isingDimension`, `/?scenario=nucleation`, `/?scenario=wake`, `/?scenario=shedding`, `/?scenario=convection`, `/?scenario=convectionOnset`, `/?scenario=sound`, `/?scenario=dimension`, `/?scenario=reverse`, `/?scenario=freeze`, `/?scenario=poiseuille`, `/?scenario=poiseuille3d`, `/?scenario=diffusion`, `/?scenario=collapse` or `/?scenario=quench`; the result is written to `window.__strataScenario`.

The address bar can also pick the substrate and knob values directly: `?substrate=md|ising|potts|gravity|mesh`, and any other parameter named after a knob sets that knob (values outside its range are clamped), e.g. `/?substrate=ising&dim=3&T=4.51` or `/?substrate=md&fractionB=0.5&epsAB=0.3&temperature=0.6&thermostat=1`. These are ignored when `?scenario=` is present. Adding `?embed=1` leaves only the stage, pause and reset, and the guided experiment being played, so that world-sim's single entry point (idea-loom) can embed it in a card; the card list is in `sim.json`. The simulation loop stops while the page is hidden and resumes on return. Without WebGPU the CPU reference implementation runs instead and the page says so; WebGPU was measured to work inside a cross-origin iframe (a `localhost` page embedding `strata.localhost`).

## Running

Requires [Bun](https://bun.sh). When WebGPU is available the GPU backend is used automatically (Chrome 113 and later); otherwise it falls back to the CPU reference implementation.

```sh
bun install
bun run dev        # http://localhost:5188
```

The rightmost button in the page header switches the colour scheme between "follow system / light / dark". `/?bench` runs four loads in turn (2D with 100,000 particles, 3D with 130,000, Ising 1024², gravity with 16,384 bodies) and reports the frame rate of each; results are stored in `window.__strataBench` and localStorage. Its clock runs only while the tab is in the foreground. Adding `?perf` shows, at the bottom right, the frame rate, frame interval, main-thread time, steps per second and GPU time per batch (from timestamp queries); the same numbers are written to `window.__strataPerf`. When the page is in the background the browser lowers the frame rate, and the readings are marked as invalid.

## Tests

```sh
bun run test       # analytic and statistical tests of the CPU reference implementation
bun run typecheck
```

The GPU kernels have no separate unit tests; instead each one is checked against the f64 CPU reference implementation. After starting the dev server, open `http://localhost:5188/?harness`; the results are also written to `window.__strataHarness`.

## Structure

```
src/core/         interfaces of substrates, derived quantities and the scheduler; counter-based random numbers
src/substrates/   md/, ising/, potts/, gravity/ and mesh/: parameter tables, CPU reference implementation (ref), WGSL kernels, backends
src/levels/       the ladder of levels of each substrate: derived quantities and their theory comparisons, and analyses based on time series
src/analysis/     small linear algebra, DMD, weak-form SINDy
src/theory/       Maxwell distribution, virial coefficients, Onsager exact solution, Plummer model, exact Potts results, the Jeans growth rate and Zel'dovich solution, scaling relations from constants to units
src/scenarios/    guided experiments (data)
src/render/       WebGPU particle and lattice rendering
src/plot/         Canvas2D plotting
src/harness/      GPU versus CPU cross-check
tests/            analytic/ (analytic) and slow/ (statistical)
```

The CPU reference implementation is written first and is the specification; the WGSL kernels are an optimization of it, and use the same potential table and the same integer hash.

## Known limits

- Molecular dynamics has at most two species, and there are no chemical bonds between particles (so there is only phase separation, no micelles or membranes).
- In 3D there are walls (two thermal walls normal to y, with x and z periodic), a driving force and a wall temperature difference, but no gravity, disc obstacle, stripe initial distribution or hexatic order parameter. Fields and profiles are averaged along z; the temperature in the profiles uses only the x and y velocity components. To select a region in 3D, switch the view to "front" first and then drag; the region is that rectangle extruded through the whole box along z, and its g(r), like the whole system's, reaches only one cell width. In the guided experiment, with 55,000 particles, a channel 43 σ wide and ρ = 0.7, the velocity profile matches the parabola and the viscosity inferred from the flow rate is about 1.07 (T ≈ 1.31; there is no thermostat and the flow is still slowly accelerating), with nothing independent to compare it against. The coordination number cannot tell a dense liquid from a crystal (about 11.3 in the supercooled liquid, 11.6 after crystallising); crystals are identified by the neighbour-averaged Steinhardt q̄₆ with a threshold of 0.3 (about 0.18 in the liquid, 0.575 for perfect fcc). It does not distinguish fcc, hcp and bcc. In 3D g(r) is computed out to one cell width only (about 2.5 to 3 σ).
- Crystallisation in 3D is by homogeneous nucleation, and when a nucleus appears is random. One measured run (16,384 particles, ρ = 0.95, quenched from 2.5 to 0.5): the crystalline fraction stayed between 0.03 and 0.06 for about 15,000 steps, then rose, reaching 0.92 at 80,000 steps. With other random seeds the incubation may be much longer, so the last step of the guided experiment may then fail.
- The independent check of transport coefficients exists on the CPU backend only (choose "CPU reference" under "compute backend"). Self-diffusion: at ρ = 0.6, T = 2 the mean-square displacement gives 0.505, while equation discovery fitted 0.47 to 0.53 on the GPU with a different number of particles. Viscosity: at ρ = 0.7, T = 1 the Green–Kubo integral, accumulated over 300 time units, lies between 1.6 and 1.9 depending on the upper limit of integration; the value inferred from the flow rate in channel flow is 1.4 to 1.5, so the two differ by ten to thirty percent. Green–Kubo converges slowly: with only 60 time units, nine estimates ranged from 1.0 to 2.6. In 2D, transport coefficients grow logarithmically with time and box size anyway and are not strict constants.
- The frame rate was measured on one machine only (Apple M4 Max, Chrome 154, a 120 Hz display, `/?bench`, foreground tab): all four loads run at 120 frames per second, with a median frame interval of 8.3 ms, a 95th percentile of 9.2 to 9.3 ms and 0.7 to 1.0 ms of main-thread time per frame. GPU time per batch: 2D with 100,000 particles 2.4 ms (8 steps), 3D with 130,000 particles 10.5 ms (8 steps), Ising 1024² 0.9 ms (8 steps), gravity with 16,384 bodies 4.2 ms (1 step). The 3D load is slightly over the 10 ms budget and longer than one frame at 120 Hz: the engine does not submit a new batch while the previous one is unfinished, so the picture stays at 120 frames while the simulation advances at 635 steps per second (960 to 980 for the other two eight-step loads). Render time was not measured separately; all that is known is that it does not stretch the frame interval. There are no numbers for other graphics hardware.
- The amphiphiles are a coarse-grained implicit-solvent model, in 2D with periodic boundaries only: the solvent is folded into the two rules "tails attract, heads only repel", and the spring stiffness (100) and rest length (1 σ) are fixed; bonded beads also repel through the pair potential, so the mean bond length is about 1.1 σ. The aggregates have no theory line. In the guided experiment (three-bead molecules, ρ = 0.15, ε_tail–tail = 3), 62% of the molecules are single at T = 3 and under 1% at T = 0.7, where the mean aggregation number is about 10 (10.2 and 10.6 in two runs); it is still growing slowly within forty thousand steps, equilibrium was not verified, and no critical micelle concentration was measured. On the GPU backend the aggregate statistics read every position back. There are micelles only, no membranes (a "bilayer" in 2D would be just a ribbon).
- Flow past the disc and convection are accepted qualitatively; there is no point-by-point theory line. Flow past the disc: over 110,000 particles, disc diameter 60 σ, flow at about half the speed of sound (so compressible); the time-averaged velocity on the lee side of the disc is −0.17 ± 0.03 (incoming flow 1.23), and the wake downstream sways periodically: the cross-flow velocity three radii behind the disc oscillates at f = 0.0065 and 0.0070 in two runs (periods 154 and 143), a sinusoid explains 92% and 96% of its variation, and the Strouhal number is St = fD/U = 0.34 and 0.38 (U = 1.15 and 1.10 is the mean flow in the channel; about 0.25 to 0.29 using the speed in the gaps beside the disc). The two runs differ in length (260,000 and 370,000 steps), and the flow is still slowing down gradually. The channel is only four diameters wide, the flow is compressible and, with no thermostat, viscous heating has raised the fluid to T ≈ 1.7, so this need not equal the value of about 0.2 for unbounded incompressible flow; at half that speed (Reynolds number about twenty) there is no significant backflow. Convection: with the lower wall ten times hotter than the upper one, at gravity 0.06 the vertical-velocity variation is five times the thermal noise and about four pairs of rolls appear; at gravity 0.02 it is about 1.5 times, with no clear rolls. Scanning gravity in six steps (0.01 to 0.06) gives, in two runs, a convection measure of 0.12, 0.12, 0.18, 0.31, 0.48, 0.66 and 0.11, 0.11, 0.22, 0.45, 0.67, 0.57 (estimated thermal noise 0.07 to 0.10): in both, it stays at the noise level up to gravity 0.02 and rises from 0.03, so the onset lies between 0.02 and 0.03; above the onset the two runs differ by up to 0.15 (each step runs only thirty to forty thousand steps, so the rolls have not fully settled), and the functional form of the growth cannot be determined. The corresponding Rayleigh number is an order of magnitude only: layer depth 156 σ, α ΔT ≈ 1.6, and the viscosity and thermal diffusivity were not measured in this state (a gas at ρ = 0.3, T ≈ 5) but estimated from kinetic theory (ν ≈ 3, κ ≈ 4, possibly off by a factor of several), giving Ra of about 10⁴, between the same order as and one order above the textbook 1708 for rigid walls. The temperature difference is more than the mean temperature, far outside the Boussinesq approximation, so the two should not be expected to agree.
- The "temperature T" counts only motion relative to the centre of mass, so the kinetic energy of a uniform drift is left out; in a sheared flow (channel flow) the layers move at different speeds and that part is still included, so it reads slightly high. For the local temperature see the temperature profile on the hydrodynamic level.
- The field readback is about 180 KB in the channel geometry (192 × 48 cells), above the 64 KB limit set at the start. Measured, it adds about 0.2 ms to each reduction (116,000 particles, about ten reductions per second), so the resolution was kept.
- The pressure is compared with the published equation of state only for the 2D one-component 12-6 potential with a cutoff of at least 4 σ (the default is 2.5 σ, where only the low-density virial line is drawn). The cutoff correction is a mean-field estimate.
- The speed of sound is checked in a dilute gas only, against the adiabatic sound speed of the virial expansion to B₂; in a dense fluid there is no independent theoretical value to compare with. The wave must be many mean free paths long to be sound at all, which needs a large box (a square box of 1840 particles at density 0.15 is too small). The structure factor is sampled along x and y only, and in large boxes at every few wave vectors, so a sharp Bragg peak can fall between samples.
- The fundamental constants panel only does scaling conversions, with argon as the reference; it does not change the dynamics in reduced units.
- The theory line for the pressure is expanded only to the second virial coefficient and is valid only at low density; disagreement with the measurement at high density is expected.
- Near the critical point Metropolis updates equilibrate extremely slowly, and large lattices may fail to reach equilibrium for a long time; the real-time Binder cumulant in the interface is therefore trustworthy only on small lattices. Wolff updates are used only in the tests and are not the dynamics being simulated.
- Effective information is experimental: its value depends on the choice of local state, and every level uses the same time step (one sweep) although coarse levels change more slowly anyway, which by itself raises their reading. There is no theoretical value to compare with. Measured (512²): from 0.60 to 2.08 bits with coarse-graining at the critical temperature, between 0.1 and 0.4 at T = 3.5, tending to 0 at T = 1.5.
- The Potts model is 2D only, with nearest-neighbour coupling and no field. Metropolis updates equilibrate extremely slowly near the transition: in the guided experiment, q = 3 at L = 256 after eighty thousand sweeps gives energies of −1.569 and −1.588 from the two starts (exact −1.577), still fluctuating; q = 4 has logarithmic corrections, and its measured order-parameter exponent is −0.10 (L = 16 to 128), a fifth away from 1/8, so it is not asserted. For q > 4 the coexistence of the two phases at the transition is metastable: small lattices (128 and below) hop between them, which is why the guided experiment uses 512. The order parameter is "the most populated state", not the vector order parameter defined per state.
- The 3D Ising model has nearest-neighbour coupling only: no next-nearest-neighbour coupling and no "effective information" card. It has no exact solution, so magnetisation and energy have no theory line, and the critical temperature and exponents are numerical results from the literature. The lattices used in the tests are small (8 to 32); the cumulant at the Binder crossing is 0.490, above the literature's large-lattice value of 0.465, which is a small-lattice correction.
- Equation discovery has been done only for the single case of diffusion. The SINDy sparsity threshold is set to 0.2 (the binned particle data have a few percent of noise per bin, and 0.1 would leave small terms that fit the noise); once the concentration approaches uniformity the signal is drowned in noise and the fit fails. The DMD decay rates agree with the prediction of the diffusion equation only in order of magnitude, and vary strongly with the length of the record: in one run the ratios of the two slowest modes to the prediction were 3.5 and 1.4 at 12,000 steps and 0.99 and 1.42 at 40,000 steps. Forward–backward DMD was tried: on synthetic data with added noise it lowers the mean error of the slowest decay rate from 264% to 81%, but on the real particle data it is no more accurate (0.86 and 1.62 at 40,000 steps). So the main error is not noise bias but higher modes of the initial step leaking into the first few. The interface still uses standard DMD.
- The particle-mesh force is smoothed below two or three grid spacings, and structure smaller than that is not to be trusted; the reading of the highest density is limited by the grid accordingly (the sheet a plane wave collapses into measures only 6 to 8 times the mean density, where theory has it diverge). The background is static (no cosmic expansion), so growth is exponential rather than a power law, and the filaments and clumps are a qualitative picture that cannot be compared with the observed galaxy distribution. The particles start on a regular lattice, whose stripes remain visible in the sheets. Energy is only approximately conserved (a drift of about 0.5% in the guided experiment). The random initial conditions contain only modes with wave number up to 4. On the GPU the deposit uses fixed-point integers, so it differs from the CPU reference by rounding (initial accelerations agree to within 0.2%).
- Gravity is O(N²) direct summation, with at most 16384 bodies; there is no gas, radiation or nuclear reactions, so there is only collisionless collapse and relaxation, and no stars.
- After a cold collapse the "2K/|U| of the whole system" does not return to 1: about twenty percent of the bodies are ejected and carry away kinetic energy, and with a softened potential |U| is not equal to the virial of the forces. The virial theorem is tested only on the bound part, using the virial of the forces.
- The bit-reversible integrator exists only on the CPU backend and does not support the thermostat, walls or the driving force; "play backwards" on the GPU backend merely flips the sign of the velocities and does not return to the starting point.
- The GPU backend uses f32: the energy gauge has a noise floor of about 1e-4 ε per particle.

## Data sources

No external data. The theory comparisons come from the published literature: Onsager (1944), Yang (1952), Kadanoff (1966), Verlet (1967), Irving & Kirkwood (1950).
