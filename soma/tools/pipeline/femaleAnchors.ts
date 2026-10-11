// 读取 tools/register 生成的女性锚点包（data/raw/female/out/anchors，见其 README.md）：
// 由 Visible Human Female CT 分割出的结构（VF_*，scanned）、丹佛大学同一供体的冰冻切片模型
// （VD_*：下肢与骨盆的肌、单块跗骨、膝韧带、关节软骨）以及 Human Reference Atlas 的女性器官
// （HRA_*，curated），全部处于同一坐标系，轴向和单位与本项目一致。
// Reader for the female anchor package built by tools/register (data/raw/female/out/anchors, see
// its README.md): structures segmented from the Visible Human Female CT (VF_*, scanned), the
// University of Denver cryosection models of the same donor (VD_*: leg and pelvis muscles, single
// tarsals, knee ligaments, articular cartilages) and female-specific organs from the Human
// Reference Atlas (HRA_*, curated), all in one frame that uses our axes and units.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Mesh } from './geometry.ts'

export const FEMALE_ANCHOR_DIR = join(import.meta.dirname, '../../data/raw/female/out/anchors')

interface MeshRef {
  positions: { byteOffset: number; count: number }
  indices: { byteOffset: number; count: number }
}

export interface FemaleItem {
  id: string
  name: string
  side: 'L' | 'R' | 'M'
  kind: 'bone' | 'bone-group' | 'cartilage' | 'organ' | 'vessel' | 'muscle' | 'surface' | 'tooth' | 'ligament'
  provenance: 'scanned' | 'curated'
  source: string
  fma: string | null
  ontology_id: string | null
  male_parts: string[]
  correspondence: 'one-to-one' | 'group' | 'none'
  quality: 'good' | 'usable' | 'poor'
  quality_reasons: string[]
  pose: 'both' | 'scanned-only'
  /** 行主序 4x4，扫描姿势 → 重新摆姿势（null 表示不变） / row-major 4x4, scanned → re-posed (null = unchanged) */
  repose: number[] | null
  volume_ml: number
  mesh: { scanned: MeshRef; reposed: MeshRef | null }
  /** 两个来源覆盖同一结构时：是否用本条目，以及另一来源的条目 id / where two sources cover one structure: use this one or not, and the other source's ids */
  preferred?: boolean
  alternatives?: string[]
  /** （Denver 骨）与之重合的 CT 锚点 / (Denver bones) the CT anchor this bone coincides with */
  duplicates?: string
  /** （Denver）骨骼摆姿势时本条目跟随的骨：肌和韧带有起点、止点 / (Denver) bones the item moves with when the skeleton is re-posed: origin and insertion for muscles and ligaments */
  follows?: { origin?: string[]; insertion?: string[]; bones: string[] }
  attribution?: string
  license?: string
}

export interface FemaleAnchors {
  items: FemaleItem[]
  byId: Map<string, FemaleItem>
  sources: { id: string; name: string; url: string; license: string; attribution: string }[]
  jointCentres: Record<string, { scanned: [number, number, number]; reposed: [number, number, number]; male: [number, number, number] }>
  /** 扫描时的网格（仰卧，手放在骨盆上） / mesh as scanned (supine, hands on the pelvis) */
  scanned(item: FemaleItem): Mesh
  /** 应用了包内上肢重摆姿势的网格；仅限扫描姿势的条目为 null / mesh with the package's arm re-posing applied; null for scanned-only items */
  reposed(item: FemaleItem): Mesh | null
}

export function hasFemaleAnchors(dir = FEMALE_ANCHOR_DIR): boolean {
  return existsSync(join(dir, 'manifest.json')) && existsSync(join(dir, 'scanned.bin')) && existsSync(join(dir, 'reposed.bin'))
}

export function loadFemaleAnchors(dir = FEMALE_ANCHOR_DIR): FemaleAnchors {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { items: FemaleItem[]; sources: FemaleAnchors['sources']; pose: { joint_centres: FemaleAnchors['jointCentres'] } }
  const bins = { scanned: readFileSync(join(dir, 'scanned.bin')), reposed: readFileSync(join(dir, 'reposed.bin')) }
  const read = (buf: Buffer, ref: MeshRef): Mesh => ({
    positions: new Float32Array(Uint8Array.from(buf.subarray(ref.positions.byteOffset, ref.positions.byteOffset + ref.positions.count * 12)).buffer),
    indices: new Uint32Array(Uint8Array.from(buf.subarray(ref.indices.byteOffset, ref.indices.byteOffset + ref.indices.count * 4)).buffer),
  })
  return {
    items: manifest.items,
    byId: new Map(manifest.items.map((i) => [i.id, i])),
    sources: manifest.sources,
    jointCentres: manifest.pose.joint_centres,
    scanned: (item) => read(bins.scanned, item.mesh.scanned),
    reposed: (item) => (item.mesh.reposed ? read(bins.reposed, item.mesh.reposed) : null),
  }
}
