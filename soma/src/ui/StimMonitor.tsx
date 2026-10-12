// 监护条：一次刺激期间的强度曲线和自主体征（心率、血压、呼吸、瞳孔、皮肤电导），带基线。
// 这些是群体平均的效应量，不能用来推断疼痛；瞳孔的数值来自麻醉下的病人。
// The monitor strip: the intensity curve and the autonomic signs (heart rate, blood pressure, respiration,
// pupil, skin conductance) during one stimulus, with baselines. These are group-average effect sizes and
// cannot be used to infer pain; the pupil numbers come from anaesthetised patients.

import { useApp } from '../state/store.ts'

const W = 220
const H = 44

function Vital({ zh, en, unit, now, base, digits = 0 }: { zh: string; en: string; unit: string; now: number; base: number; digits?: number }) {
  const d = now - base
  const changed = Math.abs(d) >= 0.5 * 10 ** -digits
  return (
    <div className={`vital${changed ? ' changed' : ''}`} title={`${en} · 基线 baseline ${base.toFixed(digits)} ${unit}`}>
      <span className="vital-name">
        {zh} <span className="en">{en}</span>
      </span>
      <span className="vital-value">
        {now.toFixed(digits)}
        <small> {unit}</small>
      </span>
      <span className="vital-delta">{changed ? `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(digits)}` : '基线'}</span>
    </div>
  )
}

export function StimMonitor() {
  const stim = useApp((s) => s.stim)
  const now = useApp((s) => s.stimNow)
  if (!stim || !now) return null
  const e = stim.e
  const a = now.sample.autonomic
  const b = stim.baseline.autonomic
  const span = Math.max(e.horizon, 0.5)
  // 时间轴取平方根：开头几百毫秒占的地方大一些 / square-root time axis: the first few hundred ms get more room
  const x = (t: number): number => Math.sqrt(Math.min(1, Math.max(0, t / span))) * W
  const y = (v: number): number => H - 2 - (Math.min(10, Math.max(0, v)) / 10) * (H - 6)
  const path = stim.curve.t.map((t, i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(stim.curve.intensity[i]!).toFixed(1)}`).join('')
  const endX = x(e.stimulusEnd)
  return (
    <div className="stim-monitor" role="group" aria-label="监护 / monitor">
      <div className="monitor-curve">
        <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-label="强度随时间 / intensity over time">
          <title>{`强度（0–10）随时间。虚线：刺激若持续会到 ${e.drive.toFixed(1)}；阴影：刺激存在的时间${e.endedByWithdrawal ? '（被退缩缩短）' : ''}。 Intensity (0–10) over time. Dashed: ${e.drive.toFixed(1)} if held; shaded: while the stimulus is on${e.endedByWithdrawal ? ' (cut short by the withdrawal)' : ''}.`}</title>
          <rect x={0} y={0} width={endX} height={H} className="monitor-stim" />
          <line x1={0} x2={W} y1={y(e.drive)} y2={y(e.drive)} className="monitor-drive" />
          <path d={path} className="monitor-line" />
          <line x1={x(now.t)} x2={x(now.t)} y1={0} y2={H} className="monitor-cursor" />
        </svg>
        <div className="monitor-readout">
          <strong>{now.sample.intensity.toFixed(1)}</strong> / 10
          <span className="en">
            {' '}
            · 若持续 if held {e.drive.toFixed(1)} · t = {now.t.toFixed(now.t < 10 ? 2 : 0)} s{now.running ? '' : ' · 结束 done'}
          </span>
        </div>
      </div>
      <div className="vitals">
        <Vital zh="心率" en="Heart rate" unit="/min" now={a.heartRate} base={b.heartRate} />
        <Vital zh="收缩压" en="Systolic" unit="mmHg" now={a.systolic} base={b.systolic} />
        <Vital zh="舒张压" en="Diastolic" unit="mmHg" now={a.diastolic} base={b.diastolic} />
        <Vital zh="呼吸" en="Resp. rate" unit="/min" now={a.respiratoryRate} base={b.respiratoryRate} />
        <Vital zh="瞳孔" en="Pupil" unit="mm" now={a.pupil} base={b.pupil} digits={1} />
        <Vital zh="皮肤电导" en="Skin cond." unit="μS" now={a.skinConductance} base={b.skinConductance} digits={1} />
      </div>
      <div className="hint monitor-note">
        群体平均的效应量，个体差异很大，不能用来推断疼痛；瞳孔的数值来自麻醉下的病人；呼吸频率没有出处。计算模型，模拟人没有主观体验。
        <span className="en"> Group-average effect sizes: individuals differ widely and these cannot be used to infer pain; pupil values come from anaesthetised patients; respiratory rate has no source. A computational model: the simulated body has no subjective experience.</span>
      </div>
    </div>
  )
}
