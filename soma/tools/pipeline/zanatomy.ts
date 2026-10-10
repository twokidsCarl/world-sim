// Reader for the Z-Anatomy / Open3DModel import package built by tools/zanatomy
// (data/raw/z-anatomy/out/import, see its README.md). Geometry there is in the source atlas
// frames ("za", "o3d") converted to our axes and units but NOT registered to BodyParts3D.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Mesh } from './geometry.ts'
import { parseTsv } from './tables.ts'

export const ZA_DIR = join(import.meta.dirname, '../../data/raw/z-anatomy/out/import')
export const FMA_NAMES = join(import.meta.dirname, '../../data/raw/z-anatomy/fma/fma_names.tsv')

export interface ZaMeshRef {
  file: string
  vOffset: number
  vCount: number
  iOffset: number
  iCount: number
}

export interface ZaItem {
  id: string
  source: 'z-anatomy' | 'open3dmodel'
  frame: 'za' | 'o3d'
  name: string
  side: 'L' | 'R' | 'M'
  fma: string | null
  fmaUnsided?: string | null
  fmaSided?: boolean
  /** lateralised item whose `fma` is the unsided class */
  fmaIsUnsided?: boolean
  fmaMatch?: string
  fmaUnsidedLabel?: string
  fmaLabel?: string
  system: string
  tissue: string
  kind: 'nerve' | 'mesh'
  category?: string
  candidate?: boolean
  preferred?: boolean
  alsoInBp3d30?: boolean
  inBp3d40?: boolean
  centrelineIncomplete?: boolean
  files: { mesh?: ZaMeshRef; centreline?: { key: string; branches: number } } | null
  triangles: number
  bbox: number[]
}

export interface ZaAnchor {
  id: string
  source: 'z-anatomy' | 'open3dmodel'
  frame: 'za' | 'o3d'
  name: string
  side: 'L' | 'R' | 'M'
  bp3dIds: string[]
  fma: string | null
  anchorClass: 'bone' | 'soft'
  tissue: string
  icp: { R: number[][]; t: [number, number, number] }
  residualMeanMm: number
  residualP95Mm: number
  resculpted: boolean
  quality: string
  files: { mesh: ZaMeshRef }
}

export interface ZaBranch {
  points: number[][]
  radius: number[]
}

export interface ZaPackage {
  items: ZaItem[]
  anchors: ZaAnchor[]
  sources: { id: string; name: string; url?: string; license: string; attribution: string }[]
  mesh(ref: ZaMeshRef): Mesh
  centreline(item: ZaItem): ZaBranch[] | null
}

export function hasZa(dir = ZA_DIR): boolean {
  return existsSync(join(dir, 'manifest.json')) && existsSync(join(dir, 'centrelines.json'))
}

export function loadZa(dir = ZA_DIR): ZaPackage {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { items: ZaItem[]; anchors: ZaAnchor[]; sources: ZaPackage['sources'] }
  const centrelines = JSON.parse(readFileSync(join(dir, 'centrelines.json'), 'utf8')) as Record<string, ZaBranch[]>
  const bins = new Map<string, Buffer>()
  const mesh = (ref: ZaMeshRef): Mesh => {
    if (!/^[\w.-]+\.bin$/.test(ref.file)) throw new Error(`unexpected mesh file ${ref.file}`)
    let buf = bins.get(ref.file)
    if (!buf) bins.set(ref.file, (buf = readFileSync(join(dir, ref.file))))
    // copy out: the offsets are not guaranteed to be 4-byte aligned within the Buffer's pool
    const v = buf.subarray(ref.vOffset, ref.vOffset + ref.vCount * 12)
    const i = buf.subarray(ref.iOffset, ref.iOffset + ref.iCount * 4)
    return { positions: new Float32Array(Uint8Array.from(v).buffer), indices: new Uint32Array(Uint8Array.from(i).buffer) }
  }
  return {
    items: manifest.items,
    anchors: manifest.anchors,
    sources: manifest.sources,
    mesh,
    centreline: (item) => (item.files?.centreline ? (centrelines[item.files.centreline.key] ?? null) : null),
  }
}

export interface FmaNames {
  label: Map<string, string>
  /** is-a parents (FMA 5.1.0) */
  parents: Map<string, string[]>
}

/** FMA labels and is-a parents extracted by tools/zanatomy/fma_extract.py; null when absent. */
export function loadFmaNames(path = FMA_NAMES): FmaNames | null {
  if (!existsSync(path)) return null
  const label = new Map<string, string>()
  const parents = new Map<string, string[]>()
  for (const r of parseTsv(readFileSync(path, 'utf8')).rows) {
    if (!r[0]) continue
    label.set(r[0], r[1] ?? r[0])
    parents.set(r[0], (r[4] ?? '').split('|').filter((p) => /^FMA\d+$/.test(p)).map((p) => 'FMA' + String(Number(p.slice(3)))))
  }
  return { label, parents }
}

/** Display name in the BodyParts3D style: "Left median nerve", "Right C5 root of brachial plexus". */
export function displayName(name: string, side: 'L' | 'R' | 'M'): string {
  // TA2 puts inconstant structures in parentheses: "(Anterior tibial node)"
  let n = name.trim()
  const m = /^\((.*)\)$/.exec(n)
  if (m && !m[1]!.includes('(')) n = m[1]!
  if (side === 'M') return n
  const lower = /^[A-Z][a-z]/.test(n) ? n[0]!.toLowerCase() + n.slice(1) : n
  return `${side === 'L' ? 'Left' : 'Right'} ${lower}`
}
