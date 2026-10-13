// 查看器里的"肌肉活动"层：按当前显示的姿势求值（src/activity/model.ts），给出每个肌肉部件的颜色和每条作用线的增粗量，
// 并把结果公布给面板。查看器只在姿势变化时调用它，不是每帧。
// The muscle-activity layer of the viewer: evaluates the displayed pose (src/activity/model.ts), yields a colour per
// muscle part and a thickening per line of action, and publishes the result for the panel. The viewer calls it
// when the pose changes, not every frame.

import { Color } from 'three/webgpu'
import type { JointFrames } from '../../tools/rig/pose.ts'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import { fetchJson } from '../anatomy/load.ts'
import type { LoadedRig, Pose } from '../anatomy/rig.ts'
import { LENGTH_RAMP, LOAD_RAMP, NO_DATA_COLOR, bulgeAmount, lengthLevel, loadLevel, rampColor } from '../activity/display.ts'
import { ActivityModel, linesOnlyData, rigSignature, type ActivityResult } from '../activity/model.ts'
import { useActivity } from '../activity/state.ts'
import type { ActivityData, ActivityMode } from '../activity/types.ts'
import { useApp } from '../state/store.ts'

/** 面板读取的当前结果（模块级：只有主视图写）/ The current result the panel reads (module level: only the main view writes it). */
export interface ActivitySnapshot {
  model: ActivityModel
  data: ActivityData | null
  result: ActivityResult
  /** 最近一次求值用时（毫秒）及其滑动最大值 / Time of the last evaluation (ms) and a decaying maximum. */
  ms: number
  msPeak: number
}
let current: ActivitySnapshot | null = null
export function currentActivity(): ActivitySnapshot | null {
  return current
}
// 验证用：浏览器控制台里读当前结果和用时 / for verification: the current result and timing from the browser console
if (typeof window !== 'undefined') (window as unknown as { __somaActivity?: () => ActivitySnapshot | null }).__somaActivity = currentActivity

/** 拖动时每次最多做这么多轮活动集迭代；没收敛的下一帧接着做 / Active-set rounds per update while dragging; what is left continues on the next frame. */
const ROUNDS_PER_UPDATE = 8

export class ActivityLayer {
  private model: ActivityModel | null = null
  private data: ActivityData | null = null
  private loading = false
  /** 肌肉下标 → 部件下标 / Muscle index → part index. */
  private partOf = new Int32Array(0)
  /** 没有数据的肌肉部件 / Muscle parts without data. */
  private noData: number[] = []
  /** 部件下标 → 当前颜色（线性空间）；没有条目表示不改颜色 / Part index → current colour (linear); no entry = colour untouched. */
  readonly tint = new Map<number, Color>()
  /** 每条作用线的增粗量（下标同 rig.muscles）/ Thickening per line of action (indexed as rig.muscles). */
  readonly bulge: Float32Array
  /** 上一次没有收敛，需要再算一轮 / The last solve did not converge; one more update is wanted. */
  pending = false
  private lastTick = 0
  private trailing: ReturnType<typeof setTimeout> | null = null
  private shownMode: ActivityMode = 'off'

  constructor(
    private readonly graph: AnatomyGraph,
    private readonly rig: LoadedRig,
    private readonly baseUrl: string,
    maxLines: number,
    private readonly onReady: () => void,
  ) {
    this.bulge = new Float32Array(maxLines)
  }

  /** 第一次打开时取 activity.json；没有或与绑定不符时只做几何层 / Fetch activity.json on first use; without it, or when it does not match the rig, only the geometry layer is built. */
  private load(): void {
    if (this.loading) return
    this.loading = true
    useActivity.setState({ status: 'loading', message: '' })
    const rig = this.rig.rig
    void fetchJson<ActivityData>(`${this.baseUrl}activity.json`)
      .catch(() => null)
      .then((data) => {
        let message = ''
        let full: ActivityData | null = null
        if (!data || !Array.isArray(data.muscles) || !data.mass) message = '此人体没有负荷估计的数据（activity.json），只显示长度变化 / this body has no data for the load estimate (activity.json); only length change is shown'
        else if (data.rigSignature !== rigSignature(rig)) message = '负荷估计的数据是为另一版骨架绑定生成的，需要重新生成（bun tools/activity/build.ts）；现在只显示长度变化 / the load-estimate data was built for another rig and must be regenerated (bun tools/activity/build.ts); only length change is shown'
        else full = data
        const names = (part: string): string => this.graph.part(part)?.name ?? part
        this.model = new ActivityModel(rig, full ?? linesOnlyData(rig, names))
        this.data = full
        this.partOf = Int32Array.from(this.model.muscles, (m) => this.graph.indexOf(m.part))
        const have = new Set(this.partOf)
        this.noData = []
        this.graph.parts.forEach((p, i) => {
          if (p.tissue === 'muscle' && !have.has(i)) this.noData.push(i)
        })
        if (message) console.warn(`[soma] ${message}`)
        useActivity.setState({ status: full ? 'ready' : 'lines', message })
        this.onReady()
      })
      .catch((err: unknown) => {
        console.warn('[soma] muscle activity failed to start', err)
        useActivity.setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
      })
  }

  /** 当前是否要显示（查看器据此决定静止姿势下也走蒙皮分支）/ Whether anything is to be shown (the viewer then takes the skinning branch even at rest). */
  wanted(): boolean {
    return useActivity.getState().mode !== 'off'
  }

  /**
   * 按当前姿势求值，更新颜色和增粗量。返回颜色可能变了的部件下标（查看器重新套用它们的外观）。
   * Evaluate the pose and update colours and thickening. Returns the part indices whose colour may have changed
   * (the viewer re-applies their look).
   */
  update(pose: Pose, frames: JointFrames): number[] {
    const st = useActivity.getState()
    const changed: number[] = []
    if (st.mode === 'off') {
      if (this.shownMode !== 'off') {
        changed.push(...this.tint.keys())
        this.tint.clear()
        this.bulge.fill(0)
        this.shownMode = 'off'
        this.pending = false
      }
      return changed
    }
    if (!this.model) {
      this.load()
      return changed
    }
    const model = this.model
    // 没有负荷数据时，"负荷"模式退回到长度 / without load data the "load" mode falls back to length
    const mode: ActivityMode = st.mode === 'load' && !model.full ? 'len' : st.mode
    const app = useApp.getState()
    const controls = app.shape?.data.controls
    const value = (id: 'stature' | 'bmi'): number | undefined => app.shapeControls[id] ?? controls?.find((c) => c.id === id)?.default
    const h = value('stature'), bmi = value('bmi')
    const t0 = performance.now()
    const res = model.evaluate(pose, frames, {
      gravity: st.gravity,
      load: st.load,
      bodyKg: h && bmi ? bmi * h * h : undefined,
      lengthsOnly: mode !== 'load',
      maxOuter: ROUNDS_PER_UPDATE,
    })
    const ms = performance.now() - t0
    this.pending = !!res.stats && !res.stats.converged
    const full = this.data?.params.displayFull ?? 0.5
    const bulgeMax = this.data?.params.bulgeMax ?? 0.1
    this.bulge.fill(0)
    const set = (part: number, rgb: [number, number, number]): void => {
      if (part < 0) return
      let c = this.tint.get(part)
      if (!c) this.tint.set(part, (c = new Color()))
      c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 'srgb')
      changed.push(part)
    }
    const none = rampColor([{ t: 0, color: NO_DATA_COLOR }], 0)
    for (let i = 0; i < model.muscles.length; i++) {
      const m = model.muscles[i]!
      if (mode === 'load') {
        if (!(m.fmax > 0)) {
          set(this.partOf[i]!, none)
          continue
        }
        const a = res.activation[i]!
        set(this.partOf[i]!, rampColor(LOAD_RAMP, loadLevel(a, full)))
        if (m.line >= 0 && m.line < this.bulge.length) this.bulge[m.line] = bulgeAmount(a, full, bulgeMax)
      } else set(this.partOf[i]!, rampColor(LENGTH_RAMP, lengthLevel(res.dRest[i]!)))
    }
    for (const part of this.noData) set(part, none)
    this.shownMode = mode
    current = { model, data: this.data, result: res, ms, msPeak: Math.max(ms, (current?.msPeak ?? 0) * 0.98) }
    // 面板的刷新节流到每秒 10 次左右；最后一次结果由延时的那次刷新补上
    // the panel is refreshed about ten times a second at most; a trailing refresh delivers the last result
    const now = performance.now()
    if (now - this.lastTick > 90) {
      this.lastTick = now
      useActivity.setState((s) => ({ tick: s.tick + 1 }))
    } else if (!this.trailing) {
      this.trailing = setTimeout(() => {
        this.trailing = null
        this.lastTick = performance.now()
        useActivity.setState((s) => ({ tick: s.tick + 1 }))
      }, 100)
    }
    return changed
  }

  dispose(): void {
    if (this.trailing) clearTimeout(this.trailing)
    if (current?.model === this.model) current = null
  }
}
