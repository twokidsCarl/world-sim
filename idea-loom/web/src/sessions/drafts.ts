import { useEffect, useState } from 'react'
import type { Attached } from '../assistant/images'

// 没发出去的草稿：每个输入框一份（每个会话一份、新开会话一份、小助手一份），存在 localStorage 里，
// 换会话、刷新页面都还在，发出去就清掉。字和图分开存：打字时不用每次把几兆的图重写一遍。
// Unsent drafts: one per input box (one per session, one for starting a session, one for the assistant), kept
// in localStorage so they survive switching sessions and reloading the page, and cleared once sent. Text and
// images are stored apart, so typing does not rewrite megabytes of images on every key.

export type Draft = { text: string; images: Attached[] }
type Box = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const PREFIX = 'idea-loom:draft:'
const textKey = (key: string) => `${PREFIX}${key}`
const imagesKey = (key: string) => `${PREFIX}${key}:images`

function box(): Box | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // 没有 localStorage 也能用 / works without localStorage
  }
}

export function loadDraft(key: string, store: Box | null = box()): Draft {
  if (!store) return { text: '', images: [] }
  let images: Attached[] = []
  try {
    const raw = JSON.parse(store.getItem(imagesKey(key)) ?? '[]') as Omit<Attached, 'url'>[]
    // 只存了原始数据；预览用的地址按它重新拼出来。 / Only the raw data is stored; the preview URL is rebuilt from it.
    images = raw.map((i) => ({ ...i, url: `data:${i.media_type};base64,${i.data}` }))
  } catch {
    /* 坏了就当没有图 / a broken entry counts as no images */
  }
  return { text: store.getItem(textKey(key)) ?? '', images }
}

export function saveText(key: string, text: string, store: Box | null = box()): void {
  if (!store) return
  try {
    if (text) store.setItem(textKey(key), text)
    else store.removeItem(textKey(key))
  } catch {
    /* 存不下就只留在这一页里 / if it does not fit it stays in this page only */
  }
}

export function saveImages(key: string, images: Attached[], store: Box | null = box()): void {
  if (!store) return
  try {
    if (images.length) store.setItem(imagesKey(key), JSON.stringify(images.map(({ media_type, data, name }) => ({ media_type, data, name }))))
    else store.removeItem(imagesKey(key))
  } catch {
    // 图太大、存不下：字照样留着，图只留在这一页里。 / Images too large to store: the text is kept anyway and the images stay in this page only.
    store.removeItem(imagesKey(key))
  }
}

// 一个输入框的草稿：和 useState 一样用，但写进 localStorage。key 变了（换会话）就读那一份。
// A box's draft: used like useState, but written to localStorage. When the key changes (another session) that one is read.
export function useDraft(key: string) {
  const [state, setState] = useState(() => ({ key, ...loadDraft(key) }))
  const current = state.key === key ? state : { key, ...loadDraft(key) }
  if (current !== state) setState(current)
  useEffect(() => saveText(key, current.text), [key, current.text])
  useEffect(() => saveImages(key, current.images), [key, current.images])
  const setText = (text: string) => setState((s) => ({ ...s, text }))
  const setImages = (images: Attached[] | ((now: Attached[]) => Attached[])) => setState((s) => ({ ...s, images: typeof images === 'function' ? images(s.images) : images }))
  return { text: current.text, images: current.images, setText, setImages }
}
