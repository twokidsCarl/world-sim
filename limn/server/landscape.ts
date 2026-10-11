/**
 * 主题 → 拥挤的细胞场景。模型写配方（哪些分子、在哪里、有多少）；代码为每种成分检索真实结构；
 * 模型再从查到的结构里为每种成分选一个。丰度优先用 PaxDb 的实测数据，查不到的才用模型的估计，
 * 两者在结果里分别标明。
 *
 * Topic -> crowded cellular scene. The model writes a recipe (which
 * molecules, where, how abundant); code finds real structures for each
 * ingredient; the model picks one per ingredient from what was found.
 * Abundances come from PaxDb's measurements where it has them and from the
 * model's estimate otherwise, and each is reported as what it is.
 */
import type { Ingredient, LandscapeSpec, Note, PanelSpec, SceneSpec, SourceRef } from '../src/scene/spec'
import { ROLES, type Role } from '../src/style/palettes'
import type { Deps } from './resolve'
import membraneData from '../data/membranes.json'
import { matchNeuro } from './motm'
import { ppmToMicromolar } from './sources/paxdb'
import type { EntryInfo } from './sources/rcsb'

/** 画出来的那一片：80 x 56 nm，厚 30 nm / The slab that is drawn: 80 x 56 nm of cell, 30 nm deep. */
export const BOX = { width: 800, height: 560, depth: 300 }
const PDB_ID = /^[0-9][A-Za-z0-9]{3}$/

interface Recipe {
  title: string
  caption: string
  membrane: boolean
  membrane_outer_side: string
  membrane_type: string
  above: string
  below: string
  density_above_g_per_L: number
  density_below_g_per_L: number
  organism_taxid: number
  tissue: string
  dna_megabases_per_cubic_micron: number
  notes: string[]
  ingredients: {
    name: string
    compartment: Ingredient['compartment']
    concentration_uM: number
    per_square_micron: number
    membrane_anchor: string
    membrane_terminus: string
    genes: string[]
    feature: boolean
    role: string
    queries: string[]
    suggested_pdb_ids: string[]
  }[]
}

/** PaxDb 里有整合数据集的常见组织和体液 / common tissues and fluids for which PaxDb has an integrated dataset */
const TISSUES = ['WHOLE_ORGANISM', 'BRAIN', 'CEREBRAL_CORTEX', 'PLASMA', 'SERUM', 'CEREBROSPINAL_FLUID', 'LIVER', 'HEART', 'KIDNEY', 'LUNG', 'SKELETAL_MUSCLE', 'PANCREAS', 'SPLEEN', 'PLATELET', 'RETINA']

const RECIPE_SCHEMA = {
  type: 'object',
  required: ['title', 'caption', 'membrane', 'membrane_outer_side', 'membrane_type', 'above', 'below', 'density_above_g_per_L', 'density_below_g_per_L', 'organism_taxid', 'tissue', 'dna_megabases_per_cubic_micron', 'notes', 'ingredients'],
  properties: {
    title: { type: 'string', description: 'language of the topic' },
    caption: { type: 'string', description: '2-4 sentences, language of the topic: where in the cell this is and what is going on. Name parts by what they are.' },
    membrane: { type: 'boolean', description: 'true if a lipid bilayer crosses the scene horizontally' },
    membrane_outer_side: { type: 'string', enum: ['above', 'below', 'none'], description: 'which side of the membrane, as drawn, is its outer face: the extracellular side of a plasma membrane or viral envelope, the periplasmic side of a bacterial inner membrane, the lumen of an organelle or vesicle. "none" if there is no membrane.' },
    membrane_type: { type: 'string', enum: ['none', 'other', ...membraneData.membranes.map((m) => m.id)], description: `which membrane this is, used to draw its real lipid composition: ${membraneData.membranes.map((m) => `${m.id} = ${m.nameEn}`).join('; ')}. "other" for a membrane not in the list (it is then drawn with one phospholipid); "none" if there is no membrane.` },
    above: { type: 'string', description: 'what is above the membrane (e.g. extracellular space, blood plasma); empty if no membrane' },
    below: { type: 'string', description: 'what is below the membrane, or the whole scene if there is no membrane (e.g. cytoplasm)' },
    density_above_g_per_L: { type: 'number', description: 'total macromolecule concentration above the membrane, grams per litre (blood plasma is about 70-80); 0 if no membrane' },
    density_below_g_per_L: { type: 'number', description: 'total macromolecule concentration below the membrane, or of the whole scene (bacterial cytoplasm is about 300, eukaryotic cytosol about 100-200)' },
    organism_taxid: { type: 'integer', description: 'NCBI taxonomy id of the organism whose cell this is, used to look up measured protein abundances: Escherichia coli K-12 = 511145, human = 9606, mouse = 10090, baker\'s yeast = 4932, Bacillus subtilis = 224308, Mycobacterium tuberculosis = 83332. 0 if unsure or if the scene is not one organism\'s cell.' },
    tissue: { type: 'string', enum: TISSUES, description: 'for human or mouse: the tissue or fluid the scene is in, if it is one of these; otherwise WHOLE_ORGANISM' },
    dna_megabases_per_cubic_micron: { type: 'number', description: 'how much double-stranded DNA the compartment below the membrane (or the whole scene) holds, in million base pairs per cubic micron: genome size times copies, divided by the volume it occupies. A bacterial nucleoid region is very roughly 5-15; a eukaryotic nucleus roughly 10-30; 0 where there is no DNA (cytosol of a eukaryote, blood plasma, outside a cell). Long DNA is then drawn as a generated double helix at that density.' },
    notes: { type: 'array', items: { type: 'string' }, description: 'what is simplified or left out, language of the topic' },
    ingredients: {
      type: 'array', minItems: 4, maxItems: 12,
      items: {
        type: 'object',
        required: ['name', 'compartment', 'concentration_uM', 'per_square_micron', 'membrane_anchor', 'membrane_terminus', 'genes', 'feature', 'role', 'queries', 'suggested_pdb_ids'],
        properties: {
          name: { type: 'string', description: 'language of the topic' },
          compartment: { type: 'string', enum: ['above', 'membrane', 'below'] },
          concentration_uM: { type: 'number', description: 'for soluble molecules: typical concentration of the assembled molecule in that compartment, micromolar. 0 for membrane proteins.' },
          per_square_micron: { type: 'number', description: 'for membrane proteins: copies per square micron of membrane. 0 for soluble molecules.' },
          membrane_anchor: {
            type: 'string', enum: ['spans', 'above', 'below', 'none'],
            description: 'membrane proteins only (otherwise "none"): what the available structures show. "spans" = includes the transmembrane region, so the molecule sits in the membrane. "above" / "below" = only the soluble part on that side was solved (true of most viral spike and receptor structures, which are ectodomains), so it must stand on that face of the membrane.',
          },
          membrane_terminus: {
            type: 'string', enum: ['N', 'C', 'unknown'],
            description: 'for "above"/"below": which end of the polypeptide chain in the structure is nearest the membrane (C for type I proteins like haemagglutinin and coronavirus spike, N for type II like neuraminidase); "unknown" otherwise',
          },
          genes: { type: 'array', maxItems: 6, items: { type: 'string' }, description: 'gene symbols, in that organism\'s own nomenclature, of the protein subunits of this molecule (tufA; rplB, rplC, rpsA for a ribosome; ALB). A few representative subunits are enough for a large complex. Empty if the molecule is not a protein of the scene\'s organism (a viral protein, an antibody, RNA).' },
          feature: { type: 'boolean', description: 'true for the few molecules the topic is about; they are shown at least once whatever their abundance' },
          role: { type: 'string', enum: ROLES },
          queries: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string' }, description: 'English RCSB full-text queries for a structure of this molecule, in the right organism' },
          suggested_pdb_ids: { type: 'array', maxItems: 3, items: { type: 'string' } },
        },
      },
    },
  },
}

const RECIPE_SYSTEM = `You plan a cellular landscape in the manner of David S. Goodsell: a thin cross-section of a cell at about 1,000,000x, in which every macromolecule is drawn to scale at its real concentration. Water, ions and small molecules are not drawn.
The scene is a slab ${BOX.width / 10} nm wide, ${BOX.height / 10} nm tall and ${BOX.depth / 10} nm deep. If there is a membrane it runs horizontally across the middle.

Write the recipe:
- List the 6 to 12 macromolecules that make up most of the mass in this place, plus the few the topic is about. Abundant, well-known molecules matter more than rare ones: a cytoplasm is mostly ribosomes, translation factors, glycolytic enzymes and chaperones; blood plasma is mostly albumin, immunoglobulins, fibrinogen and lipoproteins.
- Give each a realistic abundance from the literature for this organism and compartment. Where the molecule is a protein of the scene's organism, also give its gene symbols: measured abundances from the PaxDb database will then replace your estimate. These numbers decide how many copies are drawn, so be honest: if a molecule is rare, give its real, low value and mark it as a feature so it still appears once.
- A real compartment holds thousands of kinds of molecule and you can list only a dozen. The listed ones stand in for the rest: their relative proportions come from your abundances, and the number of copies is then scaled so that the total mass drawn matches the compartment's overall macromolecule density, which you also give. Molecules marked as a feature are not scaled.
- Only include molecules for which an experimental structure of the whole molecule or assembly plausibly exists in the PDB. Long DNA is drawn separately as a generated double helix from the density you give; do not list it as an ingredient. Messenger RNA and cytoskeletal filaments cannot be drawn yet; leave them out and say so in the notes.
- Colour roles: focus (pink-magenta) for the subject; soluble (blue) for ordinary soluble proteins; membrane (green) for membrane proteins; nucleic-binding (orange) for ribosomes, polymerases and other nucleic-acid machines; extracellular (tan) for molecules outside the cell. Use the roles to separate inside from outside and the subject from its surroundings.
- In the notes, say what a reader should not over-interpret: positions and orientations are random, abundances are estimates.`

/** 一串名字作为说明的参数：中文用顿号连，英文（`<name>En`）用逗号连 / a run of names as a note's parameters: joined the Chinese way, and the English way under `<name>En` */
const names = (name: string, list: string[]): Record<string, string> => ({ [name]: list.join('、'), [name + 'En']: list.join(', ') })

const fmt = (v: number) => (v >= 10 ? Math.round(v).toString() : v >= 1 ? v.toFixed(1) : v.toPrecision(2))

interface Pick {
  picks: { ingredient: number; source_id: string; assembly_id: string }[]
}

export async function resolveLandscape(topic: string, deps: Deps, log: (s: string) => void = () => {}): Promise<SceneSpec> {
  log('拟定场景配方')
  const recipe = await deps.ask<Recipe>({ system: RECIPE_SYSTEM, prompt: `Topic: ${topic}`, schema: RECIPE_SCHEMA })
  const ingredients = (recipe.ingredients ?? []).slice(0, 12)
  if (ingredients.length === 0) throw new Error('没能为这个主题拟出场景配方 / Could not draw up a recipe for this topic')

  log(`为 ${ingredients.length} 种成分检索结构`)
  const perIngredient: Set<string>[] = ingredients.map(() => new Set())
  const jobs: Promise<void>[] = []
  ingredients.forEach((ing, k) => {
    for (const id of ing.suggested_pdb_ids ?? []) if (PDB_ID.test(id)) perIngredient[k]!.add(id.toUpperCase())
    // 神经相关的地标结构，作为这种成分的又一批候选 / landmark neuroscience structures, as further candidates for this ingredient
    for (const n of matchNeuro(ing.queries ?? [], 2)) perIngredient[k]!.add(n.id)
    for (const q of (ing.queries ?? []).slice(0, 2)) {
      jobs.push(
        deps.searchText(q, 4).then((ids) => ids.forEach((id) => perIngredient[k]!.add(id)), (e) => log(`检索“${q}”失败: ${e instanceof Error ? e.message : e}`)),
      )
    }
  })
  await Promise.all(jobs)
  const all = [...new Set(perIngredient.flatMap((s) => [...s]))]
  const infos = new Map<string, EntryInfo>()
  for (let i = 0; i < all.length; i += 40) for (const e of await deps.entryInfo(all.slice(i, i + 40))) infos.set(e.id, e)
  const candidates = perIngredient.map((s) => [...s].filter((id) => infos.has(id)))

  log('为每种成分选定结构')
  const usable = ingredients.map((_, k) => k).filter((k) => candidates[k]!.length > 0)
  if (usable.length === 0) throw new Error('没有为任何成分找到结构 / No structure was found for any ingredient')
  const brief = (e: EntryInfo) =>
    `  ${e.id}: ${e.title.slice(0, 110)} | ${e.method}${e.resolution ? `, ${e.resolution.toFixed(1)} Å` : ''} | assemblies ${e.assemblies.map((a) => `${a.id}[${a.chains} chains, ${a.atoms} atoms]`).join(' ')} | ${e.entities.filter((x) => x.kind !== 'ligand').map((x) => `${x.description.slice(0, 40)}${x.organism ? ` (${x.organism})` : ''}`).join('; ')}`
  const prompt = [
    `Scene: ${recipe.title}`,
    'For each ingredient choose the one structure that best shows the whole, native molecule or assembly: right organism if possible, complete, no antibody fragments or fusion partners, biological assembly.',
    '',
    ...usable.map((k) => `# ingredient ${k}: ${ingredients[k]!.name}\n${candidates[k]!.map((id) => brief(infos.get(id)!)).join('\n')}`),
  ].join('\n')
  const pick = await deps.ask<Pick>({
    system: 'You choose Protein Data Bank entries for an illustrator. Choose only from the candidates listed under each ingredient.',
    prompt,
    schema: {
      type: 'object', required: ['picks'],
      properties: {
        picks: {
          type: 'array',
          items: {
            type: 'object', required: ['ingredient', 'source_id', 'assembly_id'],
            properties: { ingredient: { type: 'integer', enum: usable }, source_id: { type: 'string', enum: all.filter((id) => infos.has(id)) }, assembly_id: { type: 'string' } },
          },
        },
      },
    },
  })

  // 实测丰度：按物种和组织查 PaxDb；查不到就都用模型的估计值
  // measured abundance: PaxDb by organism and tissue; with none, the model's estimates stand
  const pax = await deps.abundances(Number(recipe.organism_taxid) || 0, recipe.tissue || 'WHOLE_ORGANISM').catch(() => null)
  if (pax) log(`丰度取自 PaxDb：${pax.name}`)
  const measured = new Map<number, { genes: string[]; ppm: number; uM: number }>()

  const volume = BOX.width * BOX.height * BOX.depth * (recipe.membrane ? 0.5 : 1) // Å^3 per compartment
  const membraneArea = BOX.width * BOX.depth // Å^2
  const DALTON_PER_HEAVY_ATOM = 13.7 // proteins and nucleic acids, hydrogens included

  interface Chosen { k: number; id: string; assembly: string; mass: number; expected: number; inMembrane: boolean; compartment: Ingredient['compartment'] }
  const chosen: Chosen[] = []
  const skipped: string[] = []
  /** 按所给丰度不到一个拷贝的成分 / ingredients whose stated abundance gives less than one copy */
  const tooFew: string[] = []
  ingredients.forEach((ing, k) => {
    const p = (pick.picks ?? []).find((x) => x.ingredient === k)
    const id = p ? String(p.source_id).toUpperCase() : ''
    // 选中的必须是为这种成分自己查到的候选 / the choice must be one of this ingredient's own candidates
    if (!p || !candidates[k]!.includes(id)) {
      skipped.push(ing.name)
      return
    }
    const info = infos.get(id)!
    const asm = info.assemblies.find((a) => a.id === p.assembly_id) ?? info.assemblies[0]
    const inMembrane = !!recipe.membrane && ing.compartment === 'membrane'
    // 分子数 = µM * 1e-6 mol/L * 6.022e23 /mol * Å^3 * 1e-27 L/Å^3
    // molecules = µM * 1e-6 mol/L * 6.022e23 /mol * Å^3 * 1e-27 L/Å^3
    let uM = Math.max(0, ing.concentration_uM)
    if (pax && !inMembrane) {
      // 复合物的丰度取各亚基的中位数，再除以每种亚基在复合物里的份数
      // a complex takes the median over its subunits, divided by how many copies of each it holds
      const hits = (ing.genes ?? []).map((g) => [g, pax.ppm.get(String(g).toLowerCase())] as const).filter((x): x is readonly [string, number] => x[1] !== undefined && x[1] > 0)
      if (hits.length) {
        const sorted = hits.map((h) => h[1]).sort((a, b) => a - b)
        const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2
        const kinds = Math.max(1, info.entities.filter((e) => e.kind === 'protein' || e.kind === 'rna' || e.kind === 'dna').length)
        const perKind = Math.max(1, Math.round((asm?.chains ?? kinds) / kinds))
        const density = (recipe.membrane && ing.compartment === 'above' ? recipe.density_above_g_per_L : recipe.density_below_g_per_L) || 200
        uM = ppmToMicromolar(median / perKind, density)
        measured.set(k, { genes: hits.map((h) => h[0]), ppm: median, uM })
      }
    }
    const expected = inMembrane ? Math.max(0, ing.per_square_micron) * membraneArea * 1e-8 : uM * volume * 6.022e-10
    chosen.push({ k, id, assembly: asm?.id ?? 'asym', mass: (asm?.atoms || info.atoms) * DALTON_PER_HEAVY_ATOM, expected, inMembrane, compartment: recipe.membrane ? ing.compartment : 'below' })
  })

  // 列出的分子代表它们所在区室里的其余一切：把普通成分的数量整体缩放，使画出的质量与区室的总密度相符；
  // 标为主角的成分保持自己的数量。
  // The listed molecules stand in for everything else in their compartment:
  // scale the copies of the ordinary ones so the mass drawn matches the
  // compartment's overall density. Featured molecules keep their own count.
  const scale = new Map<Ingredient['compartment'], number>()
  for (const [comp, density] of [['above', recipe.density_above_g_per_L], ['below', recipe.density_below_g_per_L]] as const) {
    if (!(density > 0)) continue
    const target = Math.min(density, 400) * volume * 6.022e-4 // daltons in the compartment
    const mine = chosen.filter((c) => c.compartment === comp && !c.inMembrane)
    const fixed = mine.filter((c) => ingredients[c.k]!.feature).reduce((s, c) => s + Math.max(1, Math.round(c.expected)) * c.mass, 0)
    const free = mine.filter((c) => !ingredients[c.k]!.feature).reduce((s, c) => s + c.expected * c.mass, 0)
    if (free > 0 && target > fixed) scale.set(comp, (target - fixed) / free)
  }

  const panels: PanelSpec[] = []
  const out: Ingredient[] = []
  for (const c of chosen) {
    const ing = ingredients[c.k]!
    const info = infos.get(c.id)!
    const f = c.inMembrane || ing.feature ? 1 : (scale.get(c.compartment) ?? 1)
    const copies = Math.min(600, Math.max(ing.feature ? 1 : 0, Math.round(c.expected * f)))
    if (copies === 0) {
      tooFew.push(ing.name)
      continue
    }
    const role: Role = (ROLES as string[]).includes(ing.role) ? (ing.role as Role) : 'soluble'
    const ref: SourceRef = { id: c.id, kind: 'pdb', title: info.title, method: info.method, resolution: info.resolution, year: info.year }
    panels.push({
      label: ing.name,
      source: ref,
      assembly: c.assembly,
      entities: info.entities.map((e) => ({
        entityId: e.entityId,
        role: e.kind === 'dna' || e.kind === 'rna' ? (role === 'nucleic-binding' || role === 'focus' ? role : 'nucleic') : e.kind === 'glycan' ? 'glycan' : role,
        name: e.description, description: e.description, organism: e.organism,
      })),
      reason: '',
    })
    out.push({
      panel: panels.length - 1,
      compartment: c.compartment,
      copies,
      // 只给数值，文字由网页端按界面语言写（src/i18n.ts 的 abundance.*）
      // figures only; the web app words them in the interface language (abundance.* in src/i18n.ts)
      abundance: c.inMembrane
        ? { key: 'abundance.perArea', params: { n: ing.per_square_micron } }
        : measured.has(c.k)
          ? { key: 'abundance.paxdb', params: { ...names('genes', measured.get(c.k)!.genes), ppm: Math.round(measured.get(c.k)!.ppm).toLocaleString('en'), uM: fmt(measured.get(c.k)!.uM) } }
          : { key: 'abundance.concentration', params: { uM: ing.concentration_uM } },
      tier: !c.inMembrane && measured.has(c.k) ? 'curated' : 'estimated',
      feature: !!ing.feature,
      ...(c.inMembrane
        ? {
            anchor: ing.membrane_anchor === 'above' || ing.membrane_anchor === 'below' ? ing.membrane_anchor : ('spans' as const),
            ...(ing.membrane_terminus === 'N' || ing.membrane_terminus === 'C' ? { terminus: ing.membrane_terminus } : {}),
          }
        : {}),
    })
  }
  if (panels.length === 0) throw new Error('配方里的成分都没有找到可用的结构 / None of the ingredients in the recipe has a usable structure')

  const outer = recipe.membrane_outer_side === 'below' ? ('below' as const) : ('above' as const)
  // DNA 的总长度：密度（百万碱基对/立方微米）x 体积 x 每对 3.4 Å，封顶在十倍画面宽度
  // total DNA length: density (million base pairs per cubic micron) x volume x 3.4 Å per pair, capped at ten frame widths
  const mbp = Math.max(0, Math.min(60, Number(recipe.dna_megabases_per_cubic_micron) || 0))
  const dnaLength = Math.min(BOX.width * 10, mbp * 1e6 * 3.4 * volume * 1e-12)
  const dna = dnaLength >= 300 ? { length: Math.round(dnaLength), basis: `${mbp} Mbp/μm³` } : undefined
  const landscape: LandscapeSpec = { ...BOX, membrane: !!recipe.membrane, ...(recipe.membrane ? { outer, ...(membraneData.membranes.some((m) => m.id === recipe.membrane_type) ? { membraneType: recipe.membrane_type } : {}) } : {}), ...(dna ? { dna } : {}), above: recipe.above ?? '', below: recipe.below ?? '', ingredients: out }
  // 代码写的说明只给字典键和参数，文字在 src/i18n.ts，由网页端按界面语言写出；模型写的说明是原样的字符串
  // code-written notes carry a dictionary key and parameters only; the text is in src/i18n.ts and the web app words it in the interface language. Model-written notes stay plain strings
  const rest = chosen.length - measured.size
  const densityAbove = recipe.membrane && recipe.density_above_g_per_L > 0 ? recipe.density_above_g_per_L : 0
  const densityBelow = recipe.density_below_g_per_L > 0 ? recipe.density_below_g_per_L : 0
  const scaled: Note =
    densityAbove && densityBelow
      ? { key: 'note.land.scaled.both', params: { above: densityAbove, below: densityBelow } }
      : densityAbove
        ? { key: 'note.land.scaled.above', params: { above: densityAbove } }
        : densityBelow
          ? recipe.membrane
            ? { key: 'note.land.scaled.below', params: { below: densityBelow } }
            : { key: 'note.land.scaled.whole', params: { below: densityBelow } }
          : { key: 'note.land.scaled.none' }
  const notes: Note[] = [
    { key: 'note.land.random' },
    pax && measured.size
      ? rest > 0
        ? { key: 'note.land.paxdb', params: { measured: measured.size, dataset: pax.name, rest } }
        : { key: 'note.land.paxdbAll', params: { measured: measured.size, dataset: pax.name } }
      : { key: 'note.land.estimated' },
    scaled,
    ...(recipe.membrane ? [{ key: 'note.land.membranePlacement' }] : []),
    ...(dna ? [{ key: 'note.land.dna', params: { mbp, pairs: Math.round(dna.length / 3.4) } }] : []),
    { key: dna ? 'note.land.omittedWithDna' : 'note.land.omitted' },
    ...(skipped.length ? [{ key: 'note.land.notDrawn', params: names('names', skipped) }] : []),
    ...(tooFew.length ? [{ key: 'note.land.tooFew', params: names('names', tooFew) }] : []),
    ...(recipe.notes ?? []).filter((n) => typeof n === 'string' && n.trim()),
  ]
  return { topic, kind: 'landscape', title: recipe.title?.trim() || topic, caption: recipe.caption?.trim() ?? '', panels, notes, landscape }
}
