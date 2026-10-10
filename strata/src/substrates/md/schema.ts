import type { Knob, Params } from '../../core/params'
import type { PotentialSpec } from './potential'

export const POTENTIAL_KINDS = ['mie', 'morse', 'soft'] as const

export const MD_KNOBS: Knob[] = [
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
    note: '粒子总数约为该值的平方乘 1.15。CPU 参考实现最多取 70。',
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
