import { describe, expect, it } from 'vitest'
import { sanitizeEdits } from '../src/refine/edits'

const ENTITIES = [['1', '2'], ['1']]

describe('sanitizeEdits', () => {
  it('keeps valid edits and clamps their numbers', () => {
    expect(
      sanitizeEdits(
        [
          { op: 'rotate', axis: 'y', degrees: 400 },
          { op: 'zoom', factor: 9 },
          { op: 'line_width', value: 0.1 },
          { op: 'shadow_floor', value: 0.9 },
          { op: 'background', hex: '#FAFAF5' },
        ],
        ENTITIES,
      ),
    ).toEqual([
      { op: 'rotate', axis: 'y', degrees: 180 },
      { op: 'zoom', factor: 2 },
      { op: 'line_width', value: 0.5 },
      { op: 'shadow_floor', value: 0.9 },
      { op: 'background', hex: '#FAFAF5' },
    ])
  })

  it('drops anything that is not on the list', () => {
    expect(
      sanitizeEdits(
        [
          { op: 'set_source', panel: 0, source_id: '1ABC' },
          { op: 'set_assembly', value: 2 },
          { op: 'rotate', axis: 'w', degrees: 10 },
          { op: 'background', hex: 'url(javascript:1)' },
          { op: 'zoom', factor: 'big' },
          'rotate',
          null,
        ],
        ENTITIES,
      ),
    ).toEqual([])
  })

  it('only recolours entities that exist in that panel', () => {
    expect(
      sanitizeEdits(
        [
          { op: 'set_role', panel: 0, entity_id: '2', role: 'nucleic' },
          { op: 'set_role', panel: 1, entity_id: '2', role: 'nucleic' },
          { op: 'set_role', panel: 0, entity_id: '1', role: 'chartreuse' },
          { op: 'hue_shift', panel: 5, entity_id: '1', degrees: 10 },
          { op: 'hue_shift', panel: 1, entity_id: '1', degrees: 90 },
        ],
        ENTITIES,
      ),
    ).toEqual([
      { op: 'set_role', panel: 0, entity_id: '2', role: 'nucleic' },
      { op: 'hue_shift', panel: 1, entity_id: '1', degrees: 40 },
    ])
  })

  it('needs a panel number when there are several panels', () => {
    expect(sanitizeEdits([{ op: 'set_role', entity_id: '1', role: 'focus' }], ENTITIES)).toEqual([])
    expect(sanitizeEdits([{ op: 'set_role', entity_id: '1', role: 'focus' }], [['1']])).toEqual([{ op: 'set_role', panel: 0, entity_id: '1', role: 'focus' }])
  })

  it('accepts at most twelve and tolerates non-arrays', () => {
    expect(sanitizeEdits(Array.from({ length: 30 }, () => ({ op: 'zoom', factor: 1.1 })), ENTITIES).length).toBe(12)
    expect(sanitizeEdits('rotate everything', ENTITIES)).toEqual([])
  })
})
