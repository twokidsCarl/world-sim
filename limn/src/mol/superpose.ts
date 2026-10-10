import type { Molecule } from './types'

/** Eigenvectors of a small symmetric matrix by Jacobi rotations; columns of v. */
function jacobi(a: number[][]): { values: number[]; vectors: number[][] } {
  const n = a.length
  const v: number[][] = a.map((_, i) => a.map((_, j) => (i === j ? 1 : 0)))
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p]![q]! ** 2
    if (off < 1e-18) break
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p]![q]!) < 1e-15) continue
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * a[p]![q]!)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1), s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k]![p]!, akq = a[k]![q]!
          a[k]![p] = c * akp - s * akq
          a[k]![q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p]![k]!, aqk = a[q]![k]!
          a[p]![k] = c * apk - s * aqk
          a[q]![k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!, vkq = v[k]![q]!
          v[k]![p] = c * vkp - s * vkq
          v[k]![q] = s * vkp + c * vkq
        }
      }
  }
  return { values: a.map((r, i) => r[i]!), vectors: v }
}

/**
 * Rigid transform (column-major 4x4) that best lays points `from` onto `to`
 * in the least-squares sense (Horn's quaternion method). Both are x,y,z
 * triples in matching order.
 */
export function fitRigid(from: number[], to: number[]): { matrix: Float32Array; rmsd: number } {
  const n = from.length / 3
  const cf = [0, 0, 0], ct = [0, 0, 0]
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      cf[k]! += from[i * 3 + k]! / n
      ct[k]! += to[i * 3 + k]! / n
    }
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) S[a]![b]! += (from[i * 3 + a]! - cf[a]!) * (to[i * 3 + b]! - ct[b]!)
  const [Sxx, Sxy, Sxz] = S[0] as [number, number, number], [Syx, Syy, Syz] = S[1] as [number, number, number], [Szx, Szy, Szz] = S[2] as [number, number, number]
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ]
  const { values, vectors } = jacobi(N)
  const best = values.indexOf(Math.max(...values))
  const [w, x, y, z] = [vectors[0]![best]!, vectors[1]![best]!, vectors[2]![best]!, vectors[3]![best]!]
  // rotation matrix rows
  const R = [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ]
  const t = [0, 1, 2].map((a) => ct[a]! - (R[a]![0]! * cf[0]! + R[a]![1]! * cf[1]! + R[a]![2]! * cf[2]!))
  let sq = 0
  for (let i = 0; i < n; i++)
    for (let a = 0; a < 3; a++) {
      const p = R[a]![0]! * from[i * 3]! + R[a]![1]! * from[i * 3 + 1]! + R[a]![2]! * from[i * 3 + 2]! + t[a]!
      sq += (p - to[i * 3 + a]!) ** 2
    }
  const matrix = new Float32Array([R[0]![0]!, R[1]![0]!, R[2]![0]!, 0, R[0]![1]!, R[1]![1]!, R[2]![1]!, 0, R[0]![2]!, R[1]![2]!, R[2]![2]!, 0, t[0]!, t[1]!, t[2]!, 1])
  return { matrix, rmsd: Math.sqrt(sq / n) }
}

/** Backbone trace atoms (protein Cα) of the largest protein chain, by residue number. */
function trace(mol: Molecule): Map<number, [number, number, number]> {
  let best = -1
  mol.chains.forEach((c, i) => {
    if (mol.entities[c.entity]!.kind === 'protein' && (best < 0 || c.count > mol.chains[best]!.count)) best = i
  })
  const out = new Map<number, [number, number, number]>()
  if (best < 0) return out
  const c = mol.chains[best]!
  for (let i = c.start; i < c.start + c.count; i++) {
    if (mol.isTrace[i]) out.set(mol.residue[i]!, [mol.pos[i * 3]!, mol.pos[i * 3 + 1]!, mol.pos[i * 3 + 2]!])
  }
  return out
}

/**
 * Transform that turns `mol` to match `reference`, by superposing the
 * largest protein chain of each on residues with the same number. Returns
 * null when the two do not share enough of a chain to compare (fewer than
 * 40 residues, or under 30% of the smaller chain).
 */
export function superpose(mol: Molecule, reference: Molecule): { matrix: Float32Array; rmsd: number; matched: number } | null {
  const a = trace(mol), b = trace(reference)
  const from: number[] = [], to: number[] = []
  for (const [res, p] of a) {
    const q = b.get(res)
    if (q) {
      from.push(...p)
      to.push(...q)
    }
  }
  const matched = from.length / 3
  if (matched < 40 || matched < 0.3 * Math.min(a.size, b.size)) return null
  return { ...fitRigid(from, to), matched }
}
