// "表情"面板里的"说一句话"：语音合成（后端在时）、示范句子、带动方式、正在说的词和音；以及口形和说话共用的风格开关。
// "Say something" in the Expression panel: speech synthesis (when the backend is there), the demo sentences, what drives the
// mouth, the word and sound being spoken; plus the style switch shared by held shapes and speech.
//
// 后端不在时界面照常能用：只是没有输入框，示范句子和"选择音频文件"都还在。合成用的文字只发给同源的 /api/tts，不进 URL。
// Without the backend the UI still works: the text box is simply absent, and the demo sentences and "choose an audio file"
// remain. Text typed for synthesis goes to the same-origin /api/tts only and never into the URL.

import { useEffect, useState } from 'react'
import { enableSaySound, loadDemoClip, loadDemoPacks, loadSynthesized, playSay, primeSaySound, sayClip, sayNow, setSayMode, stopSay, type DemoPack } from '../face/say.ts'
import { SAY_STATEMENT } from '../face/statements.ts'
import { useApp } from '../state/store.ts'
import { ttsAvailable, ttsVoices, type TtsLang, type TtsLimits, type TtsVoice } from '../voice/tts.ts'

export const LANGS: { id: TtsLang; zh: string; en: string }[] = [
  { id: 'en', zh: '英语', en: 'English' },
  { id: 'zh', zh: '普通话', en: 'Mandarin' },
]

/** 输入框里先放着的句子 / the sentences the text box starts with. */
const SAMPLE: Record<TtsLang, string> = { en: 'Bob and Mary bought five blue balloons.', zh: '我们一起去学校吃水果。' }

type Backend = { state: 'checking' } | { state: 'absent' } | { state: 'present'; voices: TtsVoice[]; limits: TtsLimits }

/**
 * 风格开关：缺省（口形按钮用夸张、说话用正常）、正常、夸张。口形按钮和说话共用。
 * The style switch: default (clear for the shape buttons, normal for speech), normal, clear. Shared by the shape buttons and speech.
 */
export function StyleControl() {
  const style = useApp((s) => s.speechStyle)
  const set = useApp.getState().setSpeechStyle
  const options = [
    { id: null, zh: '缺省', en: 'Default', title: '口形按钮用夸张（各口形才分得开），说话用正常 / clear for the shape buttons (so the shapes can be told apart), normal for speech' },
    { id: 'normal', zh: '正常', en: 'Normal', title: '正常朗读：按实测的切牙开度标定，张口只有几毫米 / read speech: calibrated against measured incisor openings, only a few millimetres of opening' },
    { id: 'clear', zh: '夸张', en: 'Clear', title: '夸张 / 清晰发音：校准之前的那套大口形，全部是假设 / exaggerated, clear speech: the wide shapes from before calibration, assumptions throughout' },
  ] as const
  return (
    <>
      <div className="actions say-style" role="group" aria-label="说话的风格 / style of speech">
        <span className="say-label">
          风格 <span className="en">Style</span>
        </span>
        {options.map((o) => (
          <button key={o.en} className={style === o.id ? 'on' : ''} aria-pressed={style === o.id} title={o.title} onClick={() => set(o.id)}>
            {o.zh} <span className="en">{o.en}</span>
          </button>
        ))}
      </div>
      <p className="hint">
        口形按钮和说话共用这个开关。“正常”是实测的朗读开度（开口的 a 切牙也只分开约 5 毫米，多数辅音 1–3 毫米）；“夸张”是放大的清晰发音。缺省时口形按钮用夸张（不然各口形几乎分不开），说话用正常。
        <span className="en">
          {' '}
          The shape buttons and speech share this switch. “Normal” is the measured opening of read speech (even an open a parts the incisors by only about 5 mm, and most consonants by 1–3 mm); “Clear” is enlarged, careful articulation. By default the shape buttons use Clear (the shapes would hardly differ otherwise) and speech uses Normal.
        </span>
      </p>
    </>
  )
}

/** 正在说的词和音：整句的词排成一行，当前的词高亮 / The word and sound being spoken: the sentence's words in a row with the current one highlighted. */
function SayNow() {
  const status = useApp((s) => s.say.status)
  const clipKey = useApp((s) => `${s.say.clip}|${s.say.text}|${s.say.durationS}`)
  const [now, setNow] = useState<{ word: number; phone: string; symbol: string; t: number } | null>(null)
  useEffect(() => {
    if (status !== 'playing') {
      setNow(null)
      return
    }
    let raf = 0
    let key = ''
    const loop = (): void => {
      const n = sayNow()
      const k = n ? `${n.wordIndex}|${n.phone?.t0 ?? -1}|${Math.floor(n.t * 10)}` : ''
      if (k !== key) {
        key = k
        setNow(n ? { word: n.wordIndex, phone: n.phone?.phone ?? '', symbol: n.phone?.symbol ?? '', t: Math.max(0, n.t) } : null)
      }
      raf = requestAnimationFrame(loop)
    }
    loop()
    return () => cancelAnimationFrame(raf)
  }, [status, clipKey])
  const clip = sayClip()
  if (!clip) return null
  return (
    <div className="say-now" aria-live="off">
      <div className="say-words" lang={clip.lang === 'zh' ? 'zh' : 'en'}>
        {clip.words.map((w, i) => (
          <span key={i} className={now?.word === i ? 'on' : ''}>
            {w.text}
          </span>
        ))}
      </div>
      <div className="say-phone" data-testid="say-phone">
        {now ? (
          <>
            {now.t.toFixed(2)} s · 音 <span className="en">sound</span> <strong>{now.phone || '–'}</strong>
            {now.symbol && now.symbol !== now.phone ? ` (${now.symbol})` : ''}
          </>
        ) : (
          <>
            – · 音 <span className="en">sound</span> –
          </>
        )}
      </div>
    </div>
  )
}

export function SaySection() {
  const say = useApp((s) => s.say)
  const [backend, setBackend] = useState<Backend>({ state: 'checking' })
  const [packs, setPacks] = useState<DemoPack[] | null>(null)
  const [lang, setLang] = useState<TtsLang>('en')
  const [text, setText] = useState<Record<TtsLang, string>>(SAMPLE)
  const [voice, setVoice] = useState<Record<TtsLang, string>>({ en: '', zh: '' })
  const [speed, setSpeed] = useState(1)
  const [probe, setProbe] = useState(0)

  useEffect(() => {
    let cancelled = false
    setBackend({ state: 'checking' })
    void (async () => {
      const info = (await ttsAvailable()) ? await ttsVoices() : null
      if (!cancelled) setBackend(info && info.voices.length ? { state: 'present', ...info } : { state: 'absent' })
    })()
    return () => {
      cancelled = true
    }
  }, [probe])
  useEffect(() => {
    let cancelled = false
    void loadDemoPacks().then((p) => !cancelled && setPacks(p))
    return () => {
      cancelled = true
    }
  }, [])

  const present = backend.state === 'present' ? backend : null
  const voices = present ? present.voices.filter((v) => v.lang === lang) : []
  const chosen = voices.find((v) => v.id === voice[lang]) ?? voices.find((v) => v.default) ?? voices[0]
  const limit = present?.limits.maxTextLength ?? 300
  const busy = say.status === 'loading'
  const has = say.status === 'ready' || say.status === 'playing'
  const clips = packs?.flatMap((p) => p.clips) ?? []

  const speak = async (): Promise<void> => {
    // 先在手势里叫醒声音，再等合成 / wake the sound inside the gesture, then wait for the synthesis
    primeSaySound()
    if (await loadSynthesized({ text: text[lang], lang, voice: chosen?.id, speed })) await playSay({ sound: true })
  }
  const pick = async (id: string): Promise<void> => {
    if (!id) return
    primeSaySound()
    if (await loadDemoClip(id)) await playSay({ sound: true })
  }

  return (
    <section className="group say-section">
      <h3>
        说一句话 <span className="en">Say something</span>
      </h3>

      {backend.state === 'checking' && <p className="hint">正在找语音合成服务… Looking for the speech-synthesis service…</p>}
      {backend.state === 'absent' && (
        <p className="hint" data-testid="say-absent">
          <strong>这里没有语音合成服务。</strong>输入文字来合成需要本机的服务（<code>soma/server</code>，由统一入口按需启动，或自己启动，见 README）；下面随附的示范句子和“选择音频文件”不需要它。
          <span className="en">
            {' '}
            <strong>No speech-synthesis service here.</strong> Typing text to synthesize needs the local service (<code>soma/server</code>, started on demand by the single entry point, or by hand — see the README); the shipped demo sentences below and “choose an audio file” work without it.
          </span>{' '}
          <button className="link-btn" onClick={() => setProbe(probe + 1)}>
            再找一次 <span className="en">Check again</span>
          </button>
        </p>
      )}
      {present && (
        <>
          <textarea
            className="say-text"
            rows={2}
            maxLength={limit}
            lang={lang === 'zh' ? 'zh' : 'en'}
            value={text[lang]}
            aria-label={`要说的话，最多 ${limit} 个字符 / the text to speak, at most ${limit} characters`}
            onChange={(e) => setText({ ...text, [lang]: e.target.value })}
          />
          <div className="say-row">
            <label>
              <span>
                语言 <span className="en">Language</span>
              </span>
              <select value={lang} aria-label="语言 / language" onChange={(e) => setLang(e.target.value as TtsLang)}>
                {LANGS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.zh === l.en ? l.en : `${l.zh} ${l.en}`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>
                声音 <span className="en">Voice</span>
              </span>
              <select value={chosen?.id ?? ''} aria-label="声音 / voice" onChange={(e) => setVoice({ ...voice, [lang]: e.target.value })}>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.id} · {v.sex === 'female' ? '女 female' : v.sex === 'male' ? '男 male' : v.sex}
                    {v.default ? ' · 默认 default' : ''}
                  </option>
                ))}
              </select>
            </label>
            <span className="say-count">
              {text[lang].length} / {limit}
            </span>
          </div>
          <div className="dof-row">
            <label>
              <span className="dof-name">
                语速 <span className="en">Speed (×)</span>
              </span>
              <span className="value">{speed.toFixed(2)}</span>
            </label>
            <input type="range" min={present.limits.speed[0]} max={present.limits.speed[1]} step={0.05} value={speed} aria-label="语速倍数 / speaking rate multiplier" onChange={(e) => setSpeed(Number(e.target.value))} />
          </div>
          <p className="hint">
            最多 {limit} 个字符、合成出的声音不超过 {present.limits.maxSeconds} 秒。普通话的句子里不能夹拉丁字母。文字只发给本机的合成服务，不会写进链接。
            <span className="en">
              {' '}
              At most {limit} characters and {present.limits.maxSeconds} s of audio. A Mandarin sentence must not contain Latin letters. The text goes to the local synthesis service only and is never written into the link.
            </span>
          </p>
        </>
      )}

      <div className="actions">
        {present && (
          <button className="primary-btn" disabled={busy || !text[lang].trim()} onClick={() => void speak()} title="合成并说出来，口形按音素走 / synthesize and speak; the mouth follows the phonemes">
            说 <span className="en">Speak</span>
          </button>
        )}
        <button disabled={say.status !== 'playing'} onClick={() => stopSay()}>
          停止 <span className="en">Stop</span>
        </button>
        <button
          disabled={!has}
          onClick={() => {
            primeSaySound()
            void playSay({ sound: true })
          }}
        >
          重播 <span className="en">Replay</span>
        </button>
      </div>

      <label className="say-demo">
        <span>
          示范句子（{clips.length}） <span className="en">Demo sentences</span>
        </span>
        <select value={say.source === 'demo' && say.clip ? say.clip : ''} aria-label="示范句子 / demo sentences" disabled={busy || clips.length === 0} onChange={(e) => void pick(e.target.value)}>
          <option value="">{packs === null ? '正在读取… Loading…' : clips.length ? '选一句来说… Pick one to say…' : '没有找到示范片段 No demo clips found'}</option>
          {LANGS.map((l) => {
            const list = clips.filter((c) => c.lang === l.id)
            return list.length ? (
              <optgroup key={l.id} label={`${l.zh} ${l.en}`}>
                {list.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {c.text}
                  </option>
                ))}
              </optgroup>
            ) : null
          })}
        </select>
      </label>

      {busy && <p className="hint">正在准备声音… Preparing the audio…</p>}
      {say.message && (
        <p className="hint say-error" role="alert">
          {say.message}
        </p>
      )}
      {has && (
        <>
          <p className="say-sentence" lang={say.lang === 'zh' ? 'zh' : 'en'}>
            {say.text}
          </p>
          <p className="hint">
            {say.source === 'demo' ? `${say.clip} · ` : ''}
            {say.voice} · {say.durationS.toFixed(1)} s{say.status === 'playing' ? (say.sound ? ' · 播放中 playing' : ' · 无声播放中 playing silently') : ''}
          </p>
          {say.status === 'playing' && !say.sound && (
            <p className="hint">
              浏览器还没有允许出声（要先有一次点击）：口形按页面时钟无声地走。
              <span className="en"> The browser has not allowed sound yet (it needs a click first): the mouth runs silently on the page clock.</span>{' '}
              <button className="link-btn" onClick={() => void enableSaySound()}>
                打开声音 <span className="en">Sound</span>
              </button>
            </p>
          )}
          <SayNow />
          <div className="actions say-mode" role="group" aria-label="口形由什么带动 / what drives the mouth">
            <span className="say-label">
              带动 <span className="en">Driven</span>
            </span>
            <button className={say.mode === 'phonemes' ? 'on' : ''} aria-pressed={say.mode === 'phonemes'} onClick={() => setSayMode('phonemes')} title="按音素时间线：每个音一个口形，双唇音一定合上 / by the phoneme timeline: one shape per sound, bilabials always close">
              按音素 <span className="en">By phonemes</span>
            </button>
            <button className={say.mode === 'audio' ? 'on' : ''} aria-pressed={say.mode === 'audio'} onClick={() => setSayMode('audio')} title="对同一段声音做分析：只有开口度可靠 / by analysing the same audio: only the opening is reliable">
              按声音分析 <span className="en">By audio analysis</span>
            </button>
          </div>
          <p className="hint">
            同一段声音两种带动方式，可以对比：“按音素”准确（知道每个音是什么）；“按声音分析”是近似（只从声音里猜，和下面“由音频带动口形”同一条路线，不受风格开关影响）。
            <span className="en">
              {' '}
              The same audio driven two ways, for comparison: “By phonemes” is accurate (each sound is known); “By audio analysis” is approximate (guessed from the sound alone — the route of “Speak from audio” below, unaffected by the style switch).
            </span>
          </p>
          {say.warnings.length > 0 && (
            <ul className="say-warnings">
              {say.warnings.map((w, i) => (
                <li key={i}>
                  <strong>{w.word}</strong>：{w.note}
                </li>
              ))}
            </ul>
          )}
          <p className="hint" data-testid="say-model">
            {say.model ? (
              <>
                <strong>机器合成的声音。</strong> <span className="en">Machine-synthesized audio.</span> 模型 <span className="en">Model</span> {say.model.name}
                {say.model.name.includes(say.model.version) ? '' : ` ${say.model.version}`} · 许可 <span className="en">licence</span> {say.model.licence}
              </>
            ) : (
              <>
                录音 <span className="en">Recorded audio</span>
              </>
            )}
            {say.licence ? ` · ${say.licence}` : ''}
          </p>
        </>
      )}
      <p className="hint">
        {SAY_STATEMENT.zh} <span className="en">{SAY_STATEMENT.en}</span>
      </p>
    </section>
  )
}
