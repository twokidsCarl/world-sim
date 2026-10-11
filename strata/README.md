# strata

从微观规则到涌现。只模拟最底层的规则，所有更高层级的描述都从微观数据实时算出，并把已知理论叠在实测曲线上，让"More is Different"（Anderson 1972）可以被检验，而不只是被观看。

English version below / 英文版见下文。

## 模拟什么

三个底座，在界面右上角切换：

- **分子动力学**：牛顿定律加一条可编辑的两体势（Mie n–m、Morse、纯排斥），二维或三维周期盒。维度是一个旋钮，标为“改变普适类”：换维度后速率分布的形状、第二维里系数、密堆积的配位数（6 对 12）都随之改变。三维画面可只看中间一片薄层。由粒子数据算出：
  - 微观：能量与动量守恒仪表。CPU 后端另有整数坐标的逐位可逆积分器（Levesque–Verlet）：点“倒放”后一位不差地回到起点，而普通浮点积分器因混沌放大舍入误差回不去。
  - 动理：速率分布对麦克斯韦–玻尔兹曼分布，径向分布函数 g(r) 对低密度极限。
  - 热力学：温度、压强对理论：低密度下是第二维里系数；二维 12-6 势、截断半径不小于 4σ 时，是 Homes 等 (2025) 发表的状态方程加截断修正。
  - 流体：把粒子按网格分箱成密度、流速、温度场（Irving–Kirkwood 构造的最简情形，场的质量和动量与粒子严格相等）。上下热壁加驱动力时，流速剖面对照 Navier–Stokes 的抛物线，并由流量反推粘度。页头的“敲一下”激发盒子里最长的一列驻波，由这个密度模的振荡频率得到声速，对照维里展开到 B₂ 的绝热声速。
  - 结构因子 S(k) = |ρ_k|² / N，由密度沿 x 和 y 的傅里叶模得到：理想气体为 1，液体有一个宽峰，晶体在倒格矢处有尖锐的 Bragg 峰。
  - 元：B 粒子从一条带开始扩散时，记录浓度剖面的时间序列，用弱形式稀疏回归（SINDy）在 5 个候选项里拟合它服从的方程，并用发现的方程把最早的剖面推演到现在与实测对照；再用动态模态分解（DMD）独立估计各模态的衰减率。
  - 结构：局域与全局六角序参量 ψ₆，可按它给粒子着色，看到晶粒、晶界和缺陷。
  - 两种粒子：对称的相互作用强度矩阵，异种吸引弱时低温分相。另有“打破作用力与反作用力”旋钮：一旦打开，能量和动量守恒仪表被划掉，速率分布也偏离麦克斯韦分布。
  - 基本常量面板：改精细结构常数和电子/质子质量比，按标度关系换算这盒粒子的真实尺寸、温度、时间，并给出 de Boer 参数作为经典近似是否可信的仪表。
- **Ising 自旋**：近邻与次近邻耦合加外场，四子格 Metropolis 更新。由自旋数据算出：
  - 热力学：磁化强度与能量对 Onsager–Yang 精确解。
  - 元：块自旋多数表决的重整化金字塔，以及磁化强度和近邻关联随尺度的流向；Binder 累积量（临界点上与晶格大小无关）。
  - 测试里用 Wolff 团簇更新定量检验临界行为：不同大小晶格的 Binder 曲线在精确的 Tc 相交，Tc 处磁化强度按 L^(−1/8) 衰减；加上次近邻耦合后 Tc 移动四成，交点处的累积量不变。

- **引力 N 体**：三维软化牛顿引力，直接对所有天体对求和，蛙跳积分。这是独立场景，不与分子动力学共用一个盒子。由天体数据算出：
  - 微观：能量与动量守恒。
  - 热力学：束缚部分的位力比 2K / |Σ m x·a| 对位力定理的 1。
  - 结构：束缚比例、半质量半径、径向密度（Plummer 初始状态下对 Plummer 模型）。径向量都以势阱最深处为中心。

每个可调参数都带标签，说明它是改变普适类、仅改变数值、状态变量还是数值方法。每个带理论的量旁边实时标出“吻合”或“偏离”。

页面底部有引导实验（敲一下量声速、同一条势换一个维度、把时间倒过来、冷却液体直到结晶、粒子在管道里流成抛物线、让机器从粒子数据里发现扩散方程、冷的天体团坍缩后自己找到平衡、Ising 淬火穿过临界温度）：每一步改参数、运行一段，再用实测值检验一句预期。也可以用 `/?scenario=sound`、`/?scenario=dimension`、`/?scenario=reverse`、`/?scenario=freeze`、`/?scenario=poiseuille`、`/?scenario=diffusion`、`/?scenario=collapse` 或 `/?scenario=quench` 直接启动，结果写入 `window.__strataScenario`。

## 运行

需要 [Bun](https://bun.sh)。WebGPU 可用时自动使用 GPU 后端（Chrome 113 以上），否则退回 CPU 参考实现。

```sh
bun install
bun run dev        # http://localhost:5188
```

页头最右的按钮在“跟随系统 / 浅色 / 深色”之间切换配色。加上 `?perf` 会在右下角显示帧率、帧间隔、主线程耗时、每秒步数和 GPU 每批耗时（来自 timestamp query），同样的数字写入 `window.__strataPerf`；页面在后台时浏览器会降帧，读数会标为无效。

## 测试

```sh
bun run test       # CPU 参考实现的解析与统计测试
bun run typecheck
```

GPU 内核没有独立的单元测试，而是逐个对照 f64 的 CPU 参考实现。启动开发服务器后打开 `http://localhost:5188/?harness`，结果同时写入 `window.__strataHarness`。

## 结构

```
src/core/         底座、派生量、调度器的接口；计数器式随机数
src/substrates/   md/、ising/ 与 gravity/：参数表、CPU 参考实现（ref）、WGSL 内核、后端
src/levels/       每个底座的层级阶梯：派生量及其理论对照，以及基于时间序列的分析
src/analysis/     小型线性代数、DMD、弱形式 SINDy
src/theory/       麦克斯韦分布、维里系数、Onsager 精确解、Plummer 模型、常量到单位的标度关系
src/scenarios/    引导实验（数据）
src/render/       WebGPU 粒子与晶格渲染
src/plot/         Canvas2D 绘图
src/harness/      GPU 与 CPU 交叉校验
tests/            analytic/（解析）与 slow/（统计）
```

CPU 参考实现先写，是规范；WGSL 内核是它的优化，并用同一份势表、同一个整数哈希。

## 已知边界

- 分子动力学最多两种粒子，粒子之间没有化学键（所以只有分相，没有胶束和膜）。
- 三维下没有壁面、条带初始分布和六角序参量；结构量只有配位数，它分不清稠密液体和晶体（液体约 10 到 11.5，晶体 12），还没有 Steinhardt q₆。三维的 g(r) 只算到一个元胞宽（约 2.5 到 3σ）。
- 流体层只验证了管道流的剖面形状；绕流尾迹和对流还没有做。管道流的抛物线幅度取自实测平均流速，粘度是反推值，没有独立的理论对照。
- 压强与已发表状态方程的对照只适用于二维、单组分的 12-6 势，且截断半径不小于 4σ（默认是 2.5σ，此时只画低密度的维里线）。截断修正是平均场估计。
- 声速只在稀薄气体里做了对照（维里展开到 B₂ 的绝热声速）；稠密流体没有独立的理论值可比。波长必须远大于平均自由程才算声波，这需要足够大的盒子（密度 0.15、1840 个粒子的方盒子就不够）。结构因子只沿 x 和 y 取样，大盒子里每隔几个波矢取一个，尖锐的 Bragg 峰可能落在取样点之间。
- 基本常量面板只做标度换算，以氩为基准；它不改变约化单位下的动力学。
- 压强的理论线只展开到第二维里系数，仅在低密度有效；稠密时与实测不符是预期的。
- 临界点附近 Metropolis 更新平衡极慢，大晶格可能长时间达不到平衡；界面上实时的 Binder 累积量因此只在小晶格上可信。Wolff 更新只用于测试，不是被模拟的动力学。
- Ising 只有二维。三维 Ising（临界指数不同，是“改变普适类”最干净的例子）还没有做。
- 方程发现只做了扩散这一种情形。SINDy 的稀疏阈值取 0.2（分箱的粒子数据每箱有百分之几的噪声，取 0.1 会留下拟合噪声的小项）；浓度趋于均匀后信号被噪声淹没，拟合会失效。DMD 的衰减率与扩散方程的预言只在量级上吻合，实测偏差可达三四成。
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

Three substrates, switched at the top right of the interface:

- **Molecular dynamics**: Newton's laws plus an editable pair potential (Mie n–m, Morse, purely repulsive), in a 2D or 3D periodic box. The dimension is a knob, labelled "changes the universality class": on changing the dimension, the shape of the speed distribution, the second virial coefficient and the coordination number of close packing (6 versus 12) all change with it. The 3D view can be restricted to a thin slice through the middle. Computed from the particle data:
  - Microscopic: energy and momentum conservation gauges. The CPU backend additionally has a bit-reversible integrator on integer coordinates (Levesque–Verlet): after clicking "play backwards" it returns to the starting point bit for bit, whereas the ordinary floating-point integrator cannot get back, because chaos amplifies the rounding error.
  - Kinetic: the speed distribution against the Maxwell–Boltzmann distribution, and the radial distribution function g(r) against its low-density limit.
  - Thermodynamic: temperature, and pressure against theory: the second virial coefficient at low density, and, for the 2D 12-6 potential with a cutoff of at least 4 σ, the published equation of state of Homes et al. (2025) plus a cutoff correction.
  - Hydrodynamic: the particles are binned on a grid into density, flow-velocity and temperature fields (the simplest case of the Irving–Kirkwood construction; the mass and momentum of the fields are exactly equal to those of the particles). With hot walls at top and bottom and a driving force, the flow-velocity profile is compared with the Navier–Stokes parabola, and the viscosity is inferred from the flow rate. A "knock" button launches the longest standing wave in the box; the oscillation frequency of that density mode gives the speed of sound, compared with the adiabatic sound speed of the virial expansion to B₂.
  - Structure factor S(k) = |ρ_k|² / N from the Fourier modes of the density along x and y: 1 for an ideal gas, a broad peak for a liquid, sharp Bragg peaks for a crystal.
  - Meta: when the B particles start diffusing from a stripe, the time series of the concentration profile is recorded, and weak-form sparse regression (SINDy) fits the equation it obeys among 5 candidate terms; the discovered equation is then used to evolve the earliest profile to the present for comparison with the measurement. Dynamic mode decomposition (DMD) is then used to estimate the decay rate of each mode independently.
  - Structure: the local and global hexatic order parameter ψ₆; particles can be coloured by it, showing grains, grain boundaries and defects.
  - Two species: a symmetric matrix of interaction strengths; when the unlike-species attraction is weak, the system phase-separates at low temperature. There is also a "break action and reaction" knob: once it is turned on, the energy and momentum conservation gauges are struck out, and the speed distribution also deviates from the Maxwell distribution.
  - Fundamental constants panel: change the fine-structure constant and the electron/proton mass ratio, convert the real size, temperature and time of this box of particles by scaling relations, and get the de Boer parameter as a gauge of whether the classical approximation can be trusted.
- **Ising spins**: nearest-neighbour and next-nearest-neighbour couplings plus an external field, with four-sublattice Metropolis updates. Computed from the spin data:
  - Thermodynamic: magnetization and energy against the exact Onsager–Yang solution.
  - Meta: the renormalization pyramid of block spins by majority vote, and the flow of the magnetization and the nearest-neighbour correlation with scale; the Binder cumulant (independent of lattice size at the critical point).
  - In the tests, Wolff cluster updates are used to check the critical behaviour quantitatively: the Binder curves of lattices of different sizes cross at the exact Tc, and at Tc the magnetization decays as L^(−1/8); with a next-nearest-neighbour coupling added, Tc shifts by forty percent while the cumulant at the crossing is unchanged.

- **Gravitational N-body**: 3D softened Newtonian gravity, direct summation over all pairs of bodies, leapfrog integration. This is a separate scene; it does not share a box with the molecular dynamics. Computed from the body data:
  - Microscopic: energy and momentum conservation.
  - Thermodynamic: the virial ratio 2K / |Σ m x·a| of the bound part against the value 1 of the virial theorem.
  - Structure: bound fraction, half-mass radius, radial density (against the Plummer model when the initial state is Plummer). All radial quantities are centred on the deepest point of the potential well.

Every adjustable parameter carries a label saying whether it changes the universality class, only changes numerical values, is a state variable, or is a numerical method. Next to every quantity that has a theory, "agrees" or "deviates" is shown in real time.

At the bottom of the page there are guided experiments (knocking the gas to measure the speed of sound, the same potential in a different dimension, running time backwards, cooling a liquid until it crystallizes, particles flowing in a channel with a parabolic profile, letting the machine discover the diffusion equation from particle data, a cold cluster of bodies collapsing and then finding equilibrium by itself, an Ising quench through the critical temperature): each step changes parameters, runs for a while, and then tests a one-sentence expectation against the measured value. They can also be started directly with `/?scenario=sound`, `/?scenario=dimension`, `/?scenario=reverse`, `/?scenario=freeze`, `/?scenario=poiseuille`, `/?scenario=diffusion`, `/?scenario=collapse` or `/?scenario=quench`; the result is written to `window.__strataScenario`.

## Running

Requires [Bun](https://bun.sh). When WebGPU is available the GPU backend is used automatically (Chrome 113 and later); otherwise it falls back to the CPU reference implementation.

```sh
bun install
bun run dev        # http://localhost:5188
```

The rightmost button in the page header switches the colour scheme between "follow system / light / dark". Adding `?perf` shows, at the bottom right, the frame rate, frame interval, main-thread time, steps per second and GPU time per batch (from timestamp queries); the same numbers are written to `window.__strataPerf`. When the page is in the background the browser lowers the frame rate, and the readings are marked as invalid.

## Tests

```sh
bun run test       # analytic and statistical tests of the CPU reference implementation
bun run typecheck
```

The GPU kernels have no separate unit tests; instead each one is checked against the f64 CPU reference implementation. After starting the dev server, open `http://localhost:5188/?harness`; the results are also written to `window.__strataHarness`.

## Structure

```
src/core/         interfaces of substrates, derived quantities and the scheduler; counter-based random numbers
src/substrates/   md/, ising/ and gravity/: parameter tables, CPU reference implementation (ref), WGSL kernels, backends
src/levels/       the ladder of levels of each substrate: derived quantities and their theory comparisons, and analyses based on time series
src/analysis/     small linear algebra, DMD, weak-form SINDy
src/theory/       Maxwell distribution, virial coefficients, Onsager exact solution, Plummer model, scaling relations from constants to units
src/scenarios/    guided experiments (data)
src/render/       WebGPU particle and lattice rendering
src/plot/         Canvas2D plotting
src/harness/      GPU versus CPU cross-check
tests/            analytic/ (analytic) and slow/ (statistical)
```

The CPU reference implementation is written first and is the specification; the WGSL kernels are an optimization of it, and use the same potential table and the same integer hash.

## Known limits

- Molecular dynamics has at most two species, and there are no chemical bonds between particles (so there is only phase separation, no micelles or membranes).
- In 3D there are no walls, no stripe initial distribution and no hexatic order parameter; the only structural quantity is the coordination number, which cannot tell a dense liquid from a crystal (about 10 to 11.5 for the liquid, 12 for the crystal), and there is no Steinhardt q₆ yet. In 3D, g(r) is computed only out to one cell width (about 2.5 to 3σ).
- The hydrodynamic level has only verified the shape of the channel-flow profile; wakes behind obstacles and convection have not been done yet. The amplitude of the channel-flow parabola is taken from the measured mean flow velocity, and the viscosity is an inferred value with no independent theoretical comparison.
- The pressure is compared with the published equation of state only for the 2D one-component 12-6 potential with a cutoff of at least 4 σ (the default is 2.5 σ, where only the low-density virial line is drawn). The cutoff correction is a mean-field estimate.
- The speed of sound is checked in a dilute gas only, against the adiabatic sound speed of the virial expansion to B₂; in a dense fluid there is no independent theoretical value to compare with. The wave must be many mean free paths long to be sound at all, which needs a large box (a square box of 1840 particles at density 0.15 is too small). The structure factor is sampled along x and y only, and in large boxes at every few wave vectors, so a sharp Bragg peak can fall between samples.
- The fundamental constants panel only does scaling conversions, with argon as the reference; it does not change the dynamics in reduced units.
- The theory line for the pressure is expanded only to the second virial coefficient and is valid only at low density; disagreement with the measurement at high density is expected.
- Near the critical point Metropolis updates equilibrate extremely slowly, and large lattices may fail to reach equilibrium for a long time; the real-time Binder cumulant in the interface is therefore trustworthy only on small lattices. Wolff updates are used only in the tests and are not the dynamics being simulated.
- Ising is 2D only. The 3D Ising model (different critical exponents, the cleanest example of "changing the universality class") has not been done yet.
- Equation discovery has been done only for the single case of diffusion. The SINDy sparsity threshold is set to 0.2 (the binned particle data have a few percent of noise per bin, and 0.1 would leave small terms that fit the noise); once the concentration approaches uniformity the signal is drowned in noise and the fit fails. The DMD decay rates agree with the prediction of the diffusion equation only in order of magnitude; the measured deviation can reach thirty to forty percent.
- Gravity is O(N²) direct summation, with at most 16384 bodies; there is no gas, radiation or nuclear reactions, so there is only collisionless collapse and relaxation, and no stars.
- After a cold collapse the "2K/|U| of the whole system" does not return to 1: about twenty percent of the bodies are ejected and carry away kinetic energy, and with a softened potential |U| is not equal to the virial of the forces. The virial theorem is tested only on the bound part, using the virial of the forces.
- The bit-reversible integrator exists only on the CPU backend and does not support the thermostat, walls or the driving force; "play backwards" on the GPU backend merely flips the sign of the velocities and does not return to the starting point.
- The GPU backend uses f32: the energy gauge has a noise floor of about 1e-4 ε per particle.

## Data sources

No external data. The theory comparisons come from the published literature: Onsager (1944), Yang (1952), Kadanoff (1966), Verlet (1967), Irving & Kirkwood (1950).
