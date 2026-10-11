/**
 * 预先把一个细胞的细胞器表面做好。分割数据是分块存的（一种细胞器一百多块），
 * 以前页面每次打开都要逐块去取、再算表面，要等一两分钟；这里取一次、算一次，存成一个文件。
 *
 * Prepare the organelle surfaces of a cell ahead of time. The segmentation is stored in blocks
 * (over a hundred per organelle), and the page used to fetch them one by one and compute the
 * surfaces every time it was opened, a wait of a minute or two; here it is fetched once, computed
 * once, and kept as one file.
 *
 * 单独运行 / to run on its own:  bun server/tools/cell.ts <细胞的编号 / cell id>
 */
import cells from '../../data/cells.json'
import { CELL_MAGIC, buildCell, decodeCell, encodeCell, type CellSource } from '../../src/volume/cell'
import { preparedFile } from './prepared'

export const cellSource = (id: string): CellSource | undefined => (cells.cells as (CellSource & { id: string })[]).find((c) => c.id === id)

export const cellKey = (src: CellSource) => `cell|${src.base}|${src.scale}|${src.organelles.map((o) => o.label).join(',')}|${CELL_MAGIC}`

export async function makeCell(src: CellSource): Promise<Uint8Array> {
  const g = await buildCell(src, false)
  if (g.positions.length === 0) throw new Error(`没有取到这个细胞的分割数据 / the segmentation of this cell could not be fetched: ${src.base}`)
  return encodeCell(g)
}

if (import.meta.main) {
  const src = cellSource(process.argv[2] ?? '')
  if (!src) {
    console.error('用法 / usage: bun server/tools/cell.ts <cell id from data/cells.json>')
    process.exit(1)
  }
  const t0 = performance.now()
  const path = await preparedFile(cellKey(src), () => makeCell(src))
  const g = decodeCell(new Uint8Array(await Bun.file(path).arrayBuffer()))
  console.log(JSON.stringify({ path, seconds: Math.round((performance.now() - t0) / 1000), megabytes: Math.round(Bun.file(path).size / 1e6), points: g.positions.length / 3, triangles: g.triangles.length / 3, parts: g.parts, missing: g.missing }))
}
