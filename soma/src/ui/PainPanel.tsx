// "疼痛反应"面板：强度、起病方式、触发 / 保持、静音；面部动作单元的单独滑块；声音素材的署名。
// The "pain response" panel: intensity, onset, trigger / hold, mute; a slider per facial action
// unit; the attribution of the sound material.

import { useEffect, useState } from 'react'
import { painAUs, pspi } from '../../tools/face/model.ts'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import type { FaceData } from '../face/types.ts'
import { triggerPain } from '../pain/controller.ts'
import { useApp } from '../state/store.ts'
import { CautionList } from './CautionsDialog.tsx'

/** 这个模型是什么、不是什么（界面上必须明说）。 What this model is and is not (must be stated in the UI). */
export const PAIN_STATEMENT: { zh: string; en: string }[] = [
  { zh: '这是疼痛行为（表情与发声）的计算模型，用于教学。被模拟的身体没有主观体验，不会“感到”疼。', en: 'This is a computational model of pain behaviour (expression and voice) for teaching. The simulated body has no subjective experience and does not “feel” pain.' },
  { zh: '“疼痛强度 → 表情”的数值是本项目的假设，不是测量结果。', en: 'The numbers mapping pain intensity to expression are assumptions of this project, not measurements.' },
  { zh: '声音来自演员按指令表演的录音（或参数合成），不是真实疼痛时的录音。', en: 'The sounds are recordings acted on instruction (or parametric synthesis), not recordings of real pain.' },
]

/** VIVAE 录音包的署名（全文见 voice/vivae-pain/ATTRIBUTION.txt）。 Attribution of the VIVAE sound pack (full text in voice/vivae-pain/ATTRIBUTION.txt). */
export function VoiceAttribution({ compact = false }: { compact?: boolean }) {
  const url = `${import.meta.env.BASE_URL}voice/vivae-pain/ATTRIBUTION.txt`
  if (compact) {
    return (
      <span className="voice-attrib">
        声音：VIVAE 语料（Holz、Larrouy-Maestri、Poeppel），CC BY-NC 4.0，<strong>仅限非商业使用</strong>；演员表演，经重采样。{' '}
        <span className="en">
          Sound: VIVAE corpus, CC BY-NC 4.0, <strong>non-commercial use only</strong>; acted, resampled.
        </span>{' '}
        <a href={url} target="_blank" rel="noreferrer noopener">
          署名全文
        </a>
      </span>
    )
  }
  return (
    <div className="voice-attrib">
      <p>
        <strong>声音素材仅限非商业使用（CC BY-NC 4.0）。</strong> 与本项目的解剖数据和代码分开授权。
        <span className="en"> The sound material is for non-commercial use only (CC BY-NC 4.0), licensed separately from the anatomy data and the code.</span>
      </p>
      <p>
        来源：The Variably Intense Vocalizations of Affect and Emotion Corpus (VIVAE)，Natalie Holz、Pauline Larrouy-Maestri、David Poeppel，Zenodo 2020，{' '}
        <a href="https://zenodo.org/records/4066235" target="_blank" rel="noreferrer noopener">
          DOI 10.5281/zenodo.4066235
        </a>
        。许可：{' '}
        <a href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noreferrer noopener">
          CC BY-NC 4.0
        </a>
        。
      </p>
      <p>
        已改动：只取其中“疼痛”的 185 条，重采样到 24 kHz，并附加了本项目的分析数据；男声由女声录音变调得到。这些是按指令表演的发声；原作者没有为本项目背书。
        <span className="en"> Modified: only the 185 pain items, resampled to 24 kHz, with this project's own analysis added; the male voice is derived from the female recordings. These are acted vocalisations; the authors do not endorse this project.</span>
      </p>
      <p>
        <a href={url} target="_blank" rel="noreferrer noopener">
          署名与改动说明全文 Full attribution
        </a>
      </p>
    </div>
  )
}

/**
 * 正对面部的相机位置：目标取两眼与口裂之间，相机在正前方约半米。
 * A camera facing the face: the target lies between the eyes and the oral fissure, the camera
 * about half a metre straight in front.
 */
export function faceCamera(data: FaceData): { p: [number, number, number]; t: [number, number, number] } {
  const lm = data.landmarks
  const eyes = lm.eyes.map((e) => e.globe)
  const eyeY = eyes.length ? eyes.reduce((a, g) => a + g[1], 0) / eyes.length : lm.stomionY.skin + 0.07
  const eyeZ = eyes.length ? eyes.reduce((a, g) => a + g[2], 0) / eyes.length : 0.1
  const t: [number, number, number] = [lm.midX, (eyeY + lm.stomionY.skin) / 2, eyeZ]
  return { p: [t[0] + 0.06, t[1] + 0.02, t[2] + 0.52], t }
}

let presetApplied: AnatomyGraph | null = null

export function PainPanel({ graph }: { graph: AnatomyGraph }) {
  const face = useApp((s) => s.face)
  const status = useApp((s) => s.faceStatus)
  const message = useApp((s) => s.faceMessage)
  const pain = useApp((s) => s.pain)
  const aus = useApp((s) => s.aus)
  const voiceStatus = useApp((s) => s.voiceStatus)
  const voiceProgress = useApp((s) => s.voiceProgress)
  const lastVoice = useApp((s) => s.lastVoice)
  const skinOpaque = useApp((s) => s.skinOpaque)
  const [advanced, setAdvanced] = useState(false)
  const [cautionsOpen, setCautionsOpen] = useState(false)
  const [attribOpen, setAttribOpen] = useState(false)
  const app = useApp.getState()

  const focusFace = (): void => {
    if (!face) return
    const view = faceCamera(face.data)
    useApp.setState((st) => ({ cameraRequest: { nonce: (st.cameraRequest?.nonce ?? 0) + 1, ...view } }))
  }

  // 第一次打开面板：切到肌肉视图并对准面部（皮肤是闭合曲面，眼睑和嘴唇张不开，肌肉上表情读得清）
  // first time the panel opens: switch to the muscle view and frame the face (the skin is a closed
  // surface whose lids and lips cannot part; the expression reads clearly on the muscles)
  useEffect(() => {
    if (!face || presetApplied === graph) return
    presetApplied = graph
    // 只在显示状态还是默认值时套用预设，不覆盖链接或用户已经设好的视图
    // the preset applies only while the display state is still the default; a view set by a link or by the user is left alone
    const st = useApp.getState()
    const untouched = !st.isolated && st.peel === 0 && Object.values(st.systems).every((x) => x.visible)
    if (!untouched) return
    app.setFaceView('muscle')
    focusFace()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [face, graph])

  const statement = (
    <div className="pain-statement">
      {PAIN_STATEMENT.map((s) => (
        <p key={s.en}>
          {s.zh} <span className="en">{s.en}</span>
        </p>
      ))}
    </div>
  )

  if (!face) {
    return (
      <div className="panel-body scroll">
        <section className="group">
          <h3>
            疼痛反应 <span className="en">Pain response</span>
          </h3>
          {statement}
          {(status === 'loading' || status === 'idle') && <p className="hint">正在加载表情数据… Loading the expression data…</p>}
          {(status === 'missing' || status === 'error') && (
            <p className="hint">
              <strong>此人体暂时没有表情数据。</strong> No facial expression data for this body.
              <br />
              {message}
            </p>
          )}
        </section>
      </div>
    )
  }

  const model = face.data.pain
  const score = pspi(model, painAUs(model, pain.level))
  const sex = graph.data.body === 'female' ? '女声' : '男声（由女声录音变调）'

  return (
    <div className="panel-body scroll pain-panel">
      <section className="group">
        <h3>
          疼痛反应 <span className="en">Pain response</span>
        </h3>
        {statement}
        <div className="dof-row">
          <label>
            <span className="dof-name">
              强度 <span className="en">Intensity (0–10)</span>
            </span>
            <span className="value">{pain.level.toFixed(1)}</span>
          </label>
          <input type="range" min={0} max={10} step={0.5} value={pain.level} aria-label="疼痛强度 / pain intensity" onChange={(e) => app.setPain({ level: Number(e.target.value) })} />
        </div>
        <p className="hint" title={`${model.pspi.basis.note.zh}\n${model.pspi.basis.note.en}`}>
          该强度下的 PSPI（Prkachin–Solomon 疼痛强度，0–{model.pspi.max}）：{score.toFixed(1)}
        </p>
        <div className="segmented" role="radiogroup" aria-label="起病方式 / onset">
          <button role="radio" aria-checked={pain.onset === 'sudden'} className={pain.onset === 'sudden' ? 'active' : ''} onClick={() => app.setPain({ onset: 'sudden' })}>
            突发<span className="en">Sudden</span>
          </button>
          <button role="radio" aria-checked={pain.onset === 'sustained'} className={pain.onset === 'sustained' ? 'active' : ''} onClick={() => app.setPain({ onset: 'sustained' })}>
            持续<span className="en">Sustained</span>
          </button>
        </div>
        <div className="actions">
          <button className="primary-btn" disabled={pain.level <= 0} onClick={() => void triggerPain()} title="表情按时间过程出现并消退；未静音时同时发声 / the expression rises and fades over time, with sound unless muted">
            触发 <span className="en">Trigger</span>
          </button>
          <button className={pain.hold ? 'on' : ''} aria-pressed={pain.hold} onClick={() => app.setPain({ hold: !pain.hold })} title="把表情保持在所设强度，便于观察 / hold the expression at the set intensity">
            保持表情
          </button>
          <button className={pain.muted ? 'on' : ''} aria-pressed={pain.muted} onClick={() => app.setPain({ muted: !pain.muted })}>
            {pain.muted ? '已静音' : '静音'}
          </button>
        </div>
        {voiceStatus === 'loading' && (
          <>
            <p className="hint">正在下载声音素材（约 8.6 MB）… {Math.round(voiceProgress * 100)}%</p>
            <div className="loading-bar">
              <div style={{ width: `${Math.round(voiceProgress * 100)}%` }} />
            </div>
          </>
        )}
        {!pain.muted && voiceStatus === 'idle' && <p className="hint">第一次有声触发时会下载声音素材（约 8.6 MB）。 The first unmuted trigger downloads the sound pack (about 8.6 MB).</p>}
        {voiceStatus === 'synthetic' && <p className="hint">没有找到录音包，改用参数合成的声音。 No sound pack found; using the parametric synthesizer.</p>}
        {lastVoice && (
          <p className="hint">
            上一次：{lastVoice.source === 'none' ? `按模型这一次不出声（该强度下出声的概率 ${Math.round(lastVoice.probability * 100)}%）` : `${lastVoice.type} · ${lastVoice.source === 'recorded' ? '录音（演员表演）' : '参数合成'} · ${sex}`}
          </p>
        )}
        <button className="link-btn" aria-expanded={attribOpen} onClick={() => setAttribOpen(!attribOpen)}>
          {attribOpen ? '收起' : '展开'}声音素材的署名 · 仅限非商业使用 <span className="en">Sound attribution · non-commercial only</span>
        </button>
        {attribOpen && <VoiceAttribution />}
      </section>

      <section className="group">
        <h3>
          视图 <span className="en">View</span>
        </h3>
        <div className="actions">
          <button className={!skinOpaque ? 'on' : ''} onClick={() => app.setFaceView('muscle')}>
            肌肉视图
          </button>
          <button className={skinOpaque ? 'on' : ''} onClick={() => app.setFaceView('skin')}>
            皮肤视图
          </button>
          <button onClick={focusFace}>对准面部</button>
        </div>
        <p className="hint">
          目前的皮肤是闭合曲面，眼睑和嘴唇张不开，所以默认看肌肉；皮肤视图里只能看到皱眉、提颊等表面形变。
          <span className="en"> The current skin is a closed surface whose lids and lips cannot part, so muscles are shown by default; the skin view shows only surface deformation such as the brow and cheeks.</span>
        </p>
      </section>

      <section className="group">
        <h3>
          <button className="group-toggle" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
            {advanced ? '▾' : '▸'} 单个动作单元 <span className="en">Single action units (advanced)</span>
          </button>
          {Object.keys(aus).length > 0 && (
            <button className="link-btn" onClick={() => app.clearAUs()}>
              清零
            </button>
          )}
        </h3>
        {advanced &&
          face.data.aus.map((au) => (
            <div className="dof-row" key={au.id}>
              <label title={`${au.name.en}\n${au.basis.note.zh}\n${au.basis.note.en}${au.missing?.length ? `\n模型缺少 / missing: ${au.missing.join(', ')}` : ''}`}>
                <span className="dof-name">
                  {au.id} {au.name.zh}
                  {au.basis.source === null && <span className="badge badge-review">假设</span>}
                </span>
                <span className="value">{(aus[au.id] ?? 0).toFixed(1)}</span>
              </label>
              <input type="range" min={0} max={5} step={0.5} value={aus[au.id] ?? 0} aria-label={`${au.id} ${au.name.zh}`} onChange={(e) => app.setAU(au.id, Number(e.target.value))} />
            </div>
          ))}
        {advanced && <p className="hint">强度 0–5 对应 FACS 的 A–E 级。手动设定的值与疼痛表情逐项取较大者。 Intensities 0–5 are FACS levels A–E; manual values combine with the pain expression by maximum.</p>}
      </section>

      <section className="group">
        <button className="chip chip-warn chip-button" aria-expanded={cautionsOpen} onClick={() => setCautionsOpen(!cautionsOpen)}>
          表情模型的 {face.data.cautions.length} 条局限
        </button>
        {cautionsOpen && (
          <>
            <CautionList items={face.data.cautions} />
            <p className="hint">
              {model.mapping.note.zh} <span className="en">{model.mapping.note.en}</span>
            </p>
            <ul className="skin-sources">
              {face.data.sources.map((s) => (
                <li key={s.id}>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noreferrer noopener">
                      {s.citation}
                    </a>
                  ) : (
                    s.citation
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  )
}
