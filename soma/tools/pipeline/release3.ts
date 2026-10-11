// BodyParts3D release 3.0 (2011): loader. Files are named by concept id (FMA…, BP…, "…nsn" for
// "not otherwise specified" remainders), carry no descriptive header, and use the same source
// frame as 4.0 (mm, Z up) — but NOT the same body pose/proportions, see import3.ts.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { RELEASE3_SWAPPED_GEOMETRY } from './corrections.ts'
import { measure, sourceToRuntime, weld, type Mesh, type MeshStats } from './geometry.ts'
import { parseObj } from './obj.ts'
import { parseTsv } from './tables.ts'

export const RAW3_DIR = join(import.meta.dirname, '../../data/raw/bodyparts3d-3.0')
export const OBJ3_DIR = 'obj_99'

export interface Release3Part {
  /** file id, e.g. "FMA7197", "FMA14543nsn", "BP24" */
  id: string
  name: string
  /** welded mesh in the runtime frame (metres, Y up) of the 3.0 body */
  mesh: Mesh
  stats: MeshStats
  sourceTriangles: number
}

export interface Release3 {
  parts: Map<string, Release3Part>
  /** concept id -> English name (all 1,523 concepts, including composites without a file) */
  names: Map<string, string>
  /** conventional tree: concept id -> parent concept ids (multi-parent) */
  parents: Map<string, string[]>
}

const unquote = (s: string) => s.replace(/^"|"$/g, '')

export function parseRelease3Tables(partsListTsv: string, conventionalPartOfTsv: string): Pick<Release3, 'names' | 'parents'> {
  const names = new Map<string, string>()
  for (const r of parseTsv(partsListTsv).rows) if (r[0] && r[1]) names.set(unquote(r[0]), r[1])
  const parents = new Map<string, string[]>()
  for (const r of parseTsv(conventionalPartOfTsv).rows) {
    const [pid, pname, cid, cname] = r.map(unquote)
    if (!pid || !cid) continue
    if (pname && !names.has(pid)) names.set(pid, pname)
    if (cname && !names.has(cid)) names.set(cid, cname)
    let list = parents.get(cid)
    if (!list) parents.set(cid, (list = []))
    if (!list.includes(pid)) list.push(pid)
  }
  return { names, parents }
}

/** Is release 3.0 available on disk? */
export function hasRelease3(dir = RAW3_DIR): boolean {
  return existsSync(join(dir, OBJ3_DIR)) && existsSync(join(dir, 'parts_list_e.txt')) && existsSync(join(dir, 'conventional_part_of.txt'))
}

export function loadRelease3(dir = RAW3_DIR): Release3 {
  const tables = parseRelease3Tables(readFileSync(join(dir, 'parts_list_e.txt'), 'utf8'), readFileSync(join(dir, 'conventional_part_of.txt'), 'utf8'))
  const parts = new Map<string, Release3Part>()
  for (const f of readdirSync(join(dir, OBJ3_DIR)).sort()) {
    const m = /^([A-Za-z0-9]+)\.obj$/.exec(f)
    if (!m) continue
    const id = m[1]!
    const obj = parseObj(readFileSync(join(dir, OBJ3_DIR, f)))
    if (obj.indices.length === 0) continue
    const w = weld(sourceToRuntime(obj.positions), obj.indices)
    const mesh: Mesh = { positions: w.positions, indices: w.indices }
    parts.set(id, { id, name: tables.names.get(id) ?? id, mesh, stats: measure(mesh), sourceTriangles: obj.indices.length / 3 })
  }
  // 源数据里几何互相放错文件的概念对：互换网格，id 和名称不动（证据见 corrections.ts）
  // concept pairs whose files hold each other's geometry in the source: the meshes are swapped, ids and names stay (evidence in corrections.ts)
  for (const [a, b] of RELEASE3_SWAPPED_GEOMETRY) {
    const pa = parts.get(a)
    const pb = parts.get(b)
    if (!pa || !pb) continue
    parts.set(a, { ...pa, mesh: pb.mesh, stats: pb.stats, sourceTriangles: pb.sourceTriangles })
    parts.set(b, { ...pb, mesh: pa.mesh, stats: pa.stats, sourceTriangles: pa.sourceTriangles })
  }
  return { parts, ...tables }
}

/** FMA id behind a 3.0 file id: strips the "nsn" suffix; null for BodyParts3D-private BP ids. */
export function fmaOf(id: string): string | null {
  const m = /^(FMA\d+)(nsn)?$/.exec(id)
  return m ? m[1]! : null
}

/**
 * Breadth-first walk up the conventional tree from `id` (excluded). Calls `visit` for each
 * ancestor with its distance; stop descending a branch by returning true.
 */
export function walkAncestors(parents: Map<string, string[]>, id: string, visit: (ancestor: string, distance: number) => boolean | void): void {
  const seen = new Set<string>([id])
  let frontier = [id]
  for (let d = 1; frontier.length; d++) {
    const next: string[] = []
    for (const c of frontier) {
      for (const p of parents.get(c) ?? []) {
        if (seen.has(p)) continue
        seen.add(p)
        if (!visit(p, d)) next.push(p)
      }
    }
    frontier = next
  }
}
