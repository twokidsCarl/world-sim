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
]

export interface Translator {
  /** Returns undefined when any piece of the name is outside the lexicon and rules. */
  translate(name: string): string | undefined
  /** How the last successful top-level translation was obtained: pure lexicon hit or composed. */
  isLexiconTerm(name: string): boolean
}

/**
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
    const known = subTerm(name)
    if (known) return known
    let m: RegExpExecArray | null

    // "(in-vivo)" style qualifiers
    if ((m = /^(.*) \((in[- ]vivo)\)$/.exec(name))) {
      const x = t(m[1]!, d)
      return x && `${x}（活体）`
    }

    const direct = structural(name, d)
    if (direct) return direct

    // Laterality fallback: exactly one side word and the rest is translatable -> 左/右 prefix.
    // (Runs after the structural rules so lexicon terms such as "left hepatic artery" win.)
    const sides = name.match(/\b(left|right)\b/g) ?? []
    if (sides.length === 1) {
      const zhSide = sides[0] === 'left' ? '左' : '右'
      // "right branch of portal vein": the side belongs to the part, not the whole -> 门静脉右支
      const ofAt = name.indexOf(' of ')
      if (ofAt > 0 && /\b(left|right)\b/.test(name.slice(0, ofAt))) {
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
    // Permanent teeth, e.g. "upper first secondary molar tooth".
    if ((m = /^(?:(upper|lower) )?(?:(central|lateral|first|second|third) )?secondary (incisor|canine|premolar|molar) tooth$/.exec(name))) {
      const jaw = m[1] === 'upper' ? '上颌' : m[1] === 'lower' ? '下颌' : ''
      const kind = { incisor: '切牙', canine: '尖牙', premolar: '前磨牙', molar: '磨牙' }[m[3]!]!
      const pos = m[2]
      if (pos === 'central') return `${jaw}恒中切牙`
      if (pos === 'lateral') return `${jaw}恒侧切牙`
      if (pos) return `${jaw}第${ZH_NUM[ORDINALS[pos]!]}恒${kind}`
      return `${jaw}恒${kind}`
    }

    if ((m = /^set of (.+)$/.exec(name))) {
      const inner = m[1]!
      const direct = t(inner, d)
      if (direct) return direct
      for (const [re, sing] of PLURALS) {
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

    // "first lumbrical of foot": ordinal in front of a whole lexicon term.
    if ((m = /^(\w+) (.+)$/.exec(name)) && ORDINALS[m[1]!] && m[2]! in TERMS) return `第${ORDINALS[m[1]!]}${TERMS[m[2]!]}`

    // "A of B" -> B + A (the whole comes first in Chinese). Split at the first " of ".
    const ofAt = name.indexOf(' of ')
    if (ofAt > 0) {
      const a = name.slice(0, ofAt)
      const b = name.slice(ofAt + 4)
      const tb = t(b, d)
      if (tb && a === 'branch') return `${tb}分支`
      if (tb && a === 'trunk') return `${tb}干` // vessel/nerve trunk, not the body region
      const ta = tb && headPhrase(a, d)
      if (ta && tb) return tb + ta
      return undefined
    }

    return headPhrase(name, d)
  }

  /** [ordinal] [modifiers...] noun-phrase, where the noun phrase is the longest lexicon suffix. */
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

  return {
    translate: (name) => t(name),
    isLexiconTerm: (name) => norm(name) in TERMS,
  }
}
