/**
 * 把一个 Martini 粗粒度模拟的坐标文件（GROMACS 的 .gro）转成能画的大小。
 *
 * 这类文件常常放在几十 GB 的压缩包里，和轨迹打在一起。如果要的那个文件排在压缩包的最前面，
 * 只取开头一段就够了：边解压边找到它，读完就停，后面的不要。
 *
 * .gro 里每行一个珠子，没有“哪些珠子属于同一个分子”的表，这里按残基编号来分：蛋白的残基编号
 * 往回跳就是下一条链；其余的（脂质）每个残基是一个分子。蛋白的名字不在这个文件里，只能按
 * “长度加开头的序列”分出种类。然后和 PetWorld 的模型一样，把每个分子里相邻的 g 个珠子并成一个球。
 *
 * Turn the coordinate file of a Martini coarse-grained simulation (a GROMACS .gro) into something
 * small enough to draw.
 *
 * Such files often sit in archives of tens of GB, packed together with trajectories. When the
 * wanted file comes first in the archive, its leading part is enough: unpack as it arrives, find
 * the file, stop when it has been read, and leave the rest.
 *
 * A .gro has one bead per line and no table of which beads make up a molecule, so molecules are
 * told apart by residue number here: among proteins a residue number that jumps back starts the
 * next chain, and every other residue (a lipid) is a molecule. The proteins' names are not in the
 * file; kinds can only be told apart by "length plus the start of the sequence". Then, as with
 * the PetWorld models, every g neighbouring beads within a molecule are merged into one sphere.
 *
 * 单独运行 / to run on its own:
 *   bun server/tools/gro.ts <压缩包地址 / archive URL> <包内路径 / path inside it> <取开头多少字节 / leading bytes> [球数预算 / sphere budget]
 */
import { createReadStream } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { MAGIC, decode, encode, type PreparedHeader, type PreparedObject } from '../../src/mol/prepared'
import { cached } from '../structures'
import { preparedFile } from './prepared'

const AMINO = new Set('ALA ARG ASN ASP CYS GLN GLU GLY HIS ILE LEU LYS MET PHE PRO SER THR TRP TYR VAL'.split(' '))
const ONE: Record<string, string> = { ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V' }

/** 一个 Martini 珠子大约相当于 4 个重原子；半径的算法和 petworld.ts 一致 / a Martini bead stands for about 4 heavy atoms; the radius rule matches petworld.ts */
const radiusOf = (beads: number) => 3.4 * Math.cbrt((beads * 4) / 8)
/**
 * 脂质的球至少这么大（Å）。膜里相邻的脂质相距约 8 Å，球再小就连不成一张膜，会从缝里看到对面。
 * Lipid spheres are at least this large (Å). Neighbouring lipids in a membrane are about 8 Å
 * apart, and smaller spheres would not join into a sheet: the far side would show through the gaps.
 */
const LIPID_MIN_RADIUS = 5

/**
 * 从一个 tar 的字节流里取出一个文件的各行。流可以在这个文件之后被截断。
 * The lines of one file out of the bytes of a tar. The stream may be cut off after that file.
 */
export async function* tarMemberLines(chunks: AsyncIterable<Uint8Array>, member: string): AsyncGenerator<string> {
  let buf = new Uint8Array(0)
  let state: 'header' | 'skip' | 'read' = 'header'
  let left = 0, pad = 0
  let tail = ''
  const dec = new TextDecoder()
  const names: string[] = []
  for await (const chunk of chunks) {
    const joined = new Uint8Array(buf.length + chunk.length)
    joined.set(buf)
    joined.set(chunk, buf.length)
    buf = joined
    let at = 0
    for (;;) {
      if (state === 'header') {
        if (buf.length - at < 512) break
        const h = buf.subarray(at, at + 512)
        at += 512
        if (h.every((b) => b === 0)) continue
        const text = (a: number, b: number) => dec.decode(h.subarray(a, b)).replace(/\0.*$/, '')
        const name = (text(345, 500) ? text(345, 500) + '/' : '') + text(0, 100)
        const size = parseInt(text(124, 136).trim() || '0', 8)
        names.push(name)
        left = size
        pad = (512 - (size % 512)) % 512
        state = name === member ? 'read' : 'skip'
        if (size === 0) state = 'header'
      } else {
        const take = Math.min(left, buf.length - at)
        if (state === 'read' && take > 0) {
          const text = tail + dec.decode(buf.subarray(at, at + take), { stream: true })
          const lines = text.split('\n')
          tail = lines.pop()!
          for (const l of lines) yield l
        }
        at += take
        left -= take
        if (left > 0) break
        if (state === 'read') {
          if (tail) yield tail
          return
        }
        if (buf.length - at < pad) {
          // 补齐的字节还没到齐，记下还要跳过多少 / the padding has not all arrived; remember how much is still to skip
          left = pad - (buf.length - at)
          pad = 0
          at = buf.length
          break
        }
        at += pad
        state = 'header'
      }
    }
    buf = buf.slice(at)
  }
  throw new Error(`压缩包取到的这一段里没有 ${member} / ${member} is not in the part of the archive that was fetched (saw: ${names.slice(0, 5).join(', ')})`)
}

interface Molecule {
  /** 珠子坐标（Å）/ bead coordinates in Å */
  xyz: number[]
}

export interface GroModel {
  title: string
  beads: number
  /** 蛋白链，以及它们的序列（单字母）/ protein chains and their one-letter sequences */
  proteins: (Molecule & { sequence: string })[]
  /** 其余的分子，按残基名分开 / the other molecules, by residue name */
  others: Map<string, Molecule[]>
}

/** 读 .gro 的各行 / read the lines of a .gro */
export async function readGro(lines: AsyncIterable<string>): Promise<GroModel> {
  const model: GroModel = { title: '', beads: 0, proteins: [], others: new Map() }
  let n = -1, expected = -1
  let lastKey = '', lastResid = -1, lastProtein = false
  let current: (Molecule & { sequence?: string }) | null = null
  for await (const line of lines) {
    n++
    if (n === 0) {
      model.title = line.trim()
      continue
    }
    if (n === 1) {
      expected = Number(line.trim())
      if (!Number.isInteger(expected) || expected <= 0) throw new Error('这不是一个 .gro 文件：第二行应当是原子数 / not a .gro file: the second line should be the atom count')
      continue
    }
    if (model.beads >= expected) break // 最后一行是盒子 / the last line is the box
    // 定宽的列：残基编号 5，残基名 5，原子名 5，原子编号 5，然后 x、y、z 各 8（nm）
    // fixed-width columns: residue number 5, residue name 5, atom name 5, atom number 5, then x, y, z of 8 each (nm)
    const resid = Number(line.slice(0, 5)), resname = line.slice(5, 10).trim()
    const x = Number(line.slice(20, 28)) * 10, y = Number(line.slice(28, 36)) * 10, z = Number(line.slice(36, 44)) * 10
    if (!Number.isFinite(x + y + z)) throw new Error(`第 ${n + 1} 行读不出坐标 / no coordinates could be read on line ${n + 1}`)
    const protein = AMINO.has(resname)
    const key = `${resid} ${resname}`
    if (key !== lastKey) {
      if (protein) {
        // 残基编号往回跳，或者前面不是蛋白：新的一条链 / the residue number jumps back, or what came before was not protein: a new chain
        if (!lastProtein || resid < lastResid || !current) {
          current = { xyz: [], sequence: '' }
          model.proteins.push(current as Molecule & { sequence: string })
        }
        current.sequence = (current.sequence ?? '') + (ONE[resname] ?? 'X')
      } else {
        current = { xyz: [] }
        if (!model.others.has(resname)) model.others.set(resname, [])
        model.others.get(resname)!.push(current)
      }
      lastKey = key
      lastResid = resid
      lastProtein = protein
    }
    current!.xyz.push(x, y, z)
    model.beads++
  }
  if (model.beads !== expected) throw new Error(`文件说有 ${expected} 个珠子，只读到 ${model.beads} 个 / the file announces ${expected} beads but only ${model.beads} were read`)
  return model
}

/** 把模型粗化并打包；g 取使球数不超过预算的最小整数 / coarsen and pack the model, with g the smallest whole number that keeps the spheres within the budget */
export function packGro(model: GroModel, source: string, budget: number): { header: PreparedHeader; spheres: Float32Array; ops: Float32Array } {
  const all: Molecule[] = [...model.proteins, ...[...model.others.values()].flat()]
  const count = (g: number) => all.reduce((s, m) => s + Math.ceil(m.xyz.length / 3 / g), 0)
  let g = 1
  while (count(g) > budget && g < 1e6) g++
  const spheres: number[] = []
  const add = (m: Molecule, minRadius = 0) => {
    const n = m.xyz.length / 3, parts = Math.ceil(n / g)
    for (let p = 0; p < parts; p++) {
      const a = Math.floor((p * n) / parts), b = Math.floor(((p + 1) * n) / parts)
      let x = 0, y = 0, z = 0
      for (let i = a; i < b; i++) {
        x += m.xyz[i * 3]!
        y += m.xyz[i * 3 + 1]!
        z += m.xyz[i * 3 + 2]!
      }
      spheres.push(x / (b - a), y / (b - a), z / (b - a), Math.max(minRadius, radiusOf(b - a)))
    }
  }
  // 蛋白的种类：长度加开头 16 个残基；按拷贝数从多到少编号 / kinds of protein: length plus the first 16 residues, numbered from the most copies down
  const kinds = new Map<string, number>()
  for (const p of model.proteins) {
    const k = `${p.sequence.length}:${p.sequence.slice(0, 16)}`
    kinds.set(k, (kinds.get(k) ?? 0) + 1)
  }
  const order = [...kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const label = new Map(order.map(([k, copies], i) => [k, `membrane protein ${i + 1} (${k.split(':')[0]} residues, ${copies} ${copies === 1 ? 'copy' : 'copies'})`]))
  const objects: PreparedObject[] = []
  model.proteins.forEach((p, i) => {
    const start = spheres.length / 4
    add(p)
    const n = p.xyz.length / 3
    objects.push({ name: `chain ${i + 1}`, kind: label.get(`${p.sequence.length}:${p.sequence.slice(0, 16)}`)!, instances: 1, opStart: 0, atoms: n, heavy: n, chains: [{ id: 'A', lipid: false, start, count: spheres.length / 4 - start }] })
  })
  for (const [name, mols] of model.others) {
    const start = spheres.length / 4
    let n = 0
    for (const m of mols) {
      add(m, LIPID_MIN_RADIUS)
      n += m.xyz.length / 3
    }
    objects.push({ name, kind: name, instances: 1, opStart: 0, atoms: n, heavy: n, chains: [{ id: name, lipid: true, start, count: spheres.length / 4 - start }] })
  }
  const header: PreparedHeader = { source, unit: 'beads', atomsPlaced: model.beads, heavyPlaced: model.beads, atomsPerSphere: g, spheres: spheres.length / 4, spheresPlaced: spheres.length / 4, ops: 1, objects }
  return { header, spheres: new Float32Array(spheres), ops: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]) }
}

async function* gunzipped(path: string): AsyncGenerator<Uint8Array> {
  const stream = createReadStream(path).pipe(createGunzip())
  try {
    for await (const chunk of stream) yield chunk as Uint8Array
  } catch (e) {
    // 只取了压缩包的开头，流在中途结束是预料之中的 / only the start of the archive was fetched, so the stream ending midway is expected
    if (!/unexpected end of file/i.test(String(e))) throw e
  }
}

/** 取压缩包的开头、找出那个 .gro、转换，返回要存下来的文件内容 / fetch the start of the archive, find the .gro, convert it, and return the file to keep */
export async function makeGro(url: string, member: string, head: number, budget: number): Promise<Uint8Array> {
  const raw = await cached(url, fetch, { head })
  const model = await readGro(tarMemberLines(gunzipped(raw), member))
  const { header, spheres, ops } = packGro(model, `${url}#${member}`, budget)
  return encode(header, spheres, ops)
}

export const groKey = (url: string, member: string, head: number, budget: number) => `${url}|${member}|${head}|${budget}|${MAGIC}`

if (import.meta.main) {
  const [url, member, head, budget] = process.argv.slice(2)
  if (!url || !member || !head) {
    console.error('用法 / usage: bun server/tools/gro.ts <archive url> <path inside it> <leading bytes> [sphere budget]')
    process.exit(1)
  }
  const b = budget ? Number(budget) : 4_000_000
  const t0 = performance.now()
  const path = await preparedFile(groKey(url, member, Number(head), b), () => makeGro(url, member, Number(head), b))
  const { header } = decode(new Uint8Array(await Bun.file(path).arrayBuffer()))
  console.log(JSON.stringify({ path, seconds: Math.round((performance.now() - t0) / 1000), megabytes: Math.round(Bun.file(path).size / 1e6), ...header, objects: header.objects.length }, null, 1))
}
