import { IDENTITY, type Assembly, type Molecule } from './types'

/**
 * 冷冻电镜断层扫描里挑出的粒子位置（CZ CryoET 数据门户的 ndjson 格式）：每行一个粒子，位置以体素为单位。
 * 返回 Å 为单位的坐标。
 * Particle positions picked from a cryo-electron tomogram, in the ndjson format of the CZ CryoET
 * Data Portal: one particle per line, located in voxels. Returns coordinates in Å.
 */
export function parsePicks(ndjson: string, voxelSpacing: number): Float32Array {
  return readPicks(ndjson, voxelSpacing).points
}

/**
 * 同上，并读出每个粒子的朝向矩阵（按行排的 3x3）。矩阵把模板坐标系里的偏移转到断层扫描里：
 * 断层扫描里的位置 = 粒子位置 + R · 模板里的偏移。这个读法是用断层扫描本身检验出来的
 * （research/cryoet/orient.py）：按它叠出的平均有清楚的核糖体形状，按转置叠出的只是个球。
 * 有任何一个粒子没给矩阵时，rotations 为 null。
 *
 * The same, with each particle's orientation matrix (3x3, row by row). The matrix carries an offset
 * in the template's frame into the tomogram: position in the tomogram = particle position + R x
 * offset in the template. That reading was checked against the tomogram itself
 * (research/cryoet/orient.py): averaging by it gives a clear ribosome, averaging by the transpose
 * only a ball. `rotations` is null when any particle comes without a matrix.
 */
export function readPicks(ndjson: string, voxelSpacing: number): { points: Float32Array; rotations: Float32Array | null } {
  const out: number[] = [], rot: number[] = []
  let complete = true
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue
    let o: { location?: { x?: unknown; y?: unknown; z?: unknown }; xyz_rotation_matrix?: unknown }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const l = o.location
    if (!l || typeof l.x !== 'number' || typeof l.y !== 'number' || typeof l.z !== 'number') continue
    out.push(l.x * voxelSpacing, l.y * voxelSpacing, l.z * voxelSpacing)
    const m = o.xyz_rotation_matrix
    const flat = Array.isArray(m) ? m.flat() : []
    if (flat.length === 9 && flat.every((v) => typeof v === 'number' && Number.isFinite(v))) rot.push(...(flat as number[]))
    else complete = false
  }
  return { points: new Float32Array(out), rotations: complete && rot.length === out.length * 3 ? new Float32Array(rot) : null }
}

/**
 * 原子模型怎样放进模板坐标系（由 research/cryoet/orient.py 拟合得到）。
 * How the atomic model sits in the template's frame, as fitted by research/cryoet/orient.py.
 */
export interface TemplateFit {
  /** 按行排的 3x3 旋转 Q / the 3x3 rotation Q, row by row */
  rotation: number[]
  /** 模型的参考点（Å）：拟合时放在盒子中心的那一点 / the model's reference point in Å: what the fit put at the centre of the box */
  centre: [number, number, number]
  /** 旋转后再平移多少（Å，模板坐标系）/ the shift applied after the rotation, in Å, in the template's frame */
  shift: [number, number, number]
  /**
   * 断层扫描相对原子模型是镜像的：拟合用的是镜像后的模型。画的时候把整个场景沿 x 翻过来，
   * 这样用的仍是真实手性的原子模型。
   * The tomogram is a mirror image relative to the atomic model: the fit used the mirrored model.
   * For drawing, the whole scene is flipped along x, so the atomic model keeps its true hand.
   */
  mirrored: boolean
}

/**
 * 每个粒子按实测的位置和朝向放一份 `assembly`。
 * 模型上的点 p 在断层扫描里的位置是 x + R (Q S (p - c) + k)，其中 S 在镜像时把 x 取反；
 * 镜像时再把整个场景沿 x 翻回来，得到正常手性的变换 S R Q S 和平移 S (x + R k)。
 *
 * One copy of `assembly` for every particle, at its measured position and orientation.
 * A point p of the model lies at x + R (Q S (p - c) + k) in the tomogram, where S negates x when
 * mirrored; the whole scene is then flipped back along x, which gives the proper rotation S R Q S
 * and the translation S (x + R k).
 */
export function assemblyAtPicks(mol: Molecule, assembly: string, points: Float32Array, rotations: Float32Array, fit: TemplateFit, id = 'picks'): Assembly {
  const base = mol.assemblies.find((a) => a.id === assembly) ?? mol.assemblies[0]!
  const Q = fit.rotation, sx = fit.mirrored ? -1 : 1
  const placements: Float32Array[] = []
  for (let i = 0; i < points.length / 3; i++) {
    const R = rotations.subarray(i * 9, i * 9 + 9)
    // A = S R Q S，按行算 / A = S R Q S, computed row by row
    const A: number[] = []
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        let v = 0
        for (let k = 0; k < 3; k++) v += R[r * 3 + k]! * Q[k * 3 + c]!
        A.push(v * (r === 0 ? sx : 1) * (c === 0 ? sx : 1))
      }
    const T = [0, 1, 2].map((r) => (points[i * 3 + r]! + R[r * 3]! * fit.shift[0] + R[r * 3 + 1]! * fit.shift[1] + R[r * 3 + 2]! * fit.shift[2]) * (r === 0 ? sx : 1))
    // 先减去参考点，再旋转、平移 / subtract the reference point, then rotate and translate
    const t = [0, 1, 2].map((r) => T[r]! - (A[r * 3]! * fit.centre[0] + A[r * 3 + 1]! * fit.centre[1] + A[r * 3 + 2]! * fit.centre[2]))
    placements.push(new Float32Array([A[0]!, A[3]!, A[6]!, 0, A[1]!, A[4]!, A[7]!, 0, A[2]!, A[5]!, A[8]!, 0, t[0]!, t[1]!, t[2]!, 1]))
  }
  return { id, groups: base.groups.map((g) => ({ chains: g.chains, operators: placements.flatMap((m) => g.operators.map((op) => (op === IDENTITY ? m : mul4(m, op)))) })) }
}

/** 列主序 4x4 相乘 a·b / a times b for column-major 4x4 matrices */
function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16)
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + row]! * b[col * 4 + k]!
      o[col * 4 + row] = s
    }
  return o
}

/**
 * 给分子加一个组装体：在每个给定的位置放一份 `assembly`，朝向随机（由 `rand` 决定，可重复）。
 * 位置是分子中心要去的地方。
 * Add an assembly to a molecule: one copy of `assembly` at each given position, turned at random
 * (from `rand`, so it is repeatable). A position is where the molecule's centre goes.
 */
export function assemblyAtPoints(mol: Molecule, assembly: string, points: Float32Array, rand: () => number, id = 'picks'): Assembly {
  const base = mol.assemblies.find((a) => a.id === assembly) ?? mol.assemblies[0]!
  // 这个组装体的中心：各链原子在各算符下的平均位置 / the centre of that assembly: the mean position of its chains' atoms under its operators
  const c = [0, 0, 0]
  let n = 0
  for (const g of base.groups)
    for (const op of g.operators)
      for (const ci of g.chains) {
        const ch = mol.chains[ci]!
        const step = Math.max(1, Math.floor(ch.count / 50))
        for (let i = ch.start; i < ch.start + ch.count; i += step) {
          const x = mol.pos[i * 3]!, y = mol.pos[i * 3 + 1]!, z = mol.pos[i * 3 + 2]!
          c[0]! += op[0]! * x + op[4]! * y + op[8]! * z + op[12]!
          c[1]! += op[1]! * x + op[5]! * y + op[9]! * z + op[13]!
          c[2]! += op[2]! * x + op[6]! * y + op[10]! * z + op[14]!
          n++
        }
      }
  for (let k = 0; k < 3; k++) c[k]! /= Math.max(1, n)

  const placements: Float32Array[] = []
  for (let p = 0; p < points.length; p += 3) {
    // 均匀随机的旋转（四元数法）/ a uniformly random rotation, by the quaternion method
    const u1 = rand(), u2 = rand() * 2 * Math.PI, u3 = rand() * 2 * Math.PI
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1)
    const qx = a * Math.sin(u2), qy = a * Math.cos(u2), qz = b * Math.sin(u3), qw = b * Math.cos(u3)
    const r = [
      1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw),
      2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw),
      2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy),
    ]
    const t = [0, 1, 2].map((k) => points[p + k]! - (r[k]! * c[0]! + r[3 + k]! * c[1]! + r[6 + k]! * c[2]!))
    placements.push(new Float32Array([r[0]!, r[1]!, r[2]!, 0, r[3]!, r[4]!, r[5]!, 0, r[6]!, r[7]!, r[8]!, 0, t[0]!, t[1]!, t[2]!, 1]))
  }
  const mul = (x: Float32Array, y: Float32Array) => {
    if (y === IDENTITY) return x
    const o = new Float32Array(16)
    for (let col = 0; col < 4; col++)
      for (let row = 0; row < 4; row++) {
        let s = 0
        for (let k = 0; k < 4; k++) s += x[k * 4 + row]! * y[col * 4 + k]!
        o[col * 4 + row] = s
      }
    return o
  }
  return { id, groups: base.groups.map((g) => ({ chains: g.chains, operators: placements.flatMap((m) => g.operators.map((op) => mul(m, op))) })) }
}
