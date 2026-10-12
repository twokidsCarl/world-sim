// 参考场景：在身体上按解剖关系找刺激点（不写死顶点下标），并给出一组标准刺激。
// Reference scenarios: stimulus sites found on the body by anatomy (no hard-coded vertex index)
// and a set of standard stimuli.

import type { Vec3 } from '../../src/anatomy/types.ts'
import { nearestSkinVertex } from '../../src/painmodel/index.ts'
import type { PainBody, SideLR, Stimulus } from '../../src/painmodel/types.ts'

export interface Site {
  vertex: number
  position: Vec3
}

function at(body: PainBody, vertex: number): Site {
  const p = body.skin.positions
  return { vertex, position: [p[vertex * 3]!, p[vertex * 3 + 1]!, p[vertex * 3 + 2]!] }
}

/** 某关节骨段远端处的皮肤（如 dip2_L 的远端 = 左示指尖）/ Skin at the distal end of a joint's segment (the tail of dip2_L = tip of the left index finger). */
export function segmentTip(body: PainBody, jointId: string): Site {
  const j = body.joints?.find((x) => x.id === jointId)
  if (!j) throw new Error(`pain: 没有关节 ${jointId} / no joint ${jointId}`)
  return at(body, nearestSkinVertex(body.skin.positions, j.tail ?? j.center))
}

/** 某皮神经分布区（一侧）的中心：离该区顶点质心最近的本区顶点。 */
/** Centre of a cutaneous territory on one side: the territory's own vertex nearest the centroid of its vertices. */
export function territoryCentre(body: PainBody, territory: string, side: SideLR): Site {
  const map = body.skinMaps.maps.find((m) => m.id === 'cutaneousNerve')!
  const region = body.innervation.cutaneous.findIndex((c) => c.territory === territory)
  if (region < 0) throw new Error(`pain: 没有分布区 ${territory} / no territory ${territory}`)
  const p = body.skin.positions
  const inside = (i: number) => map.data[i] === region && (p[i * 3]! >= 0) === (side === 'L')
  const c: Vec3 = [0, 0, 0]
  let n = 0
  for (let i = 0; i < body.skinMaps.vertexCount; i++) {
    if (!inside(i)) continue
    c[0] += p[i * 3]!
    c[1] += p[i * 3 + 1]!
    c[2] += p[i * 3 + 2]!
    n++
  }
  if (n === 0) throw new Error(`pain: 分布区 ${territory} ${side} 没有顶点 / territory ${territory} ${side} has no vertices`)
  return at(body, nearestSkinVertex(p, [c[0] / n, c[1] / n, c[2] / n], inside))
}

/** 把一个点镜像到对侧，并取对侧最近的皮肤顶点 / Mirror a site to the other side and take the nearest skin vertex there. */
export function mirrorSite(body: PainBody, site: Site): Site {
  const m: Vec3 = [-site.position[0], site.position[1], site.position[2]]
  return at(body, nearestSkinVertex(body.skin.positions, m, (i) => (body.skin.positions[i * 3]! >= 0) === (m[0] >= 0)))
}

export interface Scenario {
  id: string
  name: { zh: string; en: string }
  build(body: PainBody, side: SideLR): Stimulus
}

const stim = (site: Site, rest: Omit<Stimulus, 'site'>): Stimulus => ({ site: { position: site.position, vertex: site.vertex }, ...rest })

export const SCENARIOS: Scenario[] = [
  {
    id: 'pinprick-fingertip',
    name: { zh: '针刺示指尖，256 mN，2 秒', en: 'Pinprick to the index fingertip, 256 mN, 2 s' },
    build: (b, s) => stim(segmentTip(b, `dip2_${s}`), { kind: 'pinprick', forceN: 0.256, duration: 2 }),
  },
  {
    id: 'pinprick-fingertip-light',
    name: { zh: '针刺示指尖，32 mN（阈下），2 秒', en: 'Pinprick to the index fingertip, 32 mN (below threshold), 2 s' },
    build: (b, s) => stim(segmentTip(b, `dip2_${s}`), { kind: 'pinprick', forceN: 0.032, duration: 2 }),
  },
  {
    id: 'windup-hand',
    name: { zh: '手背重复针刺，256 mN，10 次，1 Hz', en: 'Repeated pinprick to the back of the hand, 256 mN, ten at 1 Hz' },
    build: (b, s) => stim(territoryCentre(b, 'superficialRadial', s), { kind: 'pinprick', forceN: 0.256, duration: 0.5, repeat: { count: 10, hz: 1 } }),
  },
  {
    id: 'heat-forearm',
    name: { zh: '前臂接触热，48 °C，8 秒', en: 'Contact heat on the forearm, 48 °C, 8 s' },
    build: (b, s) => stim(territoryCentre(b, 'lateralAntebrachial', s), { kind: 'heat', temperatureC: 48, areaMm2: 256, duration: 8 }),
  },
  {
    id: 'heat-forearm-warm',
    name: { zh: '前臂接触热，43 °C（阈下），8 秒', en: 'Contact heat on the forearm, 43 °C (below threshold), 8 s' },
    build: (b, s) => stim(territoryCentre(b, 'lateralAntebrachial', s), { kind: 'heat', temperatureC: 43, areaMm2: 256, duration: 8 }),
  },
  {
    id: 'heat-face',
    name: { zh: '面颊接触热，43 °C，3 秒', en: 'Contact heat on the cheek, 43 °C, 3 s' },
    build: (b, s) => stim(territoryCentre(b, 'infraorbital', s), { kind: 'heat', temperatureC: 43, areaMm2: 256, duration: 3 }),
  },
  {
    id: 'pressure-shin',
    name: { zh: '小腿钝压，80 N / 1 cm²（800 kPa），3 秒', en: 'Blunt pressure on the leg, 80 N on 1 cm² (800 kPa), 3 s' },
    build: (b, s) => stim(territoryCentre(b, 'saphenous', s), { kind: 'pressure', forceN: 80, areaMm2: 100, duration: 3 }),
  },
  {
    id: 'pinch-sole',
    name: { zh: '足底捏夹，20 N / 25 mm²（800 kPa），1 秒', en: 'Pinch on the sole, 20 N on 25 mm² (800 kPa), 1 s' },
    build: (b, s) => stim(territoryCentre(b, 'medialPlantar', s), { kind: 'pinch', forceN: 20, areaMm2: 25, duration: 1 }),
  },
  {
    id: 'cold-hand-held',
    name: { zh: '手掌浸冷，4 °C，60 秒，手被固定（冷加压式）', en: 'Cold on the palm, 4 °C, 60 s, hand held in place (cold-pressor style)' },
    build: (b, s) => stim(territoryCentre(b, 'median', s), { kind: 'cold', temperatureC: 4, areaMm2: 900, duration: 60, withdrawalEndsStimulus: false }),
  },
  {
    id: 'cold-hand-free',
    name: { zh: '手掌接触冷物，4 °C，60 秒，手可以缩回', en: 'Cold object on the palm, 4 °C, 60 s, hand free to withdraw' },
    build: (b, s) => stim(territoryCentre(b, 'median', s), { kind: 'cold', temperatureC: 4, areaMm2: 900, duration: 60 }),
  },
]
