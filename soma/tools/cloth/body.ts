// 衣物工具读取人体的一层：皮肤网格（米，GLB 顶点顺序）、绑定、关节中心，以及摆姿势后的皮肤。
// 只读已发布的文件（public/anatomy/<body>/），不依赖几何管线。
// The clothing tools' view of a body: the skin mesh (metres, GLB vertex order), the rig, joint
// centres and the posed skin. Reads only the published files (public/anatomy/<body>/); does not
// depend on the geometry pipeline.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rig } from '../../src/anatomy/types.ts'
import { readGlbParts } from '../skinmaps/io.ts'
import { Poser, type Pose } from '../rig/pose.ts'

export const ROOT = join(import.meta.dir, '..', '..')
export const BODIES = ['male', 'female'] as const
export type BodyId = (typeof BODIES)[number]

/** 每副人体的皮肤部件 id / The skin part id of each body. */
export const SKIN_PART: Record<BodyId, string> = { male: 'FJ2810', female: 'SOMA_skin' }

export interface SkinBody {
  id: BodyId
  dir: string
  skinId: string
  /** 静止姿势的皮肤顶点（米）/ Rest skin vertices (metres). */
  rest: Float32Array
  indices: Uint32Array
  rig: Rig
  rigBin: Uint8Array
  /** 地面高度：皮肤最低点 / Floor height: the lowest skin point. */
  floorY: number
  joint(id: string): [number, number, number]
}

export function bodyDir(id: BodyId): string {
  return join(ROOT, 'public', 'anatomy', id)
}

export async function loadSkinBody(id: BodyId): Promise<SkinBody> {
  const dir = bodyDir(id)
  const skinId = SKIN_PART[id]
  const parts = await readGlbParts(join(dir, 'integumentary.glb'), new Set([skinId]))
  const skin = parts.get(skinId)
  if (!skin) throw new Error(`cloth: ${id} has no skin part ${skinId}`)
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as Rig
  const rigBin = new Uint8Array(readFileSync(join(dir, 'rig.bin')))
  let floorY = Infinity
  for (let i = 1; i < skin.positions.length; i += 3) floorY = Math.min(floorY, skin.positions[i]!)
  const byId = new Map(rig.joints.map((j) => [j.id, j]))
  return {
    id,
    dir,
    skinId,
    rest: skin.positions,
    indices: skin.indices,
    rig,
    rigBin,
    floorY,
    joint: (j) => {
      const c = byId.get(j)?.center
      if (!c) throw new Error(`cloth: ${id} has no joint ${j}`)
      return [c[0]!, c[1]!, c[2]!]
    },
  }
}

/** 摆姿势后的皮肤顶点 / Skin vertices in a pose. */
export function posedSkin(b: SkinBody, pose: Pose): Float32Array {
  return new Poser(b.rig, b.rigBin, pose).part(b.skinId, b.rest, 'dqs', false)
}
