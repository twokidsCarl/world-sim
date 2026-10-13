// "肌肉活动"的图例：叠在舞台上，嵌入模式下也显示（嵌入时只有它，没有面板）。
// The legend of the muscle-activity display: drawn over the stage, in embed mode too (where it is all there is).

import { useEffect } from 'react'
import { LENGTH_FULL, LENGTH_RAMP, LOAD_RAMP, loadLevel, rampGradient } from '../activity/display.ts'
import { registerActivityUrlWriter, useActivity } from '../activity/state.ts'
import { useApp } from '../state/store.ts'
import { setPassthroughParam } from '../state/urlSync.ts'
import { currentActivity } from '../viewer/activityLayer.ts'
import './activity.css'

registerActivityUrlWriter(setPassthroughParam)

const GRAVITY_LABEL = { stand: { zh: '站立', en: 'standing' }, supine: { zh: '仰卧', en: 'supine' }, prone: { zh: '俯卧', en: 'prone' } } as const

export function ActivityLegend() {
  const mode = useActivity((s) => s.mode)
  const status = useActivity((s) => s.status)
  const gravity = useActivity((s) => s.gravity)
  const load = useActivity((s) => s.load)
  useActivity((s) => s.tick)
  const graph = useApp((s) => s.graph)
  // 这个显示要靠骨架绑定；地址里带了 act 而姿势是静止时，也要把绑定取来
  // the display needs the rig; fetch it also when the address carries `act` with a rest pose
  useEffect(() => {
    if (mode !== 'off' && graph) void useApp.getState().ensureRig()
  }, [mode, graph])
  if (mode === 'off') return null
  const snap = currentActivity()
  const full = snap?.data?.params.displayFull ?? 0.5
  const showLoad = mode === 'load' && status !== 'lines'
  const res = snap?.result
  const residualPct = res && res.solved && res.requiredSum > 0 ? (100 * res.residualSum) / res.requiredSum : 0
  const offset = res?.balance?.offsetM ?? 0
  return (
    <div className="activity-legend" role="note" aria-label="肌肉活动图例 / muscle activity legend">
      {showLoad ? (
        <>
          <strong>
            肌肉负荷 · 估计 <span className="en">Muscle load · an estimate</span>
          </strong>
          <div className="activity-ramp" style={{ background: rampGradient(LOAD_RAMP, 0, 1) }} />
          <div className="activity-ticks">
            {[0, 0.05, 0.2, 0.5].map((a) => (
              <span key={a} style={{ left: `${loadLevel(a, full) * 100}%` }}>
                {a === 0.5 ? '≥50%' : `${a * 100}%`}
              </span>
            ))}
          </div>
          <p>
            {GRAVITY_LABEL[gravity].zh}时抵抗重力{load ? `、手持 ${load.kg} kg` : ''}所需的激活度（静力优化）；不是肌电图。
            <span className="en">
              {' '}
              Activation needed to hold the pose against gravity, {GRAVITY_LABEL[gravity].en}
              {load ? `, holding ${load.kg} kg` : ''} (static optimisation); not an EMG.
            </span>
          </p>
          {residualPct > 10 && (
            <p className="activity-warn">
              ⚠ 肌肉给不出 {Math.round(residualPct)}% 的所需力矩，这个姿势下估计不可信 <span className="en">muscles cannot deliver {Math.round(residualPct)}% of the torque required; not credible in this pose</span>
            </p>
          )}
          {offset > 0.01 && (
            <p className="activity-warn">
              ⚠ 重心落在支撑面外 {Math.round(offset * 100)} cm：这个姿势站不住 <span className="en">centre of mass {Math.round(offset * 100)} cm outside the support: this posture cannot be held as it is</span>
            </p>
          )}
        </>
      ) : (
        <>
          <strong>
            作用线长度变化 · 几何 <span className="en">Length of the line of action · geometry</span>
          </strong>
          <div className="activity-ramp" style={{ background: rampGradient(LENGTH_RAMP, -1, 1) }} />
          <div className="activity-ticks">
            <span style={{ left: '0%' }}>缩短 {LENGTH_FULL * 100}%</span>
            <span style={{ left: '50%' }}>0</span>
            <span style={{ left: '100%' }}>拉长 {LENGTH_FULL * 100}%</span>
          </div>
          <p>
            相对模型静止姿势；只说明长度，不说明是否用力。
            <span className="en"> Relative to the model’s rest pose; length only, not effort.</span>
          </p>
          {mode === 'load' && status === 'lines' && <p className="activity-warn">⚠ 此人体没有可用的负荷数据，改为显示长度变化 <span className="en">no usable load data for this body; showing length change</span></p>}
        </>
      )}
    </div>
  )
}
