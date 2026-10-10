/**
 * Topic -> scene: the model says what to look for, code looks it up in the
 * real databases, and the model then chooses among what was found. The
 * choice is constrained to the ids that came back from the databases, so a
 * structure id can never be made up.
 */
import type { EntitySpec, PanelSpec, SceneSpec, SourceRef } from '../src/scene/spec'
import { ROLES, type Role } from '../src/style/palettes'
import { resolveLandscape } from './landscape'
import { ask as realAsk, type AskOptions } from './llm'
import { matchArticles } from './motm'
import { entryInfo, searchText, type EntryInfo } from './sources/rcsb'
import { alphafold, bestStructures, findProtein } from './sources/uniprot'

type Ask = <T>(o: AskOptions) => Promise<T>

/** Everything that touches the network or the model, so tests can replace it. */
export interface Deps {
  ask: Ask
  searchText: typeof searchText
  entryInfo: typeof entryInfo
  findProtein: typeof findProtein
  bestStructures: typeof bestStructures
  alphafold: typeof alphafold
}

export const liveDeps: Deps = { ask: realAsk, searchText, entryInfo, findProtein, bestStructures, alphafold }

interface Intent {
  kind: SceneSpec['kind']
  name_en: string
  steps: { label: string; queries: string[]; suggested_pdb_ids: string[] }[]
  genes: { symbol: string; organism: string }[]
}

const INTENT_SCHEMA = {
  type: 'object',
  required: ['kind', 'name_en', 'steps', 'genes'],
  properties: {
    kind: { type: 'string', enum: ['molecule', 'complex', 'virus', 'gene', 'mechanism', 'landscape'] },
    name_en: { type: 'string', description: 'the topic as a short English noun phrase' },
    steps: {
      type: 'array', minItems: 1, maxItems: 4,
      description: 'one item, unless the topic is a mechanism with distinct structural states; then one item per state, in order',
      items: {
        type: 'object', required: ['label', 'queries', 'suggested_pdb_ids'],
        properties: {
          label: { type: 'string', description: 'what this structure shows, in the language of the topic, under 12 words' },
          queries: { type: 'array', minItems: 1, maxItems: 3, items: { type: 'string' }, description: 'English full-text queries for the RCSB PDB, most specific first' },
          suggested_pdb_ids: { type: 'array', maxItems: 4, items: { type: 'string' }, description: 'PDB ids you recall for this; they will be checked against the database, so only list ones you are fairly sure of' },
        },
      },
    },
    genes: {
      type: 'array', maxItems: 4,
      description: 'gene symbols whose protein products are the subject',
      items: { type: 'object', required: ['symbol', 'organism'], properties: { symbol: { type: 'string' }, organism: { type: 'string', description: 'scientific name, e.g. Homo sapiens' } } },
    },
  },
}

const INTENT_SYSTEM = `You help turn a biology topic into database lookups for a scientific illustrator.
The picture will be rendered from real atomic coordinates in the Protein Data Bank, so think about which experimentally determined structures show the topic.
- "gene": the user named a gene; the subject is its protein product, ideally bound to its partner (DNA, ligand, complex).
- "mechanism": a process with distinct structural states that are each worth a panel (before/after, bound/unbound). Use at most 4 states. If one complex tells the story, it is a "complex", not a mechanism.
- "virus": a whole capsid or virion, or a viral protein as the subject.
- "landscape": the user wants a crowded cellular scene (cytoplasm, blood plasma, a synapse) rather than one assembly.
Write queries as a structural biologist would search: protein and organism names, ligands, states. Do not invent PDB ids.`

interface Candidate {
  ref: SourceRef
  info: EntryInfo
  /** how it was found, shown to the model as evidence of relevance */
  via: string[]
}

interface Choice {
  title: string
  caption: string
  notes: string[]
  panels: { label: string; source_id: string; assembly_id: string; reason: string; entities: { entity_id: string; role: string; name: string }[] }[]
}

function choiceSchema(ids: string[], maxPanels: number) {
  return {
    type: 'object',
    required: ['title', 'caption', 'notes', 'panels'],
    properties: {
      title: { type: 'string', description: 'title of the picture, in the language of the topic' },
      caption: { type: 'string', description: '2-4 sentences a museum label would carry: what this is, what each coloured part is, why it matters. Same language as the topic. State only what the listed structures support.' },
      notes: { type: 'array', items: { type: 'string' }, description: 'caveats the reader must know: truncated constructs, mutants, missing regions, different organism than asked, antibody fragments or fusion partners present. Same language as the topic.' },
      panels: {
        type: 'array', minItems: 1, maxItems: maxPanels,
        items: {
          type: 'object', required: ['label', 'source_id', 'assembly_id', 'reason', 'entities'],
          properties: {
            label: { type: 'string' },
            source_id: { type: 'string', enum: ids },
            assembly_id: { type: 'string', description: 'one of the assembly ids listed for that structure' },
            reason: { type: 'string', description: 'one sentence: why this entry over the other candidates' },
            entities: {
              type: 'array',
              description: 'one item for every entity of the chosen structure',
              items: {
                type: 'object', required: ['entity_id', 'role', 'name'],
                properties: { entity_id: { type: 'string' }, role: { type: 'string', enum: ROLES }, name: { type: 'string', description: 'short name, language of the topic' } },
              },
            },
          },
        },
      },
    },
  }
}

const CHOICE_SYSTEM = `You choose which Protein Data Bank structures an illustrator will draw, and say what each part is.
You are given candidate structures with their real metadata. Choose only from them; if none fits a step well, pick the closest and say so in "notes".

Choosing:
- Prefer the entry that shows the topic most completely and cleanly: the right organism, the full assembly, the functional state asked for, few artefacts (antibody fragments, fusion proteins, heavy truncation).
- Then prefer better resolution, but completeness matters more than resolution for an illustration.
- Choose the biological assembly (usually "1"). For a capsid, the assembly with icosahedral symmetry.
- For a mechanism, pick entries that can be compared: same protein, same organism where possible.

Colour roles follow David Goodsell's convention, by function. Each role is drawn in a fixed colour family:
- focus (pink to magenta): the subject of the picture (a viral protein, the enzyme the topic is about)
- soluble (blue): other cytoplasmic or soluble proteins; partners of the subject
- membrane (green): membrane proteins and lipids
- nucleic (yellow to yellow-green): DNA and RNA
- nucleic-binding (orange): proteins whose job is to bind nucleic acid, when they are not the subject
- extracellular (tan, earth tones): antibodies, plasma proteins, receptors' extracellular partners, matrix
- ligand (vivid magenta): drugs, cofactors, substrates, haem
- glycan (pale olive): sugars attached to proteins
- ion (grey): single atoms
Use "focus" for one thing only, so the eye knows where to go. Give different roles to parts that should be told apart.
If the caption mentions colours, use the colour families above for the roles you assigned, and no other colour words. The user can recolour the picture afterwards, so prefer naming parts by what they are.`

function describe(c: Candidate): string {
  const i = c.info
  const res = i.resolution ? `${i.resolution.toFixed(2)} Å` : 'no resolution'
  const lines = [`## ${c.ref.id}  (${c.via.join('; ')})`, `${i.title}`, `${i.method || c.ref.method}, ${res}, ${i.year ?? '?'}`]
  lines.push('assemblies: ' + i.assemblies.map((a) => `${a.id} [${a.chains} chains, ${a.atoms.toLocaleString('en')} atoms, symmetry ${a.symmetry}]`).join('; '))
  for (const e of i.entities) {
    const size = e.length ? `, ${e.length} residues` : ''
    lines.push(`  entity ${e.entityId}: ${e.kind}, ${e.description || '?'}${e.organism ? ` — ${e.organism}` : ''}, ${e.chains} chain(s)${size}`)
  }
  return lines.join('\n')
}

const PDB_ID = /^[0-9][A-Za-z0-9]{3}$/

export async function resolveTopic(topic: string, deps: Deps = liveDeps, log: (s: string) => void = () => {}): Promise<SceneSpec> {
  topic = topic.trim()
  if (!topic) throw new Error('请输入一个主题')

  log('理解主题')
  const intent = await deps.ask<Intent>({ system: INTENT_SYSTEM, prompt: `Topic: ${topic}`, schema: INTENT_SCHEMA })

  if (intent.kind === 'landscape') return resolveLandscape(topic, deps, log)

  log('检索结构数据库')
  const found = new Map<string, string[]>()
  const add = (id: string, via: string) => {
    id = id.toUpperCase()
    if (!PDB_ID.test(id)) return
    const l = found.get(id)
    if (l) l.includes(via) || l.push(via)
    else found.set(id, [via])
  }
  const predictions: Candidate[] = []
  const jobs: Promise<void>[] = []
  const soft = (p: Promise<void>) => jobs.push(p.catch((e) => log(`一项检索失败: ${e instanceof Error ? e.message : e}`)))

  const allQueries = [intent.name_en, ...intent.steps.flatMap((s) => s.queries)]
  for (const a of matchArticles(allQueries)) for (const id of a.pdb.slice(0, 6)) add(id, `PDB-101 Molecule of the Month "${a.title}"`)
  for (const [k, step] of intent.steps.entries()) {
    for (const id of step.suggested_pdb_ids) add(id, `recalled for step ${k + 1}`)
    for (const q of step.queries.slice(0, 3)) {
      soft(deps.searchText(q, 6).then((ids) => ids.forEach((id, rank) => add(id, `search "${q}" #${rank + 1}`))))
    }
  }
  for (const g of intent.genes.slice(0, 4)) {
    soft(
      (async () => {
        const [p] = await deps.findProtein(g.symbol, g.organism)
        if (!p) return
        const best = await deps.bestStructures(p.accession, 5)
        for (const b of best) add(b.pdbId, `best coverage of ${p.gene} (${p.accession}), ${Math.round(b.coverage * 100)}%`)
        // A predicted model is offered only when experiments cover the protein poorly.
        if (best.length === 0 || Math.max(...best.map((b) => b.coverage)) < 0.5) {
          const af = await deps.alphafold(p.accession)
          if (af) {
            const id = `AF-${p.accession}`
            predictions.push({
              via: [`AlphaFold prediction for ${p.gene}; ${Math.round(af.confident * 100)}% of residues confidently placed`],
              ref: { id, kind: 'alphafold', url: af.url, title: `${p.name} (predicted)`, method: 'AlphaFold prediction', resolution: null, year: null },
              info: {
                id, title: `${p.name} — AlphaFold predicted model`, method: 'PREDICTED (AlphaFold)', resolution: null, year: null, atoms: p.length * 8,
                assemblies: [{ id: 'asym', atoms: p.length * 8, chains: 1, symmetry: 'C1' }],
                entities: [{ entityId: '1', kind: 'protein', description: p.name, organism: p.organism, chains: 1, length: p.length, uniprot: [p.accession] }],
              },
            })
          }
        }
      })(),
    )
  }
  await Promise.all(jobs)

  // Keep the candidates found by the most routes, then verify each against RCSB.
  const ranked = [...found.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 24)
  const infos = await deps.entryInfo(ranked.map(([id]) => id))
  const byId = new Map(infos.map((i) => [i.id, i]))
  const candidates: Candidate[] = [...predictions]
  for (const [id, via] of ranked) {
    const info = byId.get(id)
    if (!info) continue // a recalled id that does not exist
    candidates.push({ via, info, ref: { id, kind: 'pdb', title: info.title, method: info.method, resolution: info.resolution, year: info.year } })
  }
  if (candidates.length === 0) throw new Error(`没有找到和“${topic}”对应的结构。换个更具体的说法试试，例如蛋白名加物种。`)

  log(`在 ${candidates.length} 个候选结构中选择`)
  const prompt = [
    `Topic (answer in this language): ${topic}`,
    `Kind: ${intent.kind}`,
    intent.steps.length > 1 ? `Panels wanted, in order:\n${intent.steps.map((s, k) => `${k + 1}. ${s.label}`).join('\n')}` : `One panel: ${intent.steps[0]!.label}`,
    '',
    '# Candidate structures',
    ...candidates.map(describe),
  ].join('\n')
  const choice = await deps.ask<Choice>({ system: CHOICE_SYSTEM, prompt, schema: choiceSchema(candidates.map((c) => c.ref.id), Math.max(1, intent.steps.length)) })

  const panels: PanelSpec[] = []
  const notes = (choice.notes ?? []).filter((n) => typeof n === 'string' && n.trim())
  for (const p of choice.panels ?? []) {
    const c = candidates.find((x) => x.ref.id === String(p.source_id).toUpperCase())
    if (!c) continue // not one of the candidates: dropped, never trusted
    const assembly = c.info.assemblies.some((a) => a.id === p.assembly_id) ? p.assembly_id : (c.info.assemblies[0]?.id ?? 'asym')
    const picked = new Map((p.entities ?? []).map((e) => [String(e.entity_id), e]))
    const entities: EntitySpec[] = c.info.entities.map((e) => {
      const m = picked.get(e.entityId)
      const role = m && (ROLES as string[]).includes(m.role) ? (m.role as Role) : fallbackRole(e.kind)
      return { entityId: e.entityId, role, name: m?.name?.trim() || e.description, description: e.description, organism: e.organism }
    })
    panels.push({ label: p.label?.trim() || c.info.title, source: c.ref, assembly, entities, reason: p.reason ?? '' })
    if (c.ref.kind === 'alphafold') notes.push(`${c.ref.id} 是 AlphaFold 预测模型，不是实验结构；低置信度的区域已省略。`)
  }
  if (panels.length === 0) throw new Error('没能从候选结构中选出可用的一个，请换个说法再试。')

  return { topic, kind: intent.kind, title: choice.title?.trim() || topic, caption: choice.caption?.trim() ?? '', panels, notes: [...new Set(notes)] }
}

function fallbackRole(kind: EntryInfo['entities'][number]['kind']): Role {
  switch (kind) {
    case 'dna': case 'rna': return 'nucleic'
    case 'glycan': return 'glycan'
    case 'ligand': return 'ligand'
    default: return 'soluble'
  }
}
