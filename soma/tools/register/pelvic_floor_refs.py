#!/usr/bin/env python3
"""Fetch and inspect two openly licensed references for the female pelvic floor (not part of the
anchor package; candidates only).

1. Wu Y. et al., 3D Topography of the Young Adult Anal Sphincter Complex Reconstructed from
   Undeformed Serial Anatomical Sections. PLoS ONE 10(8): e0132226 (2015), CC BY. The interactive
   3D-PDF of the female pelvic floor (specimen CVH5) is S3 Fig of the correction
   (doi:10.1371/journal.pone.0140736.s004). The embedded U3D stream is extracted and its node
   names listed; decoding U3D geometry (CLOD meshes) needs an external converter and is not done.
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
