/**
 * Build data/motm.json: for each PDB-101 "Molecule of the Month" article, its
 * number, title and the PDB entries it discusses. Only ids and titles are
 * stored; the article text and images are not copied.
 *
 *   bun server/tools/scrape_motm.ts
 */
const UA = { 'User-Agent': 'limn/0.1 (molecular illustration; local research tool)' }
const BASE = 'https://pdb101.rcsb.org'

async function get(url: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: UA })
    if (res.ok) return res.text()
    if (attempt >= 2) throw new Error(`${url}: HTTP ${res.status}`)
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
}

const unescape = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()

const index = await get(`${BASE}/motm/motm-by-title`)
const articles = new Map<number, string>()
for (const m of index.matchAll(/<a[^>]+href="\/motm\/(\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
  const title = unescape(m[2]!)
  if (title && !articles.has(Number(m[1]))) articles.set(Number(m[1]), title)
}
console.error(`${articles.size} articles`)

const out: { n: number; title: string; pdb: string[] }[] = []
const queue = [...articles.entries()]
await Promise.all(
  Array.from({ length: 5 }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const [n, title] = job
      const html = await get(`${BASE}/motm/${n}`)
      const ids: string[] = []
      // Newer articles link to /structure/<id>; older ones to explore.do?structureId=<id>.
      for (const m of html.matchAll(/(?:\/structure\/|structureId=)([0-9][A-Za-z0-9]{3})\b/g)) {
        const id = m[1]!.toUpperCase()
        if (!ids.includes(id)) ids.push(id)
      }
      out.push({ n, title, pdb: ids })
    }
  }),
)
out.sort((a, b) => a.n - b.n)
await Bun.write(new URL('../../data/motm.json', import.meta.url), JSON.stringify(out, null, 0).replace(/\},\{/g, '},\n{') + '\n')
console.error(`wrote ${out.length} articles, ${out.filter((a) => a.pdb.length).length} with structures`)
