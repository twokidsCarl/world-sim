import type { Substrate } from '../../core/substrate'
import { MESH_QUANTITIES } from '../../levels/mesh'
import { MeshCpuBackend, MeshGpuBackend, type MeshFrame } from './backend'
import { MESH_KNOBS } from './schema'

export const meshSubstrate: Substrate<MeshFrame> = {
  id: 'mesh',
  label: '引力成团',
  blurb: '只模拟最底层：周期盒子里几十万个只受引力的粒子，几乎均匀地出发。右侧各层由粒子数据算出，虚线是理论预言。',
  stepLabel: '步数',
  knobs: MESH_KNOBS,
  quantities: MESH_QUANTITIES,
  create: (p, seed, gpu) => (p.backend && gpu ? new MeshGpuBackend(gpu, p, seed) : new MeshCpuBackend(p, seed)),
}
