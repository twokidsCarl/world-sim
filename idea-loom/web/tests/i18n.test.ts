import { describe, expect, it } from 'vitest'
import type { Idea } from '../src/contract'
import { detectLang, label, pick, plural, tr } from '../src/i18n'
import { NO_FILTERS, matches } from '../src/state/derive'
import { compact, duration } from '../src/ui/viz'

describe('i18n helpers', () => {
  it('tr chooses by language', () => {
    expect(tr('zh', '想法池', 'Idea pool')).toBe('想法池')
    expect(tr('en', '想法池', 'Idea pool')).toBe('Idea pool')
  })
  it('pick falls back to the Chinese when the English is missing', () => {
    expect(pick('en', '沙堆', 'Sandpile')).toBe('Sandpile')
    expect(pick('zh', '沙堆', 'Sandpile')).toBe('沙堆')
    expect(pick('en', '沙堆', null)).toBe('沙堆')
    expect(pick('en', '沙堆', '  ')).toBe('沙堆')
    expect(pick('en', undefined, undefined)).toBe('')
  })
  it('detects the default language', () => {
    expect(detectLang('en', 'zh-CN')).toBe('en') // 存过的优先 / the saved one wins
    expect(detectLang('zh', 'en-US')).toBe('zh')
    expect(detectLang(null, 'zh-TW')).toBe('zh')
    expect(detectLang(null, 'en-GB')).toBe('en')
    expect(detectLang('fr', undefined)).toBe('zh')
  })
  it('label translates by code and falls back to the server label', () => {
    expect(label('zh', 'status', 'pool', '在池')).toBe('在池')
    expect(label('en', 'status', 'pool', '在池')).toBe('In pool')
    expect(label('en', 'phase', 'plan_ready', '方案待批')).toBe('Plan awaiting approval')
    expect(label('en', 'by', 'someone-new', '新来的')).toBe('新来的')
    expect(label('en', 'wishEvent', undefined, '记下')).toBe('记下')
  })
  it('plural adds the count', () => {
    expect([plural(0, 'idea'), plural(1, 'idea'), plural(2, 'idea')]).toEqual(['0 ideas', '1 idea', '2 ideas'])
    expect(plural(2, 'read or edit', 'reads or edits')).toBe('2 reads or edits')
  })
})

describe('number and duration formats', () => {
  it('keeps the Chinese forms', () => {
    expect([compact(999, 'zh'), compact(123_000, 'zh'), compact(2_500_000, 'zh'), compact(120_000_000, 'zh')]).toEqual(['999', '12.3 万', '250 万', '1.2 亿'])
    expect([duration(30, 'zh'), duration(840, 'zh'), duration(9000, 'zh')]).toEqual(['30 秒', '14 分钟', '2.5 小时'])
  })
  it('has English forms', () => {
    expect([compact(999, 'en'), compact(12_300, 'en'), compact(1_200_000, 'en'), compact(3_400_000_000, 'en')]).toEqual(['999', '12.3k', '1.2M', '3.4B'])
    expect([duration(30, 'en'), duration(840, 'en'), duration(9000, 'en')]).toEqual(['30 s', '14 min', '2.5 h'])
  })
})

describe('search by language', () => {
  const idea = { id: '1.2', title: '沙堆', body: '一粒一粒往下落。', title_en: 'Sandpile', body_en: 'Grain by grain.', status: 'pool', threads: [], projects: [] } as unknown as Idea
  it('looks at the English text only in the English UI', () => {
    expect(matches(idea, { ...NO_FILTERS, q: 'sandpile' })).toBe(false)
    expect(matches(idea, { ...NO_FILTERS, q: 'sandpile' }, 'en')).toBe(true)
    expect(matches(idea, { ...NO_FILTERS, q: '沙堆' }, 'en')).toBe(true)
  })
})
