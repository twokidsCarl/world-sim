import { describe, expect, it } from 'vitest'
import { loadDraft, saveImages, saveText } from '../src/sessions/drafts'

// 一个放在内存里的 localStorage，可以设上限。 / An in-memory localStorage with an optional size limit.
function memory(limit = Infinity) {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > limit) throw new Error('QuotaExceededError')
      map.set(k, v)
    },
    removeItem: (k: string) => void map.delete(k),
  }
}

const image = { media_type: 'image/png', data: 'AAAA', name: 'a.png', url: 'data:image/png;base64,AAAA' }

describe('drafts', () => {
  it('keeps one draft per session and brings each back', () => {
    const store = memory()
    saveText('session:a', '写到一半', store)
    saveText('session:b', 'half written', store)
    saveImages('session:a', [image], store)
    expect(loadDraft('session:a', store)).toEqual({ text: '写到一半', images: [image] }) // 预览地址重新拼出来 / the preview URL is rebuilt
    expect(loadDraft('session:b', store)).toEqual({ text: 'half written', images: [] })
    expect(store.map.get('idea-loom:draft:session:a:images')).not.toContain('data:') // 只存一份原始数据 / the raw data is stored once
  })

  it('clears a draft once it is sent', () => {
    const store = memory()
    saveText('session:a', 'x', store)
    saveImages('session:a', [image], store)
    saveText('session:a', '', store)
    saveImages('session:a', [], store)
    expect(store.map.size).toBe(0)
    expect(loadDraft('session:a', store)).toEqual({ text: '', images: [] })
  })

  it('keeps the text when the images do not fit', () => {
    const store = memory(100)
    saveText('assistant', 'still here', store)
    saveImages('assistant', [{ ...image, data: 'A'.repeat(500) }], store)
    expect(loadDraft('assistant', store)).toEqual({ text: 'still here', images: [] })
  })

  it('works without localStorage', () => {
    saveText('session:a', 'x', null)
    expect(loadDraft('session:a', null)).toEqual({ text: '', images: [] })
  })
})
