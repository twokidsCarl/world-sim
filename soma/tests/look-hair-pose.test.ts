// 摆姿势时贴着皮肤的毛（腋毛、阴毛、胡须）跟着皮肤走：每个发片顶点照抄最近皮肤顶点的蒙皮影响，蒙皮后离皮肤近，
// 比整张发片照抄根的主顶点（旧做法）近得多。
// Under a pose, hair lying on the skin (axillary, pubic, beard) follows the skin: each card vertex copies the nearest
// skin vertex's influences, and after skinning it stays close to the skin, much closer than when the whole card copies
// its root's main vertex (the old way).
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeLod, dominantVertex, placeVertices, surfaceAnchors } from '../src/hair/cards.ts'
import type { Rig } from '../src/anatomy/types.ts'
import type { HairData } from '../src/look/types.ts'
import { jointFrames, jointTransforms, skin } from '../tools/rig/pose.ts'
import { packJoints } from '../src/anatomy/rig.ts'
import { followSkin } from '../src/hair/follow.ts'
import { standardPostures } from '../tools/rig/postures.ts'
import { readGlbParts } from '../tools/skinmaps/io.ts'
import { Surface } from '../tools/hair/geom.ts'
import { vertexNormals } from '../tools/hair/skin.ts'

const ROOT = resolve(import.meta.dirname, '..')

/** 蒙皮后发片顶点离皮肤距离的第 95 百分位（米）/ 95th percentile distance from card vertex to skin after skinning (m) */
function p95(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length * 0.95)]!
}

for (const body of ['male', 'female']) {
  const dir = resolve(ROOT, 'public', 'anatomy', body)
  describe.skipIf(!existsSync(resolve(dir, 'hair', 'hair.json')))(`body hair follows the skin under a pose (${body})`, () => {
    for (const [piece, poseId] of [['axilla', 'shoulderAbd90'], ['pubic', 'squat'], ['axilla', 'shoulderFlex160'], ['beard', 'neckRot60']] as const) {
      it.skipIf(piece === 'beard' && body !== 'male')(`${piece} at ${poseId}`, async () => {
        const meta = JSON.parse(readFileSync(resolve(dir, 'hair', 'hair.json'), 'utf8')) as HairData
        const rig = JSON.parse(readFileSync(resolve(dir, 'rig.json'), 'utf8')) as Rig
        const rigBin = new Uint8Array(readFileSync(resolve(dir, 'rig.bin')))
        const sk = (await readGlbParts(resolve(dir, 'integumentary.glb'), new Set([meta.skin]))).get(meta.skin)!
        const b = rig.bindings.find((x) => x.part === meta.skin)!
        const n = sk.positions.length / 3
        const skinBin = rigBin.slice(b.offset!, b.offset! + n * 12)
        const pose = standardPostures(rig.joints).find((p) => p.id === poseId)!.pose
        const xfs = jointTransforms(rig.joints, pose)
        const posedSkin = skin(sk.positions, skinBin, 0, xfs)
        const surface = new Surface(posedSkin, sk.indices)
        const spec = meta.pieces.find((p) => p.id === piece)!
        const d = decodeLod(new Uint8Array(readFileSync(resolve(dir, 'hair', spec.file))), spec.lods[0]!, meta.offsetUnit, n)
        const rest = new Float32Array(d.offset.length)
        placeVertices(d, sk.positions, rest)
        const anchors = surfaceAnchors(rest, sk.positions, vertexNormals(sk.positions, sk.indices), d)
        const V = rest.length / 3, per = d.rings * 2
        // 两种做法的影响字节（每顶点 12 字节，与 rig.bin 同格式）/ influence bytes of both ways (12 bytes per vertex, rig.bin's format)
        const viaAnchor = new Uint8Array(V * 12), viaRoot = new Uint8Array(V * 12)
        for (let v = 0; v < V; v++) {
          viaAnchor.set(skinBin.subarray(anchors[v]! * 12, anchors[v]! * 12 + 12), v * 12)
          const r = dominantVertex(d, Math.floor(v / per))
          viaRoot.set(skinBin.subarray(r * 12, r * 12 + 12), v * 12)
        }
        const dist = (posed: Float32Array): number[] => {
          const out: number[] = []
          for (let v = 0; v < V; v++) out.push(surface.closest([posed[v * 3]!, posed[v * 3 + 1]!, posed[v * 3 + 2]!])!.distance)
          return out
        }
        const a = p95(dist(skin(rest, viaAnchor, 0, xfs)))
        const r = p95(dist(skin(rest, viaRoot, 0, xfs)))
        // 跟随前导恢复长度后（运行时的做法）/ after restoring the lengths follow-the-leader (what runs in the viewer)
        const infIndex = new Uint16Array(n * 4), infWeight = new Uint8Array(n * 4)
        const dv = new DataView(skinBin.buffer)
        for (let v = 0; v < n; v++) for (let k = 0; k < 4; k++) {
          infIndex[v * 4 + k] = dv.getUint16(v * 12 + k * 2, true)
          infWeight[v * 4 + k] = skinBin[v * 12 + 8 + k]!
        }
        const relaid = new Float32Array(rest.length)
        followSkin(rest, anchors, d.rings, infIndex, infWeight, packJoints(jointFrames(rig.joints, pose)), 'pose', relaid)
        const posedRelaid = skin(relaid, viaAnchor, 0, xfs)
        const f = p95(dist(posedRelaid))
        // 每张发片的长度比（姿势 / 静止）/ per-card length ratio (posed / rest)
        const cardLen = (p: Float32Array, c: number): number => {
          let L = 0
          // 中心线 / the centre line
          const mid = (k: number, j: number): number => (p[(c * per + k * 2) * 3 + j]! + p[(c * per + k * 2 + 1) * 3 + j]!) / 2
          for (let k = 1; k < d.rings; k++) L += Math.hypot(mid(k, 0) - mid(k - 1, 0), mid(k, 1) - mid(k - 1, 1), mid(k, 2) - mid(k - 1, 2))
          return L
        }
        const stretch: number[] = [], stretchAnchor: number[] = []
        const posedAnchor = skin(rest, viaAnchor, 0, xfs)
        for (let c = 0; c < d.cards; c++) {
          stretch.push(cardLen(posedRelaid, c) / cardLen(rest, c))
          stretchAnchor.push(cardLen(posedAnchor, c) / cardLen(rest, c))
        }
        // 静止时发片离皮肤的距离（参照）/ the cards' distance from the skin at rest (reference)
        const restSurface = new Surface(sk.positions, sk.indices)
        const r0: number[] = []
        for (let v = 0; v < V; v++) r0.push(restSurface.closest([rest[v * 3]!, rest[v * 3 + 1]!, rest[v * 3 + 2]!])!.distance)
        const atRest = p95(r0)
        console.log(`${body} ${piece} ${poseId}: p95 distance at rest ${(atRest * 1000).toFixed(1)} mm; posed: re-laid ${(f * 1000).toFixed(1)} mm (stretch p95 ${p95(stretch).toFixed(2)}), per-vertex only ${(a * 1000).toFixed(1)} mm (stretch p95 ${p95(stretchAnchor).toFixed(2)}), rigid by root ${(r * 1000).toFixed(1)} mm`)
        // 重排后：离皮肤比静止时多不超过 1 毫米、不比按根刚性的远（差 0.5 毫米以内算持平）；发片不被拉长（长度比 p95 ≤ 1.05）
        // re-laid: at most 1 mm farther from the skin than at rest and no farther than rigid-by-root (within 0.5 mm counts as even); cards are not stretched (length ratio p95 ≤ 1.05)
        expect(f).toBeLessThan(atRest + 0.001)
        expect(f).toBeLessThan(r + 0.0005)
        expect(p95(stretch)).toBeLessThan(1.05)
      }, 120000)
    }
  })
}
