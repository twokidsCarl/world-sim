// Unit tests for the knowledge-layer tooling (no network, no raw data needed).
import { describe, expect, it } from 'vitest'
import { plausible, sideOf, stripSide } from '../tools/knowledge/lib/model'
import { pickLatin } from '../tools/knowledge/lib/names'
import { createTranslator } from '../tools/knowledge/lib/translate'
import { cleanWikitext, parseMuscleInfobox } from '../tools/knowledge/lib/wikipedia'

describe('compositional zh translator', () => {
  const t = createTranslator()
  it.each([
    ['long head of biceps brachii', '肱二头肌长头'],
    ['short head of left biceps brachii', '左肱二头肌短头'],
    ['left fifth rib', '左第5肋'],
    ['intervertebral disk of fifth lumbar vertebra', '第5腰椎椎间盘'],
    ['distal phalanx of big toe', '踇趾远节趾骨'],
    ['proximal phalanx of left index finger', '左示指近节指骨'],
    ['left branch of portal vein', '门静脉左支'],
    ['lobe branch of left hepatic artery', '肝左动脉叶支'],
    ['upper first secondary molar tooth', '上颌第一恒磨牙'],
    ['muscle of anterior compartment of forearm', '前臂前群肌'],
    ['trunk of superior mesenteric artery', '肠系膜上动脉干'],
    ['set of thoracic vertebrae', '胸椎'],
    ['tibialis anterior', '胫骨前肌'],
  ])('%s -> %s', (en, zh) => expect(t.translate(en)).toBe(zh))

  it('gives up instead of guessing when a word is unknown', () => {
    expect(t.translate('zygapophyseal frobnicator of thorax')).toBeUndefined()
    expect(t.translate('branch of unknownium artery')).toBeUndefined()
  })

  it('uses an injected source for pieces outside the lexicon', () => {
    const withWd = createTranslator((en) => (en === 'xiphoid process' ? '剑突' : undefined))
    expect(withWd.translate('zone of xiphoid process')).toBe('剑突区')
  })
})

describe('helpers', () => {
  it('detects and strips laterality', () => {
    expect(sideOf('long head of left biceps brachii')).toBe('left')
    expect(sideOf('right lobe branch of right hepatic artery')).toBeUndefined()
    expect(sideOf('femur')).toBeUndefined()
    expect(stripSide('Long head of left biceps brachii')).toBe('long head of biceps brachii')
  })

  it('rejects zh labels of the wrong structure type', () => {
    expect(plausible('deep fibular nerve', '深腓动脉')).toBe(false)
    expect(plausible('deep fibular nerve', '腓深神经')).toBe(true)
    expect(plausible('femur', '股骨')).toBe(true)
  })

  it('picks plain Latin and expands TA abbreviations', () => {
    expect(pickLatin(['artèria aorta o només aorta', 'aorta'])).toBe('Aorta')
    expect(pickLatin([undefined, 'm. rhomboideus major'])).toBe('Musculus rhomboideus major')
    expect(pickLatin(['Vomer (anatomia)'])).toBe('Vomer')
    expect(pickLatin(['pe*e'])).toBeUndefined()
  })
})

describe('Wikipedia infobox parsing', () => {
  const wikitext = `{{Short description|Muscle}}
{{Infobox muscle
| Name = Rhomboid major
| Image = File.png
| Caption = Muscles [[connecting]] the {{nowrap|upper extremity}}
| Origin = [[Spinous process]]es of the T2 to T5 [[vertebra]]e<ref name="x">Gray</ref>
| Insertion = Medial border of the [[scapula]], inferior to the insertion of [[rhomboid minor muscle]]
| Nerve = [[Dorsal scapular nerve]]
| Action = {{unknown template|a|b}}
}}
The '''rhomboid major''' is ...`

  it('reads top-level parameters only', () => {
    const box = parseMuscleInfobox(wikitext)!
    expect(box.name).toBe('Rhomboid major')
    expect(box.nerve).toBe('[[Dorsal scapular nerve]]')
    expect(parseMuscleInfobox('no infobox here')).toBeUndefined()
  })

  it('strips markup and keeps link targets', () => {
    const box = parseMuscleInfobox(wikitext)!
    expect(cleanWikitext(box.origin!)).toEqual({ text: 'Spinous processes of the T2 to T5 vertebrae', links: ['Spinous process', 'vertebra'] })
    expect(cleanWikitext(box.nerve!)).toEqual({ text: 'Dorsal scapular nerve', links: ['Dorsal scapular nerve'] })
  })

  it('refuses values it cannot fully clean', () => {
    expect(cleanWikitext('{{unknown template|a|b}}')).toBeUndefined()
    expect(cleanWikitext('<ref>only a ref</ref>')).toBeUndefined()
  })
})
