// Dev fixture generator: writes a small, contract-conformant dataset built from primitives.
//
//   bun tools/fixture/make-fixture.ts                 -> public/anatomy/fixture/
//   bun tools/fixture/make-fixture.ts --stress 2200   -> public/anatomy/stress/ (perf testing;
//                                                        N extra blobs, ~640 triangles each)
//
// Output layout mirrors the real pipeline (src/anatomy/types.ts): anatomy.json, one GLB per
// system (EXT_meshopt_compression + KHR_mesh_quantization, node name = Part.id), plus
// knowledge/names.json and knowledge/relations.json inside the dataset directory.
// FMA ids are synthetic ("FMA9xxxxx") and must not be mistaken for real FMA concepts.

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Document, NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions'
import { quantize, reorder } from '@gltf-transform/functions'
import { MeshoptEncoder } from 'meshoptimizer'
import * as THREE from 'three'
import type {
  AnatomyData,
  Concept,
  NameEntry,
  NervePath,
  Part,
  Relation,
  RelationKind,
  Side,
  SystemDef,
  SystemId,
  TissueId,
  Vec3,
} from '../../src/anatomy/types.ts'

interface Geo {
  position: Float32Array<ArrayBuffer>
  normal: Float32Array<ArrayBuffer>
  index: Uint32Array<ArrayBuffer>
}

interface Draft {
  id: string
  fma: string
  name: string
  zh: string
  la?: string
  system: SystemId
  tissue: TissueId
  depth: number
  side: Side
  geo: Geo
  /** isa class path, root first (names). The part's own concept is appended automatically. */
  isa: string[]
  /** partOf region name, or null when the part is not covered by the partOf tree. */
  region: string | null
  /** Dataset the geometry "came from"; absent = the first source. */
  source?: string
  /** Centreline, for parts that get an entry in nerves.json. */
  path?: { points: Vec3[]; radius: number }
}

const SRC_WARPED = 'soma fixture (warped set)'
const SRC_DRAWN = 'soma fixture (drawn set)'

// ---------------------------------------------------------------- geometry helpers

function fromThree(g: THREE.BufferGeometry, m?: THREE.Matrix4): Geo {
  if (m) g.applyMatrix4(m)
  const gi = g.index ? g : indexed(g)
  const position = new Float32Array(gi.getAttribute('position').array)
  const normal = new Float32Array(gi.getAttribute('normal').array)
  const index = new Uint32Array(gi.index!.array)
  return { position, normal, index }
}

function indexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.getAttribute('position').count
  const idx = new Uint32Array(n)
  for (let i = 0; i < n; i++) idx[i] = i
  g.setIndex(new THREE.BufferAttribute(idx, 1))
  return g
}

function ellipsoid(c: Vec3, r: Vec3, seg = 20): Geo {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...c),
    new THREE.Quaternion(),
    new THREE.Vector3(...r),
  )
  return fromThree(new THREE.SphereGeometry(1, seg, Math.max(8, Math.round(seg * 0.7))), m)
}

/** Capped cylinder (or cone frustum) from a to b. */
function tube(a: Vec3, b: Vec3, r0: number, r1 = r0, seg = 14): Geo {
  const va = new THREE.Vector3(...a)
  const vb = new THREE.Vector3(...b)
  const dir = vb.clone().sub(va)
  const len = dir.length()
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize())
  const m = new THREE.Matrix4().compose(va.clone().add(vb).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1))
  // CylinderGeometry(radiusTop, radiusBottom): top is +Y, i.e. towards b.
  return fromThree(new THREE.CylinderGeometry(r1, r0, len, seg, 4), m)
}

function box(c: Vec3, s: Vec3): Geo {
  const m = new THREE.Matrix4().makeTranslation(...c)
  return fromThree(new THREE.BoxGeometry(s[0], s[1], s[2], 2, 2, 2), m)
}

/** Half ring in the XZ plane (a rib), opening towards the spine. side: +1 = body's left. */
function rib(y: number, rx: number, rz: number, side: number, t = 0.008): Geo {
  const r = Math.max(rx, rz)
  // unit torus arc in XY -> lay it in XZ, start it at the spine, then scale to an ellipse
  const m = new THREE.Matrix4()
    .makeTranslation(0, y, 0.02)
    .multiply(new THREE.Matrix4().makeScale(rx * side, r, rz))
    .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
    .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
  const out = fromThree(new THREE.TorusGeometry(1, t / r, 8, 28, Math.PI * 0.86), m)
  if (side < 0) flipWinding(out)
  return recomputeNormals(out)
}

function toThree(g: Geo): THREE.BufferGeometry {
  const b = new THREE.BufferGeometry()
  b.setAttribute('position', new THREE.BufferAttribute(g.position, 3))
  b.setAttribute('normal', new THREE.BufferAttribute(g.normal, 3))
  b.setIndex(new THREE.BufferAttribute(g.index, 1))
  return b
}

function flipWinding(g: Geo): void {
  for (let i = 0; i < g.index.length; i += 3) {
    const t = g.index[i + 1]!
    g.index[i + 1] = g.index[i + 2]!
    g.index[i + 2] = t
  }
}

function recomputeNormals(g: Geo): Geo {
  const b = toThree(g)
  b.computeVertexNormals()
  return { position: g.position, normal: new Float32Array(b.getAttribute('normal').array), index: g.index }
}

function merge(...gs: Geo[]): Geo {
  const vn = gs.reduce((a, g) => a + g.position.length, 0)
  const inn = gs.reduce((a, g) => a + g.index.length, 0)
  const position = new Float32Array(vn)
  const normal = new Float32Array(vn)
  const index = new Uint32Array(inn)
  let vo = 0
  let io = 0
  for (const g of gs) {
    position.set(g.position, vo)
    normal.set(g.normal, vo)
    for (let i = 0; i < g.index.length; i++) index[io + i] = g.index[i]! + vo / 3
    vo += g.position.length
    io += g.index.length
  }
  return { position, normal, index }
}

function measure(g: Geo): Pick<Part, 'bbox' | 'centroid' | 'triangles' | 'volume'> {
  const p = g.position
  const bbox: Part['bbox'] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k]!
      if (v < bbox[k]!) bbox[k] = v
      if (v > bbox[k + 3]!) bbox[k + 3] = v
    }
  }
  let area = 0
  let vol = 0
  const c: Vec3 = [0, 0, 0]
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const d = new THREE.Vector3()
  const ab = new THREE.Vector3()
  const ad = new THREE.Vector3()
  const cr = new THREE.Vector3()
  for (let i = 0; i < g.index.length; i += 3) {
    a.fromArray(p, g.index[i]! * 3)
    b.fromArray(p, g.index[i + 1]! * 3)
    d.fromArray(p, g.index[i + 2]! * 3)
    cr.crossVectors(ab.subVectors(b, a), ad.subVectors(d, a))
    const w = cr.length() / 2
    area += w
    c[0] += ((a.x + b.x + d.x) / 3) * w
    c[1] += ((a.y + b.y + d.y) / 3) * w
    c[2] += ((a.z + b.z + d.z) / 3) * w
    vol += a.dot(cr.crossVectors(b, d)) / 6
  }
  const r = (v: number) => Math.round(v * 1e5) / 1e5
  return {
    bbox: bbox.map(r) as Part['bbox'],
    centroid: [r(c[0] / area), r(c[1] / area), r(c[2] / area)],
    triangles: g.index.length / 3,
    volume: Math.round(Math.abs(vol) * 1e6 * 100) / 100, // m³ -> cm³
  }
}

// ---------------------------------------------------------------- systems / layers

const SYSTEMS: Omit<SystemDef, 'glb' | 'partCount'>[] = [
  { id: 'integumentary', name: { en: 'Integumentary', zh: '皮肤系统' }, color: '#e0b79b' },
  { id: 'muscular', name: { en: 'Muscular', zh: '肌肉系统' }, color: '#b5564b' },
  { id: 'skeletal', name: { en: 'Skeletal', zh: '骨骼系统' }, color: '#e3dac5' },
  { id: 'cardiovascular', name: { en: 'Cardiovascular', zh: '心血管系统' }, color: '#c8323a' },
  { id: 'nervous', name: { en: 'Nervous', zh: '神经系统' }, color: '#e2c044' },
  { id: 'respiratory', name: { en: 'Respiratory', zh: '呼吸系统' }, color: '#d99aa0' },
  { id: 'digestive', name: { en: 'Digestive', zh: '消化系统' }, color: '#c08a5e' },
  { id: 'urinary', name: { en: 'Urinary', zh: '泌尿系统' }, color: '#a8705f' },
  { id: 'reproductive', name: { en: 'Reproductive', zh: '生殖系统' }, color: '#c9909c' },
  { id: 'endocrine', name: { en: 'Endocrine', zh: '内分泌系统' }, color: '#c59a6d' },
  { id: 'lymphatic', name: { en: 'Lymphatic', zh: '淋巴系统' }, color: '#8fb08a' },
  { id: 'other', name: { en: 'Other', zh: '其他' }, color: '#9aa3ad' },
]

const LAYERS: AnatomyData['layers'] = [
  { name: { en: 'Skin', zh: '皮肤' } },
  { name: { en: 'Muscles', zh: '肌肉' } },
  { name: { en: 'Skeleton', zh: '骨骼' } },
  { name: { en: 'Viscera, vessels and nerves', zh: '内脏、血管与神经' } },
]

// ---------------------------------------------------------------- the body

const drafts: Draft[] = []
const zhOfClass = new Map<string, string>()
let partSeq = 1
let fmaSeq = 900001
const fmaByName = new Map<string, string>()
const fmaFor = (name: string) => {
  let f = fmaByName.get(name)
  if (!f) {
    f = `FMA${fmaSeq++}`
    fmaByName.set(name, f)
  }
  return f
}

function cls(path: [string, string][]): string[] {
  for (const [en, zh] of path) zhOfClass.set(en, zh)
  return path.map((p) => p[0])
}

const ROOT: [string, string] = ['Anatomical structure', '解剖结构']
const C = {
  skin: cls([ROOT, ['Integument', '皮肤被覆']]),
  muscle: cls([ROOT, ['Muscle organ', '肌器官']]),
  longBone: cls([ROOT, ['Bone organ', '骨器官'], ['Long bone', '长骨']]),
  irregularBone: cls([ROOT, ['Bone organ', '骨器官'], ['Irregular bone', '不规则骨']]),
  flatBone: cls([ROOT, ['Bone organ', '骨器官'], ['Flat bone', '扁骨']]),
  rib: cls([ROOT, ['Bone organ', '骨器官'], ['Flat bone', '扁骨'], ['Rib', '肋骨']]),
  artery: cls([ROOT, ['Blood vessel', '血管'], ['Artery', '动脉']]),
  vein: cls([ROOT, ['Blood vessel', '血管'], ['Vein', '静脉']]),
  viscus: cls([ROOT, ['Viscus', '内脏器官']]),
  neural: cls([ROOT, ['Neural structure', '神经结构']]),
  nerve: cls([ROOT, ['Neural structure', '神经结构'], ['Nerve', '神经']]),
  gland: cls([ROOT, ['Gland', '腺体']]),
}

interface Spec {
  name: string
  zh: string
  la?: string
  system: SystemId
  tissue: TissueId
  depth: number
  isa: string[]
  region: string | null
}

function single(spec: Spec, geo: Geo): Draft {
  const d: Draft = { ...spec, id: `FX${String(partSeq++).padStart(4, '0')}`, fma: fmaFor(spec.name), side: 'M', geo }
  drafts.push(d)
  return d
}

/** Left/right pair under a shared isa concept. geo(+1) is the body's left (+X). */
function pair(spec: Spec, regionLR: [string, string] | null, geo: (s: number) => Geo): void {
  zhOfClass.set(spec.name, spec.zh)
  for (const [s, side, en, zh, la] of [
    [1, 'L', 'Left', '左', 'sinister'],
    [-1, 'R', 'Right', '右', 'dexter'],
  ] as const) {
    const name = `${en} ${spec.name.toLowerCase()}`
    drafts.push({
      ...spec,
      name,
      zh: `${zh}${spec.zh}`,
      la: spec.la ? `${spec.la} ${la}` : undefined,
      id: `FX${String(partSeq++).padStart(4, '0')}`,
      fma: fmaFor(name),
      side,
      geo: geo(s),
      isa: [...spec.isa, spec.name],
      region: regionLR ? regionLR[s > 0 ? 0 : 1] : null,
    })
  }
}

function buildBody(): void {
  // --- skin: one merged shell
  single(
    { name: 'Skin', zh: '皮肤', la: 'Cutis', system: 'integumentary', tissue: 'skin', depth: 0, isa: C.skin, region: null },
    merge(
      ellipsoid([0, 1.63, 0.01], [0.1, 0.125, 0.115], 28),
      tube([0, 1.47, 0], [0, 1.54, 0], 0.06, 0.055, 20),
      ellipsoid([0, 1.2, 0], [0.19, 0.3, 0.125], 32),
      ellipsoid([0, 0.93, 0], [0.175, 0.14, 0.12], 28),
      ...[1, -1].flatMap((s) => [
        tube([s * 0.215, 1.43, 0], [s * 0.245, 1.13, 0], 0.052, 0.042, 18),
        tube([s * 0.245, 1.13, 0], [s * 0.265, 0.85, 0.02], 0.04, 0.03, 18),
        tube([s * 0.095, 0.92, 0], [s * 0.1, 0.5, 0], 0.085, 0.058, 20),
        tube([s * 0.1, 0.5, 0], [s * 0.1, 0.06, -0.01], 0.056, 0.038, 20),
      ]),
    ),
  )

  // --- muscles
  const mus = (name: string, zh: string, la: string): Spec => ({
    name, zh, la, system: 'muscular', tissue: 'muscle', depth: 1, isa: C.muscle, region: null,
  })
  pair(mus('Pectoralis major', '胸大肌', 'Musculus pectoralis major'), ['Thorax', 'Thorax'], (s) =>
    ellipsoid([s * 0.085, 1.33, 0.095], [0.08, 0.06, 0.022]))
  single({ ...mus('Rectus abdominis', '腹直肌', 'Musculus rectus abdominis'), region: 'Abdomen' },
    box([0, 1.08, 0.105], [0.13, 0.3, 0.018]))
  pair(mus('Deltoid', '三角肌', 'Musculus deltoideus'), ['Left upper limb', 'Right upper limb'], (s) =>
    ellipsoid([s * 0.215, 1.4, 0], [0.045, 0.07, 0.05]))
  pair(mus('Biceps brachii', '肱二头肌', 'Musculus biceps brachii'), ['Left upper limb', 'Right upper limb'], (s) =>
    ellipsoid([s * 0.232, 1.27, 0.022], [0.026, 0.1, 0.022]))
  pair(mus('Quadriceps femoris', '股四头肌', 'Musculus quadriceps femoris'), ['Left lower limb', 'Right lower limb'], (s) =>
    ellipsoid([s * 0.098, 0.7, 0.035], [0.05, 0.19, 0.035]))
  pair(mus('Gastrocnemius', '腓肠肌', 'Musculus gastrocnemius'), ['Left lower limb', 'Right lower limb'], (s) =>
    ellipsoid([s * 0.1, 0.33, -0.03], [0.035, 0.11, 0.028]))

  // --- skeleton
  const bone = (name: string, zh: string, la: string, isa: string[], region: string | null): Spec => ({
    name, zh, la, system: 'skeletal', tissue: 'bone', depth: 2, isa, region,
  })
  single(bone('Skull', '颅骨', 'Cranium', C.irregularBone, 'Head'), ellipsoid([0, 1.64, 0.005], [0.082, 0.1, 0.098], 24))
  single(bone('Cervical vertebral column', '颈椎', 'Vertebrae cervicales', C.irregularBone, 'Neck'),
    tube([0, 1.45, -0.03], [0, 1.56, -0.02], 0.018))
  single(bone('Thoracic vertebral column', '胸椎', 'Vertebrae thoracicae', C.irregularBone, 'Thorax'),
    tube([0, 1.14, -0.065], [0, 1.45, -0.03], 0.021))
  single(bone('Lumbar vertebral column', '腰椎', 'Vertebrae lumbales', C.irregularBone, 'Abdomen'),
    tube([0, 0.97, -0.05], [0, 1.14, -0.065], 0.025))
  single(bone('Sternum', '胸骨', 'Sternum', C.flatBone, 'Thorax'), box([0, 1.3, 0.1], [0.04, 0.17, 0.012]))
  single(bone('Pelvis', '骨盆', 'Pelvis', C.irregularBone, 'Abdomen'),
    merge(ellipsoid([0.085, 0.95, -0.01], [0.07, 0.075, 0.05]), ellipsoid([-0.085, 0.95, -0.01], [0.07, 0.075, 0.05]),
      box([0, 0.93, -0.055], [0.07, 0.09, 0.03])))
  for (const [i, y] of [1.38, 1.3, 1.22].entries()) {
    const n = ['Third', 'Fifth', 'Seventh'][i]!
    const z = ['第三', '第五', '第七'][i]!
    pair(bone(`${n} rib`, `${z}肋`, `Costa ${['III', 'V', 'VII'][i]}`, C.rib, 'Thorax'), ['Thorax', 'Thorax'], (s) =>
      rib(y, 0.118 + i * 0.012, 0.08 + i * 0.006, s))
  }
  pair(bone('Humerus', '肱骨', 'Humerus', C.longBone, null), ['Left upper limb', 'Right upper limb'], (s) =>
    tube([s * 0.21, 1.42, 0], [s * 0.243, 1.14, 0], 0.014, 0.012))
  pair(bone('Radius', '桡骨', 'Radius', C.longBone, null), ['Left upper limb', 'Right upper limb'], (s) =>
    tube([s * 0.25, 1.12, 0.004], [s * 0.268, 0.87, 0.022], 0.009))
  pair(bone('Femur', '股骨', 'Femur', C.longBone, null), ['Left lower limb', 'Right lower limb'], (s) =>
    merge(tube([s * 0.1, 0.9, -0.005], [s * 0.1, 0.5, 0], 0.017, 0.019), ellipsoid([s * 0.085, 0.91, -0.005], [0.025, 0.025, 0.025], 12)))
  pair(bone('Tibia', '胫骨', 'Tibia', C.longBone, null), ['Left lower limb', 'Right lower limb'], (s) =>
    tube([s * 0.1, 0.48, 0], [s * 0.1, 0.08, -0.005], 0.018, 0.013))

  // --- cardiovascular
  const cv = (name: string, zh: string, la: string, tissue: TissueId, isa: string[], region: string | null): Spec => ({
    name, zh, la, system: 'cardiovascular', tissue, depth: 3, isa, region,
  })
  single(cv('Heart', '心脏', 'Cor', 'heart', C.viscus, 'Thorax'), ellipsoid([0.02, 1.27, 0.04], [0.05, 0.06, 0.042]))
  single(cv('Aorta', '主动脉', 'Aorta', 'artery', C.artery, null),
    merge(tube([0.012, 1.3, 0.02], [0.012, 1.37, 0.0], 0.012), tube([0.012, 1.37, 0], [0.012, 0.99, -0.03], 0.011, 0.009)))
  single(cv('Inferior vena cava', '下腔静脉', 'Vena cava inferior', 'vein', C.vein, null),
    tube([-0.02, 1.22, 0.01], [-0.02, 0.99, -0.03], 0.012))
  pair(cv('Femoral artery', '股动脉', 'Arteria femoralis', 'artery', C.artery, null), null, (s) =>
    tube([s * 0.03, 0.985, -0.025], [s * 0.085, 0.52, 0.02], 0.006, 0.005, 10))
  pair(cv('Femoral vein', '股静脉', 'Vena femoralis', 'vein', C.vein, null), null, (s) =>
    tube([s * 0.045, 0.985, -0.03], [s * 0.1, 0.52, 0.028], 0.007, 0.006, 10))

  // --- nervous
  const nv = (name: string, zh: string, la: string, tissue: TissueId, isa: string[], region: string | null): Spec => ({
    name, zh, la, system: 'nervous', tissue, depth: 3, isa, region,
  })
  single(nv('Brain', '脑', 'Encephalon', 'brain', C.neural, 'Head'), ellipsoid([0, 1.665, 0], [0.066, 0.06, 0.08], 24))
  single(nv('Spinal cord', '脊髓', 'Medulla spinalis', 'nerve', C.neural, null), tube([0, 1.03, -0.085], [0, 1.6, -0.035], 0.006, 0.006, 8))
  pair(nv('Sciatic nerve', '坐骨神经', 'Nervus ischiadicus', 'nerve', C.nerve, null), null, (s) =>
    tube([s * 0.06, 0.95, -0.06], [s * 0.105, 0.5, -0.035], 0.005, 0.004, 8))

  // --- thin "drawn" nerves: 0.35 mm tubes with synthetic non-FMA ids, like the Z-Anatomy parts.
  // Left and right share ONE unsided concept id (so their zh name has no 左/右), and the
  // id of that concept is not an FMA id.
  zhOfClass.set('Musculocutaneous nerve', '肌皮神经')
  zhOfClass.set('Ulnar nerve', '尺神经')
  let hex = 0x3fd9f070
  for (const [name, zh, slug, dx, dz] of [
    ['Musculocutaneous nerve', '肌皮神经', 'musculocutaneous_nerve', 0.012, 0.026],
    ['Ulnar nerve', '尺神经', 'ulnar_nerve', -0.012, -0.02],
  ] as const) {
    fmaByName.set(name, `ZAC_${slug}`)
    for (const [s, side, en] of [[1, 'L', 'Left'], [-1, 'R', 'Right']] as const) {
      const pts: Vec3[] = [
        [s * 0.2, 1.43, 0.0],
        [s * (0.222 + dx), 1.3, dz],
        [s * (0.238 + dx), 1.16, dz],
        [s * (0.262 + dx * 0.5), 0.9, 0.02 + dz * 0.5],
      ]
      const r = 0.00035
      const partName = `${en} ${name.toLowerCase()}`
      fmaByName.set(partName, `ZAC_${slug}`) // shared, unsided
      drafts.push({
        id: `ZA${(hex += 0x1111).toString(16).toUpperCase().padStart(8, '0')}`,
        fma: `ZAC_${slug}`,
        name: partName,
        zh,
        la: undefined,
        system: 'nervous',
        tissue: 'nerve',
        depth: 3,
        side,
        geo: merge(...pts.slice(1).map((p, i) => tube(pts[i]!, p, r, r, 6))),
        isa: [...C.nerve],
        region: null,
        source: SRC_DRAWN,
        path: { points: pts, radius: r },
      })
    }
  }

  // --- respiratory
  const rs = (name: string, zh: string, la: string, region: string | null): Spec => ({
    name, zh, la, system: 'respiratory', tissue: 'organ', depth: 3, isa: C.viscus, region,
  })
  pair(rs('Lung', '肺', 'Pulmo', 'Thorax'), ['Thorax', 'Thorax'], (s) =>
    ellipsoid([s * 0.085, 1.3, 0.005], [0.055, 0.12, 0.07]))
  single(rs('Trachea', '气管', 'Trachea', 'Neck'), tube([0, 1.36, 0.02], [0, 1.5, 0.03], 0.01, 0.01, 12))

  // --- digestive
  const dg = (name: string, zh: string, la: string): Spec => ({
    name, zh, la, system: 'digestive', tissue: 'organ', depth: 3, isa: C.viscus, region: 'Abdomen',
  })
  single(dg('Liver', '肝', 'Hepar'), ellipsoid([-0.06, 1.13, 0.03], [0.09, 0.055, 0.06]))
  single(dg('Stomach', '胃', 'Gaster'), ellipsoid([0.06, 1.1, 0.04], [0.05, 0.05, 0.04]))
  single(dg('Small intestine', '小肠', 'Intestinum tenue'),
    fromThree(new THREE.TorusKnotGeometry(0.045, 0.014, 96, 8, 3, 5),
      new THREE.Matrix4().makeTranslation(0, 1.0, 0.04).multiply(new THREE.Matrix4().makeScale(1.3, 0.9, 0.6))))

  // --- urinary
  const ur = (name: string, zh: string, la: string): Spec => ({
    name, zh, la, system: 'urinary', tissue: 'organ', depth: 3, isa: C.viscus, region: 'Abdomen',
  })
  pair(ur('Kidney', '肾', 'Ren'), ['Abdomen', 'Abdomen'], (s) => ellipsoid([s * 0.065, 1.08, -0.045], [0.026, 0.05, 0.02]))
  single(ur('Urinary bladder', '膀胱', 'Vesica urinaria'), ellipsoid([0, 0.9, 0.04], [0.035, 0.03, 0.03]))

  // --- endocrine
  single({ name: 'Thyroid gland', zh: '甲状腺', la: 'Glandula thyroidea', system: 'endocrine', tissue: 'gland', depth: 3, isa: C.gland, region: 'Neck' },
    merge(ellipsoid([0.018, 1.47, 0.035], [0.012, 0.022, 0.01], 12), ellipsoid([-0.018, 1.47, 0.035], [0.012, 0.022, 0.01], 12)))
}

/** Stress dataset: N small blobs spread through a body-sized volume, all systems. */
function buildStress(n: number): void {
  let seed = 12345
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }
  const sysTissue: [SystemId, TissueId, number, string][] = [
    ['cardiovascular', 'artery', 3, 'Blood vessel'],
    ['cardiovascular', 'vein', 3, 'Blood vessel'],
    ['cardiovascular', 'artery', 3, 'Blood vessel'],
    ['muscular', 'muscle', 1, 'Muscle organ'],
    ['skeletal', 'bone', 2, 'Bone organ'],
    ['digestive', 'organ', 3, 'Viscus'],
    ['nervous', 'nerve', 3, 'Neural structure'],
  ]
  zhOfClass.set(ROOT[0], ROOT[1])
  for (let i = 0; i < n; i++) {
    const [system, tissue, depth, klass] = sysTissue[i % sysTissue.length]!
    const y = 0.08 + rnd() * 1.6
    const a = rnd() * Math.PI * 2
    const rad = Math.sqrt(rnd()) * (y > 0.9 && y < 1.45 ? 0.17 : 0.1)
    const c: Vec3 = [Math.cos(a) * rad, y, Math.sin(a) * rad * 0.6]
    const group = `${klass} group ${Math.floor(i / 140) + 1}`
    zhOfClass.set(klass, klass)
    zhOfClass.set(group, `分组 ${Math.floor(i / 140) + 1}`)
    const name = `Stress part ${i + 1}`
    const geo =
      tissue === 'artery' || tissue === 'vein' || tissue === 'nerve'
        ? tube(c, [c[0] + (rnd() - 0.5) * 0.06, c[1] + 0.05 + rnd() * 0.05, c[2] + (rnd() - 0.5) * 0.06], 0.004, 0.003, 32)
        : ellipsoid(c, [0.008 + rnd() * 0.012, 0.012 + rnd() * 0.02, 0.008 + rnd() * 0.012], 28)
    drafts.push({
      id: `ST${String(i + 1).padStart(5, '0')}`,
      fma: fmaFor(name),
      name,
      zh: `压力测试部件 ${i + 1}`,
      system, tissue, depth,
      side: c[0] > 0.01 ? 'L' : c[0] < -0.01 ? 'R' : 'M',
      geo,
      isa: [ROOT[0], klass, group],
      region: i % 3 === 0 ? 'Abdomen' : null,
    })
  }
}

// ---------------------------------------------------------------- assemble

function adjacency(parts: Part[], margin: number): void {
  const skip = new Set(parts.filter((p) => p.tissue === 'skin').map((p) => p.id))
  for (let i = 0; i < parts.length; i++) {
    const a = parts[i]!
    if (skip.has(a.id)) continue
    for (let j = i + 1; j < parts.length; j++) {
      const b = parts[j]!
      if (skip.has(b.id)) continue
      let near = true
      for (let k = 0; k < 3 && near; k++) {
        if (a.bbox[k]! - margin > b.bbox[k + 3]! || b.bbox[k]! - margin > a.bbox[k + 3]!) near = false
      }
      if (near) {
        a.adjacent.push(b.id)
        b.adjacent.push(a.id)
      }
    }
  }
}

function buildTrees(): AnatomyData['trees'] {
  const isa = new Map<string, Concept>()
  const ensure = (map: Map<string, Concept>, name: string, parent: string | null): Concept => {
    const id = fmaFor(name)
    let c = map.get(id)
    if (!c) {
      c = { id, name, parent, parts: [] }
      map.set(id, c)
    }
    return c
  }
  for (const d of drafts) {
    let parent: string | null = null
    for (const name of d.isa) parent = ensure(isa, name, parent).id
    // twins sharing an unsided concept id hang off that one concept, named without the side
    const own = d.fma !== fmaByName.get(d.name) || !d.fma.startsWith('ZAC_') ? d.name : d.name.replace(/^(Left|Right) (.)/, (_m, _s, c: string) => c.toUpperCase())
    ensure(isa, own, parent).parts.push(d.id)
  }

  const partOf = new Map<string, Concept>()
  const regions: [string, string, string | null][] = [
    ['Human body', '人体', null],
    ['Head', '头部', 'Human body'],
    ['Neck', '颈部', 'Human body'],
    ['Trunk', '躯干', 'Human body'],
    ['Thorax', '胸部', 'Trunk'],
    ['Abdomen', '腹部', 'Trunk'],
    ['Left upper limb', '左上肢', 'Human body'],
    ['Right upper limb', '右上肢', 'Human body'],
    ['Left lower limb', '左下肢', 'Human body'],
    ['Right lower limb', '右下肢', 'Human body'],
  ]
  for (const [en, zh, parent] of regions) {
    zhOfClass.set(en, zh)
    ensure(partOf, en, parent ? fmaFor(parent) : null)
  }
  for (const d of drafts) {
    if (d.region) partOf.get(fmaFor(d.region))!.parts.push(d.id)
  }
  return { isa: [...isa.values()], partOf: [...partOf.values()] }
}

function buildKnowledge(): { names: Record<string, NameEntry>; relations: Relation[] } {
  const names: Record<string, NameEntry> = {}
  let i = 0
  for (const d of drafts) {
    // every third name is marked reviewed so both badge states appear
    names[d.fma] = { zh: d.zh, la: d.la, zhSource: 'fixture', status: i++ % 3 === 0 ? 'reviewed' : 'unreviewed' }
  }
  for (const [en, zh] of zhOfClass) {
    const id = fmaFor(en)
    if (!names[id]) names[id] = { zh, zhSource: 'fixture', status: 'unreviewed' }
  }
  const source = { name: 'soma fixture (synthetic)', url: 'https://example.org/soma-fixture', license: 'CC0-1.0' }
  const rel = (s: string, kind: RelationKind, o: string | null, en: string, zh?: string): Relation => ({
    subject: fmaFor(s),
    kind,
    ...(o ? { object: fmaFor(o) } : {}),
    objectLabel: { en, ...(zh ? { zh } : {}) },
    source,
    status: 'unreviewed',
  })
  const has = (n: string) => fmaByName.has(n)
  const relations: Relation[] = !has('Left biceps brachii')
    ? []
    : [
        rel('Left biceps brachii', 'origin', null, 'Scapula (coracoid process, supraglenoid tubercle)', '肩胛骨（喙突、盂上结节）'),
        rel('Left biceps brachii', 'insertion', 'Left radius', 'Radial tuberosity', '桡骨粗隆'),
        rel('Left biceps brachii', 'innervatedBy', 'Musculocutaneous nerve', 'Musculocutaneous nerve', '肌皮神经'),
        rel('Right biceps brachii', 'innervatedBy', 'Musculocutaneous nerve', 'Musculocutaneous nerve', '肌皮神经'),
        rel('Musculocutaneous nerve', 'innervates', 'Left biceps brachii', 'Biceps brachii (left)', '左肱二头肌'),
        rel('Musculocutaneous nerve', 'innervates', 'Right biceps brachii', 'Biceps brachii (right)', '右肱二头肌'),
        rel('Musculocutaneous nerve', 'innervates', null, 'Coracobrachialis', '喙肱肌'),
        rel('Right biceps brachii', 'insertion', 'Right radius', 'Radial tuberosity', '桡骨粗隆'),
        rel('Left quadriceps femoris', 'origin', 'Left femur', 'Femur (shaft)', '股骨体'),
        rel('Left quadriceps femoris', 'insertion', 'Left tibia', 'Tibial tuberosity', '胫骨粗隆'),
        rel('Left quadriceps femoris', 'arterialSupply', 'Left femoral artery', 'Femoral artery', '股动脉'),
        rel('Left quadriceps femoris', 'antagonist', null, 'Hamstrings', '腘绳肌'),
        rel('Left gastrocnemius', 'innervatedBy', 'Left sciatic nerve', 'Tibial nerve (from sciatic nerve)', '胫神经（坐骨神经分支）'),
        rel('Heart', 'arterialSupply', 'Aorta', 'Coronary arteries (from aorta)', '冠状动脉（起自主动脉）'),
        rel('Heart', 'venousDrainage', 'Inferior vena cava', 'Inferior vena cava'),
        rel('Liver', 'venousDrainage', 'Inferior vena cava', 'Hepatic veins to inferior vena cava', '肝静脉汇入下腔静脉'),
        rel('Femur', 'connectsWith', 'Tibia', 'Tibia (knee joint)', '胫骨（膝关节）'),
        rel('Left kidney', 'arterialSupply', 'Aorta', 'Renal artery (from aorta)', '肾动脉'),
      ]
  return { names, relations }
}

async function writeGlb(path: string, parts: Draft[]): Promise<void> {
  const doc = new Document()
  const buffer = doc.createBuffer()
  const scene = doc.createScene('anatomy')
  for (const d of parts) {
    const prim = doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(d.geo.position).setBuffer(buffer))
      .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(d.geo.normal).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(d.geo.index).setBuffer(buffer))
    scene.addChild(doc.createNode(d.id).setMesh(doc.createMesh(d.id).addPrimitive(prim)))
  }
  await doc.transform(reorder({ encoder: MeshoptEncoder }), quantize())
  doc
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE })
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
  await writeFile(path, await io.writeBinary(doc))
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const si = args.indexOf('--stress')
  const stress = si >= 0 ? Number(args[si + 1] ?? 2200) : 0
  const outDir = resolve(import.meta.dir, '../../public/anatomy', stress ? 'stress' : 'fixture')

  buildBody()
  if (stress) buildStress(stress)

  const parts: Part[] = drafts.map((d) => ({
    id: d.id,
    fma: d.fma,
    name: d.name,
    system: d.system,
    tissue: d.tissue,
    depth: d.depth,
    side: d.side,
    provenance: d.source === SRC_DRAWN || d.tissue === 'nerve' ? 'curated' : d.side === 'R' ? 'warped' : 'scanned',
    ...(d.source === SRC_DRAWN || d.tissue === 'nerve' ? { source: SRC_DRAWN } : d.side === 'R' ? { source: SRC_WARPED } : {}),
    ...measure(d.geo),
    adjacent: [],
  }))
  adjacency(parts, stress ? 0.001 : 0.004)

  await MeshoptEncoder.ready
  await mkdir(join(outDir, 'knowledge'), { recursive: true })
  const systems: SystemDef[] = []
  for (const s of SYSTEMS) {
    const mine = drafts.filter((d) => d.system === s.id)
    const glb = mine.length ? `${s.id}.glb` : null
    if (glb) await writeGlb(join(outDir, glb), mine)
    systems.push({ ...s, glb, partCount: mine.length })
  }

  const data: AnatomyData = {
    schema: 1,
    body: 'male',
    sources: [
      {
        name: 'soma fixture',
        url: 'https://example.org/soma-fixture',
        license: 'CC0-1.0',
        attribution: 'Synthetic primitive shapes generated by tools/fixture/make-fixture.ts. Not anatomical data.',
      },
      {
        name: SRC_WARPED,
        url: 'https://example.org/soma-fixture/warped',
        license: 'CC BY-SA 4.0',
        attribution: 'Synthetic. Stands in for geometry registered from a second dataset.',
      },
      {
        name: SRC_DRAWN,
        url: 'https://example.org/soma-fixture/drawn',
        license: 'CC BY-SA 4.0',
        attribution: 'Synthetic. Stands in for artist-modelled structures (nerves).',
      },
    ],
    cautions: [
      { zh: '这是由几何基本体拼成的示例数据，不是人体解剖。', en: 'Synthetic primitives for development — not anatomy.' },
      { zh: '右侧结构标为“配准变形”，神经标为“人工建模”，仅用于演示来源标注。', en: 'Right-side parts are tagged warped and nerves curated only to exercise the provenance UI.' },
      { zh: 'FMA 编号与 ZAC 标识均为虚构。', en: 'All FMA and ZAC identifiers are made up.' },
    ],
    systems,
    layers: LAYERS,
    parts,
    trees: buildTrees(),
  }
  const k = buildKnowledge()
  await writeFile(join(outDir, 'anatomy.json'), JSON.stringify(data))
  const nerves: NervePath[] = drafts
    .filter((d) => d.path)
    .map((d) => ({ part: d.id, branches: [{ points: d.path!.points.flat(), radius: d.path!.points.map(() => d.path!.radius) }] }))
  await writeFile(join(outDir, 'nerves.json'), JSON.stringify(nerves))
  await writeFile(join(outDir, 'knowledge/names.json'), JSON.stringify(k.names, null, 1))
  await writeFile(join(outDir, 'knowledge/relations.json'), JSON.stringify(k.relations, null, 1))

  const tris = parts.reduce((a, p) => a + p.triangles, 0)
  console.log(
    `fixture -> ${outDir}\n  parts ${parts.length}, triangles ${tris}, isa concepts ${data.trees.isa.length}, ` +
      `partOf concepts ${data.trees.partOf.length} (covering ${data.trees.partOf.reduce((a, c) => a + c.parts.length, 0)} parts), ` +
      `names ${Object.keys(k.names).length}, relations ${k.relations.length}`,
  )
}

await main()
