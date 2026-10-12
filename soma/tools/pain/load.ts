// 在 Node / Bun 里读取疼痛模型需要的身体数据（界面里这些数据已经在内存中，不用这个文件）。
// Reads the body data the pain model needs under Node / Bun (the app has all of it in memory
// already and does not use this file).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decodeSkinMaps } from '../../src/anatomy/skinmaps.ts'
import type { AnatomyData, BodyId, NervePath, Rig, SkinMaps } from '../../src/anatomy/types.ts'
import type { InnervationTable, PainBody } from '../../src/painmodel/types.ts'
import { readGlbParts } from '../skinmaps/io.ts'

export const ROOT = join(import.meta.dirname, '../..')

const json = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T

/** 该体型的数据是否齐全 / Whether a body's data is all there. */
export function hasPainBody(body: BodyId, root: string = ROOT): boolean {
  const dir = join(root, 'public/anatomy', body)
  return ['anatomy.json', 'skinmaps.json', 'skinmaps.bin', 'nerves.json', 'rig.json'].every((f) => existsSync(join(dir, f))) && existsSync(join(root, 'data/curated/skinmaps', `innervation.${body}.json`))
}

export async function loadPainBody(body: BodyId, root: string = ROOT): Promise<PainBody> {
  const dir = join(root, 'public/anatomy', body)
  const anatomy = json<AnatomyData>(join(dir, 'anatomy.json'))
  const maps = json<SkinMaps>(join(dir, 'skinmaps.json'))
  const bin = readFileSync(join(dir, 'skinmaps.bin'))
  const skinMaps = decodeSkinMaps(maps, bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer)
  const skinPart = anatomy.parts.find((p) => p.id === maps.part)
  if (!skinPart) throw new Error(`pain: 找不到皮肤部件 ${maps.part} / skin part ${maps.part} not found`)
  const glb = anatomy.systems.find((s) => s.id === skinPart.system)?.glb
  if (!glb) throw new Error(`pain: 系统 ${skinPart.system} 没有 GLB / system ${skinPart.system} has no GLB`)
  const mesh = (await readGlbParts(join(dir, glb), new Set([maps.part]))).get(maps.part)
  if (!mesh) throw new Error(`pain: GLB 里没有 ${maps.part} / ${maps.part} is not in the GLB`)
  return {
    body,
    skin: { part: maps.part, positions: mesh.positions },
    skinMaps,
    innervation: json<InnervationTable>(join(root, 'data/curated/skinmaps', `innervation.${body}.json`)),
    nerves: json<NervePath[]>(join(dir, 'nerves.json')),
    parts: anatomy.parts.map((p) => ({ id: p.id, name: p.name, centroid: p.centroid })),
    joints: json<Rig>(join(dir, 'rig.json')).joints,
  }
}
