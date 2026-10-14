// 写实模式的光照环境：three 自带的程序化房间（RoomEnvironment，不用外部 HDR 图，没有许可问题）预滤波成
// PMREM 作为环境光，Khronos PBR Neutral 色调映射（保留底色的色相和饱和度；AgX 会把肤色洗淡）。只在写实模式打开时生效；关掉时把渲染器和场景还原。
// The lighting environment of the lifelike mode: three's procedural room (RoomEnvironment — no external HDR
// image, so no licence question) prefiltered into a PMREM as image-based light, and Khronos PBR Neutral tone mapping (keeps the hue and saturation of base colours; AgX washes skin out). It
// applies only while the lifelike mode is on; turning it off restores the renderer and the scene.

import { NeutralToneMapping, NoToneMapping, PMREMGenerator, type HemisphereLight, type Scene, type Texture, type WebGPURenderer } from 'three/webgpu'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

/** 写实模式下半球补光保留的比例：环境光已经给了漫射光 / share of the hemisphere fill kept in lifelike mode: the environment already provides diffuse light */
const FILL_KEEP = 0.4
/** 环境光强度 / environment intensity */
const ENV_INTENSITY = 0.3
/** 曝光 / exposure */
const EXPOSURE = 1.0

export class LookEnvironment {
  private texture: Texture | null = null
  private on = false
  private readonly fillIntensity: number

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly scene: Scene,
    private readonly fill: HemisphereLight,
  ) {
    this.fillIntensity = fill.intensity
  }

  get active(): boolean {
    return this.on
  }

  /** 打开或关上；返回是否有变化 / Switch on or off; returns whether anything changed. */
  set(on: boolean): boolean {
    if (on === this.on) return false
    this.on = on
    if (on) {
      if (!this.texture) {
        const pmrem = new PMREMGenerator(this.renderer)
        const room = new RoomEnvironment()
        this.texture = pmrem.fromScene(room, 0.04).texture
        room.dispose()
        pmrem.dispose()
      }
      this.scene.environment = this.texture
      this.scene.environmentIntensity = ENV_INTENSITY
      this.renderer.toneMapping = NeutralToneMapping
      this.renderer.toneMappingExposure = EXPOSURE
      this.fill.intensity = this.fillIntensity * FILL_KEEP
    } else {
      this.scene.environment = null
      this.renderer.toneMapping = NoToneMapping
      this.renderer.toneMappingExposure = 1
      this.fill.intensity = this.fillIntensity
    }
    return true
  }

  dispose(): void {
    this.texture?.dispose()
    this.texture = null
  }
}
