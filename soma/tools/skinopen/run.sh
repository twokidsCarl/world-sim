#!/bin/sh
# 对一个人体的皮肤包重做：导出深层部件 →（可选）移植 → 开口裂和睑裂 → 渲染检查图。皮肤包重新发布后重跑即可。
# 第二个参数是 graft.py 的步骤（逗号分隔），省略则不移植。
# Re-does the skin package of one body: export the deep parts → (optional) grafts → mouth and eye openings →
# check renders. Run it again whenever the skin package is re-issued. The second argument lists the steps of
# graft.py (comma-separated); without it nothing is grafted.
#
#   tools/skinopen/run.sh male               (在 soma/ 目录下运行 / run from soma/)
#   tools/skinopen/run.sh male genital,toes
#   tools/skinopen/run.sh female vulva,toes
set -e
BODY="$1"
STEPS="$2"
[ -n "$BODY" ] || { echo "usage: tools/skinopen/run.sh <body> [graft steps]" >&2; exit 2; }
PY=data/raw/bodyshape/.venv/bin/python
PKG="data/raw/bodyshape/out/$BODY-skin"
OUT="$PKG-open"
mkdir -p "$OUT"
bun tools/skinopen/export-deep.ts "$BODY" "$OUT/deep-face.json"
IN="$PKG"
if [ -n "$STEPS" ]; then
  $PY tools/skinopen/graft.py "$PKG" --steps "$STEPS" --deep "$OUT/deep-face.json" > "$PKG-grafted.log"
  mv "$PKG-grafted.log" "$PKG-grafted/graft.log"
  mkdir -p "$PKG-grafted/renders"
  bun tools/skinopen/render-graft.ts "$PKG-grafted"
  # 定位了但没有接进去的片，单独画出来 / patches that were fitted but not grafted are drawn on their own
  for f in "$PKG-grafted"/vulva-patch.obj "$PKG-grafted"/toes-fit-L.obj "$PKG-grafted"/toes-fit-R.obj; do
    [ -f "$f" ] && bun tools/skinopen/render-patch.ts "$f" "$PKG-grafted/renders/$(basename "$f" .obj).png" "$PKG-grafted/skin.obj"
  done
  IN="$PKG-grafted"
fi
$PY tools/skinopen/open_skin.py "$IN" --out "$OUT" --deep "$OUT/deep-face.json" > "$OUT/open.log"
bun tools/skinopen/render.ts "$BODY" "$OUT"
