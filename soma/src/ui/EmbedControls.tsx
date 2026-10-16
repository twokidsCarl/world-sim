// 嵌入模式（?embed=1）下舞台上的控件：一行注意事项、按卡片状态给出的少量控件、以及"在完整界面中打开"。
// Controls on the stage in embed mode (?embed=1): a one-line caution notice, a few controls
// chosen from the card's state, and "open full UI".

import { useEffect, useMemo, useState } from 'react'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import { posePresets } from '../anatomy/rig.ts'
import { triggerPain } from '../pain/controller.ts'
import { useApp } from '../state/store.ts'
import { useLumen } from '../lumen/state.ts'
import { currentLink } from '../state/urlSync.ts'
import { CautionList } from './CautionsDialog.tsx'
import { Icon } from './Icon.tsx'
import { VOICE_PACK } from '../pain/build.ts'
import { DISCLAIMER } from '../painmodel/index.ts'
import { replayStimulus } from '../pain/stim.ts'
import { KINDS, kindSpec } from '../pain/stimulus.ts'
import { STIM_CAVEATS } from './StimulusPanel.tsx'
import { enableSaySound, loadDemoClip, loadDemoPacks, playSay, setSayMode, type DemoClip } from '../face/say.ts'
import { EXPRESSION_STATEMENT, SAY_STATEMENT, VISEME_STATEMENT } from '../face/statements.ts'
import { PAIN_STATEMENT, VoiceAttribution } from './PainPanel.tsx'
import { ShapeSlider } from './ShapeControls.tsx'
import { SoftEmbedControls } from './SoftPanels.tsx'
import { useSoft } from '../softbody/client.ts'
import { POSTURE_CAVEATS, PRESS_CAVEATS } from '../softbody/statements.ts'

/** 卡片 URL 带了哪些参数，就显示哪些控件（见 App 中的 embedKeys）。 */
/** Which controls appear follows from which parameters the card URL carried (see embedKeys in App). */
let embedKeys = new Set<string>()
export function setEmbedKeys(keys: Iterable<string>): void {
  embedKeys = new Set(keys)
}

export function EmbedControls({ graph }: { graph: AnatomyGraph }) {
  const [cautionsOpen, setCautionsOpen] = useState(false)
  const flying = useLumen((s) => !!s.fly)
  const peel = useApp((s) => s.peel)
  const section = useApp((s) => s.section)
  const rig = useApp((s) => s.rig)
  const rigStatus = useApp((s) => s.rigStatus)
  const rigProgress = useApp((s) => s.rigProgress)
  const posePreset = useApp((s) => s.posePreset)
  const breathing = useApp((s) => s.breathing)
  const mapMode = useApp((s) => s.skinMapMode)
  const selection = useApp((s) => s.selection)
  const regions = useApp((s) => s.skinRegions)
  const maps = useApp((s) => s.skinMaps)
  const pain = useApp((s) => s.pain)
  const face = useApp((s) => s.face)
  const voiceStatus = useApp((s) => s.voiceStatus)
  const voiceProgress = useApp((s) => s.voiceProgress)
  const skinOpaque = useApp((s) => s.skinOpaque)
  const painCard = embedKeys.has('pain') || embedKeys.has('au')
  // 表情卡片：情绪或口形 / expression cards: an emotion or a mouth shape
  const exprCard = embedKeys.has('expr') || embedKeys.has('vis')
  const expr = useApp((s) => s.expr)
  const viseme = useApp((s) => s.viseme)
  // 说话卡片：一句示范片段。没有手势时无声地循环，"声音"按钮从头带声音播一遍
  // speech cards: one demo clip. Without a gesture it loops silently, and the "sound" button plays it once from the start with audio
  const sayCard = embedKeys.has('say')
  const say = useApp((s) => s.say)
  const speechStyle = useApp((s) => s.speechStyle)
  const [demoClips, setDemoClips] = useState<DemoClip[]>([])
  useEffect(() => {
    if (!sayCard) return
    let cancelled = false
    void loadDemoPacks().then((p) => !cancelled && setDemoClips(p.flatMap((x) => x.clips)))
    return () => {
      cancelled = true
    }
  }, [sayCard])
  const shape = useApp((s) => s.shape)
  const shapeCard = embedKeys.has('shape')
  const shapeStatus = useApp((s) => s.shapeStatus)
  const stimCard = embedKeys.has('stim')
  const stim = useApp((s) => s.stim)
  const stimSettings = useApp((s) => s.stimSettings)
  const stimStatus = useApp((s) => s.stimStatus)
  const stimMessage = useApp((s) => s.stimMessage)
  const app = useApp.getState()
  // 软组织物理的卡片（phys=）：把验证范围放在注意事项的最前 / soft-tissue physics cards (phys=): the validated range comes first among the cautions
  const physOn = useSoft((s) => s.physOn)
  const physPress = useSoft((s) => s.pressOn)
  const physPosture = useSoft((s) => s.posture)
  const softCautions = physOn ? [...(physPress ? [DISCLAIMER, ...PRESS_CAVEATS] : []), ...(physPress && physPosture === 'standing' ? [] : POSTURE_CAVEATS)] : []
  const layers = graph.data.layers
  const cautions = graph.cautions
  const rigCautions = rig && (embedKeys.has('pose') || embedKeys.has('breath')) ? rig.rig.cautions : []
  // 疼痛卡片：把"这是什么模型"的说明放在最前 / pain cards: the statement of what this model is comes first
  const all = [...softCautions, ...(stimCard ? [DISCLAIMER, ...STIM_CAVEATS, ...(stim ? stim.e.trace.caveats : [])] : []), ...(painCard ? PAIN_STATEMENT : []), ...(exprCard || sayCard ? EXPRESSION_STATEMENT : []), ...(sayCard ? [SAY_STATEMENT, VISEME_STATEMENT] : []), ...cautions, ...rigCautions, ...((painCard || exprCard || sayCard) && face ? face.data.cautions : []), ...(shapeCard && shape ? shape.data.cautions : [])]
  // 姿势按钮：静止、卡片指定的预设，再加几个常用的 / pose buttons: rest, the card's preset, and a few common ones
  const presets = useMemo(() => {
    if (!rig) return []
    const list = posePresets(rig.rig.joints)
    const want = ['rest', 'anatomical', 'elbow90', 'shoulderAbd90', 'squat', 'fist']
    return list.filter((p) => want.includes(p.id) || p.id === posePreset).slice(0, 7)
  }, [rig, posePreset])

  let label: string | null = null
  const map = mapMode === 'off' ? undefined : maps?.maps.find((m) => m.id === mapMode)
  if (map && regions.length) label = regions.map((r) => map.regions[r]?.name.zh).filter(Boolean).join('、')
  else if (selection.concept) {
    const c = graph.concept(selection.concept.tree, selection.concept.id)
    if (c) label = graph.conceptName(c).primary
  } else if (selection.ids.length === 1) {
    const p = graph.part(selection.ids[0]!)
    if (p) label = graph.partName(p).primary
  } else if (selection.ids.length > 1) label = `已选择 ${selection.ids.length} 个结构`

  return (
    <>
      {all.length > 0 && (
        <div className={`embed-cautions${cautionsOpen ? ' open' : ''}`}>
          <button aria-expanded={cautionsOpen} onClick={() => setCautionsOpen(!cautionsOpen)}>
            教学示意 · {all.length} 条注意事项 <span className="en">teaching model · {all.length} cautions</span> {cautionsOpen ? '▴' : '▾'}
          </button>
          {cautionsOpen && <CautionList items={all} />}
        </div>
      )}

      {/* 漫游时相机由路径带着走，拖动、缩放都不起作用，提示也就不显示 / in the fly-through the path drives the camera and dragging or zooming does nothing, so the hint is not shown */}
      {!flying && (
        <div className="embed-hint">
          拖动旋转 · 右键、Shift + 拖动或双指滑动平移 · 滚轮或捏合缩放{' '}
          <span className="en">drag to rotate · right-drag, Shift + drag or two-finger swipe to pan · wheel or pinch to zoom</span>
        </div>
      )}

      <div className="embed-strip">
        <button className="tool-btn" onClick={() => app.requestHome()} title="复位视角 Reset view">
          <Icon name="home" /> <span>复位</span>
        </button>
        {embedKeys.has('peel') && layers.length > 1 && (
          <label className="embed-slider" title="逐层剥离 Peel">
            <span>剥离 {layers[Math.min(peel, layers.length - 1)]?.name.zh}</span>
            <input type="range" min={0} max={layers.length - 1} step={1} value={Math.min(peel, layers.length - 1)} aria-label="剥离层数 / peel depth" onChange={(e) => app.setPeel(Number(e.target.value))} />
          </label>
        )}
        {embedKeys.has('cut') && (
          <label className="embed-slider" title="剖切位置 Section position">
            <span>剖切</span>
            <input type="range" min={0} max={1000} step={1} value={Math.round(section.position * 1000)} aria-label="剖切位置 / section position" onChange={(e) => app.setSection({ position: Number(e.target.value) / 1000, enabled: true })} />
          </label>
        )}
        {(embedKeys.has('pose') || embedKeys.has('breath')) && !rig && rigStatus === 'loading' && <span className="embed-note">加载骨架绑定 {Math.round(rigProgress * 100)}%</span>}
        {(embedKeys.has('pose') || embedKeys.has('breath')) && !rig && ['missing', 'stale', 'error'].includes(rigStatus) && <span className="embed-note">此人体暂不能摆姿势 Posing unavailable</span>}
        {embedKeys.has('pose') &&
          presets.map((p) => (
            <button key={p.id} className={`tool-btn${(posePreset ?? 'rest') === p.id ? ' on' : ''}`} title={p.name.en} onClick={() => app.applyPosePreset(p.id)}>
              {p.id === 'rest' ? '静止' : p.name.zh}
            </button>
          ))}
        {embedKeys.has('breath') && rig && (
          <button className={`tool-btn${breathing ? ' on' : ''}`} aria-pressed={breathing} onClick={() => app.setBreathing(!breathing)}>
            呼吸 <span className="en">Breathing</span>
          </button>
        )}
        {embedKeys.has('map') &&
          (
            [
              ['off', '关闭'],
              ['dermatome', '皮节'],
              ['cutaneousNerve', '皮神经'],
            ] as const
          ).map(([id, zh]) => (
            <button key={id} className={`tool-btn${mapMode === id ? ' on' : ''}`} onClick={() => app.setSkinMapMode(id)}>
              {zh}
            </button>
          ))}
        {painCard && face && (
          <>
            <label className="embed-slider" title="疼痛强度 Pain intensity (0–10)">
              <span>强度 {pain.level.toFixed(1)}</span>
              <input type="range" min={0} max={10} step={0.5} value={pain.level} aria-label="疼痛强度 / pain intensity" onChange={(e) => app.setPain({ level: Number(e.target.value) })} />
            </label>
            <button className="tool-btn" disabled={pain.level <= 0} onClick={() => void triggerPain()} title="按时间过程触发一次；未静音时同时发声 / trigger once over time, with sound unless muted">
              触发 <span className="en">Trigger</span>
            </button>
            <button className={`tool-btn${pain.hold ? ' on' : ''}`} aria-pressed={pain.hold} onClick={() => app.setPain({ hold: !pain.hold })}>
              保持
            </button>
            <button className={`tool-btn${pain.muted ? '' : ' on'}`} aria-pressed={!pain.muted} onClick={() => app.setPain({ muted: !pain.muted })} title="声音默认关闭；打开后点“触发”才会出声 / sound is off by default; once on, Trigger plays it">
              {pain.muted ? '声音：关' : '声音：开'}
            </button>
            <button className="tool-btn" onClick={() => app.setFaceView(skinOpaque ? 'muscle' : 'skin')}>
              {skinOpaque ? '看肌肉' : '看皮肤'}
            </button>
            {voiceStatus === 'loading' && <span className="embed-note">下载声音 {Math.round(voiceProgress * 100)}%</span>}
          </>
        )}
        {painCard && !face && <span className="embed-note">加载表情数据…</span>}
        {exprCard && face && (
          <>
            <select
              className="tool-btn"
              value={expr?.id ?? ''}
              aria-label="情绪表情 / emotion expression"
              title="情绪表情（动作单元的组合取自 Du 等 2014；强度是假设）/ emotion expression (AU sets from Du et al. 2014; intensities are assumptions)"
              onChange={(e) => app.setExpr(e.target.value ? { id: e.target.value, strength: expr?.strength || 1 } : null)}
            >
              <option value="">无表情 Neutral</option>
              {(face.data.expressions ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name.zh} {x.name.en}
                </option>
              ))}
            </select>
            {expr && (
              <label className="embed-slider" title="表情强度 Expression strength (0–1)">
                <span>强度 {expr.strength.toFixed(2)}</span>
                <input type="range" min={0} max={1} step={0.05} value={expr.strength} aria-label="表情强度 / expression strength" onChange={(e) => app.setExpr({ id: expr.id, strength: Number(e.target.value) })} />
              </label>
            )}
            <select
              className="tool-btn"
              value={viseme ?? ''}
              aria-label="口形（视位）/ mouth shape (viseme)"
              title="保持一个口形（方法取自 JALI 2016；数值是假设）/ hold one mouth shape (method from JALI 2016; the numbers are assumptions)"
              onChange={(e) => app.setViseme(e.target.value || null)}
            >
              <option value="">口形：静止 Mouth at rest</option>
              {(face.data.visemes?.visemes ?? []).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name.zh} {x.name.en}
                </option>
              ))}
            </select>
            {!painCard && (
              <button className="tool-btn" onClick={() => app.setFaceView(skinOpaque ? 'muscle' : 'skin')}>
                {skinOpaque ? '看肌肉' : '看皮肤'} <span className="en">{skinOpaque ? 'Muscles' : 'Skin'}</span>
              </button>
            )}
          </>
        )}
        {(exprCard || sayCard) && !painCard && !face && <span className="embed-note">加载表情数据… Loading…</span>}
        {sayCard && face && (
          <>
            <select
              className="tool-btn embed-say"
              value={say.source === 'demo' && say.clip ? say.clip : ''}
              aria-label="示范句子 / demo sentence"
              title="换一句示范句子（机器合成的，或 LibriSpeech 的真人朗读，都带音素时间线）/ another demo sentence (machine-synthesized, or real read speech from LibriSpeech, each with a phoneme timeline)"
              onChange={(e) => {
                const id = e.target.value
                if (id) void loadDemoClip(id).then((ok) => ok && playSay({ sound: true }))
              }}
            >
              {!(say.source === 'demo' && say.clip) && <option value="">示范句子 Demo sentence</option>}
              {demoClips.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.recording ? `真人 real · ${c.recording.sex === 'female' ? '女 F' : c.recording.sex === 'male' ? '男 M' : ''}` : c.id} · {c.text}
                </option>
              ))}
            </select>
            {/* 口形由什么带动：同一段声音，按音素（准确）或按音频分析（近似）/ what drives the mouth: the same audio by phoneme (accurate) or by audio analysis (approximate) */}
            {(['phonemes', 'audio'] as const).map((mode) => (
              <button
                key={mode}
                className={`tool-btn${say.mode === mode ? ' on' : ''}`}
                aria-pressed={say.mode === mode}
                onClick={() => setSayMode(mode)}
                title={mode === 'phonemes' ? '按音素时间线：每个音一个口形，双唇音一定合上 / by the phoneme timeline: one shape per sound, bilabials always close' : '对同一段声音做分析：只有开口度可靠 / by analysing the same audio: only the opening is reliable'}
              >
                {mode === 'phonemes' ? '按音素' : '按音频'} <span className="en">{mode === 'phonemes' ? 'By phoneme' : 'By audio'}</span>
              </button>
            ))}
            <button
              className={`tool-btn${say.status === 'playing' && say.sound ? ' on' : ''}`}
              disabled={say.status !== 'ready' && say.status !== 'playing'}
              aria-pressed={say.status === 'playing' && say.sound}
              onClick={() => void enableSaySound()}
              title="带声音从头播一遍（浏览器要有一次点击才允许出声）/ play once from the start with sound (browsers allow sound only after a click)"
            >
              声音 <span className="en">Sound</span>
            </button>
            {(['normal', 'clear'] as const).map((id) => {
              const on = (speechStyle ?? 'normal') === id
              return (
                <button
                  key={id}
                  className={`tool-btn${on ? ' on' : ''}`}
                  aria-pressed={on}
                  onClick={() => app.setSpeechStyle(id)}
                  title={id === 'normal' ? '正常朗读：按实测的切牙开度标定 / read speech: calibrated against measured incisor openings' : '夸张的清晰发音：数值是假设 / exaggerated, clear speech: the numbers are assumptions'}
                >
                  {id === 'normal' ? '正常' : '夸张'} <span className="en">{id === 'normal' ? 'Normal' : 'Clear'}</span>
                </button>
              )
            })}
            {!painCard && !exprCard && (
              <button className="tool-btn" onClick={() => app.setFaceView(skinOpaque ? 'muscle' : 'skin')}>
                {skinOpaque ? '看肌肉' : '看皮肤'} <span className="en">{skinOpaque ? 'Muscles' : 'Skin'}</span>
              </button>
            )}
            {say.status === 'loading' && <span className="embed-note">加载声音… Loading…</span>}
            {say.status === 'error' && <span className="embed-note">{say.message}</span>}
            {say.status === 'playing' && !say.sound && <span className="embed-note">无声播放中，点“声音” playing silently — press Sound</span>}
            {say.status === 'playing' && say.sound && !say.recording && <span className="embed-note">机器合成的声音 machine-synthesized audio</span>}
            {/* 真人录音的署名（CC BY 4.0）一直显示 / the credit of a recording (CC BY 4.0) is always shown */}
            {say.recording && (say.status === 'ready' || say.status === 'playing') && (
              <span className="embed-note" title={`${say.recording.corpus} ${say.recording.utterance} · ${say.recording.book}`}>
                真人朗读 · {say.recording.corpus} 说话人 {say.recording.speaker} · CC BY 4.0 · 时间线为自动对齐 <span className="en">real read speech · speaker {say.recording.speaker} · timeline automatically aligned</span>
              </span>
            )}
          </>
        )}
        {stimCard && (
          <>
            <select
              className="tool-btn"
              value={stimSettings.kind}
              aria-label="刺激种类 / stimulus kind"
              onChange={(e) => {
                app.setStimSettings({ kind: e.target.value as typeof stimSettings.kind })
                void replayStimulus()
              }}
            >
              {KINDS.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.zh} {k.en}
                </option>
              ))}
            </select>
            <button className="tool-btn" disabled={!stim} onClick={() => void replayStimulus()} title="在同一部位再施加一次 / apply again at the same site">
              触发 <span className="en">Trigger</span>
            </button>
            <button className={`tool-btn${pain.muted ? '' : ' on'}`} aria-pressed={!pain.muted} onClick={() => app.setPain({ muted: !pain.muted })} title="声音默认关闭；打开后再点“触发”才会出声 / sound is off by default; once on, Trigger plays it">
              {pain.muted ? '声音：关' : '声音：开'}
            </button>
            {stim && (
              <span className="embed-note">
                {kindSpec(stim.settings.kind).zh} {stim.settings.magnitude} {kindSpec(stim.settings.kind).unit} · {stim.e.trace.region.name.zh} · 到达 {stim.e.peak.intensity.toFixed(1)}/10（若持续 {stim.e.drive.toFixed(1)}）
              </span>
            )}
            {stimStatus === 'loading' && <span className="embed-note">准备模型数据…</span>}
            {stimStatus === 'error' && <span className="embed-note">无法施加刺激：{stimMessage}</span>}
          </>
        )}
        <SoftEmbedControls />
        {shapeCard &&
          shape &&
          shape.data.controls
            .filter((c) => c.id === 'stature' || c.id === 'bmi')
            .map((c) => <ShapeSlider key={c.id} control={c} compact />)}
        {shapeCard && !shape && (shapeStatus === 'missing' || shapeStatus === 'error') && <span className="embed-note">此人体暂时没有体型控制 No body-shape controls for this body</span>}
        {shapeCard && shape && (
          <button className="tool-btn" onClick={() => app.resetShape()}>
            原样
          </button>
        )}
        <a className="tool-btn embed-open" href={currentLink({ embed: false })} target="_blank" rel="noreferrer noopener" onClick={(e) => (e.currentTarget.href = currentLink({ embed: false }))}>
          在完整界面中打开 <span className="en">Open full UI</span>
        </a>
      </div>
      {label && <div className="embed-label">{label}</div>}
      {VOICE_PACK && (painCard || stimCard) && !pain.muted && (
        <div className="embed-attrib">
          <VoiceAttribution compact />
        </div>
      )}
    </>
  )
}
