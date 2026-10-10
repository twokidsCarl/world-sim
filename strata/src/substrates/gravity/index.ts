import type { Substrate } from '../../core/substrate'
import { GRAVITY_QUANTITIES } from '../../levels/gravity'
import { GravityCpuBackend, GravityGpuBackend, type GravityFrame } from './backend'
import { GRAVITY_KNOBS } from './schema'

export const gravitySubstrate: Substrate<GravityFrame> = {
  id: 'gravity',
  label: '引力 N 体',
  blurb: '只模拟最底层：每两个天体之间的牛顿引力。这是独立的场景，尺度与分子相差约 38 个数量级。',
  stepLabel: '步数',
  knobs: GRAVITY_KNOBS,
  quantities: GRAVITY_QUANTITIES,
  create: (p, seed, gpu) => (p.backend && gpu ? new GravityGpuBackend(gpu, p, seed) : new GravityCpuBackend(p, seed)),
}
