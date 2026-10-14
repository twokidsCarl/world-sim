// 布料自碰撞：空间哈希上的点–点碰撞。改写自 Matthias Müller 的 Ten Minute Physics 第 15 课
// “Cloth Self Collision Handling”（15-selfCollision.html），原文件的许可声明如下（MIT）：
// Cloth self-collision: point–point collisions on a spatial hash. Adapted from Matthias Müller's
// Ten Minute Physics lesson 15, "Cloth Self Collision Handling" (15-selfCollision.html), whose notice
// (MIT) follows:
//
//   Copyright 2022 Matthias Müller - Ten Minute Physics,
//   https://www.youtube.com/c/TenMinutePhysics
//   www.matthiasMueller.info/tenMinutePhysics
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
//   associated documentation files (the "Software"), to deal in the Software without restriction,
//   including without limitation the rights to use, copy, modify, merge, publish, distribute,
//   sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
//   furnished to do so, subject to the following conditions:
//
//   The above copyright notice and this permission notice shall be included in all copies or
//   substantial portions of the Software.
//
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
//   NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
//   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
//   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
// 改动 / Changes: TypeScript；“静止距离”按裁片坐标算，跨裁片的点对用各自到缝线的裁片距离之和作下界
// （布料由多片缝成，没有统一的静止网格）；哈希函数同原文。
// TypeScript; the "rest distance" comes from pattern coordinates, and for a pair on different panels
// the sum of each point's pattern distance to the nearest seam is used as a lower bound (the cloth is
// sewn from several panels and has no single rest mesh); the hash function is the original's.

export class SpatialHash {
  readonly spacing: number
  readonly tableSize: number
  readonly cellStart: Int32Array
  readonly cellEntries: Int32Array
  readonly queryIds: Int32Array
  querySize = 0
  firstAdjId: Int32Array
  adjIds: Int32Array

  constructor(spacing: number, maxNumObjects: number) {
    this.spacing = spacing
    this.tableSize = 5 * maxNumObjects
    this.cellStart = new Int32Array(this.tableSize + 1)
    this.cellEntries = new Int32Array(maxNumObjects)
    this.queryIds = new Int32Array(maxNumObjects)
    this.firstAdjId = new Int32Array(maxNumObjects + 1)
    this.adjIds = new Int32Array(10 * maxNumObjects)
  }

  hashCoords(xi: number, yi: number, zi: number): number {
    const h = Math.imul(xi, 92837111) ^ Math.imul(yi, 689287499) ^ Math.imul(zi, 283923481) // 原文的“幻想函数” / the original's "fantasy function"
    return Math.abs(h) % this.tableSize
  }

  intCoord(c: number): number {
    return Math.floor(c / this.spacing)
  }

  hashPos(pos: ArrayLike<number>, nr: number): number {
    return this.hashCoords(this.intCoord(pos[3 * nr]!), this.intCoord(pos[3 * nr + 1]!), this.intCoord(pos[3 * nr + 2]!))
  }

  create(pos: ArrayLike<number>): void {
    const num = Math.min(pos.length / 3, this.cellEntries.length)
    this.cellStart.fill(0)
    this.cellEntries.fill(0)
    for (let i = 0; i < num; i++) this.cellStart[this.hashPos(pos, i)]!++
    let start = 0
    for (let i = 0; i < this.tableSize; i++) {
      start += this.cellStart[i]!
      this.cellStart[i] = start
    }
    this.cellStart[this.tableSize] = start
    for (let i = 0; i < num; i++) {
      const h = this.hashPos(pos, i)
      this.cellStart[h]!--
      this.cellEntries[this.cellStart[h]!] = i
    }
  }

  query(pos: ArrayLike<number>, nr: number, maxDist: number): void {
    const x0 = this.intCoord(pos[3 * nr]! - maxDist), y0 = this.intCoord(pos[3 * nr + 1]! - maxDist), z0 = this.intCoord(pos[3 * nr + 2]! - maxDist)
    const x1 = this.intCoord(pos[3 * nr]! + maxDist), y1 = this.intCoord(pos[3 * nr + 1]! + maxDist), z1 = this.intCoord(pos[3 * nr + 2]! + maxDist)
    this.querySize = 0
    for (let xi = x0; xi <= x1; xi++) {
      for (let yi = y0; yi <= y1; yi++) {
        for (let zi = z0; zi <= z1; zi++) {
          const h = this.hashCoords(xi, yi, zi)
          for (let i = this.cellStart[h]!; i < this.cellStart[h + 1]!; i++) this.queryIds[this.querySize++] = this.cellEntries[i]!
        }
      }
    }
  }

  /** 所有距离不超过 maxDist 的点对（id1 < id0）/ All pairs within maxDist (id1 < id0). */
  queryAll(pos: ArrayLike<number>, maxDist: number): void {
    let num = 0
    const maxDist2 = maxDist * maxDist
    const n = this.cellEntries.length
    for (let id0 = 0; id0 < n; id0++) {
      this.firstAdjId[id0] = num
      this.query(pos, id0, maxDist)
      for (let j = 0; j < this.querySize; j++) {
        const id1 = this.queryIds[j]!
        if (id1 >= id0) continue
        const dx = pos[id0 * 3]! - pos[id1 * 3]!, dy = pos[id0 * 3 + 1]! - pos[id1 * 3 + 1]!, dz = pos[id0 * 3 + 2]! - pos[id1 * 3 + 2]!
        if (dx * dx + dy * dy + dz * dz > maxDist2) continue
        if (num >= this.adjIds.length) {
          const grown = new Int32Array(2 * num)
          grown.set(this.adjIds)
          this.adjIds = grown
        }
        this.adjIds[num++] = id1
      }
    }
    this.firstAdjId[n] = num
  }
}

export class SelfCollision {
  readonly hash: SpatialHash
  /** 每多少个子步重建一次邻接表（原文每帧一次）/ Substeps between rebuilding the adjacency (once a frame in the original). */
  rebuildEvery = 10
  private counter = 0

  /**
   * `thickness`：两点之间保持的距离；`uv`、`panel`：裁片坐标和所属裁片；`seamDist`：每点到最近缝线的裁片距离。
   * `thickness`: distance kept between points; `uv`, `panel`: pattern coordinates and panel; `seamDist`:
   * each point's pattern distance to the nearest seam.
   */
  constructor(
    readonly n: number,
    readonly thickness: number,
    readonly uv: ArrayLike<number>,
    readonly panel: ArrayLike<number>,
    readonly seamDist: ArrayLike<number>,
    readonly friction = 0,
  ) {
    this.hash = new SpatialHash(thickness, n)
  }

  private restDist2(a: number, b: number): number {
    if (this.panel[a] === this.panel[b]) {
      const du = this.uv[a * 2]! - this.uv[b * 2]!, dv = this.uv[a * 2 + 1]! - this.uv[b * 2 + 1]!
      return du * du + dv * dv
    }
    const s = this.seamDist[a]! + this.seamDist[b]!
    return s * s
  }

  solve(x: Float64Array, prev: Float64Array, w: Float64Array): void {
    if (this.counter++ % this.rebuildEvery === 0) {
      this.hash.create(x)
      // 查询半径放宽：重建之间粒子还会移动 / a wider query radius: particles keep moving between rebuilds
      this.hash.queryAll(x, 2 * this.thickness)
    }
    const t = this.thickness, t2 = t * t
    const { firstAdjId, adjIds } = this.hash
    for (let id0 = 0; id0 < this.n; id0++) {
      if (w[id0] === 0) continue
      for (let j = firstAdjId[id0]!; j < firstAdjId[id0 + 1]!; j++) {
        const id1 = adjIds[j]!
        if (w[id1] === 0) continue
        let dx = x[id1 * 3]! - x[id0 * 3]!, dy = x[id1 * 3 + 1]! - x[id0 * 3 + 1]!, dz = x[id1 * 3 + 2]! - x[id0 * 3 + 2]!
        const d2 = dx * dx + dy * dy + dz * dz
        if (d2 > t2 || d2 === 0) continue
        const r2 = this.restDist2(id0, id1)
        if (d2 > r2) continue
        const minDist = r2 < t2 ? Math.sqrt(r2) : t
        const d = Math.sqrt(d2)
        const s = (minDist - d) / d
        dx *= s
        dy *= s
        dz *= s
        x[id0 * 3] = x[id0 * 3]! - 0.5 * dx
        x[id0 * 3 + 1] = x[id0 * 3 + 1]! - 0.5 * dy
        x[id0 * 3 + 2] = x[id0 * 3 + 2]! - 0.5 * dz
        x[id1 * 3] = x[id1 * 3]! + 0.5 * dx
        x[id1 * 3 + 1] = x[id1 * 3 + 1]! + 0.5 * dy
        x[id1 * 3 + 2] = x[id1 * 3 + 2]! + 0.5 * dz
        if (this.friction > 0) {
          // 速度修正：向两点的平均速度靠拢 / velocity correction: towards the pair's mean velocity
          for (let k = 0; k < 3; k++) {
            const v0 = x[id0 * 3 + k]! - prev[id0 * 3 + k]!, v1 = x[id1 * 3 + k]! - prev[id1 * 3 + k]!
            const m = 0.5 * (v0 + v1)
            x[id0 * 3 + k] = x[id0 * 3 + k]! + (m - v0) * this.friction
            x[id1 * 3 + k] = x[id1 * 3 + k]! + (m - v1) * this.friction
          }
        }
      }
    }
  }
}
