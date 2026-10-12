import { El, type Molecule } from '../mol/types'
import { chainPainter, type Annotation, type ColorMode } from './annotate'
import { oklch, type RGB } from './oklab'
import { ROLE_HUE, TONE_MOLECULE, type Role, type Tone } from './palettes'

/** 一个结构怎么上色：每个实体一个角色，可选的精确颜色 / How one structure is coloured: a role per entity, optional exact colours. */
export interface Coloring {
  roles: Role[]
  /**
   * 每个实体的色相偏移（度），加到角色的色相上；由 spreadHues 设置
   * per-entity hue shift in degrees, added to the role's hue; set by spreadHues
   */
  hueShift: number[]
  /** 每个实体的手动色相调整（度），角色变化时保留 / per-entity manual hue adjustment in degrees, kept when roles change */
  nudge: number[]
  /** 每个实体的覆盖值 [L, C, h]；优先于角色和偏移 / per-entity override as [L, C, h]; wins over role and shift */
  override: (null | [number, number, number])[]
  /** 上色方式；缺省是按角色 / the colour mode; by role when absent */
  mode?: ColorMode
}

/** 在不了解结构是什么的情况下，给出一套合理的配色 / A reasonable colouring with no outside knowledge of what the structure is. */
export function defaultColoring(mol: Molecule): Coloring {
  const proteinRoles: Role[] = ['soluble', 'membrane', 'focus', 'extracellular']
  let p = 0
  const hasNucleic = mol.entities.some((e) => e.kind === 'dna' || e.kind === 'rna')
  const roles = mol.entities.map((e): Role => {
    switch (e.kind) {
      case 'dna': case 'rna': return 'nucleic'
      case 'glycan': return 'glycan'
      case 'ion': return 'ion'
      case 'lipid': return 'membrane'
      case 'ligand': return 'ligand'
      default:
        if (hasNucleic) return p++ === 0 ? 'soluble' : proteinRoles[p % proteinRoles.length]!
        return proteinRoles[p++ % proteinRoles.length]!
    }
  })
  return spreadHues({ roles, hueShift: roles.map(() => 0), nudge: roles.map(() => 0), override: roles.map(() => null) })
}

/** 同一角色的实体在该角色的色相范围内展开 / Entities sharing a role are fanned out across that role's hue range. */
export function spreadHues(c: Coloring): Coloring {
  const byRole = new Map<Role, number[]>()
  c.roles.forEach((r, i) => byRole.set(r, [...(byRole.get(r) ?? []), i]))
  const hueShift = c.hueShift.slice()
  for (const [role, idx] of byRole) {
    const spread = ROLE_HUE[role].spread
    idx.forEach((e, k) => {
      hueShift[e] = idx.length === 1 ? 0 : -spread + (2 * spread * k) / (idx.length - 1)
    })
  }
  return { ...c, hueShift }
}

export function entityLch(c: Coloring, entity: number, tone: Tone): [number, number, number] {
  const o = c.override[entity]
  if (o) return o
  const r = ROLE_HUE[c.roles[entity] ?? 'soluble']
  return [tone.L + r.L, tone.C * r.C, (r.h + (c.hueShift[entity] ?? 0) + (c.nudge[entity] ?? 0) + 720) % 360]
}

/**
 * 每个原子一个 RGBA8。同一实体的各条链在色相和明度上略有交替，以便分清相邻的拷贝；
 * 碳原子比同链的其他原子略灰。
 * Per-atom RGBA8. Chains of one entity alternate slightly in hue and
 * lightness so that neighbouring copies can be told apart; carbons are a
 * little greyer than the other atoms of their chain.
 */
export function atomColors(mol: Molecule, c: Coloring, tone: Tone = TONE_MOLECULE, annotation?: Annotation | null): Uint8Array {
  const out = new Uint8Array(mol.atomCount * 4)
  const seen = new Map<number, number>()
  let chainIndex = -1
  for (const ch of mol.chains) {
    chainIndex++
    const k = seen.get(ch.entity) ?? 0
    seen.set(ch.entity, k + 1)
    const [L, C, h] = entityLch(c, ch.entity, tone)
    // 膜是一片均匀的颜色，不按链变化 / a membrane is one even wash, with no variation from chain to chain
    const flat = mol.entities[ch.entity]!.kind === 'lipid'
    // 0、+1、-1、+2、-2 …… 每步 9 度（或色调自己定的步长），五条链后循环
    // 0, +1, -1, +2, -2 ... steps of 9 degrees (or the tone's own step), wrapping after five chains
    const step = flat ? 0 : ((k % 5) + 1) >> 1
    const dh = (k % 5) % 2 === 1 ? step * (tone.hueStep ?? 9) : -step * (tone.hueStep ?? 9)
    const dL = flat || tone.flatChains ? 0 : (k % 2 === 0 ? 0 : -0.035) + (k % 3 === 2 ? 0.02 : 0)
    const other = to8(oklch(L + dL, C, h + dh))
    const carbon = to8(oklch(L + dL + tone.carbonLift, Math.max(0, C - tone.carbonDrop), h + dh))
    // 按残基上色的方式（置信度、结构域、位点、致病性）：有数据的链整条改用残基的颜色
    // per-residue modes (confidence, domains, sites, pathogenicity): a chain with data takes its residues' colours instead
    const paint = c.mode && c.mode !== 'role' ? chainPainter(c.mode, mol, chainIndex, annotation) : null
    const cache = new Map<string, [RGB, RGB]>()
    for (let i = ch.start; i < ch.start + ch.count; i++) {
      const lch = paint ? paint(i) : null
      if (lch) {
        const key = lch.join()
        let pair = cache.get(key)
        if (!pair) {
          pair = [to8(oklch(lch[0], lch[1], lch[2])), to8(oklch(lch[0] + tone.carbonLift, Math.max(0, lch[1] - tone.carbonDrop), lch[2]))]
          cache.set(key, pair)
        }
        const col = pair[mol.element[i] === El.C ? 1 : 0]
        out[i * 4] = col[0]
        out[i * 4 + 1] = col[1]
        out[i * 4 + 2] = col[2]
        out[i * 4 + 3] = 255
        continue
      }
      const col = mol.element[i] === El.C ? carbon : other
      out[i * 4] = col[0]
      out[i * 4 + 1] = col[1]
      out[i * 4 + 2] = col[2]
      out[i * 4 + 3] = 255
    }
  }
  return out
}

const to8 = (c: RGB): RGB => [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)]

/**
 * Illustrate 的半径：碳 1.6，硫和磷 1.8，其余 1.5 Å。
 * Illustrate's radii: carbon 1.6, sulfur and phosphorus 1.8, others 1.5 Å.
 */
export function atomRadii(mol: Molecule): Float32Array {
  const r = new Float32Array(mol.atomCount)
  for (let i = 0; i < mol.atomCount; i++) {
    const given = mol.radius?.[i]
    if (given) {
      r[i] = given
      continue
    }
    const e = mol.element[i]
    r[i] = e === El.C ? 1.6 : e === El.S || e === El.P ? 1.8 : e === El.Other ? 1.8 : 1.5
  }
  return r
}
