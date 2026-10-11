import { useState } from 'react'
import { DE_BOER_QUANTUM, unitSystem } from '../theory/scaling'
import { useUi } from './store'

/**
 * 滑块位置 [-1, 1] 映射为 [1/span, span] 内的比值。
 * Slider position in [-1, 1] mapped to a ratio in [1/span, span].
 */
function LogSlider(props: { label: string; span: number; value: number; onChange: (v: number) => void }) {
  const position = Math.log(props.value) / Math.log(props.span)
  return (
    <div className="knob">
      <label>
        <span>{props.label}</span>
        <output>× {props.value < 10 ? props.value.toFixed(2) : props.value.toFixed(0)}</output>
      </label>
      <input
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={position}
        onChange={(e) => props.onChange(Math.pow(props.span, Number(e.target.value)))}
      />
    </div>
  )
}

export function ConstantsPanel() {
  const [alpha, setAlpha] = useState(1)
  const [massRatio, setMassRatio] = useState(1)
  const params = useUi((s) => s.params)
  const u = unitSystem(alpha, massRatio)
  const quantum = u.deBoer > DE_BOER_QUANTUM
  return (
    <div className="card">
      <h3>基本常量 → 这盒粒子的真实尺度</h3>
      <LogSlider label="精细结构常数 α" span={2} value={alpha} onChange={setAlpha} />
      <LogSlider label="电子/质子质量比" span={300} value={massRatio} onChange={setMassRatio} />
      <dl>
        <dt>粒子直径 σ</dt>
        <dd>{(u.sigma * 1e9).toFixed(3)} nm</dd>
        <dt>当前温度</dt>
        <dd>{(params.temperature! * u.kelvin).toFixed(1)} K</dd>
        <dt>时间步长</dt>
        <dd>{(params.dt! * u.tau * 1e15).toFixed(2)} fs</dd>
        <dt>速度单位</dt>
        <dd>{u.speed.toFixed(0)} m/s</dd>
        <dt>de Boer 参数 Λ</dt>
        <dd className={quantum ? 'broken' : undefined}>{u.deBoer.toFixed(3)}</dd>
      </dl>
      <p className={quantum ? 'note broken' : 'note'}>
        {quantum
          ? `Λ 超过 ${DE_BOER_QUANTUM}（氖约 0.59）：原子的量子涨落已与间距可比，经典分子动力学不再可信。`
          : '改常量不会改变画面：约化单位下的动力学完全相同，变的是它对应的真实尺寸、温度和时间。标度关系以氩为基准，只有幂次是推导出来的。'}
      </p>
    </div>
  )
}
