// 皮肤包目录的解析：构建线和下游工具（tools/rig、tools/face、腔的口端）都从这里取，免得各写一份目录名。
// 没有别的依赖，下游工具引用它不会带进管线的几何库。
// Resolving the skin package directory: the build lines and the downstream tools (tools/rig, tools/face,
// the oral end of the lumina) all take it from here, so the directory name is written down once.
// It has no other dependency, so a downstream tool importing it does not pull in the pipeline's geometry code.

/**
 * 各人体缺省的皮肤包目录（相对项目根）。女性：新头（headWarp v3）的包，fittedTo.key 26b3302d607a1b30。
 * 开口后的包按约定在 `<目录>-open`，移植后的在 `<目录>-grafted`。
 * The default skin package directory of each body (relative to the project root). Female: the package of the
 * new head (headWarp v3), fittedTo.key 26b3302d607a1b30. The opened package is `<directory>-open` by
 * convention, the grafted one `<directory>-grafted`.
 */
export const DEFAULT_SKIN_PACKAGE_DIR = {
  male: 'data/raw/bodyshape/out/male-skin',
  female: 'data/raw/bodyshape/out/female-skin-head-v3',
} as const

/**
 * 皮肤包目录（相对项目根）：缺省是各构建线写定的那个；设了环境变量 SOMA_MALE_SKIN_PACKAGE / SOMA_FEMALE_SKIN_PACKAGE
 * 就改用它指的目录（皮肤包重新发布到另一个目录时用）。开口后的包仍按约定取 `<目录>-open`。
 * 只接受项目根之下的相对路径：报告里记的就是这个相对目录，绝对路径不能进报告。
 * The skin package directory (relative to the project root): by default the one each build line names; the
 * environment variables SOMA_MALE_SKIN_PACKAGE / SOMA_FEMALE_SKIN_PACKAGE select another (for a package re-issued
 * into a directory of its own). The opened package is still `<directory>-open` by convention.
 * Only a relative path below the project root is accepted: that relative directory is what the report records,
 * and an absolute path must not get into the report.
 */
export function skinPackageDirFor(body: 'male' | 'female', fallback: string): string {
  const name = body === 'male' ? 'SOMA_MALE_SKIN_PACKAGE' : 'SOMA_FEMALE_SKIN_PACKAGE'
  const given = process.env[name]
  if (given === undefined || given === '') return fallback
  const dir = given.replace(/\/+$/, '')
  if (dir === '' || dir.startsWith('/') || /^[A-Za-z]:/.test(dir) || dir.includes('\\') || dir.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    throw new Error(`${name} must be a directory relative to the project root, without "." or ".." parts; got "${given}"`)
  }
  return dir
}

/** 这副人体的皮肤包目录：环境变量优先，否则用缺省 / this body's skin package directory: the environment variable first, else the default */
export function skinPackageDir(body: 'male' | 'female'): string {
  return skinPackageDirFor(body, DEFAULT_SKIN_PACKAGE_DIR[body])
}

/** 开口后的包的目录 / the directory of the opened package */
export function openedSkinPackageDir(body: 'male' | 'female'): string {
  return `${skinPackageDir(body)}-open`
}
