// "表情"面板：情绪预设和强度、口形（视位）、说一句话（由音素带动口形）、由音频带动口形、逐个动作单元。
// The "Expression" panel: emotion presets with a strength, mouth shapes (visemes), saying something (phoneme-driven), speaking
// from audio, and a slider per action unit.
//
// 这些都经同一个驱动（src/face/driver.ts）与疼痛表情合成；这里只改 store 里的设定。
// All of this is composed with the pain expression by one driver (src/face/driver.ts); this panel only edits settings in the store.

import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { AnatomyGraph } from '../anatomy/graph.ts'
import type { FaceData, FaceExpression } from '../face/types.ts'
import { clearSpeech, loadSpeech, playSpeech, speechTrack, stopSpeech } from '../face/speech.ts'
import { EXPRESSION_STATEMENT, SPEECH_STATEMENT, VISEME_STATEMENT } from '../face/statements.ts'
import { useApp } from '../state/store.ts'
import { AUSliders, focusFace, useFaceViewPreset } from './PainPanel.tsx'
import { SaySection, StyleControl } from './SaySection.tsx'

/** 把表情分成基本和复合两组 / Split the expressions into basic and compound. */
export function groupExpressions(list: readonly FaceExpression[]): { basic: FaceExpression[]; compound: FaceExpression[] } {
  const ids = new Set(list.map((e) => e.id))
  const basic: FaceExpression[] = [], compound: FaceExpression[] = []
  // 复合情绪：数据标了 compoundOf，或者（如"敬畏"）不在六种基本情绪之内 / compound: marked compoundOf in the data, or (as "awed") not among the six basic ones
  const BASIC = ['happy', 'sad', 'fearful', 'angry', 'surprised', 'disgusted']
  for (const e of list) (e.compoundOf?.some((x) => ids.has(x)) || !BASIC.includes(e.id) ? compound : basic).push(e)
  return { basic, compound }
}

const STRIP = { open: '#3ec7d6', round: '#d9a441', closure: '#d9705f' } as const

/** 口形轨迹的小条：整条音轨的开口、圆唇、闭合，加一条播放头。 The strip of the mouth track: opening, rounding and closure over the whole clip, with a playhead. */
function SpeechStrip({ playing }: { playing: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [now, setNow] = useState<{ open: number; round: number; closure: number } | null>(null)
  const name = useApp((s) => s.speech.name)
  const status = useApp((s) => s.speech.status)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let raf = 0
    let lastShown = -1
    const draw = (): void => {
      const tr = speechTrack()
      const g = canvas.getContext('2d')
      if (!g) return
      const w = canvas.width, h = canvas.height
      g.clearRect(0, 0, w, h)
      if (!tr || tr.frames.length === 0) return
      const n = tr.frames.length
      const x = (i: number): number => (i / Math.max(1, n - 1)) * (w - 1)
      // 闭合：底部的短线 / closure: ticks along the bottom
      g.fillStyle = STRIP.closure
      for (let i = 0; i < n; i++) if (tr.frames[i]!.closure >= 0.5) g.fillRect(x(i), h - 5, Math.max(1, w / n), 5)
      const line = (color: string, f: (i: number) => number): void => {
        g.strokeStyle = color
        g.lineWidth = 1
        g.beginPath()
        const step = Math.max(1, Math.floor(n / (w * 2)))
        for (let i = 0; i < n; i += step) {
          const y = (1 - f(i)) * (h - 8) + 1
          if (i === 0) g.moveTo(x(i), y)
          else g.lineTo(x(i), y)
        }
        g.stroke()
      }
      // 圆唇 −1…1 画在中线两侧；开口 0…1 从底往上 / rounding −1…1 about the middle line; opening 0…1 from the bottom up
      line(STRIP.round, (i) => 0.5 + 0.5 * Math.max(-1, Math.min(1, tr.frames[i]!.round)))
      line(STRIP.open, (i) => Math.max(0, Math.min(1, tr.frames[i]!.open)))
      if (tr.time !== null) {
        const i = Math.max(0, Math.min(n - 1, Math.floor(tr.time * 100)))
        g.fillStyle = '#dfe4ea'
        g.fillRect(x(i), 0, 1, h)
        if (i !== lastShown) {
          lastShown = i
          const f = tr.frames[i]!
          setNow({ open: f.open, round: f.round, closure: f.closure })
        }
      }
    }
    const loop = (): void => {
      draw()
      raf = requestAnimationFrame(loop)
    }
    if (playing) loop()
    else {
      draw()
      setNow(null)
    }
    return () => cancelAnimationFrame(raf)
  }, [playing, name, status])
  return (
    <div className="speech-strip">
      <canvas ref={ref} width={300} height={56} role="img" aria-label="口形轨迹：开口、圆唇、闭合 / mouth track: opening, rounding, closure" />
      <div className="speech-legend">
        <span style={{ color: STRIP.open }}>开口 open {now ? now.open.toFixed(2) : '–'}</span>
        <span style={{ color: STRIP.round }}>圆唇 round {now ? now.round.toFixed(2) : '–'}</span>
        <span style={{ color: STRIP.closure }}>闭合 closure {now ? now.closure.toFixed(2) : '–'}</span>
      </div>
    </div>
  )
}

function SpeechSection() {
  const speech = useApp((s) => s.speech)
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const take = (file: File | undefined | null): void => {
    if (file) void loadSpeech(file, file.name)
  }
  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setOver(false)
    take(e.dataTransfer.files[0])
  }
  const has = speech.status === 'ready' || speech.status === 'playing'
  return (
    <section className="group">
      <h3>
        由音频带动口形 <span className="en">Speak from audio</span>
      </h3>
      <div
        className={`speech-drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
      >
        <input
          ref={input}
          type="file"
          accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac"
          aria-label="选择音频文件 / choose an audio file"
          onChange={(e) => {
            take(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <button onClick={() => input.current?.click()}>
          选择音频文件 <span className="en">Choose audio file</span>
        </button>
        <span className="hint">
          或把文件拖到这里 <span className="en">or drop a file here</span>
        </span>
      </div>
      {speech.status === 'analysing' && <p className="hint">正在解码并分析 {speech.name}… Decoding and analysing…</p>}
      {speech.status === 'error' && (
        <p className="hint">
          <strong>无法使用这个文件。</strong> This file cannot be used. {speech.message}
        </p>
      )}
      {has && (
        <>
          <p className="hint">
            {speech.name} · {speech.durationS.toFixed(1)} s{speech.status === 'playing' ? ' · 播放中 playing' : ''}
          </p>
          <div className="actions">
            <button className="primary-btn" onClick={() => void playSpeech()} title="播放声音，口形跟随 / play the sound; the mouth follows">
              {speech.status === 'playing' ? '重播' : '播放'} <span className="en">{speech.status === 'playing' ? 'Replay' : 'Play'}</span>
            </button>
            <button disabled={speech.status !== 'playing'} onClick={() => stopSpeech()}>
              停止 <span className="en">Stop</span>
            </button>
            <button onClick={() => clearSpeech()}>
              移除 <span className="en">Remove</span>
            </button>
          </div>
          {speech.message && <p className="hint">{speech.message}</p>}
          <SpeechStrip playing={speech.status === 'playing'} />
        </>
      )}
      <p className="hint">
        {SPEECH_STATEMENT.zh} <span className="en">{SPEECH_STATEMENT.en}</span>
      </p>
    </section>
  )
}

function ExpressionButtons({ list, data }: { list: FaceExpression[]; data: FaceData }) {
  const expr = useApp((s) => s.expr)
  const setExpr = useApp((s) => s.setExpr)
  const nameOf = (id: string): string => data.expressions?.find((e) => e.id === id)?.name.zh ?? id
  return (
    <div className="expr-grid">
      {list.map((e) => {
        const on = expr?.id === e.id
        const parts = e.compoundOf?.length ? `\n= ${e.compoundOf.map(nameOf).join(' + ')} (${e.compoundOf.join(' + ')})` : ''
        const aus = Object.entries(e.aus)
          .map(([id, v]) => `${id} ${v}`)
          .join(', ')
        return (
          <button
            key={e.id}
            className={on ? 'on' : ''}
            aria-pressed={on}
            title={`${e.name.zh} ${e.name.en}${parts}\n${aus}${e.missing?.length ? `\n模型没有 / not in the model: ${e.missing.join(', ')}` : ''}`}
            onClick={() => setExpr(on ? null : { id: e.id, strength: expr?.strength || 1 })}
          >
            {e.name.zh}
            <span className="en">{e.name.en}</span>
          </button>
        )
      })}
    </div>
  )
}

export function ExpressionPanel({ graph }: { graph: AnatomyGraph }) {
  const face = useApp((s) => s.face)
  const status = useApp((s) => s.faceStatus)
  const message = useApp((s) => s.faceMessage)
  const expr = useApp((s) => s.expr)
  const viseme = useApp((s) => s.viseme)
  const aus = useApp((s) => s.aus)
  const skinOpaque = useApp((s) => s.skinOpaque)
  const pain = useApp((s) => s.pain)
  const [auOpen, setAuOpen] = useState(false)
  const [sourcesOpen, setSourcesOpen] = useState(false)
  const app = useApp.getState()
  useFaceViewPreset(face, graph)

  const statement = (
    <div className="pain-statement">
      {EXPRESSION_STATEMENT.map((s) => (
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
            表情 <span className="en">Expression</span>
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

  const data = face.data
  const expressions = data.expressions ?? []
  const groups = groupExpressions(expressions)
  const visemes = data.visemes?.visemes ?? []
  const current = expr ? expressions.find((e) => e.id === expr.id) : undefined
  const sources = data.sources.filter((s) => ['du2014', 'jali2016', 'articulation-summary', 'scp', 'cmu-facs', 'wikipedia-facs'].includes(s.id))

  return (
    <div className="panel-body scroll pain-panel expr-panel">
      <section className="group">
        <h3>
          情绪表情 <span className="en">Emotion</span>
          {expr && (
            <button className="link-btn" onClick={() => app.setExpr(null)}>
              清除 <span className="en">Clear</span>
            </button>
          )}
        </h3>
        {statement}
        {expressions.length === 0 && <p className="hint">这份表情数据没有情绪原型。 This face data has no emotion prototypes.</p>}
        {groups.basic.length > 0 && (
          <>
            <h4 className="expr-sub">
              基本 <span className="en">Basic ({groups.basic.length})</span>
            </h4>
            <ExpressionButtons list={groups.basic} data={data} />
          </>
        )}
        {groups.compound.length > 0 && (
          <>
            <h4 className="expr-sub">
              复合 <span className="en">Compound ({groups.compound.length})</span>
            </h4>
            <ExpressionButtons list={groups.compound} data={data} />
          </>
        )}
        <div className="dof-row">
          <label>
            <span className="dof-name">
              强度 <span className="en">Strength (0–1)</span>
            </span>
            <span className="value">{(expr?.strength ?? 1).toFixed(2)}</span>
          </label>
          <input type="range" min={0} max={1} step={0.05} value={expr?.strength ?? 1} disabled={!expr} aria-label="表情强度 / expression strength" onChange={(e) => expr && app.setExpr({ id: expr.id, strength: Number(e.target.value) })} />
        </div>
        {current && (
          <p className="hint" title={`${current.basis.note.zh}\n${current.basis.note.en}`}>
            {current.name.zh} <span className="en">{current.name.en}</span>：
            {Object.entries(current.aus)
              .map(([id, v]) => `${id} ${(v * (expr?.strength ?? 1)).toFixed(1)}`)
              .join('、')}
            {current.missing?.length ? `；原型里有而模型没有 / in the prototype but not in the model: ${current.missing.join(', ')}` : ''}
          </p>
        )}
        {(pain.hold || Object.keys(aus).length > 0) && (
          <p className="hint">
            疼痛表情或手动设定的动作单元也在起作用：同一动作单元取较大者。
            <span className="en"> The pain expression or manual action units are active too: the larger value of each unit is used.</span>
          </p>
        )}
      </section>

      <section className="group">
        <h3>
          口形（视位） <span className="en">Mouth shape (viseme)</span>
          {viseme && (
            <button className="link-btn" onClick={() => app.setViseme(null)}>
              松开 <span className="en">Release</span>
            </button>
          )}
        </h3>
        {visemes.length === 0 && <p className="hint">这份表情数据没有视位表。 This face data has no viseme table.</p>}
        {visemes.length > 0 && <StyleControl />}
        <div className="expr-grid viseme-grid">
          {visemes.map((v) => {
            const on = viseme === v.id
            return (
              <button key={v.id} className={on ? 'on' : ''} aria-pressed={on} title={`${v.name.zh} ${v.name.en}\n${v.phonemes.join(' ')}\n${v.basis.note.zh}\n${v.basis.note.en}`} onClick={() => app.setViseme(on ? null : v.id)}>
                {v.name.zh}
                <span className="en">{v.name.en}</span>
              </button>
            )
          })}
        </div>
        <p className="hint">
          共 {visemes.length} 个口形。点一个口形把它保持住，再点一次松开。说话时表情的下半脸减弱，上半脸（眉、眼）不变；闭唇的口形优先于张口的表情，下颌被姿势面板张开时也照样合唇（在唇能合上的范围内）。
          <span className="en">
            {' '}
            {visemes.length} shapes. Click a shape to hold it and again to release. While a mouth shape is held the expression's lower face is attenuated and its upper face (brows, eyes) is unchanged; a lip closure wins over an open-mouthed expression, and the lips still seal when the pose panel has opened the jaw (as far as they can reach).
          </span>
        </p>
        <p className="hint">
          {VISEME_STATEMENT.zh} <span className="en">{VISEME_STATEMENT.en}</span>
        </p>
      </section>

      <SaySection />

      <SpeechSection />

      <section className="group">
        <h3>
          视图 <span className="en">View</span>
        </h3>
        <div className="actions">
          <button className={!skinOpaque ? 'on' : ''} onClick={() => app.setFaceView('muscle')}>
            肌肉视图 <span className="en">Muscles</span>
          </button>
          <button className={skinOpaque ? 'on' : ''} onClick={() => app.setFaceView('skin')}>
            皮肤视图 <span className="en">Skin</span>
          </button>
          <button onClick={() => focusFace(data)}>
            对准面部 <span className="en">Frame face</span>
          </button>
        </div>
      </section>

      <section className="group">
        <h3>
          <button className="group-toggle" aria-expanded={auOpen} onClick={() => setAuOpen(!auOpen)}>
            {auOpen ? '▾' : '▸'} 单个动作单元（{data.aus.length}） <span className="en">Single action units</span>
          </button>
          {Object.keys(aus).length > 0 && (
            <button className="link-btn" onClick={() => app.clearAUs()}>
              清零 <span className="en">Reset</span>
            </button>
          )}
        </h3>
        {auOpen && <AUSliders data={data} />}
      </section>

      <section className="group">
        <button className="link-btn" aria-expanded={sourcesOpen} onClick={() => setSourcesOpen(!sourcesOpen)}>
          {sourcesOpen ? '收起' : '展开'}出处 <span className="en">Sources</span>
        </button>
        <p className="hint">
          动作单元的组合：Du、Tao、Martinez 2014（PNAS）。口形与协同发音的方法：JALI，Edwards 等 2016。<strong>情绪的强度是本项目的假设；视位的数值一部分按实测标定，其余是假设（见上）。</strong>
          <span className="en">
            {' '}
            AU sets: Du, Tao &amp; Martinez 2014 (PNAS). Method for mouth shapes and co-articulation: JALI, Edwards et al. 2016. <strong>Emotion intensities are assumptions of this project; the viseme numbers are partly calibrated against measurements and otherwise assumptions (see above).</strong>
          </span>
        </p>
        {sourcesOpen && (
          <ul className="skin-sources">
            {sources.map((s) => (
              <li key={s.id}>
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noreferrer noopener">
                    {s.citation}
                  </a>
                ) : (
                  s.citation
                )}
                <span className="tag"> {s.license}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
