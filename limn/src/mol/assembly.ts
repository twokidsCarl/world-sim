/**
 * Expand an mmCIF `oper_expression` into lists of operator ids to compose.
 *   "1"            -> [["1"]]
 *   "1,2,5-7"      -> [["1"],["2"],["5"],["6"],["7"]]
 *   "(1-60)(61-88)"-> every pair [a, b]: apply b first, then a
 */
export function parseOperExpression(expr: string): string[][] {
  const groups: string[][] = []
  const re = /\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(expr))) groups.push(expandList(m[1]!))
  if (groups.length === 0) groups.push(expandList(expr))
  let out: string[][] = [[]]
  for (const g of groups) {
    const next: string[][] = []
    for (const prefix of out) for (const id of g) next.push([...prefix, id])
    out = next
  }
  return out
}

function expandList(s: string): string[] {
  const out: string[] = []
  for (const part of s.split(',')) {
    const p = part.trim()
    if (!p) continue
    const range = /^(-?\d+)-(-?\d+)$/.exec(p)
    if (range) {
      const a = Number(range[1]), b = Number(range[2])
      for (let i = a; i <= b; i++) out.push(String(i))
    } else out.push(p)
  }
  return out
}

/** a * b for column-major 4x4 matrices. */
export function mul4(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!
      o[c * 4 + r] = s
    }
  return o
}
