// Reader for the female anchor package built by tools/register (data/raw/female/out/anchors, see
// its README.md): structures segmented from the Visible Human Female CT (VF_*, scanned) and
// female-specific organs from the Human Reference Atlas (HRA_*, curated), all in one frame that
// uses our axes and units.

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
  /** row-major 4x4, scanned → re-posed (null = unchanged) */
  repose: number[] | null
  volume_ml: number
  mesh: { scanned: MeshRef; reposed: MeshRef | null }
}

export interface FemaleAnchors {
  items: FemaleItem[]
  byId: Map<string, FemaleItem>
  sources: { id: string; name: string; url: string; license: string; attribution: string }[]
  jointCentres: Record<string, { scanned: [number, number, number]; reposed: [number, number, number]; male: [number, number, number] }>
  /** mesh as scanned (supine, hands on the pelvis) */
  scanned(item: FemaleItem): Mesh
  /** mesh with the package's arm re-posing applied; null for scanned-only items */
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
