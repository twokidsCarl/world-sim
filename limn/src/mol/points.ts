import { IDENTITY, type Assembly, type Molecule } from './types'

/**
 * 冷冻电镜断层扫描里挑出的粒子位置（CZ CryoET 数据门户的 ndjson 格式）：每行一个粒子，位置以体素为单位。
 * 返回 Å 为单位的坐标。文件里还有每个粒子的朝向矩阵，这里不读：它参照的是挑粒子时用的模板的坐标系，
 * 和我们用的原子模型的坐标系对不上（试过四种解释，相邻核糖体都同样互相穿插），所以不采用。
 *
 * Particle positions picked from a cryo-electron tomogram, in the ndjson format of the CZ CryoET
 * Data Portal: one particle per line, located in voxels. Returns coordinates in Å. The file also
 * carries an orientation matrix per particle, which is not read here: it refers to the frame of
 * the template the particles were picked with, and that frame could not be matched to the atomic
 * model in use (under each of four readings, neighbouring ribosomes ran through one another just
 * as much), so it is not used.
 */
export function parsePicks(ndjson: string, voxelSpacing: number): Float32Array {
  const out: number[] = []
  for (const line of ndjson.split('\n')) {
    if (!line.trim()) continue
    let o: { location?: { x?: unknown; y?: unknown; z?: unknown } }
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    const l = o.location
    if (!l || typeof l.x !== 'number' || typeof l.y !== 'number' || typeof l.z !== 'number') continue
    out.push(l.x * voxelSpacing, l.y * voxelSpacing, l.z * voxelSpacing)
  }
  return new Float32Array(out)
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
