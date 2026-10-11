// 以数据形式描述的引导实验：每一步设置参数、运行一段时间，并可给出一个预期，
// 用测得的量加以检验。
// Guided experiments as data: each step sets parameters, runs for a while, and may state
// an expectation that is checked against the measured quantity.

import type { Params } from '../core/params'

export interface Expectation {
  quantity: string
  min?: number
  max?: number
  /**
   * 要求该量与其理论叠加曲线相符，而不是限定其取值范围。
   * Require the quantity to agree with its theory overlay instead of bounding its value.
   */
  agree?: boolean
  /**
   * 要求这个分析（按 id）报告与理论相符，而不是检验某个量。
   * Require this analysis (by id) to report agreement with its theory, instead of a quantity.
   */
  analysis?: string
  /**
   * 只判断最新的单个样本，而不是最近十个样本的平均。
   * Judge the single latest sample instead of the average of the last ten.
   */
  latest?: boolean
  /** 用文字描述用户应当看到的现象。 / What the user should see, in words. */
  text: string
}

export interface ScenarioStep {
  text: string
  set?: Params
  /**
   * 进入下一步之前要运行的模拟步数（或扫描次数）。
   * Simulation steps (or sweeps) to run before moving on.
   */
  run: number
  /** 进入该步时在 `set` 之后执行的操作。 / Something to do on entering the step, after `set`. */
  action?: 'reverse' | 'perturb' | 'push'
  /** `push` 动作所加的整体速度 / Bulk velocity added by the `push` action */
  velocity?: number
  expect?: Expectation
}

export interface Scenario {
  id: string
  title: string
  substrate: string
  steps: ScenarioStep[]
}

// ⟨|ψ₆|⟩ 的阈值取在该状态点测得的两个平台值之间：
// 密度 0.8 时，液体约为 0.52，布满空洞的晶体约为 0.76。
// Thresholds for ⟨|ψ₆|⟩ sit between the two measured plateaus at this state point:
// about 0.52 in the liquid and 0.76 in the void-riddled crystal at density 0.8.
export const SCENARIOS: Scenario[] = [
  {
    id: 'freeze',
    title: '冷却液体直到结晶，再把它熔化',
    substrate: 'md',
    steps: [
      {
        text: '稠密液体接上热浴，温度 1.0。粒子挤在一起但没有固定位置，局域六角序低。',
        set: { nx: 120, density: 0.8, temperature: 1, thermostat: 1 },
        run: 3000,
        expect: { quantity: 'psi6Local', max: 0.62, text: '液体：⟨|ψ₆|⟩ 低于 0.62' },
      },
      {
        text: '把热浴降到 0.3。规则没有变，只是能量被抽走：粒子自己排成三角晶格。',
        set: { temperature: 0.3 },
        run: 8000,
        expect: { quantity: 'psi6Local', min: 0.7, text: '晶体：⟨|ψ₆|⟩ 高于 0.7' },
      },
      {
        text: '再把热浴升到 1.2，晶体熔化，六角序消失。',
        set: { temperature: 1.2 },
        run: 5000,
        expect: { quantity: 'psi6Local', max: 0.62, text: '回到液体：⟨|ψ₆|⟩ 低于 0.62' },
      },
    ],
  },
  {
    id: 'poiseuille',
    title: '粒子在管道里流成抛物线',
    substrate: 'md',
    steps: [
      {
        text: '上下两面热壁，中间是温度 1.0 的稠密流体。没有驱动力时，平均流速处处为零。',
        set: { walls: 1, nx: 120, density: 0.7, temperature: 1, thermostat: 0, drive: 0, fractionB: 0 },
        run: 4000,
      },
      {
        text: '给每个粒子加一个沿管道的小力。粒子之间只有两体碰撞，没有人告诉它们粘性是什么；流速剖面自己长成 Navier–Stokes 方程预言的抛物线。',
        set: { drive: 0.006 },
        run: 30000,
        expect: { quantity: 'flowProfile', agree: true, text: '流速剖面与抛物线吻合' },
      },
    ],
  },
  {
    id: 'nucleation',
    title: '三维过冷液体：等一个晶核',
    substrate: 'md',
    steps: [
      {
        text: '一万六千多个粒子的三维稠密流体，温度 2.5，远在熔点之上。“处在晶体环境里的粒子比例”几乎是零。',
        set: {
          dim: 3,
          nx: 64,
          density: 0.95,
          temperature: 2.5,
          thermostat: 1,
          walls: 0,
          fractionB: 0,
          integrator: 0,
        },
        run: 4000,
        expect: { quantity: 'crystalFraction', max: 0.05, text: '熔体：晶体比例低于 0.05' },
      },
      {
        text: '把热浴骤降到 0.5，远低于熔点。配位数立刻就和晶体差不多了（约 11.3），但粒子还是乱的：液体被过冷，在等一个足够大的晶核偶然出现。把着色切到“键取向序 q̄₆”、显示切到“切片”来看。',
        set: { temperature: 0.5 },
        run: 12000,
      },
      {
        text: '晶核一旦出现就长得很快，几万步之内吞掉整个盒子，留下几块取向不同的晶粒和它们之间的晶界。何时成核是随机的，每次重置都不一样。',
        run: 70000,
        expect: { quantity: 'crystalFraction', min: 0.6, text: '结晶：晶体比例超过 0.6' },
      },
    ],
  },
  {
    id: 'dimension',
    title: '同一条势，换一个维度',
    substrate: 'md',
    steps: [
      {
        text: '二维的稀薄气体。速率分布是 v·exp(−v²/2T) 的形状：小速率的粒子很少，因为平面上速率为 v 的状态数正比于 v。',
        set: {
          dim: 2,
          nx: 120,
          density: 0.03,
          temperature: 2.5,
          thermostat: 0,
          walls: 0,
          fractionB: 0,
          integrator: 0,
        },
        run: 3000,
        expect: { quantity: 'speedDist', agree: true, text: '二维：速率分布与理论吻合' },
      },
      {
        text: '压强对理想气体的偏离由第二维里系数给出，它是对两体势在平面上的积分。',
        run: 1500,
        expect: { quantity: 'pressure', agree: true, text: '二维：压强与 ρT(1 + B₂ρ) 吻合' },
      },
      {
        text: '势、温度、密度都不变，只把空间换成三维。速率分布变成 v²·exp(−v²/2T)：状态数现在正比于 v²。',
        set: { dim: 3, nx: 96 },
        run: 3000,
        expect: { quantity: 'speedDist', agree: true, text: '三维：速率分布与理论吻合' },
      },
      {
        text: '同一条势的第二维里系数，在三维里是另一个数（积分的体积元变了）。',
        run: 1500,
        expect: { quantity: 'pressure', agree: true, text: '三维：压强与 ρT(1 + B₂ρ) 吻合' },
      },
      {
        text: '压密、降温：三维的密堆积是面心立方，每个粒子有 12 个近邻；二维的三角晶格只有 6 个。',
        set: { nx: 64, density: 0.95, temperature: 0.3, thermostat: 1 },
        run: 1500,
        expect: { quantity: 'coordination', min: 11.5, text: '三维晶体：配位数接近 12' },
      },
      {
        text: '加热到 2.5，晶体熔化，第一近邻壳层散开。',
        set: { temperature: 2.5 },
        run: 4000,
        expect: { quantity: 'coordination', max: 11, text: '三维液体：配位数降到 11 以下' },
      },
    ],
  },
  {
    id: 'sound',
    title: '敲一下，量声速',
    substrate: 'md',
    steps: [
      {
        text: '一盒稀薄的气体，先让它平衡。粒子之间只有两体碰撞，没有人规定声音怎么传。',
        set: {
          dim: 2,
          nx: 120,
          density: 0.1,
          temperature: 2,
          thermostat: 0,
          walls: 0,
          fractionB: 0,
          integrator: 0,
        },
        run: 3000,
      },
      {
        text: '给所有粒子加一个沿 x 的小速度，大小按盒子里最长的正弦波变化。密度随即来回晃动：这就是一列驻波，它的频率除以波数就是声速。',
        action: 'perturb',
        run: 60000,
        expect: { quantity: 'soundMode', analysis: 'sound', text: '声速与维里展开的绝热声速相差不到一成' },
      },
    ],
  },
  {
    id: 'wake',
    title: '流过一个圆盘：背后出现回流',
    substrate: 'md',
    steps: [
      {
        text: '十一万多个粒子在管道里流过一个固定的圆盘，流速约为声速的一半。粒子只知道两两相撞和被圆盘、壁面弹开。先让流动建立起来，这一步在 GPU 上约一分钟。',
        set: {
          dim: 2,
          walls: 1,
          nx: 640,
          density: 0.5,
          temperature: 1,
          thermostat: 0,
          obstacle: 30,
          drive: 0.001,
          gravity: 0,
          deltaT: 0,
          fractionB: 0,
          integrator: 0,
        },
        action: 'push',
        velocity: 1.4,
        run: 50000,
      },
      {
        text: '看右侧“沿管道的流速场”：圆盘背后拖着一条尾迹，紧贴圆盘的地方流速为负——流体在那里打转。再往下游，尾迹左右摆动，“横向流速场”里出现正负交替的斑块。',
        run: 40000,
        expect: { quantity: 'wakeVelocity', analysis: 'wake', text: '圆盘背风面的时间平均流速为负（有回流）' },
      },
    ],
  },
  {
    id: 'convection',
    title: '从下面加热：对流卷',
    substrate: 'md',
    steps: [
      {
        text: '上冷下热的两面壁之间是一层气体，下壁的温度是上壁的十倍，重力很弱。热量只靠分子碰撞一层层往上传：竖直方向的流速在热噪声里看不出规律。',
        set: {
          dim: 2,
          walls: 1,
          nx: 320,
          density: 0.3,
          temperature: 1,
          thermostat: 0,
          obstacle: 0,
          drive: 0,
          gravity: 0.02,
          deltaT: 9,
          fractionB: 0,
          integrator: 0,
        },
        run: 50000,
        expect: { quantity: 'convection', max: 0.2, text: '弱重力：竖直流速的起伏与热噪声同量级（纯导热）' },
      },
      {
        text: '把重力加大到三倍。贴近下壁的热气体更轻，现在浮力足以克服粘性：气体自己分成几对一上一下的对流卷。看右侧“横向流速场”里红蓝相间的条带。',
        set: { gravity: 0.06 },
        run: 60000,
        expect: { quantity: 'convection', min: 0.3, text: '强重力：竖直流速的起伏是热噪声的数倍（对流）' },
      },
    ],
  },
  {
    id: 'diffusion',
    title: '让机器从粒子数据里发现扩散方程',
    substrate: 'md',
    steps: [
      {
        text: '两种粒子，相互作用完全相同，只是颜色不同。B 一开始集中在中间一条带里。右侧“元”一栏会从浓度剖面的时间序列里做稀疏回归：5 个候选项，看它留下哪几个。',
        set: {
          walls: 0,
          nx: 180,
          density: 0.6,
          temperature: 2,
          thermostat: 1,
          fractionB: 0.3,
          layoutB: 1,
          epsAB: 1,
          epsBB: 1,
          nonreciprocal: 0,
        },
        run: 16000,
      },
    ],
  },
  {
    id: 'reverse',
    title: '把时间倒过来：晶体熔化，再自己拼回去',
    substrate: 'md',
    steps: [
      {
        text: '整数坐标的积分器，从一块完美的晶格出发。温度够高，它很快熔成无序的液体：熵增加了。',
        set: {
          backend: 0,
          integrator: 1,
          nx: 30,
          density: 0.7,
          temperature: 1.2,
          thermostat: 0,
          walls: 0,
          fractionB: 0,
        },
        run: 3000,
        expect: { quantity: 'psi6Local', max: 0.62, text: '已经熔化：⟨|ψ₆|⟩ 低于 0.62' },
      },
      {
        text: '现在把时间方向反过来。运动方程本身不分过去和未来，所以每个粒子沿原路退回，液体自己重新拼成晶格。',
        action: 'reverse',
        run: 3000,
        expect: { quantity: 'distance', max: 0, latest: true, text: '回到第 0 步：每个粒子都恰好在起点' },
      },
      {
        text: '换成普通的浮点积分器重做一遍：熔化 3000 步后倒放。',
        set: { integrator: 0 },
        run: 3000,
      },
      {
        text: '这一次回不去。舍入误差只有 10⁻¹⁶，但混沌把它每个时间单位放大好几倍。宏观上的不可逆，就藏在对初始条件的这种敏感里。',
        action: 'reverse',
        run: 3000,
        expect: { quantity: 'distance', min: 0.1, latest: true, text: '回不到起点：最大偏离超过 0.1 σ' },
      },
    ],
  },
  {
    id: 'collapse',
    title: '一团静止的天体坍缩，然后自己找到平衡',
    substrate: 'gravity',
    steps: [
      {
        text: '均匀的球，所有天体静止。没有压强撑着，整团物质向中心下落；位力比从 0 开始上升。',
        set: { initial: 0, virial0: 0, n: 12, eps: 0.03, dt: 0.002 },
        run: 700,
      },
      {
        text: '穿过中心后反弹、振荡几次。没有碰撞，也没有摩擦，但系统仍然弛豫到一个稳定的核与晕，同时把一部分天体甩了出去。留下来的那部分满足位力定理：两倍动能等于力的位力。',
        run: 2800,
        expect: { quantity: 'virial', min: 0.85, max: 1.15, text: '束缚部分的位力比回到 1 附近' },
      },
    ],
  },
  {
    id: 'quench',
    title: '把 Ising 晶格淬火穿过临界温度',
    substrate: 'ising',
    steps: [
      {
        text: '高温 T = 3.0：自旋几乎独立翻转，没有净磁化。',
        set: { L: 8, T: 3, h: 0, j2: 0 },
        run: 400,
        expect: { quantity: 'magnetisation', max: 0.1, text: '无序：|m| 低于 0.1' },
      },
      {
        text: '停在临界温度 T = 2.27：各种大小的团簇同时存在，粗粒化后的图看起来和原图一样。',
        set: { T: 2.27 },
        run: 3000,
      },
      {
        text: '降到 T = 1.8：上下对称被自发打破，畴不断长大；能量先接近精确解，磁化强度要等畴壁消失。',
        set: { T: 1.8 },
        run: 4000,
        expect: { quantity: 'energy', max: -1.8, text: '能量降到 −1.8 以下（Onsager 精确解为 −1.86）' },
      },
    ],
  },
]
