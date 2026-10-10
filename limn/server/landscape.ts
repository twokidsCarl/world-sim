/**
 * Topic -> crowded cellular scene. The model writes a recipe (which
 * molecules, where, how abundant); code finds real structures for each
 * ingredient; the model picks one per ingredient from what was found.
 * Abundances are the model's estimates and are reported as such.
 */
import type { Ingredient, LandscapeSpec, PanelSpec, SceneSpec, SourceRef } from '../src/scene/spec'
import { ROLES, type Role } from '../src/style/palettes'
import type { Deps } from './resolve'
import type { EntryInfo } from './sources/rcsb'

/** The slab that is drawn: 80 x 56 nm of cell, 30 nm deep. */
export const BOX = { width: 800, height: 560, depth: 300 }
const PDB_ID = /^[0-9][A-Za-z0-9]{3}$/

interface Recipe {
  title: string
  caption: string
  membrane: boolean
  above: string
  below: string
  density_above_g_per_L: number
  density_below_g_per_L: number
  notes: string[]
  ingredients: {
    name: string
    compartment: Ingredient['compartment']
    concentration_uM: number
    per_square_micron: number
    membrane_anchor: string
    membrane_terminus: string
    feature: boolean
    role: string
    queries: string[]
    suggested_pdb_ids: string[]
  }[]
}

const RECIPE_SCHEMA = {
  type: 'object',
  required: ['title', 'caption', 'membrane', 'above', 'below', 'density_above_g_per_L', 'density_below_g_per_L', 'notes', 'ingredients'],
  properties: {
    title: { type: 'string', description: 'language of the topic' },
    caption: { type: 'string', description: '2-4 sentences, language of the topic: where in the cell this is and what is going on. Name parts by what they are.' },
    membrane: { type: 'boolean', description: 'true if a lipid bilayer crosses the scene horizontally' },
    above: { type: 'string', description: 'what is above the membrane (e.g. extracellular space, blood plasma); empty if no membrane' },
    below: { type: 'string', description: 'what is below the membrane, or the whole scene if there is no membrane (e.g. cytoplasm)' },
    density_above_g_per_L: { type: 'number', description: 'total macromolecule concentration above the membrane, grams per litre (blood plasma is about 70-80); 0 if no membrane' },
    density_below_g_per_L: { type: 'number', description: 'total macromolecule concentration below the membrane, or of the whole scene (bacterial cytoplasm is about 300, eukaryotic cytosol about 100-200)' },
    notes: { type: 'array', items: { type: 'string' }, description: 'what is simplified or left out, language of the topic' },
    ingredients: {
      type: 'array', minItems: 4, maxItems: 12,
      items: {
        type: 'object',
        required: ['name', 'compartment', 'concentration_uM', 'per_square_micron', 'membrane_anchor', 'membrane_terminus', 'feature', 'role', 'queries', 'suggested_pdb_ids'],
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
- Give each a realistic abundance from the literature for this organism and compartment. These numbers decide how many copies are drawn, so be honest: if a molecule is rare, give its real, low value and mark it as a feature so it still appears once.
- A real compartment holds thousands of kinds of molecule and you can list only a dozen. The listed ones stand in for the rest: their relative proportions come from your abundances, and the number of copies is then scaled so that the total mass drawn matches the compartment's overall macromolecule density, which you also give. Molecules marked as a feature are not scaled.
- Only include molecules for which an experimental structure of the whole molecule or assembly plausibly exists in the PDB. Nucleic acid strands and long fibres cannot be drawn yet; leave them out and say so in the notes.
- Colour roles: focus (pink-magenta) for the subject; soluble (blue) for ordinary soluble proteins; membrane (green) for membrane proteins; nucleic-binding (orange) for ribosomes, polymerases and other nucleic-acid machines; extracellular (tan) for molecules outside the cell. Use the roles to separate inside from outside and the subject from its surroundings.
- In the notes, say what a reader should not over-interpret: positions and orientations are random, abundances are estimates.`

interface Pick {
  picks: { ingredient: number; source_id: string; assembly_id: string }[]
}

export async function resolveLandscape(topic: string, deps: Deps, log: (s: string) => void = () => {}): Promise<SceneSpec> {
  log('拟定场景配方')
  const recipe = await deps.ask<Recipe>({ system: RECIPE_SYSTEM, prompt: `Topic: ${topic}`, schema: RECIPE_SCHEMA })
  const ingredients = (recipe.ingredients ?? []).slice(0, 12)
  if (ingredients.length === 0) throw new Error('没能为这个主题拟出场景配方')

  log(`为 ${ingredients.length} 种成分检索结构`)
  const perIngredient: Set<string>[] = ingredients.map(() => new Set())
  const jobs: Promise<void>[] = []
  ingredients.forEach((ing, k) => {
    for (const id of ing.suggested_pdb_ids ?? []) if (PDB_ID.test(id)) perIngredient[k]!.add(id.toUpperCase())
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
  if (usable.length === 0) throw new Error('没有为任何成分找到结构')
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

  const volume = BOX.width * BOX.height * BOX.depth * (recipe.membrane ? 0.5 : 1) // Å^3 per compartment
  const membraneArea = BOX.width * BOX.depth // Å^2
  const DALTON_PER_HEAVY_ATOM = 13.7 // proteins and nucleic acids, hydrogens included

  interface Chosen { k: number; id: string; assembly: string; mass: number; expected: number; inMembrane: boolean; compartment: Ingredient['compartment'] }
  const chosen: Chosen[] = []
  const skipped: string[] = []
  ingredients.forEach((ing, k) => {
    const p = (pick.picks ?? []).find((x) => x.ingredient === k)
    const id = p ? String(p.source_id).toUpperCase() : ''
    // the choice must be one of this ingredient's own candidates
    if (!p || !candidates[k]!.includes(id)) {
      skipped.push(ing.name)
      return
    }
    const info = infos.get(id)!
    const asm = info.assemblies.find((a) => a.id === p.assembly_id) ?? info.assemblies[0]
    const inMembrane = !!recipe.membrane && ing.compartment === 'membrane'
    // molecules = µM * 1e-6 mol/L * 6.022e23 /mol * Å^3 * 1e-27 L/Å^3
    const expected = inMembrane ? Math.max(0, ing.per_square_micron) * membraneArea * 1e-8 : Math.max(0, ing.concentration_uM) * volume * 6.022e-10
    chosen.push({ k, id, assembly: asm?.id ?? 'asym', mass: (asm?.atoms || info.atoms) * DALTON_PER_HEAVY_ATOM, expected, inMembrane, compartment: recipe.membrane ? ing.compartment : 'below' })
  })

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
      skipped.push(`${ing.name}（按所给丰度，这么小的体积里不到一个）`)
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
      abundance: c.inMembrane ? `约 ${ing.per_square_micron} 个/μm²` : `约 ${ing.concentration_uM} μM`,
      feature: !!ing.feature,
      ...(c.inMembrane
        ? {
            anchor: ing.membrane_anchor === 'above' || ing.membrane_anchor === 'below' ? ing.membrane_anchor : ('spans' as const),
            ...(ing.membrane_terminus === 'N' || ing.membrane_terminus === 'C' ? { terminus: ing.membrane_terminus } : {}),
          }
        : {}),
    })
  }
  if (panels.length === 0) throw new Error('配方里的成分都没有找到可用的结构')

  const landscape: LandscapeSpec = { ...BOX, membrane: !!recipe.membrane, above: recipe.above ?? '', below: recipe.below ?? '', ingredients: out }
  const notes = [
    '分子是真实结构，按比例绘制；它们的位置和朝向是程序随机排布的，不是观测结果。',
    '各成分之间的比例来自模型给出的丰度估计值，不是测量值。',
    `真实的细胞里有上千种分子，这里只列出十来种作为代表：除标为主角的成分外，数量已按比例放大，使画出的总质量与该区室的大分子总浓度（${[recipe.membrane && recipe.density_above_g_per_L > 0 ? `膜上方约 ${recipe.density_above_g_per_L} g/L` : '', recipe.density_below_g_per_L > 0 ? `${recipe.membrane ? '膜下方' : ''}约 ${recipe.density_below_g_per_L} g/L` : ''].filter(Boolean).join('，')}）相符。`,
    ...(recipe.membrane ? ['膜蛋白按分子长轴竖立在膜上或膜中；只解析了膜外段的结构立在膜面上，连膜的一端由链的末端位置判断。这是近似摆放，未使用实验确定的取向和插入深度，膜外段与膜之间缺失的柄部和跨膜段没有画。脂质用同一种磷脂（POPC）的理想构象铺成。'] : []),
    '未画出水、离子、小分子，以及核酸长链和纤维。',
    ...(skipped.length ? [`未能画出：${skipped.join('、')}。`] : []),
    ...(recipe.notes ?? []).filter((n) => typeof n === 'string' && n.trim()),
  ]
  return { topic, kind: 'landscape', title: recipe.title?.trim() || topic, caption: recipe.caption?.trim() ?? '', panels, notes, landscape }
}
