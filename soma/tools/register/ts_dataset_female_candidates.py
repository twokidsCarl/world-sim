#!/usr/bin/env python3
"""Find female scans with the largest body coverage in the TotalSegmentator
training dataset (Zenodo 10047292, CC BY 4.0) WITHOUT downloading the 23 GB zip:
reads meta.csv and each candidate's NIfTI header through HTTP range requests.

Usage: python -I ts_dataset_female_candidates.py OUT_DIR [--fetch sXXXX ...]
  --fetch also extracts ct.nii.gz and all segmentations/* of the given ids.
"""
import csv
import gzip
import io
import os
import struct
import sys
from collections import Counter

from remotezip import RemoteZip

URL = "https://zenodo.org/api/records/10047292/files/Totalsegmentator_dataset_v201.zip/content"


def nifti_dims(z, name):
    # only the first compressed chunk is needed for the 348-byte header
    with z.open(name) as f:
        head = f.read(4096)
    raw = gzip.GzipFile(fileobj=io.BytesIO(head)).read(348)
    dim = struct.unpack("<8h", raw[40:56])
    pix = struct.unpack("<8f", raw[76:108])
    return dim[1:4], pix[1:4]


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    fetch = sys.argv[3:] if len(sys.argv) > 2 and sys.argv[2] == "--fetch" else []
    with RemoteZip(URL) as z:
        if not os.path.exists(f"{out}/meta.csv"):
            z.extract("meta.csv", out)
        meta = list(csv.DictReader(open(f"{out}/meta.csv", encoding="utf-8-sig"), delimiter=";"))
        print("subjects", len(meta), "gender", Counter(m["gender"] for m in meta))
        fem = [m for m in meta if m["gender"] == "f"]
        print("female study types:", Counter(m["study_type"] for m in fem).most_common(40))
        if fetch:
            names = z.namelist()
            for sid in fetch:
                for n in names:
                    if n.startswith(sid + "/") and not n.endswith("/"):
                        z.extract(n, out)
                print("fetched", sid)
            return
        sizes = {i.filename.split("/")[0]: i.file_size for i in z.infolist() if i.filename.endswith("/ct.nii.gz")}
        wide = ("whole", "polytrauma", "body", "angio", "aorta", "leg", "extrem", "thorax-abdomen-pelvis", "neck-thorax-abdomen-pelvis")
        cand = [m for m in fem if any(w in m["study_type"].lower() for w in wide)]
        cand.sort(key=lambda m: -sizes.get(m["image_id"], 0))
        rows = []
        for m in cand[:120]:
            try:
                dim, pix = nifti_dims(z, m["image_id"] + "/ct.nii.gz")
            except Exception as e:  # noqa: BLE001
                print("skip", m["image_id"], e)
                continue
            ext = [round(d * p) for d, p in zip(dim, pix)]
            rows.append((ext[2], m["image_id"], m["age"], m["study_type"], m["pathology"], m["pathology_location"], dim, pix, sizes[m["image_id"]]))
        rows.sort(reverse=True)
        with open(f"{out}/female_candidates.tsv", "w") as f:
            f.write("z_extent_mm\tid\tage\tstudy_type\tpathology\tlocation\tdim\tspacing\tbytes\n")
            for r in rows:
                f.write("\t".join(map(str, r)) + "\n")
        for r in rows[:25]:
            print(r)


if __name__ == "__main__":
    main()
