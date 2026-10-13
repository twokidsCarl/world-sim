// "肌肉活动"面板（在"姿势"页里）：模式开关、重力方向和手持负荷、按激活度或长度变化排序的肌肉列表、逐自由度的力矩表。
// The muscle-activity section of the Pose tab: mode switch, gravity direction and hand load, a list of muscles
// ranked by activation or by length change, and the per-dof torque table.

import { useState } from 'react'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import { LENGTH_RAMP, LOAD_RAMP, lengthLevel, loadLevel, rampCss } from '../activity/display.ts'
import { DofStatus, FLAG_FLIP, FLAG_NEAR, type ActivityModel } from '../activity/model.ts'
import { useActivity } from '../activity/state.ts'
import type { ActivityMode, ActivityMuscle, GravityMode, HandLoad } from '../activity/types.ts'
import { useApp } from '../state/store.ts'
import { currentActivity } from '../viewer/activityLayer.ts'
import { CautionList } from './CautionsDialog.tsx'
import './activity.css'

const MODES: { id: ActivityMode; zh: string; en: string }[] = [
  { id: 'off', zh: '关', en: 'off' },
  { id: 'len', zh: '长度变化', en: 'length change' },
  { id: 'load', zh: '负荷（估计）', en: 'load (estimate)' },
]
const GRAVITY: { id: GravityMode; zh: string; en: string }[] = [
  { id: 'stand', zh: '站立', en: 'standing' },
  { id: 'supine', zh: '仰卧', en: 'supine' },
  { id: 'prone', zh: '俯卧', en: 'prone' },
]

const pct = (v: number, digits = 0): string => `${(v * 100).toFixed(digits)}%`
const signed = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100).toFixed(Math.abs(v) < 0.1 ? 1 : 0)}%`

/** 平衡单元的名字和它正、负方向的运动名 / A balance unit's name and the movements of its positive and negative directions. */
export function unitName(model: ActivityModel, u: number): { zh: string; en: string; pos: { zh: string; en: string }; neg: { zh: string; en: string } } {
  const unit = model.units[u]!
  const info = model.dofs[unit.dofs[0]!]!
  const joint = model.joints[info.joint]!
  const dof = joint.dofs[info.k]!
  const [pz, nz] = dof.name.zh.split(/\s*\/\s*/)
  const [pe, ne] = dof.name.en.split(/\s*\/\s*/)
  const name = unit.group?.name ?? joint.name
  return { zh: name.zh, en: name.en, pos: { zh: pz ?? dof.name.zh, en: pe ?? dof.name.en }, neg: { zh: nz ?? pz ?? '', en: ne ?? pe ?? '' } }
}

function flagNotes(m: ActivityMuscle | undefined, runtime: number): { zh: string; en: string }[] {
  const out = [...(m?.why ?? [])]
  if (runtime & FLAG_NEAR) out.push({ zh: '这个姿势下作用线贴近它所跨的关节中心，力臂很小、符号不稳', en: 'in this pose the line passes close to the centre of a joint it spans: the moment arm is small and its sign unstable' })
  if (runtime & FLAG_FLIP) out.push({ zh: '这个姿势下它在某个自由度上的力臂与解剖学姿势时符号相反（直线不绕行所致，或确实换了作用）', en: 'in this pose its moment arm at some dof has the opposite sign to the anatomical position (a straight line that does not wrap, or a real change of action)' })
  return out
}

export function ActivityPanel({ graph }: { graph: AnatomyGraph }) {
  const mode = useActivity((s) => s.mode)
  const gravity = useActivity((s) => s.gravity)
  const load = useActivity((s) => s.load)
  const status = useActivity((s) => s.status)
  const message = useActivity((s) => s.message)
  useActivity((s) => s.tick)
  const selection = useApp((s) => s.selection)
  const muscleSystem = useApp((s) => s.systems.muscular)
  const [all, setAll] = useState(false)
  const [notesFor, setNotesFor] = useState<string | null>(null)
  const act = useActivity.getState()
  const app = useApp.getState()
  const snap = mode === 'off' ? null : currentActivity()
  const showLoad = mode === 'load' && !!snap?.result.solved
  const setLoad = (patch: Partial<HandLoad> | null): void => act.setLoad(patch === null ? null : { kg: load?.kg ?? 2, side: load?.side ?? 'B', ...patch })

  let rows: { i: number; value: number }[] = []
  if (snap) {
    const r = snap.result
    const idx = [...snap.model.muscles.keys()]
    rows = showLoad
      ? idx.filter((i) => r.activation[i]! > 0.003).map((i) => ({ i, value: r.activation[i]! })).sort((a, b) => b.value - a.value)
      : idx.filter((i) => Math.abs(r.dRest[i]!) > 0.01).map((i) => ({ i, value: r.dRest[i]! })).sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
  }
  const shown = all ? rows : rows.slice(0, 14)
  const full = snap?.data?.params.displayFull ?? 0.5
  const metaOf = new Map((snap?.data?.muscles ?? []).map((m) => [m.part, m]))
  const units = snap && showLoad ? [...snap.model.units.keys()].filter((u) => [DofStatus.Active, DofStatus.NoMuscle, DofStatus.Limit].includes(snap.result.status[u]!) && Math.abs(snap.result.required[u]!) > 0.2).sort((a, b) => Math.abs(snap.result.required[b]!) - Math.abs(snap.result.required[a]!)) : []
  const bal = snap?.result.balance

  return (
    <section className="group activity-panel">
      <h3>
        肌肉活动 <span className="en">Muscle activity</span>
      </h3>
      <div className="activity-modes" role="group" aria-label="肌肉活动显示模式 / muscle activity mode">
        {MODES.map((m) => (
          <button key={m.id} aria-pressed={mode === m.id} onClick={() => act.setMode(m.id)}>
            {m.zh}
            <small>{m.en}</small>
          </button>
        ))}
      </div>

      {mode !== 'off' && !muscleSystem?.visible && (
        <p className="hint activity-warn">
          肌肉系统现在是隐藏的。{' '}
          <button className="link-btn" onClick={() => app.setSystemVisible('muscular', true)}>
            显示肌肉 Show muscles
          </button>
        </p>
      )}
      {mode !== 'off' && status === 'loading' && <p className="hint">正在准备… Preparing…</p>}
      {mode !== 'off' && message && <p className="hint activity-warn">{message}</p>}

      {mode === 'len' && (
        <p className="activity-statement">
          <strong>几何：</strong>每条肌肉的作用线比静止姿势短了（暖色）或长了（冷色）多少；不说明肌肉是否在用力。
          <span className="en"> Geometry: how much shorter (warm) or longer (cool) each line of action is than at rest; it says nothing about effort.</span>
        </p>
      )}
      {mode === 'load' && (
        <>
          <p className="activity-statement estimate">
            <strong>估计，不是测量：</strong>身体静止、只受重力{load ? '和手里的重物' : ''}时，保持这个姿势所需的肌肉激活度（静力优化）。看谁在用力，别信百分数；⚠ = 力臂不可靠。
            <span className="en"> An estimate, not a measurement: activations needed to hold this pose still against gravity{load ? ' and the load in the hand' : ''} (static optimisation). Read who works, not the percentages; ⚠ = unreliable moment arm.</span>
          </p>
          <div className="activity-options">
            <label>
              重力 <span className="en">Gravity</span>{' '}
              <select value={gravity} onChange={(e) => act.setGravity(e.target.value as GravityMode)} aria-label="重力方向 / gravity direction">
                {GRAVITY.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.zh} {g.en}
                  </option>
                ))}
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={!!load} onChange={(e) => setLoad(e.target.checked ? {} : null)} />
              手持重物 <span className="en">Holding</span>
            </label>
            {load && (
              <>
                <select value={load.kg} onChange={(e) => setLoad({ kg: Number(e.target.value) })} aria-label="重物质量 / load mass">
                  {[1, 2, 5, 10].map((kg) => (
                    <option key={kg} value={kg}>
                      {kg} kg
                    </option>
                  ))}
                </select>
                <select value={load.side} onChange={(e) => setLoad({ side: e.target.value as HandLoad['side'] })} aria-label="哪只手 / which hand">
                  <option value="B">两手各持 each hand</option>
                  <option value="L">左手 left</option>
                  <option value="R">右手 right</option>
                </select>
              </>
            )}
          </div>
          {bal && (
            <p className={`hint${bal.offsetM > 0.01 ? ' activity-warn' : ''}`}>
              {bal.feet.length === 2 ? '双脚着地' : bal.feet.length === 1 ? `${bal.feet[0] === 'L' ? '左' : '右'}脚单脚着地` : '没有脚着地'}，体重 {Math.round(bal.weightN / 9.81)} kg
              {bal.offsetM > 0.01 ? `；⚠ 重心投影在支撑面${bal.offsetDir[1] < 0 ? '后方' : '前方'}约 ${Math.round(bal.offsetM * 100)} cm，这个姿势站不住，下肢和躯干的估计只是"假如有人扶着"` : '；重心落在支撑面内'}。
              <span className="en">
                {' '}
                {bal.feet.length === 2 ? 'Both feet' : bal.feet.length === 1 ? `${bal.feet[0] === 'L' ? 'Left' : 'Right'} foot only` : 'No foot'} on the ground, {Math.round(bal.weightN / 9.81)} kg
                {bal.offsetM > 0.01 ? `; ⚠ the centre of mass is about ${Math.round(bal.offsetM * 100)} cm ${bal.offsetDir[1] < 0 ? 'behind' : 'in front of'} the support: the posture cannot be held, and the estimate for legs and trunk is "as if someone steadied the body"` : '; centre of mass over the support'}.
              </span>
            </p>
          )}
          {!bal && snap?.result.solved && gravity !== 'stand' && (
            <p className="hint">
              卧位：骨盆和没有摆动过的肢体由床面托住，只有抬起来的那一串关节需要肌肉。 <span className="en">Lying: the pelvis and unmoved limbs rest on the couch; only lifted chains need muscle.</span>
            </p>
          )}
        </>
      )}

      {snap && mode !== 'off' && (
        <>
          <ul className="activity-list">
            {shown.map(({ i, value }) => {
              const m = snap.model.muscles[i]!
              const part = graph.part(m.part)
              const name = part ? graph.partName(part) : null
              const meta = metaOf.get(m.part)
              const runtime = snap.result.flags[i]!
              const flagged = runtime !== 0 || !!meta?.flags.some((f) => f === 'wrap' || f === 'arm' || f === 'volume')
              const d = snap.result.dRest[i]!, dn = snap.result.dNeutral[i]!
              const contrib = showLoad
                ? snap.model
                    .contributions(i, 2)
                    .map((c) => {
                      const n = unitName(snap.model, c.unit)
                      return `${n.zh.replace(/关节$/, '')}${(c.nm > 0 ? n.pos : n.neg).zh} ${Math.abs(c.nm).toFixed(Math.abs(c.nm) < 10 ? 1 : 0)} N·m`
                    })
                    .join('，')
                : Math.abs(dn - d) > 0.005
                  ? `相对解剖学姿势 ${signed(dn)}`
                  : ''
              const notes = notesFor === m.part ? flagNotes(meta, runtime) : []
              return (
                <li key={m.part}>
                  <button
                    className={`activity-row${selection.set.has(m.part) ? ' selected' : ''}`}
                    title={`${part?.name ?? m.name}${flagged ? '\n⚠ ' + flagNotes(meta, runtime).map((n) => n.zh).join('；') : ''}`}
                    onClick={() => {
                      app.selectParts([m.part])
                      app.requestFocus([m.part])
                      setNotesFor(flagged ? m.part : null)
                    }}
                  >
                    <span className="flag" aria-label={flagged ? '力臂不可靠 / unreliable moment arm' : undefined}>
                      {flagged ? '⚠' : ''}
                    </span>
                    <span className="name">
                      {name?.primary ?? m.name} {name?.zh && <span className="en">{name.en}</span>}
                    </span>
                    <span className="value">{showLoad ? pct(value, value < 0.1 ? 1 : 0) : signed(value)}</span>
                    <span className="bar">
                      <i style={showLoad ? { width: `${Math.max(2, loadLevel(value, full) * 100)}%`, background: rampCss(LOAD_RAMP, loadLevel(value, full)) } : { width: `${Math.max(2, Math.abs(lengthLevel(value)) * 100)}%`, background: rampCss(LENGTH_RAMP, lengthLevel(value)) }} />
                    </span>
                    {showLoad ? (
                      <span className="detail">
                        长度 {signed(d)}
                        {contrib ? ` · ${contrib}` : ''}
                      </span>
                    ) : (
                      contrib && <span className="detail">{contrib}</span>
                    )}
                  </button>
                  {notes.length > 0 && (
                    <ul className="activity-flaglist">
                      {notes.map((n, k) => (
                        <li key={k}>
                          ⚠ {n.zh} <span className="en">{n.en}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>
          {rows.length === 0 && <p className="hint">{showLoad ? '没有肌肉的激活度超过 0.3%。' : '没有作用线的长度变化超过 1%：摆一个姿势试试。'} <span className="en">{showLoad ? 'No muscle above 0.3 %.' : 'No line changed by more than 1 %: set a pose.'}</span></p>}
          {rows.length > 14 && (
            <button className="link-btn" onClick={() => setAll(!all)}>
              {all ? '只看前 14 条' : `显示全部 ${rows.length} 条`} <span className="en">{all ? 'top 14 only' : `show all ${rows.length}`}</span>
            </button>
          )}

          {showLoad && (
            <details>
              <summary>
                各关节的力矩：需要 / 肌肉给出 / 残差 <span className="en">Joint torques: required / delivered / residual</span>
              </summary>
              <table className="activity-table">
                <thead>
                  <tr>
                    <th>自由度 dof</th>
                    <th>需要 N·m</th>
                    <th>肌肉</th>
                    <th>残差</th>
                  </tr>
                </thead>
                <tbody>
                  {units.slice(0, 40).map((u) => {
                    const r = snap.result
                    const n = unitName(snap.model, u)
                    const req = r.required[u]!
                    const st = r.status[u]!
                    const res = r.residual[u]!
                    const bad = st === DofStatus.NoMuscle || Math.abs(res) > Math.max(0.3, 0.1 * Math.abs(req))
                    return (
                      <tr key={u} title={`${n.en} · ${(req > 0 ? n.pos : n.neg).en}`}>
                        <td>
                          {n.zh} · {(req > 0 ? n.pos : n.neg).zh}
                        </td>
                        <td>{Math.abs(req).toFixed(1)}</td>
                        {st === DofStatus.Limit ? (
                          <td colSpan={2} className="note">
                            关节到头，被动承担 passive (end of range)
                          </td>
                        ) : (
                          <>
                            <td>{st === DofStatus.NoMuscle ? '—' : Math.abs(r.delivered[u]!).toFixed(1)}</td>
                            <td className={bad ? 'bad' : ''}>{st === DofStatus.NoMuscle ? `${Math.abs(req).toFixed(1)} 无肌肉` : Math.abs(res) < 0.05 ? '0' : Math.abs(res).toFixed(1)}</td>
                          </>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="hint">
                残差是肌肉给不出、由"备用执行器"补上的力矩：残差大的关节上估计不可信。肩带（胸锁、肩锁）、胸椎、肋和距下关节不参与平衡；腰椎、颈椎各按一段平衡。
                <span className="en"> The residual is torque the muscles cannot deliver and a reserve actuator supplies: where it is large the estimate is not credible. The shoulder girdle, thoracic spine, ribs and subtalar joint are not balanced; the lumbar and cervical spine are each balanced as one stretch.</span>
              </p>
            </details>
          )}
          {snap.data && (
            <details>
              <summary>
                方法、假设和局限（{snap.data.cautions.length} 条） <span className="en">Method, assumptions and limits</span>
              </summary>
              <CautionList items={snap.data.cautions} />
              <p className="hint">
                {snap.data.muscles.filter((m) => m.fmaxN > 0).length} 条肌肉参与负荷估计，{snap.data.muscles.filter((m) => !(m.fmaxN > 0)).length} 条只显示长度（面部、咽、肋间、带动肩带的肌肉），{snap.data.excluded.length} 个肌肉部件没有作用线。体重 {snap.data.mass.bodyKg} kg（默认体型）。最近一次求值 {snap.ms.toFixed(1)} ms。
                <span className="en">
                  {' '}
                  {snap.data.muscles.filter((m) => m.fmaxN > 0).length} muscles take part in the load estimate, {snap.data.muscles.filter((m) => !(m.fmaxN > 0)).length} show length only (facial, pharyngeal, intercostal, girdle muscles) and {snap.data.excluded.length} muscle parts have no line. Body mass {snap.data.mass.bodyKg} kg at the default shape. Last evaluation {snap.ms.toFixed(1)} ms.
                </span>
              </p>
            </details>
          )}
        </>
      )}
    </section>
  )
}
