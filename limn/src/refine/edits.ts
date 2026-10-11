import { ROLES, type Role } from '../style/palettes'

/**
 * 评审可以改什么。这里的一切都是呈现方式：相机、颜色角色、线条和阴影设置。
 * 这里没有任何东西能改变显示哪些结构，或它们的原子在哪里。
 * What a reviewer may change. Everything here is presentation: the camera,
 * colour roles, line and shadow settings. Nothing here can change which
 * structures are shown or where their atoms are.
 */
export type Edit =
  | { op: 'rotate'; axis: 'x' | 'y' | 'z'; degrees: number }
  | { op: 'zoom'; factor: number }
  | { op: 'pan'; dx: number; dy: number }
  | { op: 'set_role'; panel: number; entity_id: string; role: Role }
  | { op: 'hue_shift'; panel: number; entity_id: string; degrees: number }
  | { op: 'cut'; value: number }
  | { op: 'line_width'; value: number }
  | { op: 'inner_lines'; value: number }
  | { op: 'shadow_strength'; value: number }
  | { op: 'shadow_floor'; value: number }
  | { op: 'fog_back'; value: number }
  | { op: 'background'; hex: string }

export const EDIT_OPS = ['rotate', 'zoom', 'pan', 'set_role', 'hue_shift', 'cut', 'line_width', 'inner_lines', 'shadow_strength', 'shadow_floor', 'fog_back', 'background'] as const

/** 评审写出的一条编辑的 JSON Schema：扁平，字段随 op 而定 / JSON Schema for one edit as the reviewer writes it: flat, fields by op. */
export const EDIT_SCHEMA = {
  type: 'object',
  required: ['op'],
  properties: {
    op: { type: 'string', enum: EDIT_OPS },
    axis: { type: 'string', enum: ['x', 'y', 'z'], description: 'rotate: screen axis. x = tip top toward/away from viewer, y = turn left/right, z = spin in the picture plane' },
    degrees: { type: 'number', description: 'rotate: -180..180. hue_shift: -40..40' },
    factor: { type: 'number', description: 'zoom: >1 makes the subject larger, 0.5..2' },
    dx: { type: 'number', description: 'pan: move the subject right by this share of the frame width, -0.5..0.5' },
    dy: { type: 'number', description: 'pan: move the subject up by this share of the frame height, -0.5..0.5' },
    panel: { type: 'integer', description: 'set_role, hue_shift: panel number, starting at 0' },
    entity_id: { type: 'string', description: 'set_role, hue_shift: entity id as listed' },
    role: { type: 'string', enum: ROLES },
    value: {
      type: 'number',
      description: 'cut 0..0.9 (share of the depth cut away from the front, to look inside; 0 = whole, 0.5 = through the middle). line_width 0.5..3 (1 = default pen). inner_lines 1..60 (depth step in Å that draws a line; larger = fewer lines inside a subunit). shadow_strength 0..0.006. shadow_floor 0.4..1 (darkest shadow as a share of full colour). fog_back 0.4..1 (colour kept at the far side; 1 = no fading)',
    },
    hex: { type: 'string', description: 'background: #RRGGBB' },
  },
}

const clamp = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null)

/** `entities[panel]` 列出该面板的实体 id / `entities[panel]` lists the entity ids of that panel. */
export function sanitizeEdits(raw: unknown, entities: string[][]): Edit[] {
  if (!Array.isArray(raw)) return []
  const out: Edit[] = []
  for (const r of raw.slice(0, 12)) {
    if (!r || typeof r !== 'object') continue
    const e = r as Record<string, unknown>
    const target = (): { panel: number; entity_id: string } | null => {
      const panel = typeof e.panel === 'number' && Number.isInteger(e.panel) ? e.panel : entities.length === 1 ? 0 : -1
      const id = String(e.entity_id ?? '')
      return entities[panel]?.includes(id) ? { panel, entity_id: id } : null
    }
    switch (e.op) {
      case 'rotate': {
        const d = clamp(e.degrees, -180, 180)
        if (d !== null && d !== 0 && (e.axis === 'x' || e.axis === 'y' || e.axis === 'z')) out.push({ op: 'rotate', axis: e.axis, degrees: d })
        break
      }
      case 'zoom': {
        const f = clamp(e.factor, 0.5, 2)
        if (f !== null && f !== 1) out.push({ op: 'zoom', factor: f })
        break
      }
      case 'pan': {
        const dx = clamp(e.dx ?? 0, -0.5, 0.5), dy = clamp(e.dy ?? 0, -0.5, 0.5)
        if (dx !== null && dy !== null && (dx || dy)) out.push({ op: 'pan', dx, dy })
        break
      }
      case 'set_role': {
        const t = target()
        if (t && (ROLES as string[]).includes(String(e.role))) out.push({ op: 'set_role', ...t, role: e.role as Role })
        break
      }
      case 'hue_shift': {
        const t = target(), d = clamp(e.degrees, -40, 40)
        if (t && d !== null) out.push({ op: 'hue_shift', ...t, degrees: d })
        break
      }
      case 'cut': push(out, 'cut', clamp(e.value, 0, 0.9)); break
      case 'line_width': push(out, 'line_width', clamp(e.value, 0.5, 3)); break
      case 'inner_lines': push(out, 'inner_lines', clamp(e.value, 1, 60)); break
      case 'shadow_strength': push(out, 'shadow_strength', clamp(e.value, 0, 0.006)); break
      case 'shadow_floor': push(out, 'shadow_floor', clamp(e.value, 0.4, 1)); break
      case 'fog_back': push(out, 'fog_back', clamp(e.value, 0.4, 1)); break
      case 'background':
        if (typeof e.hex === 'string' && /^#[0-9a-f]{6}$/i.test(e.hex)) out.push({ op: 'background', hex: e.hex })
        break
    }
  }
  return out
}

function push(out: Edit[], op: 'cut' | 'line_width' | 'inner_lines' | 'shadow_strength' | 'shadow_floor' | 'fog_back', value: number | null) {
  if (value !== null) out.push({ op, value })
}
