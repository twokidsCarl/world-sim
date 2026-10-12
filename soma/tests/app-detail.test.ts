// 皱纹细节层的运行时数据处理，逐项对照 CPU 参考实现（tools/face/detail.ts）。
// The wrinkle detail layer's runtime data handling, checked item by item against the CPU reference (tools/face/detail.ts).
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as ref from '../tools/face/detail.ts'
import { painAUs } from '../tools/face/model.ts'
import type { FaceData, FaceDetail } from '../src/face/types.ts'
import { checkDetail, decodePngRgb, layerWeights, readUv } from '../src/pain/detail.ts'

const detail = {
  curve: { gamma: 0.7 },
  layers: [
    { id: 'a', name: { zh: 'a', en: 'a' }, tile: [0, 0], drivers: { AU4: 1, AU9: 0.3 }, wrinkles: 1, maxDepth: 0.001, basis: { source: null, note: { zh: '', en: '' } } },
    { id: 'b', name: { zh: 'b', en: 'b' }, tile: [1, 0], drivers: { AU6: 0.6 }, wrinkles: 1, maxDepth: 0.001, basis: { source: null, note: { zh: '', en: '' } } },
  ],
} as unknown as FaceDetail

describe('detail layer helpers', () => {
  it('layer weights follow the reference formula and clamp to 0–1', () => {
    for (const aus of [{}, { AU4: 2 }, { AU4: 5, AU9: 5 }, { AU6: 3, AU4: 0.5 }, { AU6: 9 }] as Record<string, number>[]) expect(layerWeights(detail, aus)).toEqual(ref.layerWeights(detail, aus))
    expect(layerWeights(detail, {})).toEqual([0, 0])
    expect(layerWeights(detail, { AU4: 5, AU9: 5 })[0]).toBe(1)
    // 复用输出数组 / the output array is reused
    const out: number[] = [9, 9, 9]
    expect(layerWeights(detail, { AU6: 5 }, out)).toBe(out)
    expect(out).toHaveLength(2)
  })

  it('reads uv.bin: listed vertices get a UV, the others NaN; bad files are refused', () => {
    const d = { vertexCount: 5, uv: { count: 2 } } as unknown as FaceDetail
    const bin = new Uint8Array(16)
    const dv = new DataView(bin.buffer)
    dv.setUint32(0, 1, true)
    dv.setUint32(4, 4, true)
    dv.setUint16(8, 65535, true)
    dv.setUint16(10, 0, true)
    dv.setUint16(12, 32768, true)
    dv.setUint16(14, 13107, true)
    const r = readUv(d, bin)
    expect([...r.vertices]).toEqual([1, 4])
    expect([...r.uv.slice(2, 4)]).toEqual([1, 0])
    expect(r.uv[8]).toBeCloseTo(0.5, 4)
    expect(Number.isNaN(r.uv[0]!)).toBe(true)
    expect([...r.uv].map((x) => (Number.isNaN(x) ? -1 : x))).toEqual([...ref.readUv(d, bin)].map((x) => (Number.isNaN(x) ? -1 : x)))
    expect(() => readUv(d, bin.slice(0, 10))).toThrow(/uv\.bin/)
    dv.setUint32(4, 99, true)
    expect(() => readUv(d, bin)).toThrow(/beyond|超出/)
  })
})

// 真实数据（缺失时跳过）：PNG 解码与参考实现逐字节相同，文件相互一致，疼痛 10 时至少一层权重为 1
// The real data (skipped when absent): the PNG decodes byte for byte as the reference does, the files agree, and at pain 10 at least one layer has weight 1
describe.each(['male', 'female'])('real detail data: %s', (name) => {
  const dir = resolve(__dirname, `../public/anatomy/${name}`)
  it.skipIf(!existsSync(resolve(dir, 'face/detail.json')) || !existsSync(resolve(dir, 'face/wrinkles.png')))('decodes like the reference and is consistent', async () => {
    const data = JSON.parse(readFileSync(resolve(dir, 'face/detail.json'), 'utf8')) as FaceDetail
    const png = new Uint8Array(readFileSync(resolve(dir, 'face', data.atlas.file)))
    const mine = await decodePngRgb(png)
    const theirs = ref.decodePng(png)
    expect([mine.width, mine.height]).toEqual([theirs.width, theirs.height])
    let same = true
    for (let i = 0, q = 0; i < theirs.data.length && same; i += 3, q += 4) same = mine.data[q] === theirs.data[i] && mine.data[q + 1] === theirs.data[i + 1] && mine.data[q + 2] === theirs.data[i + 2] && mine.data[q + 3] === 255
    expect(same).toBe(true)
    const loaded = checkDetail(data, new Uint8Array(readFileSync(resolve(dir, 'face', data.uv.file))), mine)
    expect(loaded.vertices).toHaveLength(data.uv.count)
    expect(() => checkDetail(data, new Uint8Array(4), mine)).toThrow(/uv\.bin/)
    expect(() => checkDetail(data, new Uint8Array(readFileSync(resolve(dir, 'face', data.uv.file))), { ...mine, width: mine.width - 1 })).toThrow(/atlas|图集/)
    const face = JSON.parse(readFileSync(resolve(dir, 'face.json'), 'utf8')) as FaceData
    const w = layerWeights(data, painAUs(face.pain, 10))
    expect(w).toEqual(ref.layerWeights(data, painAUs(face.pain, 10)))
    expect(Math.max(...w)).toBe(1)
    expect(layerWeights(data, painAUs(face.pain, 0)).every((x) => x === 0)).toBe(true)
  })
})
