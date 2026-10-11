/**
 * 看、评、调、再来：评审（claude，经本地服务器）看到的是实际的渲染结果，
 * 并以呈现方式的编辑作答。场景里的结构在这里绝不会被改动。
 * Look, judge, adjust, repeat: the reviewer (claude, through the local
 * server) is shown the actual render and answers with presentation edits.
 * The scene's structures are never touched here.
 */
import * as api from '../api'
import type { Mat3 } from '../render/camera'
import type { Renderer } from '../render/Renderer'
import { useStore, type Look, type Round } from '../state/store'
import { hex } from '../style/oklab'
import { ROLES } from '../style/palettes'
import { t, errorNote } from '../i18n'
import { renderFigure } from '../render/export'
import { stage, viewFor } from '../ui/Stage'
import { sanitizeEdits, type Edit } from './edits'
import { describeMetrics, measure } from './metrics'
import { candidateViews } from './views'

const REVIEW_SIDE = 1024

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(b)
  })
}

/** 按评审尺寸把当前外观渲染成成品图 / Render the current look as the finished figure, at review size. */
async function capture(r: Renderer, look: Look): Promise<{ px: Uint8ClampedArray; w: number; h: number; image: string }> {
  const f = renderFigure(r, look, REVIEW_SIDE)
  return { px: f.pixels, w: f.w, h: f.h, image: await blobToDataUrl(await f.canvas.convertToBlob({ type: 'image/png' })) }
}

/** 给评审看的画面内容：带 id 的面板和实体 / What is in the picture, for the reviewer: panels and entities with ids. */
export function describeContents(): string {
  const s = useStore.getState()
  const lines: string[] = []
  if (s.spec?.caption) lines.push(s.spec.caption, '')
  const land = s.spec?.landscape
  if (land) {
    lines.push(
      `A cross-section ${land.width / 10} x ${land.height / 10} nm, ${land.depth / 10} nm deep. ` +
        (land.membrane ? `A membrane runs across the middle; above it: ${land.above}; below it: ${land.below}.` : `It shows: ${land.below}.`),
      'Each "panel" below is one kind of molecule, scattered through the scene in the number of copies given.',
      '',
    )
  }
  if (s.spec?.mesoscale) {
    // 介观模型：说明它是什么、现在切了多少 / a mesoscale model: say what it is and how far it is cut open
    lines.push(
      'This is a published whole model (an entire virion, vesicle or cell) built from many structures. Every copy of every molecule is outlined on its own; the membrane is one sheet.',
      s.cut > 0 ? `It is drawn cut open: the front ${Math.round(s.cut * 100)}% of its depth is removed (edit "cut", 0 = whole).` : 'It is drawn whole (edit "cut" to open it, e.g. 0.5 for a section through the middle).',
      '',
    )
  }
  s.panels.forEach((p, i) => {
    const ing = land?.ingredients.find((x) => x.panel === i)
    lines.push(`panel ${i}: ${p.spec.label} — ${p.spec.source.id}, ${p.spec.source.title}${ing ? ` — ${s.placed[i] ?? ing.copies} copies, ${ing.compartment === 'membrane' ? 'in the membrane' : ing.compartment + ' the membrane'}` : ''}`)
    // 整细胞模型有几百种分子，只列原子最多的那些 / a whole-cell model has hundreds of kinds; list only the largest
    const size = p.mol.entities.map(() => 0)
    for (const c of p.mol.chains) size[c.entity]! += c.count
    const shown = new Set(size.map((n, k) => [n, k] as const).sort((a, b) => b[0] - a[0]).slice(0, 40).map(([, k]) => k))
    if (shown.size < p.mol.entities.length) lines.push(`  (${p.mol.entities.length} kinds of molecule; the ${shown.size} largest are listed)`)
    p.mol.entities.forEach((e, k) => {
      if (!shown.has(k)) return
      const name = p.spec.entities.find((x) => x.entityId === e.id)?.name ?? e.description
      const chains = p.mol.chains.filter((c) => c.entity === k).length
      lines.push(`  entity ${e.id}: ${name} (${e.kind}, ${chains} chain${chains === 1 ? '' : 's'}) — role ${s.colorings[i]?.roles[k]}`)
    })
  })
  return lines.join('\n')
}

function describeSettings(look: Look): string {
  const st = look.style
  return [
    `line_width ${st.lineWidth}`,
    `inner_lines ${st.contour.diffMax}`,
    `shadow_strength ${st.shadow.strength}, shadow_floor ${st.shadow.floor}`,
    `fog_back ${st.fog.back}`,
    `background ${hex(st.background)}`,
    `zoom ${look.zoom.toFixed(2)}`,
    `roles available: ${ROLES.join(', ')}`,
  ].join('\n')
}

/** 一次给评审看十二个方向，取它选中的那个 / Show the reviewer twelve directions at once and take its pick. */
async function chooseView(r: Renderer, look: Look, title: string): Promise<{ rot: Mat3; reason: string; sheet: string }> {
  const views = candidateViews(r.bounds)
  const cols = 4, cell = 300
  const rows = Math.ceil(views.length / cols)
  const sheet = new OffscreenCanvas(cols * cell, rows * cell)
  const ctx = sheet.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, sheet.width, sheet.height)
  views.forEach((rot, k) => {
    const v = { ...look, rot, zoom: 1, shift: [0, 0] as [number, number] }
    const px = r.renderPixels(viewFor(r, v, 1), look.style, cell, cell)
    const x = (k % cols) * cell, y = Math.floor(k / cols) * cell
    ctx.putImageData(new ImageData(px as Uint8ClampedArray<ArrayBuffer>, cell, cell), x, y)
    ctx.strokeStyle = '#bbb'
    ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1)
    ctx.fillStyle = '#000'
    ctx.font = 'bold 26px sans-serif'
    ctx.fillText(String(k + 1), x + 10, y + 30)
  })
  const image = await blobToDataUrl(await sheet.convertToBlob({ type: 'image/png' }))
  const pick = await api.pickView({ image, count: views.length, title, contents: describeContents() })
  const index = Number.isInteger(pick.index) && pick.index >= 1 && pick.index <= views.length ? pick.index : 1
  return { rot: views[index - 1]!, reason: pick.reason, sheet: image }
}

export interface RefineOptions {
  maxRounds: number
  /** 用户自己的要求；在第一轮应用 / the user's own request; applied in the first round */
  feedback: string
  /** 先从缩略图拼版中选一个观察方向 / start by choosing a viewing direction from a contact sheet */
  chooseView: boolean
}

/**
 * 运行循环，最后让 store 停在得分最高的外观上。每一轮都记在 `rounds` 里，
 * 用户可以退回到任意一轮。
 * Runs the loop and leaves the store on the best-scoring look. Each round is
 * recorded in `rounds` so the user can step back to any of them.
 */
export async function refine(opts: RefineOptions): Promise<void> {
  const store = useStore
  const r = stage.renderer
  const s0 = store.getState()
  if (!r || s0.panels.length === 0 || s0.refining) return
  const title = s0.spec?.title ?? ''
  const say = (refining: string) => store.setState({ refining })
  const rounds: Round[] = store.getState().rounds.slice()
  const push = (round: Round) => {
    rounds.push(round)
    store.setState({ rounds: rounds.slice() })
  }

  try {
    if (opts.chooseView) {
      say(t('refine.comparing'))
      const pick = await chooseView(r, store.getState().getLook(), title)
      store.getState().setLook({ rot: pick.rot, zoom: 1, shift: [0, 0] })
      push({ image: pick.sheet, overall: null, scores: null, comment: t('refine.viewChosen', { reason: pick.reason }), edits: [], look: store.getState().getLook() })
    }

    const entityIds = () => store.getState().panels.map((p) => p.mol.entities.map((e) => e.id))
    const history: string[] = []
    let drops = 0
    let prev = -Infinity
    for (let k = 0; k <= opts.maxRounds; k++) {
      const scoringOnly = k === opts.maxRounds
      say(scoringOnly ? t('refine.finalScore') : t('refine.round', { n: k + 1 }))
      const look = store.getState().getLook()
      const shot = await capture(r, look)
      const image = shot.image
      const reply = await api.critique({
        image,
        title,
        contents: describeContents(),
        settings: describeSettings(look),
        metrics: describeMetrics(measure(shot.px, shot.w, shot.h, look.style.background)),
        history: history.join('\n'),
        feedback: k === 0 ? opts.feedback : '',
        mode: store.getState().spec?.landscape ? 'landscape' : 'molecule',
      })
      const edits: Edit[] = scoringOnly ? [] : sanitizeEdits(reply.edits, entityIds())
      push({ image, overall: reply.overall, scores: reply.scores, comment: reply.comment, edits, look })
      history.push(`round ${k + 1}: overall ${reply.overall}. ${edits.length ? 'then changed: ' + JSON.stringify(edits) : 'no changes made'}`)
      drops = reply.overall < prev ? drops + 1 : 0
      prev = reply.overall
      if (scoringOnly || reply.done || edits.length === 0 || drops >= 2) break
      store.getState().applyEdits(edits)
    }

    // 让画面停在见过的最好版本上，不一定是最后一个。
    // Leave the picture on the best version seen, not necessarily the last.
    const scored = rounds.filter((x) => x.overall !== null)
    const best = scored.reduce<Round | null>((a, b) => (!a || b.overall! > a.overall! ? b : a), null)
    if (best) store.getState().setLook(structuredClone(best.look))
  } catch (e) {
    store.setState({ error: errorNote(e) })
  } finally {
    say('')
    // 离屏渲染按它们自己的画幅排布了面板；重画舞台
    // off-screen renders laid the panels out for their own frame; redraw the stage
    store.setState((x) => ({ drawRev: x.drawRev + 1 }))
  }
}
