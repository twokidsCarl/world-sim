// （pinchGap > 0 时，外面离另一块皮肤不到这么近的顶点也标上。）
// 埋在身体里的皮肤顶点：皮肤网格自身有重叠（腋窝处手臂内侧的皮插进躯干的皮里），这些顶点在另一处皮肤之内。
// 判断：沿顶点自己的外法线射出，第一个碰到的面若与射线同向（从里面穿出），这个顶点就在另一层皮之内。
// 皮肤有开口（眼、口），所以不用奇偶计数。反向检查排除它们：布不必去推一块本来就在身体里的皮。
// (With pinchGap > 0, vertices facing another stretch of skin closer than that are marked too.)
// Skin vertices buried in the body: the skin mesh overlaps itself (at the axillae the inner skin of the arm runs into
// the trunk's), and these vertices lie inside another stretch of skin. Test: a ray along the vertex's own outward
// normal; if the first surface it meets faces the same way (the ray leaves through it), the vertex is inside another
// layer of skin. The skin has openings (eyes, mouth), so parity counting is not used. The reverse check leaves these
// out: the cloth need not push against skin that is inside the body anyway.

import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three'
import { MeshBVH } from 'three-mesh-bvh'

export function buriedVertices(positions: Float32Array, index: Uint32Array, pinchGap = 0): Uint8Array {
  const g = new BufferGeometry()
  // 拷贝：MeshBVH 会就地重排三角形下标，不能动调用者的数组 / copies: MeshBVH reorders the triangle index in place, and the caller's arrays must not change
  g.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3))
  g.setIndex(new BufferAttribute(Uint32Array.from(index), 1))
  g.computeVertexNormals()
  const nor = g.getAttribute('normal').array as Float32Array
  const bvh = new MeshBVH(g)
  const n = positions.length / 3
  const out = new Uint8Array(n)
  const ray = new Ray()
  const fn = new Vector3()
  for (let i = 0; i < n; i++) {
    const nx = nor[i * 3]!, ny = nor[i * 3 + 1]!, nz = nor[i * 3 + 2]!
    // 起点沿法线挪开 0.5 mm，免得碰到顶点自己的三角形 / start 0.5 mm out along the normal so the vertex's own triangles are not hit
    ray.origin.set(positions[i * 3]! + nx * 5e-4, positions[i * 3 + 1]! + ny * 5e-4, positions[i * 3 + 2]! + nz * 5e-4)
    ray.direction.set(nx, ny, nz)
    const hit = bvh.raycastFirst(ray, DoubleSide)
    if (!hit || hit.distance > 0.05 || !hit.face) continue
    fn.copy(hit.face.normal)
    if (fn.dot(ray.direction) > 0) out[i] = 1
    // 夹缝：外面不到 pinchGap 就迎面碰到另一块皮肤（腋窝、并拢的大腿）；布夹在中间，不能按“钻出”去推
    // a pinch: another stretch of skin faces this one within pinchGap (axilla, thighs together); cloth caught between
    // them must not be pushed as if poked through
    else if (hit.distance < pinchGap) out[i] = 1
  }
  return out
}
