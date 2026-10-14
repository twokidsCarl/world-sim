"""把 MHR LOD0 的 UV 布局导出成一个小的二进制文件，给 tools/look/uv.ts 用。
Export the UV layout of MHR LOD0 to a small binary file for tools/look/uv.ts.

    data/raw/bodyshape/.venv/bin/python -I tools/look/mhr_uv.py
    -> data/raw/look/mhr-lod0-uv.bin

需要 pymomentum（与 tools/bodyshape/mhrlib.py 的 LOD0 路径相同）。MHR 资产不随仓库分发，见 tools/bodyshape/REPORT.md。
Needs pymomentum (as the LOD0 path of tools/bodyshape/mhrlib.py). The MHR assets are not distributed
with the repository; see tools/bodyshape/REPORT.md.

格式（小端）/ format (little-endian):
    u32 nV, nF, nT                     顶点、三角形、UV 点的个数 / counts of vertices, triangles, UV points
    u32 faces[nF*3]                    顶点下标 / vertex indices
    u32 uvFaces[nF*3]                  每个面角的 UV 点下标 / UV point index per face corner
    f32 uv[nT*2]                       UV（v 向上，与 FBX 相同）/ UV (v up, as in the FBX)
"""
import os
import sys

import numpy as np

SRC = 'data/raw/bodyshape/models/mhr/assets/lod0.fbx'
OUT = 'data/raw/look/mhr-lod0-uv.bin'


def main():
    import pymomentum.geometry as g
    if not os.path.exists(SRC):
        sys.exit(f'{SRC} is missing (see tools/bodyshape/REPORT.md for where the MHR assets come from)')
    mesh = g.Character.load_fbx(SRC).mesh
    faces = np.asarray(mesh.faces, dtype=np.uint32)
    uv_faces = np.asarray(mesh.texcoord_faces, dtype=np.uint32)
    uv = np.asarray(mesh.texcoords, dtype=np.float32)
    nv = int(np.asarray(mesh.vertices).shape[0])
    if faces.shape != uv_faces.shape:
        sys.exit(f'faces {faces.shape} and texcoord faces {uv_faces.shape} differ')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as f:
        f.write(np.array([nv, faces.shape[0], uv.shape[0]], dtype='<u4').tobytes())
        f.write(faces.astype('<u4').tobytes())
        f.write(uv_faces.astype('<u4').tobytes())
        f.write(uv.astype('<f4').tobytes())
    print(f'{OUT}: {nv} vertices, {faces.shape[0]} triangles, {uv.shape[0]} UV points, '
          f'u {uv[:, 0].min():.4f}..{uv[:, 0].max():.4f}, v {uv[:, 1].min():.4f}..{uv[:, 1].max():.4f}')


if __name__ == '__main__':
    main()
