/**
 * 用 limn 的渲染器渲染 Illustrate 自带的 2hhb 示例，使用同一个 PDB 文件和同样的输入卡片，
 * 并度量它与原程序所出图片的差异（build.sh 把两者都放进 build/）。
 * Renders Illustrate's own 2hhb example with limn's renderer, from the same
 * PDB file and the same input cards, and measures the difference against the
 * picture the original program made (build.sh puts both in build/).
 */
import { Renderer, identityInstances, type RenderItem, type View } from '../../src/render/Renderer'
import { STYLE_MOLECULE, cloneStyle, type Style } from '../../src/render/style'

interface Rule {
  record: string
  pattern: string
  from: number
  to: number
  rgb: [number, number, number]
  radius: number
}

interface Cards {
  rules: Rule[]
  scale: number
  background: [number, number, number]
  fog: { color: [number, number, number]; front: number; back: number }
  shadow: { on: boolean; strength: number; cone: number; floor: number }
  contour: { low: number; high: number; diffMin: number; diffMax: number }
  subunit: { low: number; high: number }
  residue: { low: number; high: number; diff: number }
}

const nums = (s: string) => s.split(',').map((x) => Number(x))

function parseCards(text: string): Cards {
  const lines = text.split('\n')
  const rules: Rule[] = []
  let i = lines.findIndex((l) => l.startsWith('read')) + 2
  for (; !lines[i]!.startsWith('END'); i++) {
    const l = lines[i]!
    const [from, to, r, g, b, radius] = nums(l.slice(16))
    rules.push({ record: l.slice(0, 6), pattern: l.slice(6, 16), from: from!, to: to!, rgb: [r!, g!, b!], radius: radius! })
  }
  const after = (card: string, n = 1) => lines[lines.findIndex((l) => l.startsWith(card)) + n]!
  const w = nums(after('wor'))
  const s = nums(after('wor', 2))
  const c = nums(after('illustrate'))
  const su = nums(after('illustrate', 2))
  const re = nums(after('illustrate', 3))
  return {
    rules,
    scale: Number(after('scale')),
    background: [w[0]!, w[1]!, w[2]!],
    fog: { color: [w[3]!, w[4]!, w[5]!], front: w[6]!, back: w[7]! },
    shadow: { on: s[0] !== 0, strength: s[1]!, cone: s[2]!, floor: s[4]! },
    contour: { low: c[0]!, high: c[1]!, diffMin: c[3]!, diffMax: c[4]! },
    subunit: { low: su[0]!, high: su[1]! },
    residue: { low: re[0]!, high: re[1]!, diff: re[2]! },
  }
}

/**
 * Illustrate 的原子选择：第一张匹配的卡片说了算，半径为 0 则丢弃该原子。
 * Illustrate's atom selection: the first matching card decides, radius 0 drops the atom.
 */
function parsePdb(text: string, rules: Rule[]): { item: RenderItem; center: [number, number, number] } {
  const posr: number[] = [], color: number[] = [], ids: number[] = []
  let subunit = -1, lastChain = ''
  for (const line of text.split('\n')) {
    if (!line.startsWith('ATOM') && !line.startsWith('HETATM')) continue
    const res = parseInt(line.slice(22, 26))
    const rule = rules.find((r) => {
      if (line.slice(0, 6) !== r.record) return false
      for (let k = 0; k < 10; k++) if (r.pattern[k] !== '-' && line[12 + k] !== r.pattern[k]) return false
      return res >= r.from && res <= r.to
    })
    if (!rule || rule.radius === 0) continue
    if (line[21] !== lastChain) {
      subunit++
      lastChain = line[21]!
    }
    posr.push(Number(line.slice(30, 38)), Number(line.slice(38, 46)), Number(line.slice(46, 54)), rule.radius)
    color.push(Math.round(rule.rgb[0] * 255), Math.round(rule.rgb[1] * 255), Math.round(rule.rgb[2] * 255), 255)
    ids.push(subunit, res + 1000)
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity]
  for (let k = 0; k < posr.length; k += 4)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, posr[k + a]!)
      hi[a] = Math.max(hi[a]!, posr[k + a]!)
    }
  const n = posr.length / 4
  return {
    item: {
      posr: new Float32Array(posr),
      color: new Uint8Array(color),
      ids: new Uint32Array(ids),
      draws: [{ start: 0, count: n, opStart: 0, opCount: 1 }],
      instances: identityInstances(),
      subunitSize: 40,
    },
    center: [(lo[0]! + hi[0]!) / 2, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2],
  }
}

function parsePnm(text: string): { w: number; h: number; rgb: Uint8Array } {
  const t = text.trim().split(/\s+/)
  const w = Number(t[1]), h = Number(t[2])
  const rgb = new Uint8Array(w * h * 3)
  for (let k = 0; k < rgb.length; k++) rgb[k] = Number(t[4 + k])
  return { w, h, rgb }
}

interface Score {
  /** 平均绝对差，0–255，对所有像素和通道取平均 / mean absolute difference, 0–255, over all pixels and channels */
  mean: number
  /** 最大通道差超过 32 的像素所占比例 / share of pixels whose largest channel difference exceeds 32 */
  off: number
  dx: number
  dy: number
}

/**
 * 在小位移范围内取最佳匹配：两个程序的像素中心相差半个像素。
 * Best match over small shifts: the two programs put pixel centres half a pixel apart.
 */
function compare(ours: Uint8ClampedArray, ref: Uint8Array, w: number, h: number): Score {
  let best: Score = { mean: Infinity, off: 1, dx: 0, dy: 0 }
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      let sum = 0, off = 0, n = 0
      for (let y = 4; y < h - 4; y++)
        for (let x = 4; x < w - 4; x++) {
          const a = (y * w + x) * 4, b = ((y + dy) * w + x + dx) * 3
          const d0 = Math.abs(ours[a]! - ref[b]!), d1 = Math.abs(ours[a + 1]! - ref[b + 1]!), d2 = Math.abs(ours[a + 2]! - ref[b + 2]!)
          sum += d0 + d1 + d2
          if (Math.max(d0, d1, d2) > 32) off++
          n++
        }
      if (sum / n / 3 < best.mean) best = { mean: sum / n / 3, off: off / n, dx, dy }
    }
  return best
}

/** 一张图由什么组成：纸、墨，以及其余一切的平均色调 / What a picture is made of: paper, ink, and the mean tone of everything else. */
function census(px: ArrayLike<number>, stride: number): { paper: number; ink: number; tone: number[] } {
  let paper = 0, ink = 0, n = 0
  const tone = [0, 0, 0]
  const total = px.length / stride
  for (let k = 0; k < px.length; k += stride) {
    const r = px[k]!, g = px[k + 1]!, b = px[k + 2]!
    if (r > 250 && g > 250 && b > 250) paper++
    else if (Math.max(r, g, b) < 64) ink++
    else {
      tone[0]! += r
      tone[1]! += g
      tone[2]! += b
      n++
    }
  }
  return { paper: paper / total, ink: ink / total, tone: tone.map((v) => Math.round(v / n)) }
}

function show(id: string, w: number, h: number, fill: (out: Uint8ClampedArray) => void): void {
  const c = document.getElementById(id) as HTMLCanvasElement
  c.width = w
  c.height = h
  const img = new ImageData(w, h)
  fill(img.data)
  c.getContext('2d')!.putImageData(img, 0, 0)
}

async function main(): Promise<void> {
  const get = async (name: string) => {
    const r = await fetch(`build/${name}`)
    if (!r.ok) throw new Error(`没有 build/${name}，先运行 research/illustrate/build.sh`)
    return r.text()
  }
  const cards = parseCards(await get('2hhb.inp'))
  const { item, center } = parsePdb(await get('2hhb.pdb'), cards.rules)
  const ref = parsePnm(await get('2hhb.pnm'))
  const { w, h } = ref

  const style: Style = cloneStyle(STYLE_MOLECULE)
  style.background = cards.background
  // 无论图像多大，Illustrate 的卷积核步长始终是一个像素
  // Illustrate's kernel step is always one pixel, whatever the image size
  style.lineWidth = 1500 / Math.max(w, h)
  style.contour = cards.contour
  style.subunit = cards.subunit
  style.residue = cards.residue
  style.shadow = { strength: cards.shadow.on ? cards.shadow.strength : 0, cone: cards.shadow.cone, floor: cards.shadow.floor, radius: 50 / cards.scale }
  style.fog = { color: cards.fog.color, front: cards.fog.front, back: cards.fog.back, layers: 0 }

  const renderer = new Renderer(new OffscreenCanvas(4, 4))
  renderer.setScene([item])
  // 示例里的 "zrot 90" 抵消了 Illustrate 对调的图像坐标轴：
  // 画面沿 z 轴向下看，x 向右，y 向上。
  // The example's "zrot 90" undoes Illustrate's swapped image axes: the
  // picture looks down z with x to the right and y up.
  const view: View = { rot: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), center, height: h / cards.scale, clipFront: Infinity }
  const ours = renderer.renderPixels(view, style, w, h)

  const score = compare(ours, ref.rgb, w, h)
  const result = { size: [w, h], atoms: item.posr.length / 4, score, ours: census(ours, 4), illustrate: census(ref.rgb, 3) }
  show('ours', w, h, (o) => o.set(ours))
  show('ref', w, h, (o) => {
    for (let k = 0; k < w * h; k++) o.set([ref.rgb[k * 3]!, ref.rgb[k * 3 + 1]!, ref.rgb[k * 3 + 2]!, 255], k * 4)
  })
  show('diff', w, h, (o) => {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = (y * w + x) * 4
        const yy = Math.min(h - 1, Math.max(0, y + score.dy)), xx = Math.min(w - 1, Math.max(0, x + score.dx))
        const b = (yy * w + xx) * 3
        const d = Math.max(Math.abs(ours[a]! - ref.rgb[b]!), Math.abs(ours[a + 1]! - ref.rgb[b + 1]!), Math.abs(ours[a + 2]! - ref.rgb[b + 2]!))
        o.set([255 - d, 255 - d, 255 - d, 255], a)
      }
  })
  document.getElementById('out')!.textContent = JSON.stringify(result, null, 1)
  Object.assign(window, { result })
}

main().catch((e) => {
  document.getElementById('out')!.textContent = String(e)
  Object.assign(window, { result: { error: String(e) } })
})
