/**
 * 预处理过的超大模型：本地服务把几十亿个原子的实例化模型粗化成球之后存下来的小文件
 * （怎么做的见 server/tools/petworld.ts）。这里是它的格式，以及怎样把它变成可以画的结构。
 *
 * Prepared very large models: the small file the local service keeps after coarsening an
 * instanced model of billions of atoms into spheres (how is in server/tools/petworld.ts). This
 * is its format, and how it becomes a structure that can be drawn.
 */
import { El, type Chain, type Entity, type Molecule } from './types'

export interface PreparedChain {
  /** label_asym_id */
  id: string
  /** 膜的脂质（PetWorld 把它们的链叫 MEM…）/ lipids of a membrane (PetWorld names their chains MEM...) */
  lipid: boolean
  /** 在球表里的起点和个数 / first sphere and how many */
  start: number
  count: number
}

export interface PreparedObject {
  name: string
  instances: number
  /** 在变换表里的起点 / first transform */
  opStart: number
  /** 这种对象一份里的原子数（含氢）和重原子数 / atoms (with hydrogens) and heavy atoms in one copy of this object */
  atoms: number
  heavy: number
  chains: PreparedChain[]
}

export interface PreparedHeader {
  source: string
  /** 放置后的原子总数（含氢）、重原子总数 / atoms placed in all (with hydrogens), and heavy atoms */
  atomsPlaced: number
  heavyPlaced: number
  /** 每个球代表多少个重原子 / heavy atoms per sphere */
  atomsPerSphere: number
  spheres: number
  spheresPlaced: number
  ops: number
  objects: PreparedObject[]
}

export const MAGIC = 'LIMNPET1'

/** 文件：8 字节标记，4 字节头部长度，JSON 头部（补到 4 的倍数），球（每个 4 个浮点数），变换（每个 12 个）/ the file: an 8-byte tag, 4 bytes of header length, the JSON header (padded to a multiple of 4), the spheres (4 floats each), the transforms (12 each) */
export function encode(header: PreparedHeader, spheres: Float32Array, ops: Float32Array): Uint8Array {
  let json = new TextEncoder().encode(JSON.stringify(header))
  if (json.length % 4) {
    const padded = new Uint8Array(json.length + 4 - (json.length % 4)).fill(32)
    padded.set(json)
    json = padded
  }
  const out = new Uint8Array(12 + json.length + spheres.byteLength + ops.byteLength)
  out.set(new TextEncoder().encode(MAGIC))
  new DataView(out.buffer).setUint32(8, json.length, true)
  out.set(json, 12)
  out.set(new Uint8Array(spheres.buffer, spheres.byteOffset, spheres.byteLength), 12 + json.length)
  out.set(new Uint8Array(ops.buffer, ops.byteOffset, ops.byteLength), 12 + json.length + spheres.byteLength)
  return out
}

export function decode(buf: Uint8Array): { header: PreparedHeader; spheres: Float32Array; ops: Float32Array } {
  if (new TextDecoder().decode(buf.subarray(0, 8)) !== MAGIC) throw new Error('不是预处理过的模型文件 / not a prepared model file')
  const n = new DataView(buf.buffer, buf.byteOffset).getUint32(8, true)
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(12, 12 + n))) as PreparedHeader
  const body = buf.slice(12 + n)
  const all = new Float32Array(body.buffer, 0, body.byteLength >> 2)
  return { header, spheres: all.subarray(0, header.spheres * 4), ops: all.subarray(header.spheres * 4, header.spheres * 4 + header.ops * 12) }
}

/**
 * 变成可以画的结构：每种对象是一个实体，膜的脂质合成一个实体；组装体里每种对象一行，带着它的全部变换。
 * Into a drawable structure: each kind of object is an entity, with membrane lipids gathered into
 * one; the assembly has one row per kind of object, carrying all its transforms.
 */
export function preparedMolecule(buf: Uint8Array, id: string, title: string): { mol: Molecule; header: PreparedHeader } {
  const { header, spheres, ops } = decode(buf)
  const n = header.spheres
  const pos = new Float32Array(n * 3), radius = new Float32Array(n), chainOf = new Uint32Array(n), residue = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    pos[i * 3] = spheres[i * 4]!
    pos[i * 3 + 1] = spheres[i * 4 + 1]!
    pos[i * 3 + 2] = spheres[i * 4 + 2]!
    radius[i] = spheres[i * 4 + 3]!
  }
  const entities: Entity[] = [{ id: 'membrane', description: 'membrane', kind: 'lipid' }]
  const chains: Chain[] = []
  const groups: Molecule['assemblies'][number]['groups'] = []
  header.objects.forEach((o, oi) => {
    let entity = -1
    const mine: number[] = []
    for (const c of o.chains) {
      if (c.count === 0) continue
      if (!c.lipid && entity < 0) {
        entities.push({ id: o.name, description: o.name, kind: 'protein' })
        entity = entities.length - 1
      }
      chainOf.fill(chains.length, c.start, c.start + c.count)
      for (let k = 0; k < c.count; k++) residue[c.start + k] = k + 1
      mine.push(chains.length)
      chains.push({ asymId: `${o.name}.${c.id}`, authAsymId: c.id, entity: c.lipid ? 0 : entity, start: c.start, count: c.count, model: oi + 1 })
    }
    if (mine.length === 0) return
    const operators: Float32Array[] = []
    for (let k = o.opStart; k < o.opStart + o.instances; k++) {
      const m = k * 12
      // 文件里是 3×4 的三行；这里要列主序的 4×4 / the file holds the three rows of a 3x4; a column-major 4x4 is wanted here
      operators.push(new Float32Array([ops[m]!, ops[m + 4]!, ops[m + 8]!, 0, ops[m + 1]!, ops[m + 5]!, ops[m + 9]!, 0, ops[m + 2]!, ops[m + 6]!, ops[m + 10]!, 0, ops[m + 3]!, ops[m + 7]!, ops[m + 11]!, 1]))
    }
    groups.push({ chains: mine, operators })
  })
  const mol: Molecule = {
    id, title, atomCount: n, pos,
    // 一个球一种颜色：按“非碳”处理 / one sphere, one colour: treated as non-carbon
    element: new Uint8Array(n).fill(El.N),
    radius, chainOf, isTrace: new Uint8Array(n).fill(1), residue, chains, entities,
    assemblies: [{ id: '1', groups }],
  }
  return { mol, header }
}
