import type { Substrate } from '../../core/substrate'
import { MD_QUANTITIES } from '../../levels/md'
import { MdCpuBackend, type MdFrame } from './backend-cpu'
import { MdGpuBackend } from './backend-gpu'
import { MD_KNOBS } from './schema'

export const mdSubstrate: Substrate<MdFrame> = {
  id: 'md',
  label: '分子动力学',
  blurb: '只模拟最底层：牛顿定律加一条两体势。右侧各层由粒子数据算出，虚线是理论预言。',
  stepLabel: '步数',
  knobs: MD_KNOBS,
  quantities: MD_QUANTITIES,
  create: (p, seed, gpu) => (p.backend && gpu ? new MdGpuBackend(gpu, p, seed) : new MdCpuBackend(p, seed)),
}
