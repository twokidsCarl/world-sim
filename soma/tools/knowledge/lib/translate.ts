// 组合式英译中（简体）翻译器，用于 FMA 风格的解剖学名称。
// 这是机器翻译：手写词表（tools/knowledge/lexicon/，遵循大陆《人体解剖学名词》用法）加少量结构规则。
// 这里产生的内容都没有经过医学专业人员审核，调用方必须如实标注。
//
// Compositional English -> Simplified Chinese translator for FMA-style anatomical names.
//
// This is MACHINE TRANSLATION: a hand-written lexicon (tools/knowledge/lexicon/) that follows
// mainland usage (《人体解剖学名词》 style) plus a handful of structural rules. Nothing produced
// here has been reviewed by a medical professional; callers must label it as such.
import { MODIFIERS } from '../lexicon/modifiers.ts'
import { TERMS } from '../lexicon/terms.ts'

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6,
  seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
}
const ZH_NUM = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 }

const PLURALS: [RegExp, string][] = [
  [/arteries$/, 'artery'],
  [/vertebrae$/, 'vertebra'],
  [/branches$/, 'branch'],
  [/veins$/, 'vein'],
  [/hairs$/, 'hair'],
  [/organs$/, 'organ'],
  [/parts$/, 'part'],
  [/regions$/, 'region'],
  [/clusters$/, 'cluster'],
  [/nodes$/, 'node'],
  [/nerves$/, 'nerve'],
  [/ligaments$/, 'ligament'],
  [/components$/, 'component'],
]

const SIDED_PART_HEADS = /(branch|branches|trunk|lobe|cusp|leaflet|division|tributary|wall|side|limb|duct)$/

export interface Translator {
  /**
   * 名称中任何一部分超出词表和规则时返回 undefined。
   * Returns undefined when any piece of the name is outside the lexicon and rules.
   */
  translate(name: string): string | undefined
  /**
   * 该名称是否为词表中的完整词条（而非组合得到）。
   * Whether the name is a whole lexicon term (pure lexicon hit rather than composed).
   */
  isLexiconTerm(name: string): boolean
  /**
   * 见实现中的 `exact`：整词命中词表，只允许侧别 / “set of” / 序数的包装。
   * See `exact` in the implementation: a whole-term lexicon hit, modulo side / set / ordinal.
   */
  exact(name: string): string | undefined
}

/**
 * @param subTerm 可选：按完整英文词查询已知中文名（如 Wikidata 标签），仅用于词表未覆盖的片段。
 * @param subTerm optional lookup of an already-known zh name for an exact English term
 *                (e.g. a Wikidata label); used only for pieces the lexicon does not cover.
 */
export function createTranslator(subTerm: (en: string) => string | undefined = () => undefined): Translator {
  const memo = new Map<string, string | undefined>()

  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

  function t(raw: string, depth = 0): string | undefined {
    const name = norm(raw)
    if (memo.has(name)) return memo.get(name)
    const out = depth > 12 ? undefined : compute(name, depth + 1)
    memo.set(name, out)
    return out
  }

  function compute(name: string, d: number): string | undefined {
    if (name in TERMS) return TERMS[name]
    // 整词词条（允许侧别 / set of / 序数包装）优先于逐段组合
    // a whole lexicon term (modulo side / set of / ordinal) beats piecewise composition
    const whole = exact(name)
    if (whole) return whole
    const known = subTerm(name)
    if (known) return known
    let m: RegExpExecArray | null

    // “(in-vivo)” 一类的限定语
    // "(in-vivo)" style qualifiers
    if ((m = /^(.*) \((in[- ]vivo)\)$/.exec(name))) {
      const x = t(m[1]!, d)
      return x && `${x}（活体）`
    }

    // 结尾括号里的限定语：“nail plate (foot)” -> 甲板（足）
    // Trailing parenthetical qualifier: "nail plate (foot)" -> 甲板（足）
    if ((m = /^(.+) \(([^()]+)\)$/.exec(name))) {
      const x = t(m[1]!, d)
      const q = x && t(m[2]!, d)
      if (x && q) return `${x}（${q}）`
    }

    const direct = structural(name, d)
    if (direct) return direct

    // 侧别兜底：恰有一个侧别词且其余部分可译 -> 加 左/右 前缀。
    // （在结构规则之后运行，使 “left hepatic artery” 这类词表词条优先。）
    // Laterality fallback: exactly one side word and the rest is translatable -> 左/右 prefix.
    // (Runs after the structural rules so lexicon terms such as "left hepatic artery" win.)
    const sides = name.match(/\b(left|right)\b/g) ?? []
    if (sides.length === 1) {
      const zhSide = sides[0] === 'left' ? '左' : '右'
      // “right branch of portal vein”：侧别属于局部而非整体 -> 门静脉右支
      // "right branch of portal vein": the side belongs to the part, not the whole -> 门静脉右支
      const ofAt = name.indexOf(' of ')
      // 仅用于在同一整体内本身分左右的局部（支、叶、瓣尖……）；
      // “left superficial part of tibial collateral ligament” 指左侧韧带的局部。
      // Only for parts that are themselves left/right within one whole (branch, lobe, cusp ...);
      // "left superficial part of tibial collateral ligament" is the left ligament's part.
      if (ofAt > 0 && /\b(left|right)\b/.test(name.slice(0, ofAt)) && SIDED_PART_HEADS.test(name.slice(0, ofAt))) {
        const a = norm(name.slice(0, ofAt).replace(/\b(left|right)\b/, ''))
        const tb = t(name.slice(ofAt + 4), d)
        const ta = tb && a ? (a === 'branch' ? '支' : a === 'trunk' ? '干' : headPhrase(a, d)) : undefined
        if (ta && tb) return tb + zhSide + ta
      }
      const rest = norm(name.replace(/\b(left|right)\b/, ''))
      const x = rest ? t(rest, d) : undefined
      if (x) return zhSide + x
    }
    return undefined
  }

  function structural(name: string, d: number): string | undefined {
    let m: RegExpExecArray | null
    // 恒牙 / Permanent teeth, e.g. "upper first secondary molar tooth".
    if ((m = /^(?:(upper|lower) )?(?:(central|lateral|first|second|third) )?secondary (incisor|canine|premolar|molar) tooth$/.exec(name))) {
      const jaw = m[1] === 'upper' ? '上颌' : m[1] === 'lower' ? '下颌' : ''
      const kind = { incisor: '切牙', canine: '尖牙', premolar: '前磨牙', molar: '磨牙' }[m[3]!]!
      const pos = m[2]
      if (pos === 'central') return `${jaw}恒中切牙`
      if (pos === 'lateral') return `${jaw}恒侧切牙`
      if (pos) return `${jaw}第${ZH_NUM[ORDINALS[pos]!]}恒${kind}`
      return `${jaw}恒${kind}`
    }

    // “articular capsule of knee joint” -> 膝关节囊（而不是 膝关节关节囊）；指甲/趾甲按指（趾）命名
    // "articular capsule of knee joint" -> 膝关节囊 (not 膝关节关节囊); nails by digit
    if ((m = /^(?:articular |joint )?capsule of (.+)$/.exec(name))) {
      const j = t(m[1]!, d)
      if (j?.endsWith('关节')) return `${j}囊`
    }
    if ((m = /^nail of (.+)$/.exec(name))) {
      const digit = t(m[1]!, d)
      return digit && `${digit}${/toe/.test(m[1]!) ? '趾甲' : '指甲'}`
    }

    // 带序号的脊神经节 / Numbered spinal ganglia: "eighth cervical spinal ganglion" -> 第8颈神经脊神经节
    if ((m = /^(\w+) (cervical|thoracic|lumbar|sacral) spinal ganglion$/.exec(name)) && ORDINALS[m[1]!]) {
      const seg = { cervical: '颈', thoracic: '胸', lumbar: '腰', sacral: '骶' }[m[2]!]!
      return `第${ORDINALS[m[1]!]}${seg}神经脊神经节`
    }

    // “nerve(s) to X [and Y]” -> X[和Y]神经 / "nerve(s) to X [and Y]" -> X[和Y]神经
    if ((m = /^nerves? to (.+?)(?: and (.+))?$/.exec(name))) {
      const a = t(m[1]!, d)
      const b = m[2] ? t(m[2], d) : ''
      return a && b !== undefined ? `${a}${b ? `和${b}` : ''}神经` : undefined
    }

    // 淋巴结群，以及 “X node(s)” 的简写
    // Lymph node groups and the "X node(s)" shorthand
    if ((m = /^(.+) lymph node group$/.exec(name))) {
      const x = t(`${m[1]} lymph node`, d) ?? t(`${m[1]} lymph nodes`, d)
      return x && `${x}群`
    }
    if ((m = /^(.+) nodes?$/.exec(name)) && !/lymph$/.test(m[1]!)) {
      const x = t(`${m[1]} lymph node`, d)
      if (x) return x
    }

    if ((m = /^set of (.+)$/.exec(name))) {
      const inner = m[1]!
      const direct = t(inner, d)
      if (direct) return direct
      for (const [re, sing] of PLURALS) {
        // 把中心名词变为单数：第一个 “ of ” 之前的最后一个词，或整个短语的最后一个词
        // singularise the head noun: the last word before the first " of ", or the last word
        const [head, ...tail] = inner.split(' of ')
        if (re.test(head!)) {
          const x = t([head!.replace(re, sing), ...tail].join(' of '), d)
          if (x) return x
        }
      }
      return undefined
    }

    if (!name.includes(' of ') && (m = /^(.+) proper$/.exec(name))) {
      const x = t(m[1]!, d)
      return x && `${x}固有部`
    }

    if ((m = /^communicating branch of (.+) with (.+)$/.exec(name))) {
      const a = t(m[1]!, d)
      const b = t(m[2]!, d)
      return a && b && `${a}与${b}的交通支`
    }
    if ((m = /^branch of (.+?) to (.+)$/.exec(name))) {
      const a = t(m[1]!, d)
      const b = t(m[2]!, d)
      return a && b && `${a}至${b}支`
    }

    // 指（趾）骨：手指用 指骨，足趾用 趾骨。
    // Phalanges: 指骨 for fingers, 趾骨 for toes.
    if ((m = /^(?:(proximal|middle|distal) )?phalanx of (.+)$/.exec(name))) {
      const digit = t(m[2]!, d)
      if (!digit) return undefined
      const bone = /toe/.test(m[2]!) ? '趾骨' : '指骨'
      const row = m[1] ? { proximal: '近节', middle: '中节', distal: '远节' }[m[1]]! : ''
      return `${digit}${row}${bone}`
    }

    if ((m = /^(deep |superficial )?muscle of (anterior|posterior|lateral|medial) compartment of (.+)$/.exec(name))) {
      const where = t(m[3]!, d)
      const group = { anterior: '前', posterior: '后', lateral: '外侧', medial: '内侧' }[m[2]!]!
      const layer = m[1] ? (m[1].trim() === 'deep' ? '深层' : '浅层') : ''
      return where && `${where}${group}群${layer}肌`
    }

    if ((m = /^(.+) (cervical|thoracic|lumbar) intervertebral symphysis$/.exec(name)) && ORDINALS[m[1]!]) {
      const seg = { cervical: '颈', thoracic: '胸', lumbar: '腰' }[m[2]!]!
      return `第${ORDINALS[m[1]!]}${seg}椎椎间联合`
    }

    if ((m = /^hepatovenous segment ([ivx]+)$/.exec(name)) && ROMAN[m[1]!]) {
      return `肝静脉段${m[1]!.toUpperCase()}`
    }
    if ((m = /^myocardial zone (\d+)$/.exec(name))) return `心肌第${m[1]}区`

    // “first lumbrical of foot”：序数词加完整词表词条。
    // "first lumbrical of foot": ordinal in front of a whole lexicon term.
    if ((m = /^(\w+) (.+)$/.exec(name)) && ORDINALS[m[1]!] && m[2]! in TERMS) return `第${ORDINALS[m[1]!]}${TERMS[m[2]!]}`

    // “A of B” -> B + A（中文里整体在前）。在第一个 “ of ” 处切分。
    // "A of B" -> B + A (the whole comes first in Chinese). Split at the first " of ".
    const ofAt = name.indexOf(' of ')
    if (ofAt > 0) {
      const a = name.slice(0, ofAt)
      const b = name.slice(ofAt + 4)
      const tb = t(b, d)
      if (tb && a === 'branch') return `${tb}分支`
      if (tb && a === 'trunk') return `${tb}干` // 血管/神经的“干”，不是躯干 / vessel/nerve trunk, not the body region
      const ta = tb && headPhrase(a, d)
      if (ta && tb) return tb + ta
      return undefined
    }

    const whole = headPhrase(name, d)
    if (whole) return whole
    if (name.endsWith(' muscle')) {
      const x = t(name.slice(0, -7), d)
      if (x?.endsWith('肌')) return x
    }
    return undefined
  }

  /**
   * [序数] [修饰语...] 名词短语，其中名词短语取词表中能匹配的最长后缀。
   * [ordinal] [modifiers...] noun-phrase, where the noun phrase is the longest lexicon suffix.
   */
  function headPhrase(phrase: string, d: number): string | undefined {
    if (phrase in TERMS) return TERMS[phrase]
    const known = subTerm(phrase)
    if (known) return known
    const words = phrase.split(' ')
    if (words.length > 1 && ORDINALS[words[0]!]) {
      const rest = headPhrase(words.slice(1).join(' '), d)
      return rest && `第${ORDINALS[words[0]!]}${rest}`
    }
    for (let i = 1; i < words.length; i++) {
      const noun = words.slice(i).join(' ')
      const tn = noun in TERMS ? TERMS[noun] : subTerm(noun)
      if (!tn) continue
      const mods = words.slice(0, i).map((w) => MODIFIERS[w])
      if (mods.every((x) => x !== undefined)) return mods.join('') + tn
    }
    return undefined
  }

  /**
   * 建立在一个完整词表词条之上的译名，只允许不改变词条本身的包装：侧别词、“set of”、序数或带序号的规则。
   * 大陆用语优先策略把它视为“确切、可信”的词表词条。
   *
   * A translation that rests on one whole lexicon term, allowing only wrappers that cannot change
   * the term itself: a side word, "set of", an ordinal, or a numbered-level rule. This is what
   * the mainland-wording policy treats as an "exact, confident" lexicon entry.
   */
  function exact(raw: string): string | undefined {
    const direct = exactCore(norm(raw))
    if (direct) return direct
    // “right infraspinatus muscle”：词表按不带 muscle 的拉丁式名称收录肌肉
    // "right infraspinatus muscle": the lexicon lists muscles by their bare Latin-style name
    const bare = norm(raw).replace(/ muscle$/, '')
    const viaBare = bare !== norm(raw) ? exactCore(bare) : undefined
    return viaBare?.endsWith('肌') ? viaBare : undefined
  }

  function exactCore(raw: string): string | undefined {
    let name = raw
    if (name in TERMS) return TERMS[name]
    const sides = name.match(/\b(left|right)\b/g) ?? []
    let prefix = ''
    if (sides.length === 1) {
      const stripped = norm(name.replace(/\b(left|right)\b/, ''))
      // 仅当侧别词位于名称开头，或去掉侧别后本身就是词条时
      // only when the side leads the name or the stripped name is itself a term
      if (!(stripped in TERMS) && !/^(left|right) /.test(name) && !/^set of (left|right) /.test(name)) return undefined
      prefix = sides[0] === 'left' ? '左' : '右'
      name = stripped
      if (name in TERMS) return prefix + TERMS[name]
    } else if (sides.length > 1) return undefined
    let m: RegExpExecArray | null
    if ((m = /^set of (.+)$/.exec(name))) {
      const inner = m[1]!
      if (inner in TERMS) return prefix + TERMS[inner]
      for (const [re, sing] of PLURALS) {
        const one = inner.replace(re, sing)
        if (one !== inner && !inner.includes(' of ') && one in TERMS) return prefix + TERMS[one]
      }
      return undefined
    }
    if ((m = /^(\w+) (cervical|thoracic|lumbar|sacral) spinal ganglion$/.exec(name)) && ORDINALS[m[1]!]) {
      const g = structural(name, 1)
      return g && prefix + g
    }
    if ((m = /^(\w+) (.+)$/.exec(name)) && ORDINALS[m[1]!] && m[2]! in TERMS) return `${prefix}第${ORDINALS[m[1]!]}${TERMS[m[2]!]}`
    return undefined
  }

  return {
    exact,
    translate: (name) => t(name),
    isLexiconTerm: (name) => norm(name) in TERMS,
  }
}
