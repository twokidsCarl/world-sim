// 软组织物理的界面：钝压的"物理按压"（在刺激工具里）、体位与重力（在姿势页里）、嵌入卡片上的控件。
// 每处都写明哪些验证过、哪些没有（文字在 src/softbody/statements.ts）。
// The UI of the soft-tissue physics: the "physics press" of a pressure stimulus (in the stimulus tool), posture and
// gravity (in the Pose tab), and the controls on embed cards. Each states what is validated and what is not (texts in
// src/softbody/statements.ts).

import { useState } from 'react'
import { replayStimulus } from '../pain/stim.ts'
import { useApp } from '../state/store.ts'
import { softAvailable, useSoft, type JobStatus } from '../softbody/client.ts'
import { DISP_FULL_MM, DISP_RAMP, POSTURES, PROBE_LIMITS } from '../softbody/protocol.ts'
import { FEMALE_UNAVAILABLE, POSTURE_CAVEATS, PRESS_CAVEATS, PRESS_VALIDATED, stopText } from '../softbody/statements.ts'

const fmt = (x: number, d = 2): string => (Number.isFinite(x) ? String(Math.round(x * 10 ** d) / 10 ** d) : '—')

const FLAG_TEXT: Record<string, { zh: string; en: string }> = {
  'not-converged': { zh: '力没有稳定（未收敛）', en: 'the force did not settle (not converged)' },
  'force-not-reached:tissue-crushed-or-bottomed-out': { zh: '没有达到要求的力', en: 'the requested force was not reached' },
  'not-finite': { zh: '求解发散', en: 'the solve diverged' },
  'probe-under-resolved': { zh: '压头比三个单元还小，分辨不够', en: 'the probe is smaller than about three cells: under-resolved' },
  'strain-beyond-model-range': { zh: '压应变超过验证过的 0.4', en: 'compressive strain beyond the validated 0.4' },
  'pressure-beyond-validated-range': { zh: '平均压强超过验证过的 45 kPa', en: 'mean pressure beyond the validated 45 kPa' },
  'depth-beyond-60%-of-tissue-thickness': { zh: '深度超过组织厚度的 60%', en: 'depth beyond 60 % of the tissue thickness' },
}

function StatusLine({ status, message, what }: { status: JobStatus; message: string; what: { zh: string; en: string } }) {
  if (status === 'error' || status === 'unavailable')
    return (
      <p className="hint shape-limit">
        <strong>
          {what.zh}没有完成。 {what.en} did not complete.
        </strong>
        <br />
        {message}
      </p>
    )
  if (message) return <p className="hint">{message}</p>
  return null
}

/** 钝压的物理按压：开关、压头、力或深度、结果 / The physics press of a pressure stimulus: switch, probe, force or depth, result. */
export function PressControls() {
  const s = useSoft()
  const graph = useApp((x) => x.graph)
  const avail = softAvailable()
  void graph
  const [more, setMore] = useState(false)
  if (!avail.ok)
    return (
      <p className="hint">
        物理按压不可用：{avail.reason!.zh} <span className="en">Physics press unavailable: {avail.reason!.en}</span>
      </p>
    )
  const r = s.pressResult
  const stop = r ? stopText(r) : null
  const running = s.pressStatus === 'preparing' || s.pressStatus === 'running'
  return (
    <div className="soft-press">
      <label className="check">
        <input type="checkbox" checked={s.pressOn} onChange={(e) => s.setPress({ pressOn: e.target.checked })} />
        物理按压（软组织求解，取代名义的 1 cm² 探头） <span className="en">Physics press (soft-tissue solve, replacing the nominal 1 cm² probe)</span>
      </label>
      {s.pressOn && (
        <>
          <div className="segmented" role="radiogroup" aria-label="压头 / probe">
            {(['sphere', 'flat'] as const).map((k) => (
              <button key={k} role="radio" aria-checked={s.probe.kind === k} className={s.probe.kind === k ? 'active' : ''} onClick={() => s.setPress({ probe: { ...s.probe, kind: k } })}>
                {k === 'sphere' ? '球形压头' : '平头压头'} <span className="en">{k === 'sphere' ? 'sphere' : 'flat punch'}</span>
              </button>
            ))}
          </div>
          <div className="dof-row">
            <label>
              <span className="dof-name">
                半径 <span className="en">Radius</span>
              </span>
              <span className="value">{s.probe.radiusMm} mm</span>
            </label>
            <input type="range" min={PROBE_LIMITS.radiusMm.min} max={PROBE_LIMITS.radiusMm.max} step={0.5} value={s.probe.radiusMm} aria-label="压头半径 / probe radius (mm)" onChange={(e) => s.setPress({ probe: { ...s.probe, radiusMm: Number(e.target.value) } })} />
          </div>
          <div className="segmented" role="radiogroup" aria-label="控制 / control">
            {(['force', 'depth'] as const).map((k) => (
              <button key={k} role="radio" aria-checked={s.control === k} className={s.control === k ? 'active' : ''} onClick={() => s.setPress({ control: k })}>
                {k === 'force' ? '给定力' : '给定深度'} <span className="en">{k === 'force' ? 'force' : 'depth'}</span>
              </button>
            ))}
          </div>
          {s.control === 'force' ? (
            <div className="dof-row">
              <label>
                <span className="dof-name">
                  力 <span className="en">Force</span>
                </span>
                <span className="value">{s.forceN} N</span>
              </label>
              <input type="range" min={0.1} max={10} step={0.1} value={s.forceN} aria-label="力 / force (N)" onChange={(e) => s.setPress({ forceN: Number(e.target.value) })} />
            </div>
          ) : (
            <div className="dof-row">
              <label>
                <span className="dof-name">
                  深度 <span className="en">Depth</span>
                </span>
                <span className="value">{s.depthMm} mm</span>
              </label>
              <input type="range" min={0.5} max={10} step={0.1} value={s.depthMm} aria-label="深度 / depth (mm)" onChange={(e) => s.setPress({ depthMm: Number(e.target.value) })} />
            </div>
          )}
          <p className="hint">
            {PRESS_VALIDATED.zh} <span className="en">{PRESS_VALIDATED.en}</span>
          </p>
          <p className="hint">
            点皮肤后在后台求解（几秒到几十秒），凹陷边算边显示；算完才施加刺激，刺激结束时凹陷回弹。上面的"力"滑块不再起作用。
            <span className="en"> After a click on the skin the solve runs in the background (seconds to tens of seconds) and the dent shows as it forms; the stimulus is applied when it ends, and the dent springs back when the stimulus ends. The "Force" slider above no longer applies.</span>
          </p>
          {running && (
            <p className="hint">
              {s.pressStatus === 'preparing' ? '准备几何和细笼子… Preparing geometry and the fine cage…' : `求解中 Solving · ${s.pressProgress?.frames ?? 0} 帧 frames · ${fmt((s.pressProgress?.elapsedMs ?? 0) / 1000, 1)} s${s.pressProgress?.depthMm != null ? ` · 压头深度 probe depth ${fmt(s.pressProgress.depthMm)} mm` : ''}`}
            </p>
          )}
          <StatusLine status={s.pressStatus} message={s.pressMessage} what={{ zh: '按压', en: 'The press' }} />
          {r && (
            <>
              <dl className="stim-summary soft-result">
                <dt>
                  压入深度 <span className="en">Indentation</span>
                </dt>
                <dd>{fmt(r.depthMm)} mm</dd>
                <dt>
                  到达的力 <span className="en">Force reached</span>
                </dt>
                <dd>
                  {fmt(r.forceN, 3)} N{'forceN' in r.target ? ` / 要求 asked ${fmt(r.target.forceN)} N` : ''}
                </dd>
                <dt>
                  平均接触压强 <span className="en">Mean contact pressure</span>
                </dt>
                <dd>{fmt(r.meanPressureKPa)} kPa · → 疼痛模型 pain model</dd>
                <dt>
                  最大结点压强 <span className="en">Peak nodal pressure</span>
                </dt>
                <dd>{fmt(r.peakPressureKPa)} kPa</dd>
                <dt>
                  接触面积 <span className="en">Contact area</span>
                </dt>
                <dd>{fmt(r.contactAreaMm2, 1)} mm²</dd>
                <dt>
                  轴线最大压应变 <span className="en">Peak axial strain</span>
                </dt>
                <dd>{fmt(r.peakStrain, 3)}</dd>
              </dl>
              {stop && (
                <p className="hint shape-limit">
                  <strong>{stop.zh}</strong> <span className="en">{stop.en}</span>
                </p>
              )}
              {r.flags.length > 0 && (
                <p className="hint">
                  {r.valid ? '' : '超出验证范围或不可靠：'}
                  {r.flags.map((f) => FLAG_TEXT[f]?.zh ?? f).join('；')}
                  <span className="en">
                    {' '}
                    {r.valid ? '' : 'Outside the validated range or unreliable: '}
                    {r.flags.map((f) => FLAG_TEXT[f]?.en ?? f).join('; ')}
                  </span>
                </p>
              )}
              {s.pressTiming && (
                <p className="hint">
                  细笼子 {s.pressTiming.nodes} 结点 / {s.pressTiming.tets} 四面体，单元 {fmt(r.cellMm, 1)} mm；组织厚度 {r.tissueThicknessMm ?? '—'} mm；{r.frames} 帧，{fmt(s.pressTiming.msPerFrame, 1)} ms/帧（{s.pressTiming.backend === 'gpu' ? 'GPU' : 'CPU'}）；第一次看到凹陷 {s.pressTiming.clickToFirstDentMs ?? '—'} ms，结果 {fmt(s.pressTiming.clickToResultMs / 1000, 1)} s。
                  <span className="en">
                    {' '}
                    Fine cage {s.pressTiming.nodes} nodes / {s.pressTiming.tets} tets, cell {fmt(r.cellMm, 1)} mm; tissue {r.tissueThicknessMm ?? '—'} mm; {r.frames} frames at {fmt(s.pressTiming.msPerFrame, 1)} ms ({s.pressTiming.backend === 'gpu' ? 'GPU' : 'CPU'}); first dent shown after {s.pressTiming.clickToFirstDentMs ?? '—'} ms, result after {fmt(s.pressTiming.clickToResultMs / 1000, 1)} s.
                  </span>
                </p>
              )}
            </>
          )}
          <button className="chip chip-warn chip-button" aria-expanded={more} onClick={() => setMore(!more)}>
            物理按压的验证范围与局限 · {PRESS_CAVEATS.length} 条 <span className="en">Validation and limits of the physics press</span>
          </button>
          {more && (
            <ul className="trace-caveats">
              {PRESS_CAVEATS.map((c) => (
                <li key={c.en}>
                  {c.zh} <span className="en">{c.en}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

/** 位移着色的图例（色带与 protocol.ts 的 DISP_RAMP 相同）/ The legend of the displacement colours (the ramp is DISP_RAMP of protocol.ts). */
function DispLegend() {
  const stops = DISP_RAMP.map((s) => `rgb(${s.rgb.map((c) => Math.round(c * 255)).join(',')}) ${s.t * 100}%`).join(', ')
  return (
    <span className="soft-legend">
      相对站立 <span className="en">vs standing</span> 0
      <span className="soft-legend-bar" style={{ background: `linear-gradient(to right, ${stops})` }} />
      {DISP_FULL_MM}+ mm
    </span>
  )
}

/** 体位与重力 / Posture and gravity. */
export function PosturePanel({ compact = false }: { compact?: boolean }) {
  const s = useSoft()
  const graph = useApp((x) => x.graph)
  void graph
  const avail = softAvailable()
  const [more, setMore] = useState(false)
  const busy = s.postureStatus === 'preparing' || s.postureStatus === 'running' || s.postureStatus === 'paused'
  const st = s.postureStats
  const buttons = (
    <div className="segmented soft-postures" role="radiogroup" aria-label="体位 / posture">
      {POSTURES.map((p) => (
        <button key={p.id} role="radio" disabled={!avail.ok} aria-checked={s.physOn && s.posture === p.id} className={s.physOn && s.posture === p.id ? 'active' : ''} onClick={() => s.setPosture(p.id)} title={p.en}>
          {p.zh}
          {!compact && <span className="en"> {p.en}</span>}
        </button>
      ))}
    </div>
  )
  const progress = busy && (
    <span className={compact ? 'embed-note' : 'hint'}>
      {s.postureStatus === 'preparing' ? '建全身笼子… building the whole-body cage…' : s.postureStatus === 'paused' ? '已暂停（页面隐藏）paused (page hidden)' : `走向平衡 settling · ${s.postureProgress?.frames ?? 0} 帧 frames · ${fmt(s.postureProgress?.msPerFrame ?? 0, 0)} ms/帧 · v_max ${(s.postureProgress?.maxSpeed ?? 0).toExponential(1)} m/s · ${s.postureBackend === 'gpu' ? 'GPU' : 'CPU'}`}
    </span>
  )
  const result = st && s.postureStatus === 'done' && (
    <span className={compact ? 'embed-note' : 'hint'}>
      皮肤相对站立：平均 {fmt(st.skinMeanMm, 1)} mm，最大 {fmt(st.skinMaxMm, 1)} mm（{st.frames} 帧，{fmt(st.msPerFrame, 1)} ms/帧，{st.substeps} 子步，{st.backend === 'gpu' ? 'GPU' : 'CPU'}）· 未与实测对照
      <span className="en">
        {' '}
        skin relative to standing: mean {fmt(st.skinMeanMm, 1)} mm, largest {fmt(st.skinMaxMm, 1)} mm ({st.frames} frames at {fmt(st.msPerFrame, 1)} ms, {st.substeps} substeps, {st.backend === 'gpu' ? 'GPU' : 'CPU'}) · not checked against measurements
      </span>
    </span>
  )
  const legend = s.colorOn && st && s.postureStatus === 'done' && s.posture !== 'standing' && <DispLegend />
  if (compact)
    return (
      <>
        {buttons}
        {progress}
        {result}
        {legend}
        {!avail.ok && <span className="embed-note">{avail.reason!.zh}</span>}
      </>
    )
  return (
    <section className="group soft-posture">
      <h3>
        体位与重力 <span className="en">Posture and gravity</span>
      </h3>
      {avail.ok ? (
        <p className="hint">
          转动重力，全身软组织笼子在后台走到平衡（有 WebGPU 时在 GPU 上，每帧约 8 ms；否则在 CPU 上，每帧约 100 ms；几百帧），然后显示皮肤相对站立的位移。GPU 与 CPU 的约束求解顺序不同，结果在给定的容差内一致（见 README）。骨架保持静止姿势。
          <span className="en"> Gravity is turned and the whole-body soft-tissue cage runs to equilibrium in the background (on the GPU when WebGPU is there, about 8 ms a frame; otherwise on the CPU, about 100 ms a frame; a few hundred frames); then the skin's displacement relative to standing is shown. The GPU solves the constraints in a different order from the CPU; the results agree within the stated tolerance (see the README). The skeleton stays in the rest pose.</span>
        </p>
      ) : (
        <p className="hint shape-limit">
          {avail.reason === FEMALE_UNAVAILABLE ? FEMALE_UNAVAILABLE.zh : avail.reason!.zh} <span className="en">{avail.reason!.en}</span>
        </p>
      )}
      {buttons}
      {progress && <p>{progress}</p>}
      {result && <p>{result}</p>}
      <StatusLine status={s.postureStatus} message={s.postureMessage} what={{ zh: '体位求解', en: 'The posture solve' }} />
      {avail.ok && (
        <label className="check">
          <input type="checkbox" checked={s.exaggerate > 1} onChange={(e) => s.setExaggerate(e.target.checked ? 3 : 1)} />
          位移放大 3 倍显示（只为看清；数字仍是真实大小） <span className="en">Show the displacement ×3 (for visibility only; the numbers stay true-size)</span>
        </label>
      )}
      {avail.ok && (
        <label className="check">
          <input type="checkbox" checked={s.colorOn} onChange={(e) => s.setColorOn(e.target.checked)} />
          皮肤按位移着色（真实大小） <span className="en">Colour the skin by displacement (true size)</span>
        </label>
      )}
      {legend && <p>{legend}</p>}
      <p className="hint shape-limit">
        {POSTURE_CAVEATS[0]!.zh} <span className="en">{POSTURE_CAVEATS[0]!.en}</span>
      </p>
      <button className="chip chip-warn chip-button" aria-expanded={more} onClick={() => setMore(!more)}>
        体位求解的局限 · {POSTURE_CAVEATS.length} 条 <span className="en">Limits of the posture solve</span>
      </button>
      {more && (
        <ul className="trace-caveats">
          {POSTURE_CAVEATS.map((c) => (
            <li key={c.en}>
              {c.zh} <span className="en">{c.en}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 嵌入卡片：phys= 带了按压就显示按压的结果和"再按一次"，带了体位就显示体位按钮 / Embed cards: a press in phys= shows its result and "press again"; physics on shows the posture buttons. */
export function SoftEmbedControls() {
  const s = useSoft()
  if (!s.physOn) return null
  const r = s.pressResult
  const stop = r ? stopText(r) : null
  const running = s.pressStatus === 'preparing' || s.pressStatus === 'running'
  return (
    <>
      {s.pressOn && (
        <>
          <button className="tool-btn" disabled={running} onClick={() => void replayStimulus()} title="在同一部位再按一次 / press again at the same site">
            再按一次 <span className="en">Press again</span>
          </button>
          {running && <span className="embed-note">{s.pressStatus === 'preparing' ? '准备细笼子…' : `求解中 ${s.pressProgress?.frames ?? 0} 帧 · 凹陷 ${fmt(s.pressProgress?.dentMm ?? 0, 1)} mm`}</span>}
          {r && (
            <span className="embed-note">
              {s.probe.kind === 'sphere' ? '球' : '平头'} {s.probe.radiusMm} mm · 深 {fmt(r.depthMm)} mm · {fmt(r.forceN, 2)} N · 平均 {fmt(r.meanPressureKPa, 0)} kPa / 峰 {fmt(r.peakPressureKPa, 0)} kPa{stop ? ' · 压溃闸停住 crush gate stopped it' : ''}
            </span>
          )}
          {(s.pressStatus === 'error' || s.pressStatus === 'unavailable') && <span className="embed-note">{s.pressMessage}</span>}
        </>
      )}
      {(!s.pressOn || s.posture !== 'standing') && <PosturePanel compact />}
    </>
  )
}
