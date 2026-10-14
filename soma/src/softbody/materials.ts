// 材料表的类型和"求解器用的材料"：不依赖 node，浏览器（Web Worker）和命令行工具共用。
// The type of the material table and "the materials as the solver uses them": no node dependency, shared by the browser
// (a Web Worker) and the command-line tools.
//
// 表本身在 data/curated/softbody/materials.json（进 git）；命令行由 tools/softbody/build.ts 的 readMaterials() 读，浏览器直接 import。
// The table itself is data/curated/softbody/materials.json (in git); the command line reads it with readMaterials() of
// tools/softbody/build.ts, the browser imports it directly.

import type { SoftMaterial } from './types.ts'

export interface MaterialsFile {
  damping: { rate: number }
  gravity: [number, number, number]
  materials: (SoftMaterial & { basis: { thickness?: { value: number }; activeStrain?: { value: number } } })[]
}

/** 求解器用的材料：去掉出处说明，只留数值 / the materials as the solver uses them: numbers only, without the provenance notes */
export function solverMaterials(file: MaterialsFile): SoftMaterial[] {
  return file.materials.map(({ id, name, young, poisson, density, youngActive, fibreYoung, rigid, stiffening, branchRatio, branchTau, ogden }) => ({ id, name, young, poisson, density, ...(youngActive ? { youngActive } : {}), ...(fibreYoung ? { fibreYoung } : {}), ...(rigid ? { rigid } : {}), ...(stiffening ? { stiffening } : {}), ...(branchRatio ? { branchRatio, branchTau } : {}), ...(ogden ? { ogden: { c: ogden.c, m: ogden.m } } : {}) }))
}

/** 皮肤层厚度，米（材料表里没有时 1.5 mm）/ the skin layer's thickness, metres (1.5 mm when the table has none) */
export function skinThickness(file: MaterialsFile): number {
  return file.materials.find((m) => m.id === 'skin')?.basis.thickness?.value ?? 0.0015
}
