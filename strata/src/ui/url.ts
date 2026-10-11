// 地址栏里的直达参数：?embed=1 只留舞台，?substrate=ising 选底座，
// 其余与旋钮同名的参数（如 ?T=2.27&L=256）设置该旋钮。?scenario= 由引导实验栏处理。
// Deep-link parameters in the address bar: ?embed=1 keeps only the stage, ?substrate=ising
// picks the substrate, and any other parameter named after a knob (e.g. ?T=2.27&L=256)
// sets that knob. ?scenario= is handled by the scenario bar.

import { SUBSTRATES } from '../substrates'
import { engine } from './engine'

const query = new URLSearchParams(location.search)

export const EMBED = query.get('embed') === '1'

/**
 * 应用地址栏里的底座和旋钮取值。要在后端选择稳定之后调用；有 ?scenario= 时什么都不做，
 * 因为引导实验自己设置参数。
 * Apply the substrate and knob values from the address bar. Call it once the backend
 * choice has settled; does nothing when ?scenario= is present, since a guided
 * experiment sets its own parameters.
 */
export function applyUrl(): void {
  if (query.has('scenario')) return
  const substrate = query.get('substrate')
  if (substrate && SUBSTRATES.some((s) => s.id === substrate)) engine.setSubstrate(substrate)
  // 会重建状态的旋钮先设，其余的后设，免得被重建冲掉。
  // Knobs that rebuild the state go first, so the others are not lost to a rebuild.
  const knobs = [...engine.substrate.knobs].sort((a, b) => Number(b.rebuild === 'state') - Number(a.rebuild === 'state'))
  for (const knob of knobs) {
    const raw = query.get(knob.id)
    if (raw === null || raw === '' || knob.id === 'backend') continue
    const value = Number(raw)
    if (!Number.isFinite(value)) continue
    const clamped = Math.min(knob.max, Math.max(knob.min, value))
    if (engine.params[knob.id] !== clamped) engine.setParam(knob.id, clamped)
  }
}
