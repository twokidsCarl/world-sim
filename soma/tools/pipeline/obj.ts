// Minimal, fast Wavefront OBJ reader for BodyParts3D element files.
// Handles `v`, `vn` and `f` records with any of the index forms v, v/vt, v//vn, v/vt/vn,
// negative (relative) indices and polygons (fan-triangulated). Everything else is skipped.

export interface ObjHeader {
  fileId?: string
  representationId?: string
  conceptId?: string
  name?: string
  /** Source bounds in mm: [minX, minY, minZ, maxX, maxY, maxZ]. */
  bounds?: [number, number, number, number, number, number]
  /** cm³ */
  volume?: number
  buildUp?: string
}

export interface ObjMesh {
  header: ObjHeader
  /** xyz triples, source units and axes. */
  positions: Float32Array
  /** Triangle vertex indices into `positions`. */
  indices: Uint32Array
  /** Source normals re-indexed per position, or null when the file has none / they are indexed differently. */
  normals: Float32Array | null
}

const NUM = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g

export function parseObjHeader(text: string): ObjHeader {
  const h: ObjHeader = {}
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.startsWith('#')) {
      if (raw.trim() === '') continue
      break
    }
    const m = /^#\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(raw)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    const value = m[2]!
    if (key === 'file id') h.fileId = value
    else if (key === 'representation id') h.representationId = value
    else if (key === 'concept id') h.conceptId = value
    else if (key === 'english name') h.name = value
    else if (key === 'build-up logic') h.buildUp = value
    else if (key.startsWith('bounds')) {
      const n = (value.match(NUM) ?? []).map(Number)
      if (n.length === 6) h.bounds = n as ObjHeader['bounds']
    } else if (key.startsWith('volume')) {
      const v = Number(value)
      if (Number.isFinite(v)) h.volume = v
    }
  }
  return h
}

const SP = 32
const TAB = 9
const LF = 10
const CR = 13
const HASH = 35
const SLASH = 47
const MINUS = 45
const PLUS = 43
const DOT = 46
const CH_v = 118
const CH_n = 110
const CH_f = 102
const CH_e = 101
const CH_E = 69

export function parseObj(bytes: Uint8Array): ObjMesh {
  const len = bytes.length
  // Header: leading comment block.
  let headEnd = 0
  while (headEnd < len) {
    const c = bytes[headEnd]!
    if (c !== HASH && c !== LF && c !== CR) break
    while (headEnd < len && bytes[headEnd] !== LF) headEnd++
    headEnd++
  }
  const header = parseObjHeader(new TextDecoder().decode(bytes.subarray(0, Math.min(headEnd, len))))

  let pos = new Float32Array(3 * 4096)
  let nrm = new Float32Array(3 * 4096)
  let idx = new Uint32Array(3 * 8192)
  let nIdx = new Uint32Array(3 * 8192)
  let nv = 0
  let nn = 0
  let ni = 0
  let anyNormalIndex = false

  let i = 0
  // Parses a float starting at i (after skipping blanks); leaves i after it.
  const readFloat = (): number => {
    while (i < len && (bytes[i] === SP || bytes[i] === TAB)) i++
    let sign = 1
    let c = bytes[i]!
    if (c === MINUS) {
      sign = -1
      i++
    } else if (c === PLUS) i++
    let mant = 0
    let scale = 0
    let seenDot = false
    let digits = 0
    for (; i < len; i++) {
      c = bytes[i]!
      if (c >= 48 && c <= 57) {
        mant = mant * 10 + (c - 48)
        if (seenDot) scale++
        digits++
      } else if (c === DOT && !seenDot) seenDot = true
      else break
    }
    if (digits === 0) return NaN
    let exp = 0
    if (c === CH_e || c === CH_E) {
      i++
      let es = 1
      if (bytes[i] === MINUS) {
        es = -1
        i++
      } else if (bytes[i] === PLUS) i++
      for (; i < len; i++) {
        c = bytes[i]!
        if (c >= 48 && c <= 57) exp = exp * 10 + (c - 48)
        else break
      }
      exp *= es
    }
    return (sign * mant) / 10 ** (scale - exp)
  }
  const readInt = (): number => {
    let sign = 1
    if (bytes[i] === MINUS) {
      sign = -1
      i++
    }
    let v = 0
    let digits = 0
    for (; i < len; i++) {
      const c = bytes[i]!
      if (c >= 48 && c <= 57) {
        v = v * 10 + (c - 48)
        digits++
      } else break
    }
    return digits ? sign * v : NaN
  }

  const corner: number[] = []
  const cornerN: number[] = []
  while (i < len) {
    const c = bytes[i]!
    const c1 = bytes[i + 1]
    if (c === CH_v && (c1 === SP || c1 === TAB)) {
      i += 2
      if (3 * nv + 3 > pos.length) {
        const g = new Float32Array(pos.length * 2)
        g.set(pos)
        pos = g
      }
      pos[3 * nv] = readFloat()
      pos[3 * nv + 1] = readFloat()
      pos[3 * nv + 2] = readFloat()
      nv++
    } else if (c === CH_v && c1 === CH_n) {
      i += 2
      if (3 * nn + 3 > nrm.length) {
        const g = new Float32Array(nrm.length * 2)
        g.set(nrm)
        nrm = g
      }
      nrm[3 * nn] = readFloat()
      nrm[3 * nn + 1] = readFloat()
      nrm[3 * nn + 2] = readFloat()
      nn++
    } else if (c === CH_f && (c1 === SP || c1 === TAB)) {
      i += 2
      corner.length = 0
      cornerN.length = 0
      for (;;) {
        while (i < len && (bytes[i] === SP || bytes[i] === TAB)) i++
        if (i >= len || bytes[i] === LF || bytes[i] === CR) break
        let vi = readInt()
        if (Number.isNaN(vi)) break
        vi = vi < 0 ? nv + vi : vi - 1
        let vnI = -1
        if (bytes[i] === SLASH) {
          i++
          if (bytes[i] !== SLASH) readInt() // texture index, unused
          if (bytes[i] === SLASH) {
            i++
            const n = readInt()
            if (!Number.isNaN(n)) vnI = n < 0 ? nn + n : n - 1
          }
        }
        corner.push(vi)
        cornerN.push(vnI)
      }
      for (let k = 1; k + 1 < corner.length; k++) {
        if (ni + 3 > idx.length) {
          const g = new Uint32Array(idx.length * 2)
          g.set(idx)
          idx = g
          const gn = new Uint32Array(nIdx.length * 2)
          gn.set(nIdx)
          nIdx = gn
        }
        idx[ni] = corner[0]!
        idx[ni + 1] = corner[k]!
        idx[ni + 2] = corner[k + 1]!
        const a = cornerN[0]!
        const b = cornerN[k]!
        const d = cornerN[k + 1]!
        if (a >= 0 && b >= 0 && d >= 0) anyNormalIndex = true
        nIdx[ni] = a >>> 0
        nIdx[ni + 1] = b >>> 0
        nIdx[ni + 2] = d >>> 0
        ni += 3
      }
    }
    while (i < len && bytes[i] !== LF) i++
    i++
  }

  const positions = pos.slice(0, 3 * nv)
  const indices = idx.slice(0, ni)
  for (let k = 0; k < ni; k++) {
    if (indices[k]! >= nv) throw new Error(`OBJ face references vertex ${indices[k]! + 1} of ${nv}`)
  }
  // Per-position normals: only when every corner's normal index is valid; with split normals the
  // last one seen for a position wins (BodyParts3D always uses v//vn with equal indices).
  let normals: Float32Array | null = null
  if (anyNormalIndex && nn > 0) {
    normals = new Float32Array(3 * nv)
    for (let k = 0; k < ni; k++) {
      const n = nIdx[k]!
      if (n >= nn) {
        normals = null
        break
      }
      const v = indices[k]!
      normals[3 * v] = nrm[3 * n]!
      normals[3 * v + 1] = nrm[3 * n + 1]!
      normals[3 * v + 2] = nrm[3 * n + 2]!
    }
  }
  return { header, positions, indices, normals }
}
