// Shared materials: one per (system, tissue, variant). Parts never own a material; a
// highlighted part is simply switched to the hover / selected variant of its material.
//
// Section caps: when a section plane is active the opaque materials become double-sided
// and their back faces are written as a flat, unlit tissue colour (outputNode below). For
// closed meshes this reads as a filled cut surface instead of a hollow shell, with no
// stencil passes or cap geometry.

import { Color, DoubleSide, FrontSide, MeshBasicNodeMaterial, MeshStandardNodeMaterial, type Material } from 'three/webgpu'
import { frontFacing, output, select, uniform, vec4 } from 'three/tsl'
import { TISSUE_COLOR, TISSUE_OPACITY, TISSUE_ROUGHNESS } from '../anatomy/labels.ts'
import type { SystemDef, SystemId, TissueId } from '../anatomy/types.ts'

export type Variant = 'base' | 'hover' | 'selected'

const ACCENT = new Color('#3ec7d6')
const GHOST_COLOR = new Color('#8d99a6')
export const GHOST_OPACITY = 0.07
/** Parts drawn more transparent than this are not pickable (the pointer passes through). */
export const PICK_OPACITY = 0.4

interface Entry {
  material: MeshStandardNodeMaterial
  system: SystemId
  tissue: TissueId
  variant: Variant
}

export class PartMaterials {
  readonly ghost: Material
  /** Faint see-through tint drawn over selected parts so they can be located behind others. */
  readonly xray: Material
  private readonly entries = new Map<string, Entry>()
  private readonly systemColor = new Map<SystemId, string>()
  private readonly systemOpacity = new Map<SystemId, number>()
  private capped = false

  constructor(systems: readonly SystemDef[]) {
    for (const s of systems) this.systemColor.set(s.id, s.color)
    const g = new MeshStandardNodeMaterial({ color: GHOST_COLOR, roughness: 1, metalness: 0 })
    g.transparent = true
    g.opacity = GHOST_OPACITY
    g.depthWrite = false
    this.ghost = g
    const x = new MeshBasicNodeMaterial({ color: ACCENT })
    x.transparent = true
    x.opacity = 0.26
    x.depthTest = false
    x.depthWrite = false
    this.xray = x
  }

  tissueColor(system: SystemId, tissue: TissueId): Color {
    return new Color(TISSUE_COLOR[tissue] ?? this.systemColor.get(system) ?? '#9aa3ad')
  }

  /** Opacity the base variant is drawn with (tissue default × the system's slider). */
  effectiveOpacity(system: SystemId, tissue: TissueId): number {
    return (TISSUE_OPACITY[tissue] ?? 1) * (this.systemOpacity.get(system) ?? 1)
  }

  get(system: SystemId, tissue: TissueId, variant: Variant): Material {
    const key = `${system}|${tissue}|${variant}`
    let e = this.entries.get(key)
    if (!e) {
      e = { material: this.create(system, tissue, variant), system, tissue, variant }
      this.entries.set(key, e)
      this.apply(e)
    }
    return e.material
  }

  setSystemOpacity(system: SystemId, opacity: number): void {
    if ((this.systemOpacity.get(system) ?? 1) === opacity) return
    this.systemOpacity.set(system, opacity)
    for (const e of this.entries.values()) if (e.system === system) this.apply(e)
  }

  setCapped(on: boolean): void {
    if (this.capped === on) return
    this.capped = on
    for (const e of this.entries.values()) this.apply(e)
  }

  dispose(): void {
    for (const e of this.entries.values()) e.material.dispose()
    this.ghost.dispose()
    this.xray.dispose()
    this.entries.clear()
  }

  private create(system: SystemId, tissue: TissueId, variant: Variant): MeshStandardNodeMaterial {
    const base = this.tissueColor(system, tissue)
    const color = base.clone()
    const emissive = new Color(0x000000)
    if (variant === 'selected') {
      color.lerp(ACCENT, 0.55)
      emissive.copy(ACCENT).multiplyScalar(0.28)
    } else if (variant === 'hover') {
      color.lerp(new Color(0xffffff), 0.28)
      emissive.copy(base).multiplyScalar(0.18)
    }
    const m = new MeshStandardNodeMaterial({
      color,
      emissive,
      roughness: TISSUE_ROUGHNESS[tissue] ?? 0.55,
      metalness: 0,
    })
    // flat cut-surface colour: the (possibly highlighted) surface colour, slightly darkened
    const cap = uniform(color.clone().multiplyScalar(0.72))
    m.outputNode = select(frontFacing, output, vec4(cap, output.a))
    m.name = `${system}/${tissue}/${variant}`
    return m
  }

  private apply(e: Entry): void {
    const m = e.material
    // a selected part is shown solid so it can be found; hover keeps the base opacity
    const opacity = e.variant === 'selected' ? 1 : this.effectiveOpacity(e.system, e.tissue)
    const transparent = opacity < 0.999
    const side = this.capped && !transparent ? DoubleSide : FrontSide
    if (m.transparent !== transparent || m.side !== side) m.needsUpdate = true
    m.opacity = opacity
    m.transparent = transparent
    m.depthWrite = !transparent
    m.side = side
  }
}
