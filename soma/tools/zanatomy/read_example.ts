// Minimal Bun/TypeScript reader for data/raw/z-anatomy/out/import (run: bun tools/zanatomy/read_example.ts)
const dir = 'data/raw/z-anatomy/out/import'
const manifest = await Bun.file(`${dir}/manifest.json`).json()
const centrelines = await Bun.file(`${dir}/centrelines.json`).json()
const bins = new Map<string, ArrayBuffer>()
async function mesh(ref: { file: string; vOffset: number; vCount: number; iOffset: number; iCount: number }) {
  if (!bins.has(ref.file)) bins.set(ref.file, await Bun.file(`${dir}/${ref.file}`).arrayBuffer())
  const buf = bins.get(ref.file)!
  return {
    positions: new Float32Array(buf, ref.vOffset, ref.vCount * 3), // xyz, metres, Y up, anterior +Z, left +X
    indices: new Uint32Array(buf, ref.iOffset, ref.iCount), // triangles, CCW outward
  }
}
const item = manifest.items.find((i: any) => i.name === 'Sciatic nerve' && i.side === 'L' && i.preferred)
const m = await mesh(item.files.mesh)
const cl = centrelines[item.files.centreline.key]
console.log(item.id, item.source, item.fma, item.fmaLabel, 'tris', m.indices.length / 3, 'verts', m.positions.length / 3)
console.log('bbox', item.bbox, 'branches', cl.length, 'first point', cl[0].points[0], 'radius m', cl[0].radius[0])
const a = manifest.anchors.find((x: any) => x.name === 'Femur' && x.side === 'L' && x.source === 'z-anatomy')
console.log('anchor', a.id, a.bp3dIds, a.fma, 'residual mm', a.residualMeanMm, 'resculpted', a.resculpted, 't', a.icp.t)

export {}
