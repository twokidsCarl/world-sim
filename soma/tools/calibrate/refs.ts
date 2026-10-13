// 标定用的外部参照：名称、版本、网址、许可（含引用的条款）和要下载的文件。
// The external references used for calibration: name, version, URL, licence (with the clause quoted) and the files to fetch.
//
// 这些参照只当“量具”用：在我们的模型和参照里算同一个量，写出差值表。参照的数据不进仓库，
// 只下载到 data/raw/calibration/<id>/（已被 .gitignore 忽略），每个目录带一份 SOURCE.txt。
// The references are measuring instruments only: the same quantity is computed in our model and in the reference and a
// difference table is written. No reference data enters the repository; downloads go to data/raw/calibration/<id>/
// (ignored by .gitignore), each directory with a SOURCE.txt.

import { join } from 'node:path'

export const ROOT = join(import.meta.dirname, '..', '..')
export const RAW = join(ROOT, 'data', 'raw', 'calibration')
export const OUT = join(ROOT, 'data', 'curated', 'calibration')
/** 下载时使用的 User-Agent（不含个人信息）/ the User-Agent used for downloads (no personal data). */
export const USER_AGENT = 'world-sim calibration (https://github.com/twokidsCarl/world-sim)'

/** 写进每张表里的参照说明 / the description of a reference written into every table. */
export interface RefInfo {
  id: string
  name: string
  version: string
  url: string
  licence: string
  /** 许可原文中允许本用途的那一句，以及它是在哪里读到的 / the sentence of the licence that permits this use, and where it was read. */
  clause: string
  /** 读到许可的日期 / the day the licence was read. */
  opened: string
}

export interface RefDownload extends RefInfo {
  /** 逐个文件：下载地址 → 目录内的相对路径 / file by file: URL → path inside the directory. */
  files: { url: string; path: string }[]
  /** GitHub 仓库里按规则挑选的文件（用 tree 接口列出）/ files picked by a rule from a GitHub repository (listed through the tree API). */
  tree?: { repo: string; commit: string; pick: (path: string) => boolean }
}

const MIT_GRANT = '"Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software"'
const APACHE_GRANT = '"2. Grant of Copyright License. Subject to the terms and conditions of this License, each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work and such Derivative Works in Source or Object form."'

const OSIM_COMMIT = 'd9b05d470b1a481c222372c85b75772faf8f7792'
const MYO_COMMIT = '93b0ca8f4ec90c9899ee7f05fee561e9911da91b'
const ORL_COMMIT = '9ca65ac08b64a1ea5f0d79466e64706b3ac524ba'
const ICT_COMMIT = 'da5f95a607f5e6b37755b38d3385d7f2853732e5'
const MP_COMMIT = '77824f917d924d3a25615e9923eaf7e0b144705b'

export const REFS = {
  rajagopal: {
    id: 'opensim-rajagopal',
    name: 'Rajagopal et al. 2016 full-body OpenSim model (Rajagopal2016.osim) and RajagopalLaiUhlrich2023.osim',
    version: `opensim-org/opensim-models commit ${OSIM_COMMIT.slice(0, 8)} (2025-11-05), Models/Rajagopal`,
    url: 'https://simtk.org/projects/full_body',
    licence: 'MIT ("MIT Use Agreement", Copyright (c) 2015, Stanford University)',
    clause: `SimTK project page, licence pop-over of the package "Full Body Model": ${MIT_GRANT}. The copy in opensim-org/opensim-models carries no licence file of its own; its README says the files "are modified from the original distribution, which can be found on SimTK.org".`,
    opened: '2026-10-13',
    files: ['Rajagopal2016.osim', 'RajagopalLaiUhlrich2023.osim', 'README.txt'].map((f) => ({ url: `https://raw.githubusercontent.com/opensim-org/opensim-models/${OSIM_COMMIT}/Models/Rajagopal/${f}`, path: f })),
  },
  myosim: {
    id: 'myo-sim',
    name: 'MyoSim (MyoHub/myo_sim): MuJoCo musculoskeletal models MyoLeg, MyoArm, MyoHand, MyoTorso, composed as MyoFullBody',
    version: `MyoHub/myo_sim commit ${MYO_COMMIT.slice(0, 8)} (2026-09-16)`,
    url: 'https://github.com/MyoHub/myo_sim',
    licence: 'Apache-2.0',
    clause: `LICENSE at the repository root (the README says "Apache 2.0 — see LICENSE"): ${APACHE_GRANT}`,
    opened: '2026-10-13',
    files: ['LICENSE', 'README.md'].map((f) => ({ url: `https://raw.githubusercontent.com/MyoHub/myo_sim/${MYO_COMMIT}/${f}`, path: f })),
    // 只取 XML 和各模型的 README：不要网格 / XML and the models' READMEs only: no meshes
    tree: { repo: 'MyoHub/myo_sim', commit: MYO_COMMIT, pick: (p: string) => p.startsWith('myo_sim/models/') && (p.endsWith('.xml') || p.endsWith('.md')) && !p.includes('/legacy/') && !p.includes('/scene/') },
  },
  openriglogic: {
    id: 'openriglogic',
    name: 'OpenRigLogic (EpicGames/openriglogic): the RigLogic and DNA libraries of the MetaHuman facial rig — source and documentation only, no character DNA',
    version: `EpicGames/openriglogic commit ${ORL_COMMIT.slice(0, 8)} (2026-09-30), branch main`,
    url: 'https://github.com/EpicGames/openriglogic',
    licence: 'MIT (Copyright (c) 2026 Epic Games, Inc.)',
    clause: `LICENSE at the repository root: ${MIT_GRANT}. The README says sample assets are a separate Fab listing "available under the Fab Standard License"; those were not downloaded.`,
    opened: '2026-10-13',
    files: [],
    // 源码和文档；不取二进制（仓库里没有 .dna 文件）/ source and documentation; no binaries (the repository has no .dna files)
    tree: { repo: 'EpicGames/openriglogic', commit: ORL_COMMIT, pick: (p: string) => /\.(h|cpp|md|txt|py|i)$/.test(p) || p === 'LICENSE' },
  },
  ict: {
    id: 'ict-facekit',
    name: 'ICT-FaceKit (USC Institute for Creative Technologies, Vision and Graphics Lab): morphable face model with 53 expression shapes',
    version: `ICT-VGL/ICT-FaceKit commit ${ICT_COMMIT.slice(0, 8)} (2020-12-01), FaceXModel`,
    url: 'https://github.com/ICT-VGL/ICT-FaceKit',
    licence: 'MIT (Copyright (c) 2020 USC Institute for Creative Technologies)',
    clause: `LICENSE at the repository root: ${MIT_GRANT}`,
    opened: '2026-10-13',
    files: ['LICENSE', 'README.md'].map((f) => ({ url: `https://raw.githubusercontent.com/ICT-VGL/ICT-FaceKit/${ICT_COMMIT}/${f}`, path: f })),
    // 中性脸和表情形状；不取 100 个身份形状 / the neutral face and the expression shapes; not the 100 identity shapes
    tree: { repo: 'ICT-VGL/ICT-FaceKit', commit: ICT_COMMIT, pick: (p: string) => p.startsWith('FaceXModel/') && p.endsWith('.obj') && !/identity\d+\.obj$/.test(p) },
  },
  mediapipe: {
    id: 'mediapipe',
    name: 'MediaPipe Face Landmarker: the list of blendshape categories in face_blendshapes_graph.cc',
    version: `google-ai-edge/mediapipe commit ${MP_COMMIT.slice(0, 8)} (2026-10-12)`,
    url: 'https://github.com/google-ai-edge/mediapipe',
    licence: 'Apache-2.0',
    clause: `LICENSE at the repository root: ${APACHE_GRANT}`,
    opened: '2026-10-13',
    files: ['LICENSE', 'mediapipe/tasks/cc/vision/face_landmarker/face_blendshapes_graph.cc'].map((f) => ({ url: `https://raw.githubusercontent.com/google-ai-edge/mediapipe/${MP_COMMIT}/${f}`, path: f.split('/').pop()! })),
  },
  arkit: {
    id: 'arkit-docs',
    name: 'Apple ARKit documentation: ARFaceAnchor.BlendShapeLocation (the names and one-line definitions of the 52 coefficients)',
    version: 'developer.apple.com documentation JSON as served on 2026-10-13',
    url: 'https://developer.apple.com/documentation/arkit/arfaceanchor/blendshapelocation',
    licence: 'No open licence: Apple developer documentation, © Apple Inc. Read as a public definition; only the identifiers (also present in the Apache-2.0 MediaPipe list) and our own paraphrase are used.',
    clause: 'No licence grant. The page is public documentation; nothing but the coefficient identifiers is carried into the tables, and Apple publishes no metric displacement for them.',
    opened: '2026-10-13',
    files: [{ url: 'https://developer.apple.com/tutorials/data/documentation/arkit/arfaceanchor/blendshapelocation.json', path: 'blendshapelocation.json' }],
  },
} satisfies Record<string, RefDownload>

/** 表里用的精简说明（不含下载清单）/ the short form used in tables (without the download list). */
export function refInfo(r: RefInfo): RefInfo {
  return { id: r.id, name: r.name, version: r.version, url: r.url, licence: r.licence, clause: r.clause, opened: r.opened }
}
