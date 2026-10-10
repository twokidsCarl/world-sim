/**
 * The reviewer: the model looks at a rendered image and answers with scores,
 * a comment and a list of presentation edits (src/refine/edits.ts).
 */
import { EDIT_SCHEMA } from '../src/refine/edits'
import { ask as realAsk, type AskOptions } from './llm'

type Ask = <T>(o: AskOptions) => Promise<T>

export interface CritiqueRequest {
  /** PNG bytes of the current render */
  image: Uint8Array
  title: string
  /** what is in the picture: panels, entities with ids and current roles */
  contents: string
  /** current values of everything the reviewer may change */
  settings: string
  /** numbers measured from the image */
  metrics: string
  /** earlier rounds: what was changed and how it scored */
  history: string
  /** the user's own request for this round, if any */
  feedback: string
  mode: 'molecule' | 'landscape'
}

export interface Critique {
  scores: { composition: number; color: number; line: number; depth: number; readability: number }
  overall: number
  comment: string
  edits: unknown[]
  done: boolean
}

const SCORE = { type: 'number', minimum: 1, maximum: 10 }
const SCHEMA = {
  type: 'object',
  required: ['scores', 'overall', 'comment', 'edits', 'done'],
  properties: {
    scores: {
      type: 'object',
      required: ['composition', 'color', 'line', 'depth', 'readability'],
      properties: { composition: SCORE, color: SCORE, line: SCORE, depth: SCORE, readability: SCORE },
    },
    overall: { ...SCORE, description: 'how close this is to a picture Goodsell would publish; 8 or more means ready' },
    comment: { type: 'string', description: '2-4 sentences, in Chinese: what works, what is the main problem, what you are changing and why' },
    edits: { type: 'array', maxItems: 6, items: EDIT_SCHEMA, description: 'the changes to make now; empty if the picture is ready' },
    done: { type: 'boolean', description: 'true when further edits would not improve it' },
  },
}

const SYSTEM = `You are the art director for scientific illustrations in the style of David S. Goodsell (RCSB PDB "Molecule of the Month").
First read the image file render.png with the Read tool. Judge what you actually see, not what the settings say.

The style, which the picture must follow:
- Flat colour only. Every atom is a flat disc; there are no highlights and no shading that follows surface direction.
- Black outlines. The outer silhouette and the boundaries between subunits are continuous, even lines. Inside one subunit there are only a few short lines where the surface steps sharply in depth. Too many inner lines turn the picture grey and scratchy; too few make it a featureless blob.
- Colour by function. Parts that do different jobs have clearly different hues; copies of the same subunit differ only slightly. One part is the focus and carries the strongest, warmest colour. Colours are bright but not garish.
- Soft shadow in crevices gives depth. It should model the form without muddying the colours.
- Composition: the subject fills the frame with a small even margin, is centred, and is turned so that the functionally important part faces the viewer: a binding interface, an active site, the symmetry axis of a ring, the long axis of a fibre across the frame. Membrane proteins stand upright with the membrane horizontal. Tall subjects stand upright.
- Scientific readability: someone who knows the molecule should recognise it and see the point of the picture.

When the mode is "landscape", the picture is a crowded cross-section of a cell instead of one molecule, and these replace the points above where they differ:
- The frame is filled edge to edge with molecules at their real concentrations; molecules run off the edges. There is no margin and no single subject to centre, so ignore the "fill" numbers.
- Ink lines separate whole molecules only. Molecules further back are darker, fading towards black, in about three depth layers that should read clearly: bright foreground, a darker middle, a deepest layer that is nearly black but still has a hint of its hue.
- Colour separates compartments and kinds of molecule; the subject of the picture carries the warmest, brightest colour and its surroundings recede into cooler or greyer hues. Colours are greyer than in a single-molecule picture.
- Rhythm: crowded but not chaotic; no large empty holes, no part where everything is one colour.
- You cannot rotate a landscape; rotate edits will have no useful effect. Change colours (set_role, hue_shift), lines, shadow, depth fading (fog_back: lower = darker background layers) and zoom/pan to choose the crop.

Scoring, 1-10 each: composition, color, line, depth, readability; and overall.
Be a demanding but practical reviewer. Do not hand out 9s on the first look, and do not keep changing a picture that is already good.

Edits: you may only change presentation, using the listed operations. You cannot change which structures are shown.
- Make few, purposeful edits per round (at most 6). Prefer the one change that fixes the biggest problem.
- Rotation is relative to the current view. Use it deliberately: say in the comment what you expect to come into view.
- Use the measured numbers as evidence: "fill" is the share of the frame's height and width the subject spans (aim for 0.80-0.92 on the tighter axis), "ink" is the share of pixels that are outline (molecule pictures by Goodsell are about 0.03; above 0.08 is too heavy).
- If the user gave a request, carry it out first; it outranks your own preferences.
- If earlier rounds are listed, do not repeat a change that lowered the score, and do not undo one that raised it.`

export function critique(req: CritiqueRequest, ask: Ask = realAsk): Promise<Critique> {
  const prompt = [
    `Picture: ${req.title}`,
    `Mode: ${req.mode}`,
    '',
    '# What is shown',
    req.contents,
    '',
    '# Current settings',
    req.settings,
    '',
    '# Measured from the image',
    req.metrics,
    req.history ? `\n# Earlier rounds\n${req.history}` : '',
    req.feedback ? `\n# Request from the user (do this first)\n${req.feedback}` : '',
    '',
    'Read render.png, then review it.',
  ].join('\n')
  return ask<Critique>({ system: SYSTEM, prompt, schema: SCHEMA, images: [{ name: 'render.png', data: req.image }], cache: false })
}

const PICK_SCHEMA = {
  type: 'object',
  required: ['index', 'reason'],
  properties: {
    index: { type: 'integer', description: 'the number printed on the chosen view' },
    reason: { type: 'string', description: 'one sentence, in Chinese' },
  },
}

const PICK_SYSTEM = `You are choosing the viewing direction for a scientific illustration in the style of David S. Goodsell.
Read the image file views.png with the Read tool. It is a contact sheet of the same subject seen from numbered directions.
Pick the one that best shows what the subject is: its overall shape and symmetry, how its subunits are arranged, and above all the functionally important part named in the description (binding interface, active site, bound nucleic acid or ligand) facing the viewer and not hidden.
Prefer views where differently coloured parts are all visible and overlap little. Avoid views straight down a long axis that foreshorten the subject into a blob, unless the subject is a ring or a channel whose symmetry is the point.`

export function pickView(image: Uint8Array, count: number, title: string, contents: string, ask: Ask = realAsk): Promise<{ index: number; reason: string }> {
  const prompt = `Subject: ${title}\n\n# What is shown\n${contents}\n\nThe sheet has views numbered 1 to ${count}. Read views.png and choose one.`
  return ask({ system: PICK_SYSTEM, prompt, schema: PICK_SCHEMA, images: [{ name: 'views.png', data: image }], cache: false })
}
