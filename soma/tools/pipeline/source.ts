// Locating and loading the BodyParts3D source files.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildOntology, type Ontology } from './tables.ts'

export const RAW_DIR = join(import.meta.dirname, '../../data/raw/bodyparts3d')
/** Extracted OBJ directories, in priority order; the same FJ id is the same mesh in both. */
export const OBJ_DIRS = ['isa_BP3D_4.0_obj_99', 'partof_BP3D_4.0_obj_99']

export interface SourceTables {
  isa: Ontology
  partOf: Ontology
}

export function loadTables(dir = RAW_DIR): SourceTables {
  const read = (f: string) => readFileSync(join(dir, f), 'utf8')
  return {
    isa: buildOntology(read('isa_inclusion_relation_list.txt'), read('isa_element_parts.txt')),
    partOf: buildOntology(read('partof_inclusion_relation_list.txt'), read('partof_element_parts.txt')),
  }
}

/** element id -> OBJ path, union of all extracted directories. */
export function listObjFiles(dir = RAW_DIR): Map<string, string> {
  const out = new Map<string, string>()
  for (const d of OBJ_DIRS) {
    const full = join(dir, d)
    if (!existsSync(full)) continue
    for (const f of readdirSync(full)) {
      const m = /^(FJ\w+)\.obj$/i.exec(f)
      if (m && !out.has(m[1]!)) out.set(m[1]!, join(full, f))
    }
  }
  return new Map([...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}
