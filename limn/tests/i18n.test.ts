import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import catalog from '../data/catalog.json'
import cells from '../data/cells.json'
import membranes from '../data/membranes.json'
import neuro from '../data/neuro.json'
import neurons from '../data/neurons.json'
import { en, errorNote, getLang, listParams, noteError, noteKey, noteText, pick, say, shown, syncLang, t, tIn, zh } from '../src/i18n'
import { COLOR_MODES } from '../src/style/annotate'
import { ROLES } from '../src/style/palettes'

const HAN = /[一-鿿]/
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort()
const zhTable: Record<string, string> = zh
const enTable: Record<string, string> = en

/** 目录下所有 .ts / .tsx 文件 / every .ts and .tsx file under a directory */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) ? [path] : []
  })
}

describe('两张字典 / the two dictionaries', () => {
  it('have exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('have no empty value', () => {
    for (const table of [zhTable, enTable]) for (const [k, v] of Object.entries(table)) expect(v.trim(), k).not.toBe('')
  })

  it('use the same placeholders in both languages', () => {
    for (const k of Object.keys(zh)) expect(placeholders(enTable[k]!), k).toEqual(placeholders(zhTable[k]!))
  })

  it('keep Chinese out of the English table', () => {
    // 语言切换按钮上写的是要换成的那种语言 / the language switch names the language it switches to
    for (const [k, v] of Object.entries(en)) if (k !== 'lang.switch') expect(HAN.test(v), k).toBe(false)
  })

  it('have a label for every role, colour mode and tier', () => {
    for (const r of ROLES) expect(zhTable[`role.${r}`], r).toBeTruthy()
    for (const m of COLOR_MODES) expect(zhTable[`colorMode.${m}`], m).toBeTruthy()
    for (const tier of ['measured', 'curated', 'predicted', 'estimated']) expect(zhTable[`tier.${tier}`], tier).toBeTruthy()
  })
})

describe('取文字 / looking text up', () => {
  it('interpolates parameters, in either language', () => {
    expect(tIn('zh', 'busy.downloading', { name: '2HHB' })).toBe('正在下载 2HHB…')
    expect(tIn('en', 'busy.downloading', { name: '2HHB' })).toBe('Downloading 2HHB…')
    expect(tIn('en', 'landscape.size', { w: 80, h: 56, d: 30 })).toBe('80×56 nm, 30 nm deep')
  })

  it('follows the current language, and leaves an unknown placeholder alone', () => {
    const before = getLang()
    try {
      syncLang('zh')
      expect(t('look.cut')).toBe('剖开')
      expect(pick('中', 'en')).toBe('中')
      expect(pick('', 'en')).toBe('en')
      syncLang('en')
      expect(t('look.cut')).toBe('Cut')
      expect(pick('中', 'en')).toBe('en')
      expect(pick('中', undefined)).toBe('中')
      expect(t('busy.downloading')).toBe('Downloading {name}…')
    } finally {
      syncLang(before)
    }
  })

  it('renders notes: a model-written string as it is, a keyed one in the current language', () => {
    const before = getLang()
    try {
      const note = { key: 'note.cell.missing', params: listParams('names', (lang) => (lang === 'zh' ? ['细胞核', '内体'] : ['nucleus', 'endosomes'])) }
      syncLang('zh')
      expect(noteText('模型写的')).toBe('模型写的')
      expect(noteText(note)).toBe('没能取到：细胞核、内体。')
      syncLang('en')
      expect(noteText('模型写的')).toBe('模型写的')
      expect(noteText(note)).toBe('Could not be fetched: nucleus, endosomes.')
      // 英文下成对的参数用 xEn / in English a paired parameter uses xEn
      expect(noteText({ key: 'note.neuron.about', params: { species: 'rat', region: 'CA1', has: '胞体', hasEn: 'soma' } })).toContain('(rat, CA1): soma.')
      expect(noteText({ key: 'no.such.key' })).toBe('no.such.key')
      expect(noteKey(note)).toBe('note.cell.missing')
      expect(noteKey('模型写的')).toBe('')
    } finally {
      syncLang(before)
    }
  })
})

describe('源码里用到的键 / the keys the source uses', () => {
  const files = [...sources('src'), ...sources('server')].filter((f) => !f.endsWith(join('src', 'i18n.ts')))
  const text = files.map((f) => readFileSync(f, 'utf8')).join('\n')

  it('are all in the dictionaries: t(...), tr(...) and tIn(...) calls', () => {
    const used = [...text.matchAll(/\b(?:t|tr)\(\s*'([^']+)'/g), ...text.matchAll(/\btIn\(\s*(?:'zh'|'en'|lang)\s*,\s*'([^']+)'/g)].map((m) => m[1]!)
    expect(used.length).toBeGreaterThan(100)
    for (const k of new Set(used)) expect(zhTable[k], k).toBeTruthy()
  })

  it('are all in the dictionaries: note keys, including those chosen by a condition', () => {
    // { key: 'a' }、{ key: cond ? 'a' : 'b' }，以及 t(cond ? 'a' : 'b') 里的每个字符串
    // { key: 'a' }, { key: cond ? 'a' : 'b' }, and every string inside t(cond ? 'a' : 'b')
    const used: string[] = []
    for (const m of text.matchAll(/\bkey:\s*([^,}\n]+)/g)) for (const q of m[1]!.matchAll(/'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g)) used.push(q[1]!)
    for (const m of text.matchAll(/\bt\(([^,)\n]*\?[^,)\n]*)/g)) for (const q of m[1]!.matchAll(/'([a-zA-Z][\w-]*(?:\.[\w-]+)+)'/g)) used.push(q[1]!)
    expect(used.length).toBeGreaterThan(30)
    for (const k of new Set(used)) expect(zhTable[k], k).toBeTruthy()
  })

  it('leave no dictionary key unused', () => {
    // role.* / colorMode.* / tier.* 是按模板拼出来的 / role.*, colorMode.* and tier.* are built from a template
    const built = /^(role|colorMode|tier)\./
    for (const k of Object.keys(zh)) if (!built.test(k)) expect(text.includes(`'${k}'`), k).toBe(true)
  })
})

describe('数据文件里成对的字段 / paired fields in the data files', () => {
  const both = (o: Record<string, unknown>, zhField: string, where: string) => {
    expect(o[zhField], `${where}.${zhField}`).toBeTruthy()
    expect(o[zhField + 'En'], `${where}.${zhField}En`).toBeTruthy()
    expect(HAN.test(String(o[zhField + 'En'])), `${where}.${zhField}En`).toBe(false)
  }
  /** 含中文的字段必须另有英文 / a field with Chinese in it must have its English beside it */
  const englishIfChinese = (o: Record<string, unknown>, field: string, where: string) => {
    if (HAN.test(String(o[field] ?? ''))) both(o, field, where)
  }

  it('catalogue models', () => {
    for (const m of catalog.models as Record<string, unknown>[]) {
      both(m, 'title', String(m.id))
      both(m, 'caption', String(m.id))
      englishIfChinese(m, 'licence', String(m.id))
      englishIfChinese(m, 'attribution', String(m.id))
    }
  })

  it('cells and their organelles', () => {
    for (const c of cells.cells as Record<string, unknown>[]) {
      both(c, 'title', String(c.id))
      both(c, 'caption', String(c.id))
      englishIfChinese(c, 'licence', String(c.id))
      englishIfChinese(c, 'attribution', String(c.id))
      for (const o of c.organelles as Record<string, unknown>[]) both(o, 'name', `${c.id}.${o.label}`)
    }
  })

  it('neurons', () => {
    for (const n of neurons.neurons as Record<string, unknown>[]) {
      both(n, 'title', String(n.id))
      both(n, 'has', String(n.id))
    }
  })

  it('molecules of the nervous system', () => {
    for (const g of neuro.groups as Record<string, unknown>[]) {
      both(g, 'title', String(g.id))
      for (const e of g.entries as Record<string, unknown>[]) both(e, 'title', `${g.id}.${e.id}`)
    }
  })

  it('membranes', () => {
    for (const m of membranes.membranes as Record<string, unknown>[]) {
      both(m, 'name', String(m.id))
      both(m, 'basis', String(m.id))
    }
  })
})

// 可重译的消息 / messages that can be re-worded
describe('messages kept as keys', () => {
  it('re-words a status and an error when the language changes', () => {
    const busy = say('busy.downloading', { name: '2HHB' })
    const err = errorNote(noteError('error.badId'))
    syncLang('zh')
    const zhBusy = shown(busy), zhErr = shown(err)
    syncLang('en')
    expect(shown(busy)).not.toBe(zhBusy)
    expect(shown(busy)).toContain('2HHB')
    expect(shown(err)).not.toBe(zhErr)
    syncLang('zh')
  })

  it('keeps only the current half of a bilingual server error, and leaves other text alone', () => {
    syncLang('en')
    expect(shown('没有找到配体 X / No ligand X found')).toBe('No ligand X found')
    syncLang('zh')
    expect(shown('没有找到配体 X / No ligand X found')).toBe('没有找到配体 X')
    expect(shown('HTTP 500 / gateway')).toBe('HTTP 500 / gateway')
    expect(shown('')).toBe('')
    expect(errorNote(new Error('plain'))).toBe('plain')
  })
})
