#!/usr/bin/env python3
"""下载并检查两个开放许可的女性盆底参考数据。第 1 项的 U3D 流由 rh_mesh.py 解码、wu_place.py 配准后
进入锚定数据包（WU_ 条目）；第 2 项只用于形状核对。

Fetch and inspect two openly licensed references for the female pelvic floor. The U3D stream of
item 1 is decoded by rh_mesh.py and registered by wu_place.py into the anchor package (WU_ items);
item 2 is a shape check only.

1. Wu Y. et al., 3D Topography of the Young Adult Anal Sphincter Complex Reconstructed from
   Undeformed Serial Anatomical Sections. PLoS ONE 10(8): e0132226 (2015), CC BY. The interactive
   3D-PDF of the female pelvic floor (specimen CVH5) is S3 Fig of the correction
   (doi:10.1371/journal.pone.0140736.s004). The embedded U3D stream is extracted and its node
   names listed. The meshes are NOT ECMA-363 CLOD meshes but RHAdobeMeshResource extension blocks
   (documented in Adobe's "U3D Supported Elements", Acrobat 8.1 SDK); rh_mesh.py decodes them.
2. Routzong M. et al., Statistical Shape Modeling of Nulliparous, Pregnant, and Parous Female
   Pelvic Floor Muscle Complexes, Mendeley Data doi:10.17632/75vnsc24wk.1, CC BY 4.0: mean shape
   of the fused levator / coccygeus / perineal complex as VTK polydata.

Usage: python -I pelvic_floor_refs.py OUT_DIR
"""
import os
import re
import subprocess
import sys

import numpy as np
import pypdf

PDF = "https://journals.plos.org/plosone/article/file?type=supplementary&id=10.1371/journal.pone.0140736.s004"
VTK = "https://data.mendeley.com/public-files/datasets/75vnsc24wk/files/8dcc2e9e-b371-492b-bacf-046a9537b6b5/file_downloaded"


def fetch(url, path):
    if not os.path.exists(path) or os.path.getsize(path) < 10000:
        subprocess.run(["curl", "-sfL", "-A", "Mozilla/5.0 (Macintosh) Safari/605.1.15", "-o", path, url], check=True)


def u3d_blocks(buf):
    import struct
    p = 0
    while p + 12 <= len(buf):
        t, ds, ms = struct.unpack_from("<III", buf, p)
        yield t, buf[p + 12:p + 12 + ds]
        p = (p + 12 + ds + ms + 3) & ~3


def u3d_inventory(data, tsv):
    """Which block types carry the geometry? ECMA-363 CLOD meshes are 0xFFFFFF31 / 3B / 3C. This file has none:
    every mesh is a 0x00000100 block registered by a New Object Type block as "RHAdobeMeshResource"
    (Right Hemisphere / Adobe compressed mesh, an undocumented extension; ~7.6-8 bits/byte entropy)."""
    import struct
    from collections import Counter
    kinds, rows, ext = Counter(), [], None
    for t, body in u3d_blocks(data):
        kinds[hex(t)] += 1
        if t != 0xFFFFFF14:
            continue
        ln = struct.unpack_from("<H", body, 0)[0]
        chain = body[2:2 + ln].decode("utf8", "replace")
        q = 2 + ln
        _, attr = struct.unpack_from("<II", body, q)
        q += 8 + (16 if attr & 1 else 0) + (24 if attr & 2 else 0)
        q = ((q + 3) & ~3) + 4
        for t2, b2 in u3d_blocks(body[q:]):
            kinds["chain:" + hex(t2)] += 1
            if t2 == 0xFFFFFF16:
                n = struct.unpack_from("<H", b2, 0)[0]
                ext = b2[2:2 + n].decode("latin-1")
            if t2 == 0xFFFFFF22:                      # model node: name, parents (+ 4x4 each), resource name
                n = struct.unpack_from("<H", b2, 0)[0]
                name = b2[2:2 + n].decode("utf8", "replace")
                q2 = 2 + n
                pc = struct.unpack_from("<I", b2, q2)[0]
                q2 += 4
                for _ in range(pc):
                    m = struct.unpack_from("<H", b2, q2)[0]
                    q2 += 2 + m + 64
                m = struct.unpack_from("<H", b2, q2)[0]
                rows.append(["model", name, b2[q2 + 2:q2 + 2 + m].decode("utf8", "replace"), ""])
            if t2 == 0x100:
                rows.append(["mesh", chain, "", len(b2)])
    size = {r[1]: r[3] for r in rows if r[0] == "mesh"}
    with open(tsv, "w") as f:
        f.write("structure\tmesh_resource\tcompressed_bytes\n")
        for r in rows:
            if r[0] == "model":
                f.write(f"{r[1]}\t{r[2]}\t{size.get(r[2], '')}\n")
    print("block types:", dict(kinds))
    print("extension block 0x100 =", ext, "| model nodes:", sum(r[0] == "model" for r in rows), "| mesh resources:", len(size),
          "| ECMA CLOD mesh blocks:", kinds.get("chain:0xffffff31", 0))


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    pdf, vtk = os.path.join(out, "wu2015_corr_pone.0140736.s004.pdf"), os.path.join(out, "PFMC_SSM_Average.vtk")
    fetch(PDF, pdf)
    fetch(VTK, vtk)
    r = pypdf.PdfReader(pdf)
    for pg in r.pages:
        for a in pg.get("/Annots") or []:
            a = a.get_object()
            if a.get("/Subtype") != "/3D":
                continue
            st = a["/3DD"].get_object()
            if st.get("/Type") == "/3DRef":
                st = st["/3DD"].get_object()
            data = st.get_data()
            open(pdf.replace(".pdf", ".u3d"), "wb").write(data)
            print("3D stream:", st.get("/Subtype"), len(data), "bytes")
            # U3D strings are length-prefixed UTF-8; node / mesh names survive as plain text
            names = sorted({m.decode("latin-1").strip() for m in re.findall(rb"[A-Za-z][A-Za-z0-9_ .,()\-]{3,70}", data)})
            # keep only strings that look like words (the stream is mostly compressed geometry)
            keep = [n for n in names if re.fullmatch(r"[A-Z][a-z]{2,}([ ,\-][A-Za-z()]{2,}){0,7}", n) and len(n) > 5
                    and not re.search(r"(?i)^(light|camera|default|shader|material|texture|scene|world|adobe)", n)]
            print(len(keep), "names:")
            print("; ".join(keep))
            u3d_inventory(data, os.path.join(out, "wu2015_u3d_blocks.tsv"))
    lines = open(vtk).read().split("\n")
    n = int(lines[3].split()[1]) if lines[3].startswith("POINTS") else int(lines[4].split()[1])
    start = 4 if lines[3].startswith("POINTS") else 5
    pts = np.array(" ".join(lines[start:start + n]).split(), dtype=float).reshape(-1, 3)
    rest = "\n".join(lines[start + n:])
    m = re.search(r"POLYGONS (\d+)", rest)
    print("VTK mean pelvic floor complex:", len(pts), "points,", m.group(1) if m else "?", "polygons; bbox",
          pts.min(0).round(1).tolist(), pts.max(0).round(1).tolist(), "extent", np.ptp(pts, axis=0).round(1).tolist())


if __name__ == "__main__":
    main()
