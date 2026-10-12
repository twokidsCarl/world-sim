// 面部表情数据的契约（提议）：离线工具 tools/face/ 写，界面读。
// Data contract of the facial expression layer (proposed): written by tools/face/, read by the UI.
//
// 文件 / Files
//   /anatomy/<body>/face.json   FaceData
//   /anatomy/<body>/face.bin    face.json 引用的逐顶点位移 / per-vertex displacements referenced by face.json
//
// 这是疼痛行为（面部表情）的计算模型，用于教学；模拟人并没有主观感受。
// This is a computational model of pain behaviour (the facial expression) for teaching; the
// simulated body has no subjective experience.
//
// 运行时公式（参考实现见 tools/face/model.ts）/ Runtime formula (reference: tools/face/model.ts)
//   1. AU 强度 I_k ∈ [0, 5]（FACS 的 A–E；AU43 也按 0–5 连续取值，5 = 完全闭合）。
//      AU intensities I_k ∈ [0, 5] (FACS A–E; AU43 too is continuous here, 5 = fully closed).
//   2. 通道激活 a_c = clamp(Σ_k w_kc · I_k / 5, 0, 1)。
//      Channel activation a_c = clamp(Σ_k w_kc · I_k / 5, 0, 1).
//   3. 静止空间里每个顶点：p′ = p + Σ_c a_c · D_c[v]，D_c[v] = scale_c · (int16 向量) / 32767。
//      Per vertex in rest space: p′ = p + Σ_c a_c · D_c[v], with D_c[v] = scale_c · (int16 vector) / 32767.
//   4. 然后照常蒙皮（rig.json）；下颌角 = clamp(Σ_k jaw_k · I_k / 5, 0, jaw.max) 加到 jaw.joint 的 jaw.dof 上。
//      Then skin as usual (rig.json); jaw angle = clamp(Σ_k jaw_k · I_k / 5, 0, jaw.max) is added to dof jaw.dof of jaw.joint.

import type { BodyId, Side, Vec3 } from '../anatomy/types.ts'

export interface Bilingual {
  zh: string
  en: string
}

/** 一条出处。`license` 说明能否再分发；这里只引用事实和数字。 One source. `license` says whether it may be redistributed; only facts and numbers are taken. */
export interface FaceSource {
  id: string
  citation: string
  url: string
  license: string
  /** 本项目实际打开并读到的内容 / what was actually opened and read for this project. */
  opened: Bilingual
}

/** 带出处的数值或陈述；`source` 为空即为本项目的假设。 A statement or number with its source; a null `source` marks an assumption of this project. */
export interface Sourced {
  /** FaceData.sources 里的 id；null = 假设，没有出处 / id into FaceData.sources; null = assumption, unsourced. */
  source: string | null
  note: Bilingual
}

export type FaceChannelKind =
  /** 线状肌：把止点附近的皮肤拉向起点 / linear muscle: pulls the skin round its insertion towards its origin. */
  | 'linear'
  /** 环状肌：把环周围的皮肤拉向中心 / sphincter: draws the skin round the ring towards its centre. */
  | 'sphincter'
  /** 眼睑：上睑下落或下睑上抬，沿眼球表面滑动 / eyelid: the upper lid comes down or the lower lid up, sliding over the globe. */
  | 'lid'
  /**
   * 口裂内陷（只作用于皮肤）：皮肤是一张闭合的面，唇不能分开；张口时把两唇相贴的那道褶向口内推，
   * 让被拉开的皮肤成为一个凹陷而不是一张平的膜。这是几何上的替代，不是肌肉；parts 为空。
   * Oral recess (skin only): the skin is one closed surface and the lips cannot part; on mouth opening the crease where the lips
   * meet is pushed into the mouth, so that the stretched skin becomes a hollow instead of a flat membrane. A geometric stand-in,
   * not a muscle; `parts` is empty.
   */
  | 'recess'

/** 一个通道在一个部件上的稀疏位移场。 The sparse displacement field of one channel on one part. */
export interface FaceField {
  /** Part.id；顶点顺序与该部件 GLB 解码出的顺序一致 / Part.id; vertex order as decoded from the part's GLB. */
  part: string
  /**
   * face.bin 里的字节偏移（4 的倍数）。布局（小端）：count × uint32 顶点下标（升序），
   * 随后 count × 3 × int16 位移分量；位移（米）= 分量 × scale / 32767。
   * Byte offset into face.bin (a multiple of 4). Layout (little-endian): count × uint32 vertex
   * indices (ascending), then count × 3 × int16 components; displacement in metres = component × scale / 32767.
   */
  offset: number
  count: number
  /** 该场中最大的位移分量绝对值，米 / largest absolute displacement component of this field, metres. */
  scale: number
}

export interface FaceChannel {
  /** 如 "corrugator_L"。 E.g. "corrugator_L". */
  id: string
  /** data/curated/face/muscles.json 里的肌肉条目 id / id of the muscle entry in data/curated/face/muscles.json. */
  muscle: string
  name: Bilingual
  kind: FaceChannelKind
  side: Side
  /** 驱动该通道的肌肉部件；kind 为 'recess' 时为空 / the muscle parts that drive this channel; empty for kind 'recess'. */
  parts: string[]
  /**
   * 作用线（静止姿势，米）：origin 是固定端（骨或筋膜），insertion 是活动端（皮肤）。
   * 环状肌和眼睑通道：origin = insertion = 环的中心。
   * Line of action (rest pose, metres): `origin` is the fixed end (bone or fascia), `insertion` the
   * mobile end (skin). Sphincter and lid channels: origin = insertion = centre of the ring.
   */
  line: { origin: Vec3; insertion: Vec3; /** 两端在皮肤上的投影 / both ends projected onto the skin. */ originOnSkin: Vec3; insertionOnSkin: Vec3 }
  /** 作用线是怎样得到的 / how the line was obtained. */
  basis: 'geometry' | 'geometry+override' | 'landmarks'
  /** 激活为 1 时的最大位移（含沿法线的厚度变化），米 / largest displacement at activation 1 (thickness change along the normal included), metres. */
  excursion: number
  fields: FaceField[]
}

/** 一个 FACS 动作单元：若干通道的加权组合。 One FACS action unit: a weighted combination of channels. */
export interface FaceAU {
  /** 如 "AU4"。 E.g. "AU4". */
  id: string
  name: Bilingual
  /** 强度为 5（E 级）时各通道的激活；键是 FaceChannel.id / channel activations at intensity 5 (level E), keyed by FaceChannel.id. */
  channels: Record<string, number>
  /** 强度为 5 时的下颌张开角，弧度 / jaw opening at intensity 5, radians. */
  jaw?: number
  /** FACS 所述肌肉基础中模型里没有的部分 / parts of the FACS muscular basis that the model lacks. */
  missing?: string[]
  basis: Sourced
}

export interface PainKeyframe {
  /** 疼痛强度，0–10 / pain intensity, 0–10. */
  level: number
  /** 该强度下各 AU 的强度（0–5）；中间强度线性插值 / AU intensities (0–5) at this level; linear in between. */
  aus: Record<string, number>
}

export interface PainModel {
  /** PSPI = AU4 + max(AU6, AU7) + max(AU9, AU10) + AU43（AU43 取 0 或 1）。 */
  pspi: { terms: (string | string[])[]; binary: string[]; max: number; basis: Sourced }
  /** 强度 → AU 强度的关键帧，按 level 升序 / keyframes from level to AU intensities, ascending in level. */
  keyframes: PainKeyframe[]
  mapping: Sourced
  /**
   * 时间过程（秒）：刺激开始后经 latency 起始，onset 内升到峰值，刺激期间保持，结束后 offset 内回落。
   * Time course (seconds): starts `latency` after stimulus onset, rises to the apex within `onset`,
   * holds while the stimulus lasts, and falls back within `offset` after it ends.
   */
  timing: { latency: number; onset: number; offset: number; basis: Sourced }
}

export interface FaceData {
  schema: 1
  body: BodyId
  /** 这份数据是什么、不是什么 / what this data is and is not. */
  note: Bilingual
  /** 皮肤部件的 Part.id / Part.id of the skin part. */
  skin: string
  /** 构建所用输入文件的 sha256（前 16 位十六进制）/ sha256 (first 16 hex) of the inputs it was built from. */
  inputs: Record<string, string>
  /** face.bin 的字节数 / byte length of face.bin. */
  binBytes: number
  /** 有位移的部件及其顶点数（用于校验顶点顺序没变）/ parts that are displaced, with their vertex counts (to check the vertex order is unchanged). */
  parts: { part: string; vertexCount: number; /** 该部件上所有通道的非零项总数 / non-zero entries over all channels. */ entries: number }[]
  channels: FaceChannel[]
  aus: FaceAU[]
  pain: PainModel
  jaw: { joint: string; dof: number; /** 弧度 / radians */ max: number; /** 闭口肌与开口肌的部件，仅供显示 / closers and openers, for display only. */ closers: string[]; openers: string[] }
  /** 单个通道位移的上界，以及所有通道同时全激活时位移之和的上界，米 / bound of one channel's displacement, and of the sum with every channel fully active, metres. */
  bounds: { channel: number; total: number }
  /** 构建时在静止几何上量得的标志 / landmarks measured on the rest geometry at build time. */
  landmarks: {
    /** 头部正中矢状面的 x / x of the head's midsagittal plane. */
    midX: number
    /** 口裂（两唇之间）的高度：皮肤上的和深层唇部件上的 / height of the oral fissure on the skin and on the deep lip part. */
    stomionY: { skin: number; deep: number | null }
    eyes: {
      side: Side
      globe: Vec3
      radius: number
      /** 深层睑裂（睑部肌肉网格上量得）：内外眦的 x、最大开度（米）/ the deep palpebral fissure (measured on the lid muscle meshes): x of both canthi, largest aperture (metres). */
      fissure: { x0: number; x1: number; aperture: number; /** 下睑缘最低处、上睑缘最高处的 y / y of the lowest point of the lower margin and the highest of the upper. */ lowerY?: number; upperY?: number } | null
      /** 皮肤上的睑裂形状（皮肤没有开口）：同上 / the shape of the fissure on the skin (which has no opening): as above. */
      skinFissure?: { x0: number; x1: number; aperture: number; lowerY?: number; upperY?: number } | null
    }[]
  }
  sources: FaceSource[]
  /** 模型没有做到的事，供显示 / what the model does not do, for display. */
  cautions: Bilingual[]
}

// —— 皱纹细节层 / The wrinkle detail layer ——
//
// 文件 / Files
//   /anatomy/<body>/face/detail.json    FaceDetail
//   /anatomy/<body>/face/uv.bin         皮肤面部顶点的 UV / UVs of the skin's face vertices
//   /anatomy/<body>/face/wrinkles.png   法线贴图图集，每层一格 / the normal-map atlas, one tile per layer
//
// 运行时公式（参考实现见 tools/face/detail.ts）/ Runtime formula (reference: tools/face/detail.ts)
//   层权重 w_l = clamp(Σ_AU drivers[AU] · (I_AU / 5)^gamma, 0, 1)
//   每层在 (u, v) 处取样 n_l（rgb · 2 − 1），取斜率 g_l = n_l.xy / n_l.z
//   合成的切线空间法线 n = normalize(Σ_l w_l · g_l, 1)
//   世界空间法线 N′ = normalize(T̂ · n.x + B̂ · n.y + N · n.z)，
//   其中 N 是位移和蒙皮之后的表面法线，T̂ 是 u 增大方向在切面内的单位向量，B̂ = N × T̂（v 增大的方向，朝上）。
//   layer weight w_l = clamp(Σ_AU drivers[AU] · (I_AU / 5)^gamma, 0, 1);
//   sample each layer at (u, v) as n_l (rgb · 2 − 1) and take the slope g_l = n_l.xy / n_l.z;
//   composite tangent-space normal n = normalize(Σ_l w_l · g_l, 1);
//   world normal N′ = normalize(T̂ · n.x + B̂ · n.y + N · n.z), where N is the surface normal after
//   displacement and skinning, T̂ the unit direction of increasing u within the tangent plane and
//   B̂ = N × T̂ (the direction of increasing v, upwards).

export interface FaceDetailLayer {
  id: string
  name: Bilingual
  /** 该层在图集里的格子：列、行（行 0 在图像顶部）/ the layer's tile in the atlas: column, row (row 0 at the top of the image). */
  tile: [number, number]
  /** AU id → 权重 / AU id → weight. */
  drivers: Record<string, number>
  /** 该层画了几条沟纹（两侧合计）/ number of furrows drawn in this layer (both sides). */
  wrinkles: number
  /** 该层最深的沟，米 / deepest furrow of the layer, metres. */
  maxDepth: number
  basis: Sourced
}

export interface FaceDetail {
  schema: 1
  body: BodyId
  note: Bilingual
  /** 皮肤部件的 Part.id 及其顶点数（校验顶点顺序）/ Part.id of the skin and its vertex count (to check the vertex order). */
  skin: string
  vertexCount: number
  /** 构建所用输入的 sha256（前 16 位十六进制）/ sha256 (first 16 hex) of the inputs. */
  inputs: Record<string, string>
  uv: {
    file: string
    /**
     * 有 UV 的顶点数。uv.bin 布局（小端）：count × uint32 顶点下标（升序），随后 count × 2 × uint16：
     * u、v ∈ [0, 65535] 对应一个格子的 [0, 1]；u 向身体左侧增大，v 向上增大（图像行 = (1 − v) · (tile − 1)）。
     * 没有列出的顶点不采样细节（法线不变）。
     * Number of vertices with a UV. Layout of uv.bin (little-endian): count × uint32 vertex indices (ascending), then
     * count × 2 × uint16: u, v ∈ [0, 65535] map to [0, 1] of one tile; u grows towards the body's left and v upwards
     * (image row = (1 − v) · (tile − 1)). Vertices not listed take no detail (normal unchanged).
     */
    count: number
    /** 投影：绕竖直轴的柱面。u = 0.5 + θ · radius / extent，θ = atan2(x − axis.x, z − axis.z)；v = (y − y0) / extent。 Projection: a cylinder about a vertical axis. */
    projection: { kind: 'cylindrical'; axis: { x: number; z: number }; radius: number; y0: number; extent: number }
    /** 一个纹素在参考半径处的大小，米 / size of one texel at the reference radius, metres. */
    texel: number
    /** 展开的质量：三角形数、翻转的比例、线性拉伸（三维长度 / UV 长度）的分位数 / quality of the unwrap: triangle count, flipped fraction, quantiles of linear stretch (3D length / UV length). */
    stretch: { triangles: number; flipped: number; p05: number; median: number; p95: number; max: number }
  }
  atlas: { file: string; width: number; height: number; tile: number; columns: number; rows: number; bytes: number }
  curve: { gamma: number }
  layers: FaceDetailLayer[]
  /** 切线空间的约定 / the tangent-space convention. */
  convention: Bilingual
  cautions: Bilingual[]
}
