// 皮肤上真实的睑裂和口裂：睑缘、唇缘的顶点环，剪口两侧各属哪一片，以及构造物（睑缘内卷、口腔袋）。
// The real eye and mouth openings of the skin: the lid-margin and lip-margin vertex loops, which sheet each vertex near a
// cut lies on, and the construction aids (lid rims, oral pouch).
//
// 来源是皮肤包的清单（data/raw/bodyshape/out/<body>-skin-open/manifest.json，不在仓库里），下标经
// public/anatomy/<body>/skin-source.u32 换成发布的皮肤的顶点下标——只按下标对应，绝不按位置（上下唇缘的顶点成对重合）。
// 换好的结果写到 public/anatomy/<body>/face/openings.json；皮肤包不在时就读这份文件，所以干净的检出里也能重建。
// The source is the skin package manifest (data/raw/bodyshape/out/<body>-skin-open/manifest.json, not in the repository);
// its indices are converted to vertex indices of the shipped skin through public/anatomy/<body>/skin-source.u32 — by index
// only, never by position (upper and lower lip-margin vertices coincide in pairs). The converted result is written to
// public/anatomy/<body>/face/openings.json; without the package that file is read instead, so a clean checkout can rebuild.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FaceOpenings } from '../../src/face/types.ts'

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex').slice(0, 16)

interface Manifest {
  face?: {
    margins?: Record<string, number[] | number>
    sheets?: { mouth: { upper: number[]; lower: number[]; lateral: number[] }; eyeL: { upper: number[]; lower: number[] }; eyeR: { upper: number[]; lower: number[] } }
    constructionAids?: { lidRimL: { vertices: number[]; of: number[] }; lidRimR: { vertices: number[]; of: number[] }; oralPouch: { upper: number[]; lower: number[]; seam: number[]; rows: number; columns: number } }
  }
}

/**
 * 读出开口数据。返回 null = 这个体型的皮肤没有开口（闭合的皮肤），构建走旧的路径。
 * `fromPackage` 说明这次是从皮肤包换算的（应当写回 openings.json）还是读的已发布文件。
 * Loads the openings. null = this body's skin has no openings (a closed skin) and the build takes the old path.
 * `fromPackage` says whether they were converted from the package this time (and should be written back) or read from the published file.
 */
export function loadOpenings(root: string, bodyDir: string, bodyId: string, skinPart: string, vertexCount: number): { openings: FaceOpenings; fromPackage: boolean } | null {
  const published = join(bodyDir, 'face', 'openings.json')
  const sidecarPath = join(bodyDir, 'skin-source.u32')
  const manifestPath = join(root, 'data', 'raw', 'bodyshape', 'out', `${bodyId}-skin-open`, 'manifest.json')
  if (existsSync(sidecarPath) && existsSync(manifestPath)) {
    const sidecarBytes = new Uint8Array(readFileSync(sidecarPath))
    const src = new Uint32Array(sidecarBytes.buffer.slice(sidecarBytes.byteOffset, sidecarBytes.byteOffset + sidecarBytes.byteLength))
    const f = (JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest).face
    if (src.length === vertexCount && f?.margins && f.sheets && f.constructionAids) {
      const inv = new Map<number, number>()
      src.forEach((p, v) => inv.set(p, v))
      const one = (i: number, what: string): number => {
        const v = inv.get(i)
        if (v === undefined) throw new Error(`face openings: package vertex ${i} (${what}) is not in the shipped skin`)
        return v
      }
      const list = (a: number[], what: string): number[] => a.map((i) => one(i, what))
      const m = f.margins, s = f.sheets, c = f.constructionAids
      const num = (k: string): number => one(m[k] as number, k)
      const arr = (k: string): number[] => list(m[k] as number[], k)
      const openings: FaceOpenings = {
        schema: 1,
        skin: skinPart,
        vertexCount,
        source: { sidecar: sha(sidecarBytes), note: { zh: '由皮肤包清单的 face.margins / sheets / constructionAids 经 skin-source.u32 换成发布皮肤的顶点下标。', en: 'Converted from face.margins / sheets / constructionAids of the skin package manifest to vertex indices of the shipped skin through skin-source.u32.' } },
        margins: { upperLip: arr('upperLip'), lowerLip: arr('lowerLip'), upperLidL: arr('upperLidL'), lowerLidL: arr('lowerLidL'), upperLidR: arr('upperLidR'), lowerLidR: arr('lowerLidR') },
        points: { mouthCornerR: num('mouthCornerR'), mouthCornerL: num('mouthCornerL'), medialCanthusL: num('medialCanthusL'), lateralCanthusL: num('lateralCanthusL'), medialCanthusR: num('medialCanthusR'), lateralCanthusR: num('lateralCanthusR') },
        sheets: { mouthUpper: list(s.mouth.upper, 'mouth.upper'), mouthLower: list(s.mouth.lower, 'mouth.lower'), mouthLateral: list(s.mouth.lateral, 'mouth.lateral'), eyeUpperL: list(s.eyeL.upper, 'eyeL.upper'), eyeLowerL: list(s.eyeL.lower, 'eyeL.lower'), eyeUpperR: list(s.eyeR.upper, 'eyeR.upper'), eyeLowerR: list(s.eyeR.lower, 'eyeR.lower') },
        lidRims: [
          { side: 'L', vertices: list(c.lidRimL.vertices, 'lidRimL'), of: list(c.lidRimL.of, 'lidRimL.of') },
          { side: 'R', vertices: list(c.lidRimR.vertices, 'lidRimR'), of: list(c.lidRimR.of, 'lidRimR.of') },
        ],
        oralPouch: { upper: list(c.oralPouch.upper, 'pouch.upper'), lower: list(c.oralPouch.lower, 'pouch.lower'), seam: list(c.oralPouch.seam, 'pouch.seam'), rows: c.oralPouch.rows, columns: c.oralPouch.columns },
      }
      return { openings, fromPackage: true }
    }
  }
  if (existsSync(published)) {
    const openings = JSON.parse(readFileSync(published, 'utf8')) as FaceOpenings
    // 皮肤换过之后旧文件不能用 / a file made for another skin must not be used
    const sidecarOk = !existsSync(sidecarPath) || sha(new Uint8Array(readFileSync(sidecarPath))) === openings.source.sidecar
    if (openings.vertexCount === vertexCount && openings.skin === skinPart && sidecarOk) return { openings, fromPackage: false }
  }
  return null
}
