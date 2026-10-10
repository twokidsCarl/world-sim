// Traditional -> Simplified conversion, character by character, using OpenCC's TSCharacters table
// (Apache-2.0, https://github.com/BYVoid/OpenCC). Character-level T->S is close to lossless for
// anatomical vocabulary, but regional word choice is NOT normalised (e.g. zh-tw 脛後肌 becomes
// 胫后肌, where mainland usage is 胫骨后肌), so converted names are flagged in zhSource.
import { cachedGet, type FetchOptions } from './sparql.ts'

const URL = 'https://raw.githubusercontent.com/BYVoid/OpenCC/master/data/dictionary/TSCharacters.txt'

export async function loadT2S(opts: FetchOptions): Promise<(s: string) => string> {
  const text = await cachedGet('opencc', URL, opts, 'txt')
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const [trad, simp] = line.split('\t')
    const first = simp?.split(' ')[0]
    if (trad && first) map.set(trad, first)
  }
  if (map.size < 2000) throw new Error(`T->S table looks wrong (${map.size} entries)`)
  return (s) => Array.from(s, (ch) => map.get(ch) ?? ch).join('')
}
