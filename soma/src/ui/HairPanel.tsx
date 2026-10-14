// 写实模式的毛发控件：发型（无 / 短 / 长，缺省按人体）和发色（按黑色素浓度的几个预设）。
// The lifelike hair controls: style (none / short / long, default by body) and colour (presets by melanin concentration).

import { HAIR_COLOURS, HAIR_COLOUR_LABEL, swatch } from '../hair/colour.ts'
import type { BeardStyle, HairStyle } from '../look/types.ts'
import { useApp } from '../state/store.ts'

const BEARDS: { id: BeardStyle; zh: string; en: string }[] = [
  { id: 'none', zh: '无须', en: 'No beard' },
  { id: 'stubble', zh: '胡茬', en: 'Stubble' },
  { id: 'short', zh: '短须', en: 'Short beard' },
]

const STYLES: { id: HairStyle; zh: string; en: string }[] = [
  { id: 'none', zh: '无', en: 'None' },
  { id: 'short', zh: '短发', en: 'Short' },
  { id: 'long', zh: '长发', en: 'Long' },
]

/** 各人体的默认发型（与 hair.json 的 defaultStyle 一致）/ each body's default style (as defaultStyle in hair.json) */
const BODY_DEFAULT: Record<string, HairStyle> = { male: 'short', female: 'long' }

export function HairPanel() {
  const style = useApp((s) => s.hairStyle)
  const colour = useApp((s) => s.hairColor)
  const dataset = useApp((s) => s.dataset)
  const beard = useApp((s) => s.beard)
  const app = useApp.getState()
  const fallback = BODY_DEFAULT[dataset ?? ''] ?? 'short'
  const current = style ?? fallback
  // 选回这副人体的默认就记成"默认"（URL 里不写）/ picking this body's default again is stored as "default" (not written to the URL)
  const pick = (id: HairStyle): void => app.setHairStyle(id === fallback ? null : id)
  return (
    <div className="hair-controls">
      <div className="segmented" role="radiogroup" aria-label="发型 / Hair style">
        {STYLES.map((s) => (
          <button key={s.id} role="radio" aria-checked={current === s.id} className={current === s.id ? 'active' : ''} onClick={() => pick(s.id)}>
            {s.zh}
            <span className="en">{s.en}</span>
          </button>
        ))}
      </div>
      {/* 胡须只有男性有数据 / only the male has beard data */}
      {dataset === 'male' && (
        <div className="segmented" role="radiogroup" aria-label="胡须 / Facial hair" style={{ marginTop: 6 }}>
          {BEARDS.map((b) => (
            <button key={b.id} role="radio" aria-checked={beard === b.id} className={beard === b.id ? 'active' : ''} onClick={() => app.setBeard(b.id)}>
              {b.zh}
              <span className="en">{b.en}</span>
            </button>
          ))}
        </div>
      )}
      <div role="radiogroup" aria-label="发色 / Hair colour" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, margin: '6px 0' }}>
        {HAIR_COLOURS.map((c) => (
          <button
            key={c}
            role="radio"
            aria-checked={colour === c}
            title={`${HAIR_COLOUR_LABEL[c].zh} / ${HAIR_COLOUR_LABEL[c].en}`}
            onClick={() => app.setHairColor(c)}
            style={{ width: 22, height: 22, borderRadius: 11, background: swatch(c), border: colour === c ? '2px solid #fff' : '1px solid rgba(255,255,255,0.25)', padding: 0, cursor: 'pointer' }}
          />
        ))}
      </div>
    </div>
  )
}
