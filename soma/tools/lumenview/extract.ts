// 从管线报告里取出"腔"的显示所需的一小份数据，写成 public/anatomy/<人体>/lumen-path.json（几 kB）。
// 界面平时不读 1–2 MB 的 pipeline-report.json；这里只挑三样：消化道各段的先后次序、每个腔的壁部件、
// 口腔和咽的引导线（这两段是体素等值面，网格里没有一圈一圈的顶点，中心线没法从网格里取）。
// 结果是确定的：同一份报告得到逐字节相同的文件。管线以后应当自己写出这些（见文件里的 note）。
// Extracts the little the lumina display needs from the pipeline report into
// public/anatomy/<body>/lumen-path.json (a few kB). The UI does not read the 1–2 MB
// pipeline-report.json in normal use; three things are taken: the order of the canal's segments, the
// wall parts of every lumen, and the guide line through mouth and pharynx (both are voxel isosurfaces
// with no rings of vertices, so their centreline cannot be read off the mesh). Deterministic: the same
// report gives the same bytes. The pipeline should write these itself later (see `note` in the file).
//
// 用法 / usage:  bun tools/lumenview/extract.ts [male|female]

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type V3 = [number, number, number]

interface Report {
  lumen?: {
    parts?: { id: string; walls?: string[] }[]
    canal?: { groups?: { group: string; lumen: string }[]; runs?: { startMm: V3 }[] }
    inventory?: { group: string; id: string }[]
    sphincters?: { sphincter: string; atMm: V3 }[]
    head?: {
      midlineXMm?: number
      oral?: { tongueToPalateAlongMidline?: { zMm: number; tongueTopMm: number; palateMm: number | null }[] }
      pharynx?: { walls?: { yMm: number; posteriorMm: number; anteriorMm: number }[] }
    }
  }
}

export interface LumenPathFile {
  schema: 1
  body: string
  note: { zh: string; en: string }
  /** 消化道各段的腔，从口到肛门 / the canal's lumina, mouth to anus */
  canal: string[]
  /** 腔 → 它的壁部件 / lumen → its wall parts */
  walls: Record<string, string[]>
  /** 没有成圈顶点的腔的引导线，毫米 / guide lines of lumina without rings of vertices, millimetres */
  guides: Record<string, V3[]>
  sphincters: { id: string; atMm: V3 }[]
}

const r1 = (v: number): number => Math.round(v * 10) / 10

/** 由报告组出要写的内容；没有腔的人体返回 null / Build the file's content from a report; null for a body without lumina. */
export function extractLumenPath(body: string, report: Report): LumenPathFile | null {
  const lumen = report.lumen
  if (!lumen?.parts?.length) return null
  const canal = (lumen.canal?.groups ?? []).map((g) => g.lumen)
  const walls: Record<string, string[]> = {}
  for (const p of lumen.parts) walls[p.id] = [...(p.walls ?? [])]
  // 报告里 parts[].walls 对小肠只列了前几片；消化道各段的壁以 inventory 为准（每片一行）
  // parts[].walls lists only the first few pieces of the small intestine; for the canal the inventory (a row per piece) is authoritative
  for (const g of lumen.canal?.groups ?? []) {
    const ids = (lumen.inventory ?? []).filter((row) => row.group === g.group).map((row) => row.id)
    if (ids.length) walls[g.lumen] = ids
  }
  const guides: Record<string, V3[]> = {}
  const x = lumen.head?.midlineXMm ?? 0
  // 口腔：正中线上舌背与腭之间的中点；腭已经没有的几站（口咽峡之后）取舌背上方 4 毫米
  // mouth: midway between the tongue's dorsum and the palate on the midline; where the palate has ended (past the fauces) 4 mm above the dorsum
  const oral = lumen.head?.oral?.tongueToPalateAlongMidline ?? []
  if (canal[0] && oral.length) {
    const pts: V3[] = []
    const start = lumen.canal?.runs?.[0]?.startMm
    if (start) pts.push([r1(start[0]), r1(start[1]), r1(start[2])])
    for (const o of oral) pts.push([r1(x), r1(o.palateMm === null ? o.tongueTopMm + 4 : (o.tongueTopMm + o.palateMm) / 2), r1(o.zMm)])
    guides[canal[0]] = pts
  }
  // 咽：各高度上后壁与前壁之间的中点 / pharynx: midway between the posterior and anterior walls at each level
  const pharynx = lumen.head?.pharynx?.walls ?? []
  if (canal[1] && pharynx.length) guides[canal[1]] = pharynx.map((w) => [r1(x), r1(w.yMm), r1((w.posteriorMm + w.anteriorMm) / 2)])
  return {
    schema: 1,
    body,
    note: {
      zh: '由 tools/lumenview/extract.ts 从 pipeline-report.json 的 lumen 一节取出，供界面的“腔”显示和内镜漫游使用。引导线只是口腔和咽里的大致中线（由报告里的舌背、腭和咽壁的测量点算出），不是测量得到的中心线；其余各段的中心线由界面从网格的顶点圈算出。',
      en: 'Extracted by tools/lumenview/extract.ts from the `lumen` section of pipeline-report.json for the lumina display and the fly-through. The guide lines are only a rough midline through mouth and pharynx (computed from the tongue, palate and pharyngeal-wall samples in the report), not a measured centreline; the centreline of every other segment is computed in the UI from the rings of vertices of its mesh.',
    },
    canal,
    walls,
    guides,
    sphincters: (lumen.sphincters ?? []).map((s) => ({ id: s.sphincter, atMm: [r1(s.atMm[0]), r1(s.atMm[1]), r1(s.atMm[2])] })),
  }
}

if (import.meta.main) {
  const body = process.argv[2] ?? 'male'
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'anatomy', body)
  const reportPath = join(dir, 'pipeline-report.json')
  if (!existsSync(reportPath)) throw new Error(`no pipeline-report.json for body "${body}"`)
  const out = extractLumenPath(body, JSON.parse(readFileSync(reportPath, 'utf8')) as Report)
  if (!out) {
    console.log(`${body}: the report has no lumen section; nothing written`)
  } else {
    const text = JSON.stringify(out) + '\n'
    writeFileSync(join(dir, 'lumen-path.json'), text)
    console.log(`${body}: lumen-path.json ${text.length} bytes, canal ${out.canal.length} segments, guides ${Object.values(out.guides).map((g) => g.length).join('+')} points`)
  }
}
