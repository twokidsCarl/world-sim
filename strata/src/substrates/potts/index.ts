import type { Substrate } from '../../core/substrate'
import { POTTS_QUANTITIES } from '../../levels/potts'
import { PottsCpuBackend, PottsGpuBackend, type PottsFrame } from './backend'
import { POTTS_KNOBS } from './schema'

export const pottsSubstrate: Substrate<PottsFrame> = {
  id: 'potts',
  label: 'Potts 模型',
  blurb: '只模拟最底层：每个格点有 q 种状态，按与近邻是否同态随机改变。右侧各层由格点数据算出，虚线是严格结果。',
  stepLabel: '扫描数',
  knobs: POTTS_KNOBS,
  quantities: POTTS_QUANTITIES,
  create: (p, seed, gpu) => (p.backend && gpu ? new PottsGpuBackend(gpu, p, seed) : new PottsCpuBackend(p, seed)),
}
