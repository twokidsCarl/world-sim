// "疼痛"页里的刺激工具和解释面板：选一种刺激、定量值和时长，点（或按住）皮肤施加；
// 下面按模型的九个步骤解释模拟人为什么这样反应，每个数字都标明是有出处、是假设、还是算出来的。
// The stimulus tool and the explanation panel of the Pain tab: pick a kind, a magnitude and a duration,
// then click (or press and hold) the skin; below, the model's nine steps explain why the simulated person
// responds as it does, with every number marked as sourced, assumed or computed.

import { useState } from 'react'
import { DISCLAIMER, type PainTrace, type SideLR, type SourceRef, type TraceNumber } from '../painmodel/index.ts'
import { applyStimulus, clearStimulus, replayStimulus } from '../pain/stim.ts'
import { HEAT_ANCHORS, KINDS, SITES, kindSpec, pressureKPa } from '../pain/stimulus.ts'
import { useApp } from '../state/store.ts'
import { PAIN_COLORS } from '../viewer/stimColors.ts'

/** 模型说明里要求界面明说的事（INTEGRATION.txt 第 9 节）/ What the model's note requires the UI to say plainly (section 9 of INTEGRATION.txt). */
export const STIM_CAVEATS: { zh: string; en: string }[] = [
  { zh: '除热以外，所有阈上增益（针刺、钝压、捏夹、冷）都是本项目的假设。', en: 'Every supra-threshold gain except heat (pinprick, pressure, pinch, cold) is an assumption of this project.' },
  { zh: '第一痛 / 第二痛的比例、所有上升、消退、适应的时间常数和 0.15 秒的中枢延迟都是假设。', en: 'The first / second pain shares, every rise, decay and adaptation time constant and the 0.15 s central delay are assumptions.' },
  { zh: '退缩阈（4/10）、运动传导速度、脊髓延迟、电–机械延迟、0.1 秒的逃离时间和所有反射的关节角度都是假设；只有"哪些关节、往哪个方向"有出处。', en: 'The withdrawal threshold (4 out of 10), motor conduction velocity, spinal delay, electromechanical delay, the 0.1 s escape time and every reflex joint angle are assumptions; only which joints move and in which direction is sourced.' },
  { zh: '自主体征的参考强度（皮肤电导除外）和几乎所有时间常数是假设；呼吸频率整项没有出处。', en: 'The reference intensities of the autonomic signs (except skin conductance) and nearly all their time constants are assumptions; respiratory rate has no source at all.' },
  { zh: '瞳孔的数值来自麻醉下的病人，不是清醒的人。', en: 'The pupil numbers come from anaesthetised patients, not awake people.' },
  { zh: '皮节图和皮神经分布区图是构造的教学用图，未经临床医师审校。', en: 'The dermatome and cutaneous nerve maps are constructed teaching maps, unreviewed by a clinician.' },
  { zh: '监护条上的数是群体平均的效应量，个体差异很大，不能用来推断疼痛。', en: 'The monitor shows group-average effect sizes; individuals differ widely and the signs cannot be used to infer pain.' },
  { zh: '超出"检验过的范围"时模型仍会给出结果（强度封顶在 10），但没有检验过；组织损伤没有模拟。', en: 'Beyond the tested ranges the model still answers (intensity capped at 10) but nothing was checked; tissue injury is not modelled.' },
]

function value(n: TraceNumber): string {
  const f = (x: number): string => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : String(Math.round(x * 1000) / 1000))
  return Array.isArray(n.value) ? `${f(n.value[0])}–${f(n.value[1])}` : f(n.value)
}

function NumberRow({ n, sources }: { n: TraceNumber; sources: SourceRef[] }) {
  const [open, setOpen] = useState(false)
  const kind = n.sources.length ? 'sourced' : n.assumption ? 'assumed' : 'computed'
  const label = kind === 'sourced' ? `出处 ${n.sources.length}` : kind === 'assumed' ? '假设' : '计算'
  const en = kind === 'sourced' ? 'sourced' : kind === 'assumed' ? 'assumption' : 'computed'
  const refs = sources.filter((s) => n.sources.includes(s.id))
  const more = refs.length > 0 || !!n.note
  return (
    <li className="trace-number">
      <div className="trace-number-row">
        <span className="trace-label">
          {n.label.zh} <span className="en">{n.label.en}</span>
        </span>
        <span className="trace-value">
          {value(n)} {n.unit}
        </span>
        <button className={`trace-kind trace-${kind}`} aria-expanded={open} disabled={!more} onClick={() => setOpen(!open)} title={en}>
          {label} <span className="en">{en}</span>
        </button>
      </div>
      {/* 假设的理由始终显示：假设不能看起来像测量值 / an assumption's reason is always shown: it must not look like a measurement */}
      {n.note && (kind === 'assumed' || open) && (
        <p className="hint">
          {n.note.zh} <span className="en">{n.note.en}</span>
        </p>
      )}
      {open &&
        refs.map((s) => (
          <div className="trace-source" key={s.id}>
            <p>{s.citation}</p>
            <p className="hint">
              支持的内容：{s.supports.zh} <span className="en">{s.supports.en}</span>
            </p>
            <p className="hint">这条出处是怎么读的 / how it was read: {s.opened}</p>
            <p className="hint">
              {s.license}
              {s.url && (
                <>
                  {' · '}
                  <a href={s.url} target="_blank" rel="noreferrer noopener">
                    {s.doi || '链接 link'}
                  </a>
                </>
              )}
            </p>
          </div>
        ))}
    </li>
  )
}

/** 解释面板：模型的九个步骤 / The explanation panel: the model's nine steps. */
export function TraceSteps({ trace }: { trace: PainTrace }) {
  const [open, setOpen] = useState<string | null>('stimulus')
  return (
    <ol className="trace-steps">
      {trace.steps.map((step, i) => (
        <li key={step.id} className={open === step.id ? 'open' : ''}>
          <button className="trace-step-head" aria-expanded={open === step.id} onClick={() => setOpen(open === step.id ? null : step.id)}>
            <span className="trace-step-n">{i + 1}</span>
            <span>
              {step.title.zh} <span className="en">{step.title.en}</span>
            </span>
          </button>
          <p className="trace-text">
            {step.text.zh}
            <span className="en"> {step.text.en}</span>
          </p>
          {open === step.id && step.numbers.length > 0 && (
            <ul className="trace-numbers">
              {step.numbers.map((n, k) => (
                <NumberRow key={`${n.label.en}${k}`} n={n} sources={trace.sources} />
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  )
}

export function StimulusPanel() {
  const settings = useApp((s) => s.stimSettings)
  const armed = useApp((s) => s.stimArmed)
  const stim = useApp((s) => s.stim)
  const status = useApp((s) => s.stimStatus)
  const message = useApp((s) => s.stimMessage)
  const [site, setSite] = useState(SITES[0]!.id)
  const [side, setSide] = useState<SideLR>('L')
  const [caveats, setCaveats] = useState(false)
  const app = useApp.getState()
  const k = kindSpec(settings.kind)
  const kpa = pressureKPa(settings)
  const e = stim?.e
  const arm = (on: boolean): void => {
    app.setStimArmed(on)
    // 要点皮肤，皮肤得看得见 / the skin has to be visible to be clicked
    if (on) app.setSystemVisible('integumentary', true)
  }
  return (
    <>
      <section className="group stim-panel">
        <h3>
          施加刺激 <span className="en">Apply a stimulus</span>
          {stim && (
            <button className="link-btn" onClick={() => clearStimulus()}>
              清除
            </button>
          )}
        </h3>
        <div className="pain-statement">
          <p>
            {DISCLAIMER.zh} <span className="en">{DISCLAIMER.en}</span>
          </p>
        </div>
        <div className="segmented stim-kinds" role="radiogroup" aria-label="刺激种类 / stimulus kind">
          {KINDS.map((x) => (
            <button key={x.id} role="radio" aria-checked={settings.kind === x.id} className={settings.kind === x.id ? 'active' : ''} onClick={() => app.setStimSettings({ kind: x.id })}>
              {x.zh} <span className="en">{x.en}</span>
            </button>
          ))}
        </div>
        <div className="dof-row">
          <label>
            <span className="dof-name">
              {k.unit === '°C' ? '温度' : '力'} <span className="en">{k.unit === '°C' ? 'Temperature' : 'Force'}</span>
            </span>
            <span className="value">
              {settings.magnitude} {k.unit}
              {kpa !== null && ` · ${Math.round(kpa)} kPa`}
            </span>
          </label>
          <input type="range" min={k.min} max={k.max} step={k.step} value={settings.magnitude} aria-label={`${k.zh} / ${k.en} (${k.unit})`} onChange={(ev) => app.setStimSettings({ magnitude: Number(ev.target.value) })} />
          <p className="hint">
            {k.range.zh}
            {k.areaMm2 && settings.kind !== 'heat' && settings.kind !== 'cold' ? `；接触面 ${k.areaMm2} mm²` : ''}。<span className="en"> {k.range.en}.</span>
          </p>
        </div>
        <div className="dof-row">
          <label>
            <span className="dof-name">
              时长 <span className="en">Duration</span>
            </span>
            <span className="value">{settings.duration} s</span>
          </label>
          <input type="range" min={0.5} max={k.durationMax} step={0.5} value={settings.duration} aria-label="时长 / Duration (s)" onChange={(ev) => app.setStimSettings({ duration: Number(ev.target.value) })} />
        </div>
        <label className="check">
          <input type="checkbox" checked={!!settings.repeat} onChange={(ev) => app.setStimSettings({ repeat: ev.target.checked ? { count: 10, hz: 1 } : null })} />
          重复 <span className="en">Repeat</span>
        </label>
        {settings.repeat && (
          <div className="stim-repeat">
            <label>
              次数 <span className="en">count</span>
              <input type="number" min={2} max={30} value={settings.repeat.count} onChange={(ev) => app.setStimSettings({ repeat: { count: Math.min(30, Math.max(2, Number(ev.target.value) || 2)), hz: settings.repeat!.hz } })} />
            </label>
            <label>
              频率 Hz
              <input type="number" min={0.1} max={5} step={0.1} value={settings.repeat.hz} onChange={(ev) => app.setStimSettings({ repeat: { count: settings.repeat!.count, hz: Math.min(5, Math.max(0.1, Number(ev.target.value) || 1)) } })} />
            </label>
            <p className="hint">频率不低于 0.33 Hz 时有时间总和。 Temporal summation at 0.33 Hz or faster.</p>
          </div>
        )}
        <label className="check" title="冷加压式浸泡、夹住不放 / cold-pressor immersion, a clamp left on">
          <input type="checkbox" checked={settings.held} onChange={(ev) => app.setStimSettings({ held: ev.target.checked })} />
          刺激物（或肢体）被固定：退缩不能结束刺激 <span className="en">Held: a withdrawal does not end the stimulus</span>
        </label>
        {settings.kind === 'heat' && (
          <label className="stim-anchor">
            热痛"温度–评分"斜率的取法 <span className="en">Reading of the heat slope</span>
            <select value={settings.heatAnchor} onChange={(ev) => app.setStimSettings({ heatAnchor: ev.target.value as typeof settings.heatAnchor })}>
              {HEAT_ANCHORS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.zh} / {a.en}
                </option>
              ))}
            </select>
            <span className="hint">四种取法相差近三倍；默认的一种只来自一项研究的一个温度点。 The four readings differ almost threefold; the default rests on one temperature of one study.</span>
          </label>
        )}
        <div className="actions">
          <button className={armed ? 'on' : ''} aria-pressed={armed} onClick={() => arm(!armed)}>
            {armed ? '正在等待点击皮肤…' : '在皮肤上施加'} <span className="en">{armed ? 'Click the skin…' : 'Apply on the skin'}</span>
          </button>
          <button disabled={!stim} onClick={() => void replayStimulus()}>
            再来一次 <span className="en">Again</span>
          </button>
        </div>
        <p className="hint">
          打开后：点一下皮肤，按设定的时长施加；按住不动，施加到松手为止。摆了姿势、改了体型也可以。
          <span className="en"> While on: a click on the skin applies it for the set duration; pressing and holding applies it until release. Works on a posed or reshaped body.</span>
        </p>
        <div className="stim-sites">
          <select value={site} aria-label="预设部位 / preset site" onChange={(ev) => setSite(ev.target.value)}>
            {SITES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.zh} / {s.en}
              </option>
            ))}
          </select>
          <div className="segmented">
            {(['L', 'R'] as SideLR[]).map((x) => (
              <button key={x} className={side === x ? 'active' : ''} onClick={() => setSide(x)}>
                {x === 'L' ? '左' : '右'}
              </button>
            ))}
          </div>
          <button className="tool-btn" onClick={() => void applyStimulus({ name: site, side }, { gesture: true, frame: true })}>
            施加于此 <span className="en">Apply here</span>
          </button>
        </div>
        {status === 'loading' && <p className="hint">正在准备模型数据（体表图、神经、骨架绑定）… Preparing the model data…</p>}
        {status === 'error' && (
          <p className="hint shape-limit">
            <strong>无法施加刺激。</strong> The stimulus could not be applied.
            <br />
            {message}
          </p>
        )}
      </section>

      {e && stim && (
        <section className="group stim-result">
          <h3>
            模拟人为什么这样反应 <span className="en">Why the simulated person responds this way</span>
          </h3>
          <dl className="stim-summary">
            <dt>
              部位 <span className="en">Site</span>
            </dt>
            <dd>
              {e.trace.region.name.zh} <span className="en">{e.trace.region.name.en}</span> · {e.trace.side === 'L' ? '左 left' : '右 right'}
            </dd>
            <dt>
              阈值 <span className="en">Threshold</span>
            </dt>
            <dd>
              {Math.round(e.trace.threshold.value * 100) / 100} {e.trace.threshold.unit}
              {e.trace.threshold.borrowed && (
                <span className="trace-kind trace-assumed">
                  借用 {e.trace.threshold.site} 的阈值 <span className="en">borrowed from {e.trace.threshold.site}</span>
                </span>
              )}
            </dd>
            <dt>
              刺激若持续，强度会到 <span className="en">Would reach if held</span>
            </dt>
            <dd>{e.drive.toFixed(1)} / 10</dd>
            <dt>
              实际到达 <span className="en">Actually reached</span>
            </dt>
            <dd>
              {e.peak.intensity.toFixed(1)} / 10
              {e.endedByWithdrawal && (
                <span className="hint">
                  {' '}
                  退缩在 {e.stimulusEnd.toFixed(2)} s 结束了刺激（原定 {e.statedEnd.toFixed(1)} s）。 <span className="en">The withdrawal ended the stimulus at {e.stimulusEnd.toFixed(2)} s (stated {e.statedEnd.toFixed(1)} s).</span>
                </span>
              )}
              {e.peak.intensity === 0 && (
                <span className="hint">
                  {' '}
                  阈下：没有疼痛反应。 <span className="en">Below threshold: no pain response.</span>
                </span>
              )}
            </dd>
            <dt>
              退缩反射 <span className="en">Withdrawal</span>
            </dt>
            <dd>
              {e.at(0).reflex.withdraws ? '有 yes' : '没有 no'}
              <span className="hint">
                {' '}
                {e.at(0).reflex.reason.zh} <span className="en">{e.at(0).reflex.reason.en}</span>
              </span>
            </dd>
          </dl>
          <div className="stim-legend">
            <span>
              <i style={{ background: PAIN_COLORS.focus }} /> 接触区（随强度变亮） <span className="en">contact area (brightens with intensity)</span>
            </span>
            <span>
              <i style={{ background: PAIN_COLORS.territory }} /> 同一皮神经分布区{e.trace.territory ? `：${e.trace.territory.name.zh}` : ''} <span className="en">same cutaneous territory</span>
            </span>
            <span>
              <i style={{ background: PAIN_COLORS.dermatome }} /> 同一皮节{e.trace.dermatome ? `：${e.trace.dermatome.name.zh}` : ''} <span className="en">same dermatome</span>
            </span>
            <span>
              <i style={{ background: PAIN_COLORS.path }} /> 通路上的神经 <span className="en">nerves on the pathway</span>
            </span>
            <span>
              <i style={{ background: PAIN_COLORS.fast }} /> Aδ 纤维的冲动（快） <i style={{ background: PAIN_COLORS.slow }} /> C 纤维的冲动（慢） <span className="en">Aδ volley (fast) / C volley (slow)</span>
            </span>
            <p className="hint">两档背景色是显示用的固定值，不是那里的疼痛强度。 The two background levels are display values, not pain intensities there.</p>
            {e.trace.path.bridgedM > 0.001 && (
              <p className="hint">
                通路中有 {(e.trace.path.bridgedM * 100).toFixed(0)} cm 是直线跨越（模型里没有建出的神经段，如神经丛）。 <span className="en">{(e.trace.path.bridgedM * 100).toFixed(0)} cm of the pathway is a straight bridge (a stretch with no centreline in the model, such as a plexus).</span>
              </p>
            )}
          </div>
          <TraceSteps trace={e.trace} />
          <h4 className="trace-caveats-title">
            这一次刺激的局限 <span className="en">Limitations of this stimulus</span>
          </h4>
          <ul className="trace-caveats">
            {e.trace.caveats.map((c) => (
              <li key={c.en}>
                {c.zh} <span className="en">{c.en}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="group">
        <button className="chip chip-warn chip-button" aria-expanded={caveats} onClick={() => setCaveats(!caveats)}>
          刺激模型里哪些是假设 · {STIM_CAVEATS.length} 条 <span className="en">What is assumed in the stimulus model</span>
        </button>
        {caveats && (
          <ul className="trace-caveats">
            {STIM_CAVEATS.map((c) => (
              <li key={c.en}>
                {c.zh} <span className="en">{c.en}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  )
}
