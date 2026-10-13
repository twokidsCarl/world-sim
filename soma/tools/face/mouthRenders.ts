// 口部特写的离线渲染：口角（AU12 / 20 / 25）、全部视位、情绪原型。只读已发布的 face.json / face.bin，不重建。
// Offline close-ups of the mouth: the corners (AU12 / 20 / 25), every viseme, the emotion prototypes. Reads the published
// face.json / face.bin and rebuilds nothing.
//
//   bun tools/face/mouthRenders.ts [male|female] [corner|visemes|tongue|emotions|aus|all]
//
// visemes：每张 6 个视位；四排 = 正常风格正面、正常风格斜侧、夸张风格正面、夸张风格斜侧。tongue：正中矢状切片里的舌（从身体左侧看），
// 一张是五个示意姿势，另外几张是各视位的舌。
// visemes: six visemes a sheet; four rows = normal style front, normal three-quarter, exaggerated front, exaggerated three-quarter.
// tongue: the tongue in a midsagittal slab (seen from the body's left), one sheet with the five schematic poses and further sheets
// with the tongue of every viseme.
//
// 输出在 tools/face/out/<body>/（不入库）/ output goes to tools/face/out/<body>/ (not committed).

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Rig } from '../../src/anatomy/types.ts'
import type { FaceData, FaceOpenings } from '../../src/face/types.ts'
import { readBody } from '../rig/io.ts'
import { Poser } from '../rig/pose.ts'
import { type Image, type RenderItem, type View, render, sheet } from '../rig/render.ts'
import { type AUs, type Activations, SPEECH_STYLES, activations, expressionAUs, visemeAUs } from './model.ts'
import { type FaceScene, posedPart, scene, skinViewItems } from './renders.ts'

const ROOT = join(import.meta.dirname, '..', '..')

/** 给定通道激活和下颌角的一帧：皮肤视图或肌肉视图。 One frame for given channel activations and jaw angle: skin view or muscle view. */
export function renderChannels(s: FaceScene, channels: Activations, jaw: number, view: View, muscle = false): Image {
  const pose = jaw > 0 ? { [s.face.jaw.joint]: Array.from({ length: s.face.jaw.dof + 1 }, (_, k) => (k === s.face.jaw.dof ? jaw : 0)) } : {}
  const poser = new Poser(s.rig, s.rigBin, pose)
  const items: RenderItem[] = muscle ? s.deepParts.map((d) => ({ positions: posedPart(s, poser, d.part.id, channels), indices: s.body.meshes.get(d.part.id)!.indices, color: d.color })) : skinViewItems(s, poser, channels)
  // 调试：FACE_SHEETS=1 时给口周的三片上色（上唇红、下唇绿、口角外侧蓝、口腔袋品红）/ debugging: with FACE_SHEETS=1 the three perioral sheets are tinted (upper lip red, lower lip green, lateral blue, pouch magenta)
  const O = s.openings
  if (!muscle && O && process.env.FACE_SHEETS && items[0]?.vertexColors) {
    const col = items[0].vertexColors
    for (const [list, c] of [[O.sheets.mouthLateral, [110, 130, 230]], [O.sheets.mouthUpper, [230, 110, 110]], [O.sheets.mouthLower, [110, 200, 120]], [[...O.oralPouch.upper, ...O.oralPouch.lower, ...O.oralPouch.seam], [255, 0, 255]]] as [number[], number[]][]) for (const v of list) col.set(c, v * 3)
  }
  return render(items, view)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const bodyId = args[0] ?? 'male', what = args[1] ?? 'all'
  const only = args[2]
  const dir = join(ROOT, 'public', 'anatomy', bodyId)
  const body = await readBody(dir)
  const rig = JSON.parse(readFileSync(join(dir, 'rig.json'), 'utf8')) as Rig
  const face = JSON.parse(readFileSync(join(dir, 'face.json'), 'utf8')) as FaceData
  const bin = new Uint8Array(readFileSync(join(dir, 'face.bin')))
  const op = join(dir, 'face', 'openings.json')
  const openings = existsSync(op) ? (JSON.parse(readFileSync(op, 'utf8')) as FaceOpenings) : null
  const sc = scene(body, rig, new Uint8Array(readFileSync(join(dir, 'rig.bin'))), face, bin, openings)
  const outDir = join(import.meta.dirname, 'out', bodyId)
  mkdirSync(outDir, { recursive: true })
  // 取景中心放在口的深度上，斜侧视图里口才在画面中间 / the view centre sits at the depth of the mouth, so that the mouth stays centred in the three-quarter view
  const mouthZ = (face.channels.find((c) => c.id === 'orbicularis_oris')?.line.originOnSkin[2] ?? 0.18) - 0.02
  const mouth = (yaw: number, size: number, half = 0.042): View => ({ yaw, center: [face.landmarks.midX, face.landmarks.stomionY.skin - 0.006, mouthZ], halfHeight: half, width: size, height: size })
  const head = (yaw: number, size: number): View => ({ yaw, center: [sc.center[0], sc.center[1] - 0.006, sc.center[2]], halfHeight: sc.halfHeight - 0.012, width: size, height: size })
  const ofAUs = (aus: AUs): { channels: Activations; jaw: number } => activations(face, aus)
  const save = (im: Image[], cols: number, name: string): void => {
    sheet(im, cols).save(join(outDir, name))
    console.log(join('tools/face/out', bodyId, name))
  }
  if (what === 'corner' || what === 'all') {
    // 每个 AU 一张：列 = 静止、强度 3、强度 5；上排正面，下排斜侧 / one sheet per AU: columns rest, 3, 5; front above, three-quarter below
    for (const au of only ? [only] : ['AU12', 'AU20', 'AU25']) {
      const cols = [0, 3, 5].map((i) => ofAUs(i ? { [au]: i } : {}))
      save([...cols.map((c) => renderChannels(sc, c.channels, c.jaw, mouth(0, 700))), ...cols.map((c) => renderChannels(sc, c.channels, c.jaw, mouth(45, 700)))], 3, `mouth-${au}.png`)
    }
  }
  if (what === 'aus' || what === 'all') {
    const ids = ['AU10', 'AU11', 'AU13', 'AU14', 'AU15', 'AU16', 'AU17', 'AU18', 'AU22', 'AU23', 'AU24', 'AU28'].filter((id) => face.aus.some((a) => a.id === id))
    const cols = ids.map((id) => ofAUs({ [id]: 5 }))
    save([...cols.map((c) => renderChannels(sc, c.channels, c.jaw, mouth(0, 420))), ...cols.map((c) => renderChannels(sc, c.channels, c.jaw, mouth(45, 420)))], ids.length, 'mouth-aus.png')
  }
  if ((what === 'visemes' || what === 'all') && face.visemes) {
    const vs = only ? face.visemes.visemes.filter((v) => only.split(',').includes(v.id)) : face.visemes.visemes
    const per = 6
    for (let k = 0; k * per < vs.length; k++) {
      const part = vs.slice(k * per, (k + 1) * per)
      const rows = [SPEECH_STYLES.normal, SPEECH_STYLES.clear].flatMap((style) => {
        const cols = part.map((v) => visemeAUs(face, { [v.id]: 1 }, style))
        return [cols.map((c) => renderChannels(sc, c.channels, c.jaw, mouth(0, 480))), cols.map((c) => renderChannels(sc, c.channels, c.jaw, mouth(45, 480)))]
      })
      save(rows.flat(), part.length, `visemes-${k + 1}.png`)
      console.log('  ', part.map((v) => v.id).join(' '))
    }
  }
  if (what === 'tongue' || what === 'all') {
    // 正中矢状切片（正中两侧各 6 mm）：舌、牙、骨；从身体左侧看，前方在画面左边 / a midsagittal slab (6 mm either side of the midline): tongue, teeth, bone; seen from the body's left, anterior on the left of the image
    const tongueCh = face.channels.filter((c) => c.kind === 'tongue')
    const tonguePart = tongueCh[0]?.fields[0]?.part
    if (tonguePart) {
      const tb = body.byId.get(tonguePart)!.bbox
      const view: View = { yaw: 90, center: [face.landmarks.midX, (tb[1] + tb[4]) / 2 + 0.006, (tb[2] + tb[5]) / 2 + 0.008], halfHeight: 0.036, width: 480, height: 480, slab: [-0.006, 0.006] }
      const parts = body.data.parts.filter((p) => body.meshes.has(p.id) && p.bbox[4] > tb[1] - 0.03 && p.bbox[1] < tb[4] + 0.04 && (p.id === tonguePart || p.tissue === 'tooth' || p.tissue === 'bone'))
      const sagittal = (channels: Activations, jaw: number): Image => {
        const poser = new Poser(rig, sc.rigBin, jaw > 0 ? { [face.jaw.joint]: Array.from({ length: face.jaw.dof + 1 }, (_, k) => (k === face.jaw.dof ? jaw : 0)) } : {})
        return render(parts.map((p) => ({ positions: posedPart(sc, poser, p.id, channels), indices: body.meshes.get(p.id)!.indices, color: p.id === tonguePart ? ([196, 96, 104] as const) : p.tissue === 'tooth' ? ([246, 244, 232] as const) : ([226, 220, 200] as const) })), view, [40, 40, 46])
      }
      save([sagittal({}, 0), ...tongueCh.map((c) => sagittal({ [c.id]: 1 }, 0))], tongueCh.length + 1, 'tongue-poses.png')
      console.log('   rest', tongueCh.map((c) => c.id).join(' '))
      const vs = face.visemes?.visemes ?? []
      for (let k = 0; k * 8 < vs.length; k++) {
        const part = vs.slice(k * 8, (k + 1) * 8)
        save(part.map((v) => visemeAUs(face, { [v.id]: 1 })).map((c) => sagittal(c.channels, c.jaw)), part.length, `tongue-visemes-${k + 1}.png`)
        console.log('  ', part.map((v) => v.id).join(' '))
      }
    }
  }
  if ((what === 'emotions' || what === 'all') && face.expressions) {
    const basic = face.expressions.filter((e) => !e.compoundOf).slice(0, 6)
    // 总览：第一列静止，其后六种基本情绪；上排皮肤，下排肌肉 / overview: rest first, then the six basic emotions; skin above, muscle below
    {
      const sets = [ofAUs({}), ...basic.map((e) => ofAUs(expressionAUs(face.expressions, e.id, 1)))]
      save([...sets.map((c) => renderChannels(sc, c.channels, c.jaw, head(0, 520))), ...sets.map((c) => renderChannels(sc, c.channels, c.jaw, { ...head(0, 520), halfHeight: sc.halfHeight, center: sc.center }, true))], sets.length, 'emotions-basic.png')
    }
    for (const e of basic) {
      const c = ofAUs(expressionAUs(face.expressions, e.id, 1)), r = ofAUs({})
      save([renderChannels(sc, r.channels, r.jaw, head(0, 620)), renderChannels(sc, c.channels, c.jaw, head(0, 620)), renderChannels(sc, c.channels, c.jaw, { ...head(0, 620), halfHeight: sc.halfHeight, center: sc.center }, true)], 3, `emotion-${e.id}.png`)
    }
  }
}
