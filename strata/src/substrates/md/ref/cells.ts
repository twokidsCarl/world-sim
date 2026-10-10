// Uniform cell grid built by counting sort: count per cell -> prefix sum -> scatter.
// The GPU neighbour search follows the same three passes.

export interface CellGrid {
  rc: number
  /** Cells per axis; unused axes are 1. */
  nc: [number, number, number]
  /** start[c] .. start[c + 1] indexes into items. */
  start: Int32Array
  items: Int32Array
  cellOf: Int32Array
  cursor: Int32Array
}

/** Returns null when the box is under 3 cells wide on some axis; callers fall back to all pairs. */
export function makeGrid(dim: 2 | 3, box: Float64Array, rc: number, n: number): CellGrid | null {
  const nc: [number, number, number] = [1, 1, 1]
  for (let d = 0; d < dim; d++) {
    nc[d] = Math.floor(box[d] / rc)
    if (nc[d] < 3) return null
  }
  const cells = nc[0] * nc[1] * nc[2]
  return {
    rc,
    nc,
    start: new Int32Array(cells + 1),
    items: new Int32Array(n),
    cellOf: new Int32Array(n),
    cursor: new Int32Array(cells),
  }
}

export function buildCells(g: CellGrid, dim: 2 | 3, pos: Float64Array, box: Float64Array, n: number): void {
  const [nx, ny, nz] = g.nc
  const { start, items, cellOf, cursor } = g
  start.fill(0)
  for (let i = 0; i < n; i++) {
    const cx = Math.min(nx - 1, Math.floor((pos[i * dim] / box[0]) * nx))
    const cy = Math.min(ny - 1, Math.floor((pos[i * dim + 1] / box[1]) * ny))
    const cz = dim === 3 ? Math.min(nz - 1, Math.floor((pos[i * dim + 2] / box[2]) * nz)) : 0
    const c = cx + nx * (cy + ny * cz)
    cellOf[i] = c
    start[c + 1]++
  }
  const cells = nx * ny * nz
  for (let c = 0; c < cells; c++) start[c + 1] += start[c]
  cursor.set(start.subarray(0, cells))
  for (let i = 0; i < n; i++) items[cursor[cellOf[i]]++] = i
}
