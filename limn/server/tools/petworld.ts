/**
 * 把 YASARA PetWorld 的“实例化全原子”模型（几十亿个原子，mmCIF 的一个变体）转成能画的大小。
 *
 * 文件里每种对象（一种蛋白、一小块膜……）的原子只存一份，另有几十万个刚体变换说明它被放在哪些位置。
 * 解压后是几百 MB 的文本，浏览器里一次解析不动，所以放在本地服务里做：一行一行读，只留重原子，
 * 把每条链上相邻的重原子每 g 个并成一个球（球心是它们的质心），g 取使“球数 × 实例数”的总和不超过
 * 预算的最小值。结果写成一个小的二进制文件，存在状态目录里，下次直接用。
 *
 * Turn a YASARA PetWorld "instanced all-atom" model (billions of atoms, in a variant of mmCIF)
 * into something small enough to draw.
 *
 * The file stores the atoms of each kind of object (a protein, a patch of membrane...) once, plus
 * several hundred thousand rigid transforms saying where it is placed. Unpacked it is hundreds of
 * MB of text, more than a browser can parse in one go, so the work is done in the local service:
 * read line by line, keep heavy atoms only, and merge every g neighbouring heavy atoms along a
 * chain into one sphere at their centroid, with g the smallest value that keeps the sum of
 * "spheres times instances" within the budget. The result is a small binary file kept under the
 * state directory and reused afterwards.
 *
 * 也可以单独运行 / it can also be run on its own:
 *   bun server/tools/petworld.ts <模型的 .cif.gz 地址 / URL of the model's .cif.gz> [球数预算 / sphere budget]
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createGunzip } from 'node:zlib'
import { MAGIC, decode, encode, type PreparedChain, type PreparedHeader, type PreparedObject } from '../../src/mol/prepared'
import { cached, stateDir } from '../structures'

/** 默认的球数预算 / the default budget of placed spheres */
export const SPHERE_BUDGET = 30_000_000

/** 一个残基（约 8 个重原子）的球半径（Å），与 src/mol/coarse.ts 一致 / the radius in Å of one residue's sphere (about 8 heavy atoms), as in src/mol/coarse.ts */
const RESIDUE_RADIUS = 3.4

interface RawObject {
  name: string
  instances: number
  opStart: number
  atoms: number
  /** 每条链的重原子坐标 / heavy-atom coordinates of each chain */
  chains: { id: string; xyz: number[] }[]
}

/** 逐行读一个 YASARA mmCIF，取出对象、变换和重原子 / read a YASARA mmCIF line by line into objects, transforms and heavy atoms */
export async function readPetworld(lines: AsyncIterable<string>): Promise<{ objects: RawObject[]; ops: Float32Array }> {
  const names: { name: string; instances: number }[] = []
  /** 每个模型号的变换范围（从 1 数起，两端都含）/ the range of transforms of each model number (1-based, inclusive) */
  const ranges = new Map<number, [number, number]>()
  const ops: number[] = []
  const byModel = new Map<number, RawObject>()
  let category = '', columns: string[] = [], inHeader = false
  let ix = -1, iy = -1, iz = -1, iel = -1, iasym = -1, imodel = -1
  let current: { id: string; xyz: number[] } | null = null, currentModel = -1
  for await (const line of lines) {
    if (line.length === 0 || line.charCodeAt(0) === 35 /* # */) continue
    if (line.startsWith('loop_')) {
      category = ''
      columns = []
      inHeader = true
      continue
    }
    const t = line.trimStart()
    if (inHeader && t.charCodeAt(0) === 95 /* _ */) {
      const [cat, col] = t.trim().split('.')
      category = cat!
      columns.push(col ?? '')
      continue
    }
    if (inHeader) {
      inHeader = false
      if (category === '_atom_site') {
        ix = columns.indexOf('Cartn_x')
        iy = columns.indexOf('Cartn_y')
        iz = columns.indexOf('Cartn_z')
        iel = columns.indexOf('type_symbol')
        iasym = columns.indexOf('label_asym_id')
        imodel = columns.indexOf('pdbx_PDB_model_num')
        if (Math.min(ix, iy, iz, iel, iasym, imodel) < 0) throw new Error('这个文件的原子表缺少需要的列 / the atom table of this file lacks a column that is needed')
      }
      // 键表在原子表后面，用不着 / the bond table follows the atoms and is not needed
      if (category === '_struct_conn') break
    }
    if (category === '_pdbx_model') {
      const f = t.split(/\s+/)
      names.push({ name: f[0]!, instances: Number(f[1]) })
    } else if (category === '_pdbx_struct_assembly_gen') {
      // 1 '(7201-28823)' "A" 2：变换的范围，最后一列是模型号 / the range of transforms, with the model number last
      const m = /\((\d+)(?:-(\d+))?\)/.exec(t)
      const model = Number(t.slice(t.lastIndexOf(' ') + 1))
      if (m && Number.isFinite(model)) ranges.set(model, [Number(m[1]), Number(m[2] ?? m[1])])
    } else if (category === '_pdbx_struct_oper_list') {
      const f = t.split(/\s+/)
      if (f.length < 13) continue
      // 文件里是 3×3 矩阵（按行）后跟平移；存成 3×4 的三行 / the file gives the 3x3 matrix by rows, then the translation; kept as the three rows of a 3x4
      const k = (Number(f[0]) - 1) * 12
      for (let r = 0; r < 3; r++) {
        ops[k + r * 4] = Number(f[1 + r * 3])
        ops[k + r * 4 + 1] = Number(f[2 + r * 3])
        ops[k + r * 4 + 2] = Number(f[3 + r * 3])
        ops[k + r * 4 + 3] = Number(f[10 + r])
      }
    } else if (category === '_atom_site') {
      const f = t.split(/\s+/)
      const model = Number(f[imodel])
      let obj = byModel.get(model)
      if (!obj) {
        const n = names[model - 1], range = ranges.get(model)
        if (!n || !range) throw new Error(`模型 ${model} 没有名字或没有变换 / model ${model} has no name or no transforms`)
        obj = { name: n.name, instances: range[1] - range[0] + 1, opStart: range[0] - 1, atoms: 0, chains: [] }
        byModel.set(model, obj)
      }
      obj.atoms++
      if (f[iel] === 'H' || f[iel] === 'D') continue
      const asym = f[iasym]!
      if (!current || currentModel !== model || current.id !== asym) {
        current = { id: asym, xyz: [] }
        currentModel = model
        obj.chains.push(current)
      }
      current.xyz.push(Number(f[ix]), Number(f[iy]), Number(f[iz]))
    }
  }
  return { objects: [...byModel.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]), ops: new Float32Array(ops) }
}

/** 每 g 个重原子一个球时，放置后一共多少个球 / how many spheres are placed in all at g heavy atoms per sphere */
function placedAt(objects: RawObject[], g: number): number {
  let n = 0
  for (const o of objects) for (const c of o.chains) n += o.instances * Math.ceil(c.xyz.length / 3 / g)
  return n
}

/**
 * 选出每个球代表的重原子数：不超过预算的最小整数（至少 1，也就是不粗化）。
 * Choose how many heavy atoms a sphere stands for: the smallest whole number that keeps within
 * the budget (at least 1, which is no coarsening at all).
 */
export function atomsPerSphere(objects: RawObject[], budget: number): number {
  let lo = 1, hi = 1
  while (placedAt(objects, hi) > budget && hi < 1e7) hi *= 2
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (placedAt(objects, mid) <= budget) hi = mid
    else lo = mid + 1
  }
  return lo
}

/** 把对象粗化并打包 / coarsen the objects and pack them */
export function pack(objects: RawObject[], ops: Float32Array, source: string, budget = SPHERE_BUDGET): { header: PreparedHeader; spheres: Float32Array } {
  const g = atomsPerSphere(objects, budget)
  const spheres: number[] = []
  const out: PreparedObject[] = []
  let atomsPlaced = 0, heavyPlaced = 0, spheresPlaced = 0
  for (const o of objects) {
    const chains: PreparedChain[] = []
    let heavy = 0
    for (const c of o.chains) {
      const n = c.xyz.length / 3
      heavy += n
      const start = spheres.length / 4
      // 均分成几段，每段不超过 g 个原子 / split evenly into runs of at most g atoms
      const parts = Math.ceil(n / g)
      for (let p = 0; p < parts; p++) {
        const a = Math.floor((p * n) / parts), b = Math.floor(((p + 1) * n) / parts)
        let x = 0, y = 0, z = 0
        for (let i = a; i < b; i++) {
          x += c.xyz[i * 3]!
          y += c.xyz[i * 3 + 1]!
          z += c.xyz[i * 3 + 2]!
        }
        const k = b - a
        // 半径按原子数的立方根放大；单个原子时取 1.7 Å / the radius grows as the cube root of the atom count; a lone atom gets 1.7 Å
        spheres.push(x / k, y / k, z / k, g === 1 ? 1.7 : RESIDUE_RADIUS * Math.cbrt(k / 8))
      }
      chains.push({ id: c.id, lipid: c.id.startsWith('MEM'), start, count: spheres.length / 4 - start })
    }
    out.push({ name: o.name, instances: o.instances, opStart: o.opStart, atoms: o.atoms, heavy, chains })
    atomsPlaced += o.atoms * o.instances
    heavyPlaced += heavy * o.instances
    spheresPlaced += o.instances * chains.reduce((s, c) => s + c.count, 0)
  }
  return {
    header: { source, atomsPlaced, heavyPlaced, atomsPerSphere: g, spheres: spheres.length / 4, spheresPlaced, ops: ops.length / 12, objects: out },
    spheres: new Float32Array(spheres),
  }
}

const pending = new Map<string, Promise<string>>()

/**
 * 预处理过的文件的路径；没有就先下载原文件并转换。同一个地址同时只做一次。
 * Path of the prepared file, downloading and converting the original first if needed. One URL is
 * prepared only once at a time.
 */
export function prepared(url: string, budget = SPHERE_BUDGET): Promise<string> {
  const dir = join(stateDir(), 'prepared')
  const path = join(dir, createHash('sha256').update(`${url}|${budget}|${MAGIC}`).digest('hex').slice(0, 32))
  const running = pending.get(path)
  if (running) return running
  const job = (async () => {
    if (await stat(path).then((s) => s.size > 0, () => false)) return path
    const raw = await cached(url)
    const lines = createInterface({ input: createReadStream(raw).pipe(createGunzip()), crlfDelay: Infinity })
    const { objects, ops } = await readPetworld(lines)
    if (objects.length === 0 || ops.length === 0) throw new Error(`没有读到对象或变换 / no objects or transforms were read: ${url}`)
    const { header, spheres } = pack(objects, ops, url, budget)
    await mkdir(dir, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, encode(header, spheres, ops))
    await rename(tmp, path)
    return path
  })().finally(() => pending.delete(path))
  pending.set(path, job)
  return job
}

const failed = new Map<string, string>()

/**
 * 不等它做完：已经有了就给路径，否则在后台开始做并说“还在准备”。转换要一两分钟，比一次请求能等的时间长。
 * 上次失败的原因只报一次，之后再问会重新开始。
 * Without waiting for it: the path if the file is there, otherwise start the work in the
 * background and say it is still being prepared. Converting takes a minute or two, longer than
 * one request can wait. A failure is reported once, and asking again starts over.
 */
export async function poll(url: string, budget = SPHERE_BUDGET): Promise<{ path: string } | { preparing: true }> {
  const key = `${url}|${budget}`
  const error = failed.get(key)
  if (error) {
    failed.delete(key)
    throw new Error(error)
  }
  const job = prepared(url, budget)
  job.catch((e) => failed.set(key, e instanceof Error ? e.message : String(e)))
  const done = await Promise.race([job.then((path) => ({ path })).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))])
  return done ?? { preparing: true }
}

if (import.meta.main) {
  const [url, budget] = process.argv.slice(2)
  if (!url) {
    console.error('用法 / usage: bun server/tools/petworld.ts <url of .cif.gz> [sphere budget]')
    process.exit(1)
  }
  const t0 = performance.now()
  const path = await prepared(url, budget ? Number(budget) : SPHERE_BUDGET)
  const { header } = decode(new Uint8Array(await Bun.file(path).arrayBuffer()))
  console.log(JSON.stringify({ path, seconds: Math.round((performance.now() - t0) / 1000), megabytes: Math.round(Bun.file(path).size / 1e6), ...header, objects: header.objects.length }, null, 1))
}
