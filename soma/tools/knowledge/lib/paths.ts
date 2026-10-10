import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const BP3D_DIR = resolve(ROOT, 'data/raw/bodyparts3d')
export const CACHE_DIR = resolve(ROOT, 'data/raw/knowledge')
export const CURATED_DIR = resolve(ROOT, 'data/curated/knowledge')
export const PUBLIC_DIR = resolve(ROOT, 'public/anatomy/knowledge')
