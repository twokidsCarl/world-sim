// 写实外观的数据约定：工具（tools/look/、tools/hair/、tools/cloth/）写，查看器（src/look/ 等）读。
// The data contract of the lifelike look: written by the tools (tools/look/, tools/hair/, tools/cloth/),
// read by the viewer (src/look/ and friends).

/**
 * public/anatomy/<body>/look/skin-uv.json：写实皮肤的 UV 网格说明；数据在同名 .bin。
 * 写实皮肤是一块跟随皮肤的覆盖网格。它的每个顶点指回一个发布的皮肤顶点；UV 接缝处一个皮肤顶点有两个或更多副本。
 * 三角形与发布皮肤的三角形一一对应，次序相同（第 t 个三角形就是皮肤的第 t 个三角形）。
 *
 * public/anatomy/<body>/look/skin-uv.json: describes the UV mesh of the lifelike skin; the data are in
 * the .bin of the same name. The lifelike skin is an overlay mesh that follows the skin. Each of its
 * vertices points back to one shipped skin vertex; at UV seams one skin vertex has two or more copies.
 * The triangles correspond one to one, in the same order, to those of the shipped skin (triangle t is
 * skin triangle t).
 *
 * .bin 布局（小端，依次）/ .bin layout (little-endian, in order):
 *   u32 skinVertex[vertexCount]   覆盖网格顶点 → 皮肤顶点 / overlay vertex → skin vertex
 *   u16 uv[vertexCount * 2]       UV，按 1/65535 量化；v 向上（OpenGL 习惯）/ UV quantised by 1/65535; v up (OpenGL convention)
 *   u32 index[triangleCount * 3]  覆盖网格顶点下标 / overlay vertex indices
 */
export interface SkinUvData {
  schema: 1
  /** 皮肤部件 id / skin part id */
  skin: string
  /** 发布的皮肤的顶点数和三角形数（加载时核对）/ vertex and triangle count of the shipped skin (checked on load) */
  skinVertexCount: number
  skinTriangleCount: number
  /** 覆盖网格的顶点数（≥ skinVertexCount）/ vertex count of the overlay mesh (≥ skinVertexCount) */
  vertexCount: number
  triangleCount: number
  /** 生成它所用的输入文件的 sha256（前 16 位）/ sha256 (first 16 hex) of the input files it was built from */
  inputs: Record<string, string>
  /** UV 岛的个数 / number of UV islands */
  islands: number
  /** 构建统计（只供阅读）/ build statistics (for reading only) */
  stats: Record<string, number>
  source: { zh: string; en: string }
}

/** 量化 UV 的分母 / denominator of the quantised UV */
export const UV_SCALE = 65535

/**
 * public/anatomy/<body>/look/skin-colour.json：写实皮肤的颜色数据（tools/look/skin_colour.py 和 skin_regions.py 生成）。
 * 底色 = 查找表(Cm, Chd)，Cm = 色调的黑色素 × 部位倍数（手足掌在对数空间里拉向 palmMelanin），Chd = bloodChd × 部位倍数。
 *
 * public/anatomy/<body>/look/skin-colour.json: the colour data of the lifelike skin (built by
 * tools/look/skin_colour.py and skin_regions.py). Albedo = table(Cm, Chd), with Cm = the tone's melanin × the
 * region multiplier (palms and soles pulled to palmMelanin in log space) and Chd = bloodChd × the region multiplier.
 */
export interface SkinColourData {
  schema: 1
  skin: string
  /** 64×64 RGBA half-float，行是血量 v、列是黑色素 u；Cm = cmMax·u²，Chd = chdMax·v²；线性 sRGB 漫反射（不含表面反射）
   * 64×64 RGBA half-float, rows are blood v, columns melanin u; Cm = cmMax·u², Chd = chdMax·v²; linear-sRGB diffuse (surface reflection excluded) */
  lut: { file: string; size: number; cmMax: number; chdMax: number }
  /** RGBA8 PNG，第 0 行是 v = 0。R、G：黑色素、血量倍数 2^((x − 128) / logScale)；B：手足掌权重；A：粗糙度
   * RGBA8 PNG, row 0 is v = 0. R, G: melanin and blood multipliers 2^((x − 128) / logScale); B: palmoplantar weight; A: roughness */
  regions: { file: string; size: number; logScale: number; rowOrder: string; palmMelanin: number }
  /** 色调滑块：Cm = cmMax·(tone/100)²；default 是 NIST 的中位数，nistMax 以上是外推
   * the tone slider: Cm = cmMax·(tone/100)²; default is the NIST median; above nistMax is extrapolation */
  tone: { cmMax: number; default: number; nistMax: number; bloodChd: number }
  /** 表面外反射（8° 菲涅尔）；查找表里不含它 / the external surface reflection (Fresnel at 8°); not in the table */
  surfaceReflection: number
  source: { zh: string; en: string }
}

/** 色调滑块的缺省值（与 skin-colour.json 的 tone.default 相同；数据到之前用它）/ the tone slider's default (equal to tone.default in skin-colour.json; used until the data arrive) */
export const DEFAULT_TONE = 12
