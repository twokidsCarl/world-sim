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
