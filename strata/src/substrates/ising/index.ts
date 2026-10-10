import type { Substrate } from '../../core/substrate'
import { ISING_QUANTITIES } from '../../levels/ising'
import { IsingCpuBackend, IsingGpuBackend, type IsingFrame } from './backend'
import { ISING_KNOBS } from './schema'

export const isingSubstrate: Substrate<IsingFrame> = {
  id: 'ising',
  label: 'Ising 自旋',
  blurb: '只模拟最底层：每个自旋按近邻取向随机翻转。右侧各层由自旋数据算出，虚线是精确解。',
  stepLabel: '扫描数',
  knobs: ISING_KNOBS,
  quantities: ISING_QUANTITIES,
  create: (p, seed, gpu) => (p.backend && gpu ? new IsingGpuBackend(gpu, p, seed) : new IsingCpuBackend(p, seed)),
}
