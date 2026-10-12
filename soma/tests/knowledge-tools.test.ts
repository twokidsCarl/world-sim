// 知识层工具的单元测试（不需要网络和原始数据）。
// Unit tests for the knowledge-layer tooling (no network, no raw data needed).
import { describe, expect, it } from 'vitest'
import { plausible, sideOf, stripSide } from '../tools/knowledge/lib/model'
import { pickLatin } from '../tools/knowledge/lib/names'
import { createTranslator } from '../tools/knowledge/lib/translate'
import { cleanWikitext, parseMuscleInfobox } from '../tools/knowledge/lib/wikipedia'
import { buildReview, type SignOffFile } from '../tools/knowledge/lib/review'
import type { Model } from '../tools/knowledge/lib/model'
import type { BuiltRelation } from '../tools/knowledge/lib/relations'
import type { NameEntry } from '../src/anatomy/types'

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
    ['anterior root of left eighth cervical nerve', '左第8颈神经前根'],
    ['eighth cervical spinal ganglion', '第8颈神经脊神经节'],
    ['fifth intercostal nerve', '第5肋间神经'],
    ['superior trunk of left brachial nerve plexus', '左臂丛上干'],
    ['nerves to levator ani and coccygeus', '肛提肌和尾骨肌神经'],
    ['superficial inguinal lymph node group', '腹股沟浅淋巴结群'],
    ['set of axillary lymph nodes', '腋淋巴结'],
    ['retrocaval nodes', '腔静脉后淋巴结'],
    ['left anterior talofibular ligament', '左距腓前韧带'],
    ['ligament of knee joint', '膝关节韧带'],
    ['articular capsule of left knee joint', '左膝关节囊'],
    ['anterior horn of left medial meniscus', '左内侧半月板前角'],
    ['anterior meniscotibial ligament (lateral meniscus)', '半月板胫骨前韧带（外侧半月板）'],
    ['nail of right big toe', '右踇趾趾甲'],
    ['superficial fascia of left upper limb', '左上肢皮下脂肪（浅筋膜）'],
  ])('%s -> %s', (en, zh) => expect(t.translate(en)).toBe(zh))

  it('exact() accepts whole lexicon terms only (plus side, set-of, ordinal)', () => {
    expect(t.exact('common carotid artery')).toBe('颈总动脉')
    expect(t.exact('left medial pterygoid')).toBe('左翼内肌')
    expect(t.exact('set of axillary lymph nodes')).toBe('腋淋巴结')
    expect(t.exact('first thoracic nerve')).toBe('第1胸神经')
    expect(t.exact('branch of median nerve')).toBeUndefined() // composed, not exact
    expect(t.exact('zone of deltoid')).toBeUndefined()
  })

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

// 签核机制：只有签核过的审核项变为 reviewed；改正和否决按约定生效。
// The sign-off mechanism: only signed-off items become reviewed; corrections and rejections apply as specified.
describe('review sign-offs', () => {
  const concept = (fma: string, en: string) => [fma, { fma, en, inIsa: true, inPartOf: false }] as const
  const model = {
    concepts: new Map([concept('FMA1', 'femur'), concept('FMA2', 'left femur'), concept('FMA3', 'tibia'), concept('FMA4', 'biceps brachii'), concept('FMA5', 'musculocutaneous nerve')]),
    dataset: { partFmas: new Map([['male', new Set(['FMA2'])]]) },
    unsidedOf: (id: string) => (id === 'FMA2' ? ['FMA1'] : []),
    fmaByName: new Map<string, Set<string>>(),
  } as unknown as Model
  const fresh = () => {
    const names: Record<string, NameEntry> = {
      FMA1: { zh: '股骨', zhSource: 'wikidata', status: 'unreviewed' },
      FMA2: { zh: '左股骨', zhSource: 'derived:laterality', status: 'unreviewed' },
      FMA3: { zh: '胫骨头', zhSource: 'machine-translation', status: 'unreviewed' },
      FMA4: { zh: '肱二头肌', zhSource: 'machine-translation', status: 'unreviewed' },
      FMA5: { zh: '肌皮神经', zhSource: 'wikidata', status: 'unreviewed' },
    }
    const rel = (subject: string, kind: BuiltRelation['kind'], object: string, en: string, name: string, url: string): BuiltRelation => ({
      subject, kind, object, objectLabel: { en }, source: { name, url, license: 'CC0 1.0' }, status: 'unreviewed', via: 'direct',
    })
    const relations = [
      rel('FMA1', 'connectsWith', 'FMA3', 'tibia', 'Wikidata', 'https://www.wikidata.org/wiki/Q1#P2789'),
      rel('FMA2', 'connectsWith', 'FMA3', 'tibia', 'Wikidata (propagated via BodyParts3D is-a from FMA1 "femur")', 'https://www.wikidata.org/wiki/Q1#P2789'),
      rel('FMA4', 'innervatedBy', 'FMA5', 'musculocutaneous nerve', 'Wikidata', 'https://www.wikidata.org/wiki/Q4#P3189'),
      rel('FMA5', 'innervates', 'FMA4', 'biceps brachii', 'Wikidata; inverse of a statement made on the innervated structure', 'https://www.wikidata.org/wiki/Q4#P3189'),
      rel('FMA4', 'origin', 'FMA3', 'tibia', 'Wikidata', 'https://www.wikidata.org/wiki/Q4#P3490'),
    ]
    return { names, relations }
  }
  const run = (items: SignOffFile['items']) => {
    const { names, relations } = fresh()
    const review = buildReview({ m: model, names, nameChecks: new Map(), relations, relationChecks: relations.map(() => ({ result: 'none' as const })), signoffs: { note: { zh: '', en: '' }, example: {}, items } })
    return { names, relations, review }
  }
  const by = { reviewedBy: 'anatomy lecturer', date: '2026-11-03' }

  it('reviews nothing without sign-offs and groups derived items', () => {
    const { names, relations, review } = run({})
    expect(Object.values(names).every((e) => e.status === 'unreviewed')).toBe(true)
    expect(relations.every((r) => r.status === 'unreviewed')).toBe(true)
    const ids = review.queue.map((q) => q.id)
    expect(ids).toContain('name:FMA1') // 左股骨 归入 股骨 / "left femur" is grouped under "femur"
    expect(ids).not.toContain('name:FMA2')
    expect(ids).toContain('rel:connectsWith|Q1#P2789|tibia')
    expect(ids).toContain('rel:innervatedBy|Q4#P3189|musculocutaneous nerve') // 含镜像的 innervates / includes the mirrored innervates
    expect(review.queue.find((q) => q.id === 'rel:innervatedBy|Q4#P3189|musculocutaneous nerve')!.members.count).toBe(2)
  })

  it('accept marks the whole group reviewed, correct rewrites the name with its side word', () => {
    const { names, relations } = run({ 'name:FMA1': { ...by, verdict: 'correct', corrected: { zh: '股骨（改）' } }, 'rel:connectsWith|Q1#P2789|tibia': { ...by, verdict: 'accept' } })
    expect(names.FMA1).toMatchObject({ zh: '股骨（改）', zhSource: 'reviewer', status: 'reviewed' })
    expect(names.FMA2).toMatchObject({ zh: '左股骨（改）', zhSource: 'reviewer', status: 'reviewed' })
    expect(names.FMA3!.status).toBe('unreviewed')
    expect(relations.slice(0, 2).every((r) => r.status === 'reviewed')).toBe(true)
    expect(relations[2]!.status).toBe('unreviewed')
  })

  it('reject drops the relations and leaves a name unreviewed; unknown ids are reported', () => {
    const { names, review } = run({ 'rel:origin|Q4#P3490|tibia': { ...by, verdict: 'reject' }, 'name:FMA3': { ...by, verdict: 'reject' }, 'name:NOPE': { ...by, verdict: 'accept' } })
    expect([...review.rejectedRelations]).toEqual([4])
    expect(names.FMA3!.status).toBe('unreviewed')
    expect((review.stats.signOffs as { unknownOrInvalidIds: string[] }).unknownOrInvalidIds).toEqual(['name:NOPE'])
  })
})
