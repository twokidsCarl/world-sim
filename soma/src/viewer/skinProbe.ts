// 验证用：把 GPU 着色器算出的蒙皮顶点位置读回 CPU，与参考实现对照。
// Verification: read the skinned vertex positions the GPU shader computes back to the CPU, to
// compare with the reference implementation.
//
// 做法：把抽样的顶点各画成一个盖住单个像素的小三角形（三个角带相同的属性），片元输出就是
// 蒙皮后的位置，渲染到一张 RGBA32F 目标后读回。用的是和正式材质同一个位置节点。
// How: each sampled vertex is drawn as a small triangle covering one pixel (its three corners
// carry identical attributes) whose fragment output is the skinned position, rendered into an
// RGBA32F target and read back. The position node is the very one the real materials use.

import { BufferAttribute, BufferGeometry, DoubleSide, FloatType, Mesh, NodeMaterial, OrthographicCamera, RGBAFormat, RenderTarget, Scene, type WebGPURenderer } from 'three/webgpu'
import { attribute, float, varying, vec4 } from 'three/tsl'
import type { PartBuffers } from './batches.ts'
import { positionNodeFor, type SkinningData, type SkinningMode } from './skinning.ts'

export async function probeSkinnedPositions(
  renderer: WebGPURenderer,
  data: SkinningData,
  mode: SkinningMode,
  buffers: PartBuffers,
  vertexIds: readonly number[],
): Promise<Float32Array> {
  const n = vertexIds.length
  const width = Math.min(256, Math.max(1, n))
  const height = Math.max(1, Math.ceil(n / width))
  const position = new Float32Array(n * 9)
  const normal = new Float32Array(n * 9)
  const skinIndex = new Uint16Array(n * 12)
  const skinWeight = new Uint8Array(n * 12)
  const thin = new Float32Array(n * 3)
  const clip = new Float32Array(n * 6)
  // 一个像素在裁剪空间里的大小；三角形比像素大一圈，保证盖住像素中心
  // size of a pixel in clip space; the triangle is larger than the pixel so it covers the centre
  const px = 2 / width
  const py = 2 / height
  const corners = [[-1.5, -1.5], [3, -1.5], [-1.5, 3]]
  vertexIds.forEach((v, i) => {
    const cx = (((i % width) + 0.5) / width) * 2 - 1
    const cy = ((Math.floor(i / width) + 0.5) / height) * 2 - 1
    for (let c = 0; c < 3; c++) {
      const o = i * 3 + c
      position.set(buffers.position.subarray(v * 3, v * 3 + 3), o * 3)
      normal[o * 3 + 1] = 1
      skinIndex.set(buffers.skinIndex.subarray(v * 4, v * 4 + 4), o * 4)
      skinWeight.set(buffers.skinWeight.subarray(v * 4, v * 4 + 4), o * 4)
      thin[o] = buffers.aux[v]!
      clip[o * 2] = cx + corners[c]![0]! * px * 0.5
      clip[o * 2 + 1] = cy + corners[c]![1]! * py * 0.5
    }
  })
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(position, 3))
  geometry.setAttribute('normal', new BufferAttribute(normal, 3))
  geometry.setAttribute('skinIndex', new BufferAttribute(skinIndex, 4, true))
  geometry.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4, true))
  geometry.setAttribute('aThin', new BufferAttribute(thin, 1))
  geometry.setAttribute('probeClip', new BufferAttribute(clip, 2))

  const material = new NodeMaterial()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const skinned: any = positionNodeFor(data, mode)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  material.vertexNode = (vec4 as any)(attribute('probeClip', 'vec2'), float(0), float(1))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  material.fragmentNode = (vec4 as any)(varying(skinned), float(1))
  material.side = DoubleSide
  material.depthTest = false
  material.depthWrite = false

  const mesh = new Mesh(geometry, material)
  mesh.frustumCulled = false
  const scene = new Scene()
  scene.add(mesh)
  const target = new RenderTarget(width, height, { type: FloatType, format: RGBAFormat, depthBuffer: false, samples: 0 })
  // 读回期间关掉神经加粗，免得位置被沿法线推开
  // the nerve aid is switched off for the read-back so positions are not pushed along the normal
  const boost = data.boost.value
  data.boost.value = 0
  const previous = renderer.getRenderTarget()
  renderer.setRenderTarget(target)
  renderer.render(scene, new OrthographicCamera(-1, 1, 1, -1, 0, 1))
  renderer.setRenderTarget(previous)
  data.boost.value = boost
  const pixels = (await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height)) as Float32Array
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) out.set(pixels.subarray(i * 4, i * 4 + 3), i * 3)
  target.dispose()
  geometry.dispose()
  material.dispose()
  return out
}
