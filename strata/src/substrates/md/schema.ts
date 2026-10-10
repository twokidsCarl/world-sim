import type { Knob, Params } from '../../core/params'
import type { PotentialSpec } from './potential'

export const POTENTIAL_KINDS = ['mie', 'morse', 'soft'] as const

/** Conventional fcc cells per side for the 3D box, from the `nx` knob. */
export const fccCells = (nx: number) => Math.max(4, Math.round(nx / 4))

export const MD_KNOBS: Knob[] = [
  {
    id: 'dim',
    label: '空间维度',
    tag: 'class',
    min: 2,
    max: 3,
    step: 1,
    default: 2,
    rebuild: 'state',
    options: [
      { value: 2, label: '二维' },
      { value: 3, label: '三维' },
    ],
    note: '同一条势，换一个维度：速率分布的形状、密堆积的配位数（6 对 12）、维里系数都随之改变，二维里也没有真正的长程晶体序。壁面、条带和六角序只在二维下提供。',
  },
  {
    id: 'kind',
    label: '势的形式',
    tag: 'value',
    min: 0,
    max: 2,
    step: 1,
    default: 0,
    rebuild: 'table',
    options: [
      { value: 0, label: 'Mie n–m' },
      { value: 1, label: 'Morse' },
      { value: 2, label: '纯排斥' },
    ],
  },
  {
    id: 'n',
    label: '排斥指数 n',
    tag: 'value',
    min: 7,
    max: 18,
    step: 1,
    default: 12,
    rebuild: 'table',
    when: (p) => p.kind !== 1,
  },
  {
    id: 'm',
    label: '吸引指数 m',
    tag: 'value',
    min: 3,
    max: 6,
    step: 1,
    default: 6,
    rebuild: 'table',
    note: 'm 大于空间维度时作用是短程的；降到维度以下才会改变普适类。',
    when: (p) => p.kind === 0,
  },
  {
    id: 'a',
    label: 'Morse 势阱宽度 a',
    tag: 'value',
    min: 3,
    max: 10,
    step: 0.5,
    default: 6,
    rebuild: 'table',
    when: (p) => p.kind === 1,
  },
  {
    id: 'rc',
    label: '截断半径 rc',
    tag: 'value',
    min: 1.5,
    max: 4,
    step: 0.1,
    default: 2.5,
    rebuild: 'table',
    note: '截断会移动相图，但不改变短程作用的普适类。',
  },
  {
    id: 'epsBB',
    label: 'B–B 吸引强度 ε_BB',
    tag: 'value',
    min: 0.2,
    max: 2,
    step: 0.05,
    default: 1,
    rebuild: 'table',
    when: (p) => p.fractionB > 0,
  },
  {
    id: 'epsAB',
    label: 'A–B 吸引强度 ε_AB',
    tag: 'value',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.3,
    rebuild: 'table',
    note: '低于同种吸引时，两种粒子在低温下分相。A–A 强度固定为 1。',
    when: (p) => p.fractionB > 0,
  },
  {
    id: 'nonreciprocal',
    label: '打破作用力与反作用力 δ',
    tag: 'toy',
    min: 0,
    max: 1,
    step: 0.05,
    default: 0,
    rebuild: 'table',
    breaks: '动量和能量不再守恒',
    note: 'A 受 B 的力乘 (1+δ)，B 受 A 的力乘 (1−δ)。δ>0 时不存在势能函数：这是“粒子生命”一类玩具规则的做法，不是封闭系统的物理。',
    when: (p) => p.fractionB > 0,
  },
  {
    id: 'fractionB',
    label: 'B 粒子比例',
    tag: 'state',
    min: 0,
    max: 0.5,
    step: 0.05,
    default: 0,
    rebuild: 'state',
    note: '大于 0 时出现第二种粒子，以及它与 A 的相互作用矩阵。',
  },
  {
    id: 'layoutB',
    label: 'B 的初始分布',
    tag: 'state',
    min: 0,
    max: 1,
    step: 1,
    default: 0,
    rebuild: 'state',
    options: [
      { value: 0, label: '随机混合' },
      { value: 1, label: '中间一条带' },
    ],
    note: '条带：盒子变成扁长形，B 从中间向两侧扩散，可以从浓度剖面里发现扩散方程。',
    when: (p) => p.fractionB > 0 && p.dim === 2,
  },
  {
    id: 'walls',
    label: '边界',
    tag: 'state',
    min: 0,
    max: 1,
    step: 1,
    default: 0,
    rebuild: 'state',
    breaks: '有壁面换热和外力做功：系统是开放的，能量和动量不再守恒',
    options: [
      { value: 0, label: '周期' },
      { value: 1, label: '上下热壁（管道）' },
    ],
    note: '热壁：撞到壁面的粒子按壁面温度重新发射，速度方向随机，因此流体贴壁处流速为零。壁面温度取上面的温度 T。',
    when: (p) => p.dim === 2,
  },
  {
    id: 'drive',
    label: '沿管道的驱动力 g',
    tag: 'state',
    min: 0,
    max: 0.02,
    step: 0.001,
    default: 0.006,
    rebuild: 'none',
    when: (p) => p.walls === 1,
  },
  { id: 'density', label: '数密度 ρ', tag: 'state', min: 0.02, max: 1.0, step: 0.01, default: 0.6, rebuild: 'state' },
  {
    id: 'temperature',
    label: '温度 T',
    tag: 'state',
    min: 0.05,
    max: 3,
    step: 0.05,
    default: 1,
    rebuild: 'none',
    note: '孤立系统下拖动是一次性干预：把速度缩放到该温度，之后任其演化。接热浴时是热浴温度。',
  },
  {
    id: 'thermostat',
    label: '恒温器',
    tag: 'numerical',
    min: 0,
    max: 1,
    step: 1,
    default: 0,
    rebuild: 'none',
    note: '开启后系统与热浴交换能量，总能量不再守恒；漂移仪表改为扣除热交换后的值。',
    options: [
      { value: 0, label: '关（孤立系统）' },
      { value: 1, label: '开（接热浴）' },
    ],
  },
  {
    id: 'integrator',
    label: '积分器',
    tag: 'numerical',
    min: 0,
    max: 1,
    step: 1,
    default: 0,
    rebuild: 'state',
    options: [
      { value: 0, label: '浮点 Verlet' },
      { value: 1, label: '整数坐标（逐位可逆）' },
    ],
    note: '牛顿力学在微观上是时间可逆的。浮点运算的舍入会破坏这一点；把坐标取成整数后，倒放能一位不差地回到起点。整数积分器不支持恒温器、壁面和驱动力。',
    when: (p) => p.backend === 0,
  },
  {
    id: 'backend',
    label: '计算后端',
    tag: 'numerical',
    min: 0,
    max: 1,
    step: 1,
    default: 0,
    rebuild: 'state',
    options: [
      { value: 0, label: 'CPU 参考（f64）' },
      { value: 1, label: 'WebGPU（f32）' },
    ],
  },
  {
    id: 'nx',
    label: '每行粒子数',
    tag: 'numerical',
    min: 20,
    max: 400,
    step: 4,
    default: 40,
    rebuild: 'state',
    note: '二维：粒子总数约为该值的平方乘 1.15，CPU 参考实现最多取 70。三维：每边 nx/4 个面心立方晶胞，共 4(nx/4)³ 个粒子，CPU 最多 2048 个。',
  },
  { id: 'dt', label: '时间步长 dt', tag: 'numerical', min: 0.001, max: 0.01, step: 0.001, default: 0.005, rebuild: 'none' },
]

export function potentialSpec(p: Params): PotentialSpec {
  switch (POTENTIAL_KINDS[p.kind] ?? 'mie') {
    case 'mie':
      return { kind: 'mie', epsilon: 1, sigma: 1, n: p.n, m: p.m, rc: p.rc }
    case 'morse':
      return { kind: 'morse', epsilon: 1, r0: Math.pow(2, 1 / 6), a: p.a, rc: p.rc }
    case 'soft':
      return { kind: 'soft', epsilon: 1, sigma: 1, n: p.n, rc: p.rc }
  }
}

/** strength[si][sj] scales epsilon for the force on species si from species sj. */
export function strengthMatrix(p: Params): number[][] {
  if (!p.fractionB) return [[1]]
  return [
    [1, p.epsAB * (1 + p.nonreciprocal)],
    [p.epsAB * (1 - p.nonreciprocal), p.epsBB],
  ]
}

/** Changes whenever the pair interaction does. */
export function fieldKey(p: Params): string {
  return JSON.stringify([potentialSpec(p), strengthMatrix(p)])
}

/** Width over height of the box: square, except for the channel and the diffusion band. */
export function boxAspect(p: Params): number {
  if (p.dim === 3) return 1
  if (p.walls) return 4
  return p.fractionB > 0 && p.layoutB ? 6 : 1
}
