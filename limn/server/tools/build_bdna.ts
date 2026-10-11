/**
 * 从 PDB 1BNA（B 型 DNA 十二聚体，CC0）量出一个碱基对在螺旋坐标系里的原子位置，写成 data/bdna.json。
 * 之后画 DNA 长链时，就把这四种碱基对沿一条曲线一个个摆出来。
 *
 * 做法：相邻两个碱基对的糖-磷酸骨架原子名字相同，把第 i 对叠合到第 i+1 对上，得到一个螺旋运动
 * （绕轴转一个角度、沿轴升一段）。轴的方向和位置由这个运动定出；每个碱基对在“原点在轴上、z 沿轴、
 * x 指向本对骨架质心”的坐标系里记下来。
 *
 * Measures, from PDB 1BNA (the B-DNA dodecamer, CC0), where the atoms of one base pair sit in
 * the frame of the helix, and writes data/bdna.json. Long DNA is later drawn by laying these
 * four kinds of base pair along a curve, one after another.
 *
 * Method: the sugar-phosphate backbone atoms of neighbouring base pairs carry the same names, so
 * pair i is superposed onto pair i+1, which gives a screw motion (a turn about an axis and a rise
 * along it). The motion fixes the axis; each base pair is recorded in the frame with its origin
 * on the axis, z along it and x pointing at the pair's backbone centroid.
 *
 * 用法 / usage: bun server/tools/build_bdna.ts
 */
import { CIF } from 'molstar/lib/mol-io/reader/cif'
import { join } from 'node:path'
import { fitRigid } from '../../src/mol/superpose'

const BACKBONE = new Set(["P", "OP1", "OP2", "O5'", "C5'", "C4'", "O4'", "C3'", "O3'", "C2'", "C1'"])

interface Atom { name: string; el: string; p: [number, number, number] }

const res = await fetch('https://files.rcsb.org/download/1BNA.cif')
if (!res.ok) throw new Error(`HTTP ${res.status}`)
const parsed = await CIF.parseText(await res.text()).run()
if (parsed.isError) throw new Error(parsed.message)
const site = parsed.result.blocks[0]!.categories['atom_site']!
const f = (n: string) => site.getField(n)!
const residues = new Map<string, { comp: string; atoms: Atom[] }>()
for (let i = 0; i < site.rowCount; i++) {
  if (f('group_PDB').str(i) !== 'ATOM' || f('type_symbol').str(i) === 'H') continue
  const key = `${f('auth_asym_id').str(i)}:${f('auth_seq_id').int(i)}`
  if (!residues.has(key)) residues.set(key, { comp: f('label_comp_id').str(i), atoms: [] })
  residues.get(key)!.atoms.push({ name: f('label_atom_id').str(i), el: f('type_symbol').str(i), p: [f('Cartn_x').float(i), f('Cartn_y').float(i), f('Cartn_z').float(i)] })
}
// 1BNA：A 链 1-12，B 链 13-24；A:i 与 B:(25-i) 配对 / 1BNA: chain A 1-12, chain B 13-24; A:i pairs with B:(25-i)
const pair = (i: number) => ({ a: residues.get(`A:${i}`)!, b: residues.get(`B:${25 - i}`)! })
const backbone = (r: { atoms: Atom[] }) => new Map(r.atoms.filter((x) => BACKBONE.has(x.name)).map((x) => [x.name, x.p]))

const sub = (a: number[], b: number[]) => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]
const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
const norm = (a: number[]) => { const l = Math.hypot(a[0]!, a[1]!, a[2]!); return [a[0]! / l, a[1]! / l, a[2]! / l] }
const add = (a: number[], b: number[], s = 1) => [a[0]! + b[0]! * s, a[1]! + b[1]! * s, a[2]! + b[2]! * s]

/** 第 i 对到第 i+1 对的螺旋运动 / the screw motion from pair i to pair i+1 */
function screw(i: number) {
  const from: number[] = [], to: number[] = []
  for (const [x, y] of [[pair(i).a, pair(i + 1).a], [pair(i).b, pair(i + 1).b]] as const) {
    const bx = backbone(x), by = backbone(y)
    for (const [name, p] of bx) {
      const q = by.get(name)
      if (q) { from.push(...p); to.push(...q) }
    }
  }
  const m = fitRigid(from, to).matrix
  // 转轴：旋转矩阵的反对称部分 / the axis: the antisymmetric part of the rotation matrix
  const axis = norm([m[6]! - m[9]!, m[8]! - m[2]!, m[1]! - m[4]!])
  const twist = Math.acos(Math.max(-1, Math.min(1, (m[0]! + m[5]! + m[10]! - 1) / 2)))
  const t = [m[12]!, m[13]!, m[14]!]
  const rise = dot(t, axis)
  // 轴上的一点 c 满足 (I - R) c = t_perp / a point c on the axis satisfies (I - R) c = t_perp
  const tp = add(t, axis, -rise)
  // 对垂直于轴的平面内的旋转：c = tp/2 + (axis × tp) / (2 tan(twist/2))
  const c = add([tp[0]! / 2, tp[1]! / 2, tp[2]! / 2], cross(axis, tp), 1 / (2 * Math.tan(twist / 2)))
  return { axis, twist, rise, c }
}

const steps = [3, 4, 5, 6, 7, 8, 9].map(screw)
const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length
const rise = mean(steps.map((s) => s.rise)), twist = mean(steps.map((s) => s.twist))

/** 第 i 对在螺旋坐标系里的原子 / the atoms of pair i in the helix frame */
function template(i: number, s: ReturnType<typeof screw>) {
  const { a, b } = pair(i)
  const all = [...a.atoms, ...b.atoms]
  const bb = all.filter((x) => BACKBONE.has(x.name)).map((x) => x.p)
  const centroid = [mean(bb.map((p) => p[0])), mean(bb.map((p) => p[1])), mean(bb.map((p) => p[2]))]
  const origin = add(s.c, s.axis, dot(sub(centroid, s.c), s.axis))
  const z = s.axis
  // x 指向 A 链的 C1'，这样小沟、大沟的朝向在四种碱基对之间一致
  // x points at strand A's C1', so the minor and major grooves face the same way in all four kinds of pair
  const c1 = a.atoms.find((x) => x.name === "C1'")!.p
  const radial = sub(c1, origin)
  const x = norm(add(radial, z, -dot(radial, z)))
  const y = cross(z, x)
  return {
    pair: a.comp.replace('D', '') + b.comp.replace('D', ''),
    atoms: all.map((t) => {
      const d = sub(t.p, origin)
      return [t.el, +dot(d, x).toFixed(3), +dot(d, y).toFixed(3), +dot(d, z).toFixed(3), t.name === 'P' ? 1 : 0] as const
    }),
    strandA: a.atoms.length,
  }
}

// CGCGAATTCGCG：第 3 对 C-G，第 4 对 G-C，第 5 对 A-T，第 7 对 T-A
const out = {
  about: '由 PDB 1BNA（CC0）量出的 B 型 DNA 碱基对模板：原点在螺旋轴上，z 沿轴，坐标单位 Å。由 server/tools/build_bdna.ts 生成。 / B-DNA base-pair templates measured from PDB 1BNA (CC0): origin on the helix axis, z along it, coordinates in Å. Generated by server/tools/build_bdna.ts.',
  source: 'PDB 1BNA, Drew et al., PNAS 1981, doi:10.1073/pnas.78.4.2179',
  rise: +rise.toFixed(3),
  twistDegrees: +((twist * 180) / Math.PI).toFixed(2),
  pairs: [template(3, steps[0]!), template(4, steps[1]!), template(5, steps[2]!), template(7, steps[4]!)],
}
await Bun.write(join(import.meta.dir, '..', '..', 'data', 'bdna.json'), JSON.stringify(out) + '\n')
console.log('rise', out.rise, 'twist', out.twistDegrees, 'per step:', steps.map((s) => `${s.rise.toFixed(2)}/${((s.twist * 180) / Math.PI).toFixed(1)}`).join(' '))
console.log(out.pairs.map((p) => `${p.pair}: ${p.atoms.length} atoms, P radius ${p.atoms.filter((a) => a[4]).map((a) => Math.hypot(a[1], a[2]).toFixed(1)).join(',')}`).join('\n'))
