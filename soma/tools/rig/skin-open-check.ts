// 开口皮肤（真正的口裂和睑裂）的绑定检查：bun tools/rig/skin-open-check.ts [male|female]
// Check of the binding of an opened skin (real oral and palpebral fissures): bun tools/rig/skin-open-check.ts [male|female]
//
// 发布的开口皮肤和它的下标对照文件还没有；这里直接拿皮肤包分辨率的开口皮肤（skin.obj）来绑定，
// 下标对照取恒等映射——这与“有对照文件时”走的是同一条代码路径（weldByIndex + byIndex）。
// 然后只转下颌（颞下颌关节）10° 和 25°，量：上唇缘是否留在颅骨上、下唇缘是否随下颌、两条唇缘是否干净地分开。
// 同时给出“按位置”的老办法（按位置焊接 + 最近点传递）在同一张网格上的结果，作为对照。
// The shipped opened skin and its index sidecar do not exist yet; the package-resolution opened skin
// (skin.obj) is bound here directly with the identity map as sidecar — the very code path used when
// a sidecar is present (weldByIndex + byIndex). Then only the jaw (temporomandibular joint) is
// turned by 10° and 25° and we measure whether the upper lip margin stays with the skull, the lower
// follows the jaw, and the two margins part cleanly. The old position-based way (welding by
// position + closest-point transfer) on the same mesh is reported for comparison.

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rig } from '../../src/anatomy/types.ts'
import { type BindRules, quantise, weld, weldByIndex } from './bind.ts'
import { withInstalledSkinPackages } from './build.ts'
import { loadExternalWeights, readObj } from './external.ts'
import { type V3, xfApply } from './math.ts'
import { BYTES_PER_VERTEX, jointFrames, skin } from './pose.ts'
import { type RenderItem, render, sheet } from './render.ts'

const ROOT = join(import.meta.dirname, '..', '..')

export interface OpenSkinCheck {
  body: string
  vertices: number
  marginPairs: number
  /** 权重：上唇缘（不含口角）在下颌上的最大份额、下唇缘的最小份额；按下标 / 按位置。 Weights: largest jaw share on the upper margin (corners excluded) and smallest on the lower; by index / by position. */
  byIndex: { upperMaxJaw: number; lowerMinJaw: number; uniqueVertices: number }
  byPosition: { upperMaxJaw: number; lowerMinJaw: number; uniqueVertices: number; marginPairsWelded: number }
  /** 每个张口角度：上唇缘最大位移、下唇缘相对“刚性随下颌”的最大偏差、成对唇缘顶点之间的距离（mm）。 Per opening angle: largest displacement of the upper margin, largest deviation of the lower margin from moving rigidly with the jaw, and the distance between paired margin vertices (mm). */
  poses: { degrees: number; upperMaxMoveMm: number; lowerMaxDeviationMm: number; gapMinMm: number; gapMidMm: number; gapMaxMm: number; cornerMoveMm: number }[]
  renders: string[]
}

export function checkOpenSkin(bodyId: 'male' | 'female', renderDir: string | null = null): OpenSkinCheck | null {
  const dir = join(ROOT, 'public', 'anatomy', bodyId)
  // 包目录与 rig 构建取的相同（装入的皮肤包）/ the package directory is the one the rig build takes (the installed skin package)
  const rules = withInstalledSkinPackages(JSON.parse(readFileSync(join(ROOT, 'data/curated/rig/bindings.json'), 'utf8')) as BindRules)
  const cfg = (rules.externalWeights ?? []).find((e) => e.body === bodyId)
  if (!cfg?.openDir || !existsSync(join(ROOT, cfg.openDir, 'weights.bin')) || !existsSync(join(dir, 'rig.json'))) return null
  const pkg = join(ROOT, cfg.openDir)
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as Rig
  const geom = rig.joints.map((j) => ({ id: j.id, center: j.center as V3, tail: ((j as { tail?: V3 }).tail ?? j.center) as V3 }))
  const ext = loadExternalWeights(pkg, geom, cfg.map ?? [])!
  const mesh = readObj(join(pkg, 'skin.obj'))
  const n = mesh.positions.length / 3
  const manifest = JSON.parse(readFileSync(join(pkg, 'manifest.json'), 'utf8')) as { face: { margins: { upperLip: number[]; lowerLip: number[] } } }
  const up = manifest.face.margins.upperLip, lo = manifest.face.margins.lowerLip
  const inner = up.map((_, k) => k).filter((k) => k > 0 && k < up.length - 1)
  const tmj = rig.joints.findIndex((j) => j.id === 'tmj')

  const bind = (rows: Map<number, number>[], map: Uint32Array): Uint8Array => {
    const bin = new Uint8Array(n * BYTES_PER_VERTEX)
    const dv = new DataView(bin.buffer)
    const idx = new Uint16Array(4), w = new Uint8Array(4)
    for (let i = 0; i < n; i++) {
      const row = rows[map[i]!]!
      const palette = [...row.keys()]
      quantise(palette.map((j) => row.get(j)!), palette, idx, w, 0)
      for (let k = 0; k < 4; k++) {
        dv.setUint16(i * BYTES_PER_VERTEX + k * 2, idx[k]!, true)
        bin[i * BYTES_PER_VERTEX + 8 + k] = w[k]!
      }
    }
    return bin
  }
  const jawShare = (bin: Uint8Array, v: number): number => {
    const dv = new DataView(bin.buffer)
    let s = 0
    for (let k = 0; k < 4; k++) if (dv.getUint16(v * BYTES_PER_VERTEX + k * 2, true) === tmj) s += bin[v * BYTES_PER_VERTEX + 8 + k]! / 255
    return s
  }
  // 按下标：恒等对照 / by index: the identity sidecar
  const identity = Uint32Array.from({ length: n }, (_, i) => i)
  const wi = weldByIndex(mesh.positions, mesh.indices, identity)
  const binIndex = bind(ext.byIndex(wi.source), wi.map)
  // 按位置：老办法 / by position: the old way
  const wp = weld(mesh.positions, mesh.indices)
  const binPos = bind(ext.transfer(wp.pos).rows, wp.map)
  const stats = (bin: Uint8Array): { upperMaxJaw: number; lowerMinJaw: number } => ({
    upperMaxJaw: Math.round(Math.max(...inner.map((k) => jawShare(bin, up[k]!))) * 1000) / 1000,
    lowerMinJaw: Math.round(Math.min(...inner.map((k) => jawShare(bin, lo[k]!))) * 1000) / 1000,
  })

  const poses: OpenSkinCheck['poses'] = []
  const files: string[] = []
  const c: V3 = [0, 0, 0]
  for (const k of inner) (c[0] += mesh.positions[up[k]! * 3]! / inner.length), (c[1] += mesh.positions[up[k]! * 3 + 1]! / inner.length), (c[2] += mesh.positions[up[k]! * 3 + 2]! / inner.length)
  const tiles = []
  for (const degrees of [0, 10, 25]) {
    const xfs = jointFrames(rig.joints, { tmj: [(degrees * Math.PI) / 180, 0] }).xfs
    const out = skin(mesh.positions, binIndex, 0, xfs, 'dqs')
    const P = (a: Float32Array, v: number): V3 => [a[v * 3]!, a[v * 3 + 1]!, a[v * 3 + 2]!]
    const d = (p: V3, q: V3): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    if (degrees > 0) {
      const gaps = inner.map((k) => d(P(out, up[k]!), P(out, lo[k]!))).sort((a, b) => a - b)
      poses.push({
        degrees,
        upperMaxMoveMm: Math.round(Math.max(...inner.map((k) => d(P(out, up[k]!), P(mesh.positions, up[k]!)))) * 1e5) / 100,
        lowerMaxDeviationMm: Math.round(Math.max(...inner.map((k) => d(P(out, lo[k]!), xfApply(xfs[tmj]!, P(mesh.positions, lo[k]!))))) * 1e5) / 100,
        gapMinMm: Math.round(gaps[0]! * 1e5) / 100,
        gapMidMm: Math.round(gaps[gaps.length >> 1]! * 1e5) / 100,
        gapMaxMm: Math.round(gaps[gaps.length - 1]! * 1e5) / 100,
        cornerMoveMm: Math.round(Math.max(d(P(out, up[0]!), P(mesh.positions, up[0]!)), d(P(out, up[up.length - 1]!), P(mesh.positions, up[up.length - 1]!))) * 1e5) / 100,
      })
    }
    if (renderDir) {
      const item = (pos: Float32Array): RenderItem[] => [{ positions: pos, indices: mesh.indices, color: [228, 180, 150] }]
      tiles.push(render(item(out), { yaw: 0, center: [c[0], c[1] - 0.01, c[2]], halfHeight: 0.05, width: 420, height: 420 }))
      tiles.push(render(item(out), { yaw: 60, center: [c[0], c[1] - 0.01, c[2]], halfHeight: 0.05, width: 420, height: 420 }))
      // 对照：按位置绑定的同一姿势 / for comparison: the same pose bound by position
      tiles.push(render(item(skin(mesh.positions, binPos, 0, xfs, 'dqs')), { yaw: 0, center: [c[0], c[1] - 0.01, c[2]], halfHeight: 0.05, width: 420, height: 420 }))
    }
  }
  if (renderDir) {
    mkdirSync(renderDir, { recursive: true })
    const f = join(renderDir, 'skin-open-jaw.png')
    sheet(tiles, 3).save(f)
    files.push(f.slice(ROOT.length + 1))
  }
  let welded = 0
  for (const k of inner) if (wp.map[up[k]!] === wp.map[lo[k]!]) welded++
  return {
    body: bodyId, vertices: n, marginPairs: inner.length,
    byIndex: { ...stats(binIndex), uniqueVertices: wi.n },
    byPosition: { ...stats(binPos), uniqueVertices: wp.n, marginPairsWelded: welded },
    poses, renders: files,
  }
}

if (import.meta.main) {
  const bodyId = (process.argv[2] ?? 'male') as 'male' | 'female'
  const r = checkOpenSkin(bodyId, join(import.meta.dirname, 'out', bodyId))
  console.log(r ? JSON.stringify(r, null, 1) : `no opened skin package for ${bodyId}`)
}
