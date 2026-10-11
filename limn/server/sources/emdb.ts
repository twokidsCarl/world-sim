/**
 * EMDB：电镜密度图的数据库。这里取一个条目的基本信息：标题、作者建议的等值面阈值、体素大小、
 * 拟合进去的原子模型的 PDB 编号，以及密度图文件的地址。密度图是 CC0 数据，运行时下载并缓存。
 *
 * EMDB, the database of electron-microscopy density maps. This reads the basics of an entry: its
 * title, the contour level its authors recommend, the voxel size, the PDB ids of atomic models
 * fitted into it, and where the map file is. Maps are CC0 data, downloaded at run time and cached.
 */
const UA = { 'User-Agent': 'limn/0.1 (molecular illustration; local research tool)' }

export interface EmdbEntry {
  id: string
  title: string
  /** 作者建议的等值面阈值；没有给时为 null / the contour level recommended by the authors; null when none is given */
  contour: number | null
  voxel: number
  dims: [number, number, number]
  megabytes: number
  /** 拟合进这张图的原子模型 / atomic models fitted into the map */
  pdb: string[]
  resolution: number | null
  url: string
}

/** 把 EMDB 接口的条目整理成我们用的几项 / reduce an EMDB API entry to the few fields used here */
export function readEmdb(d: any, n: string): EmdbEntry | null {
  const m = d?.map
  const dim = m?.dimensions
  if (!m || !dim) return null
  const contours: any[] = m.contour_list?.contour ?? []
  const primary = contours.find((c) => c.primary) ?? contours[0]
  const level = Number(primary?.level)
  const res = Number(d?.structure_determination_list?.structure_determination?.[0]?.image_processing?.[0]?.final_reconstruction?.resolution?.valueOf_)
  return {
    id: `EMD-${n}`,
    title: String(d?.admin?.title ?? ''),
    contour: Number.isFinite(level) ? level : null,
    voxel: Number(m.pixel_spacing?.x?.valueOf_) || 1,
    dims: [Number(dim.col), Number(dim.row), Number(dim.sec)],
    megabytes: Math.round((Number(m.size_kbytes) || 0) / 1024),
    pdb: (d?.crossreferences?.pdb_list?.pdb_reference ?? []).map((p: any) => String(p.pdb_id).toUpperCase()).filter((x: string) => /^[0-9][A-Z0-9]{3}$/.test(x)),
    resolution: Number.isFinite(res) ? res : null,
    url: `https://ftp.ebi.ac.uk/pub/databases/emdb/structures/EMD-${n}/map/emd_${n}.map.gz`,
  }
}

export async function emdb(n: string): Promise<EmdbEntry | null> {
  if (!/^\d{4,6}$/.test(n)) return null
  const res = await fetch(`https://www.ebi.ac.uk/emdb/api/entry/EMD-${n}`, { headers: UA }).catch(() => null)
  if (!res || !res.ok) return null
  return readEmdb(await res.json().catch(() => null), n)
}
