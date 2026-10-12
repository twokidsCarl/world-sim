#!/bin/sh
# 对一个人体的皮肤包重做开口：导出深层面部部件 → 开口 → 渲染检查图。皮肤包重新发布后重跑即可。
# Re-opens the skin package of one body: export the deep facial parts → open → render the check sheets.
# Run it again whenever the skin package is re-issued.
#
#   tools/skinopen/run.sh male            (在 soma/ 目录下运行 / run from soma/)
set -e
BODY="$1"
[ -n "$BODY" ] || { echo "usage: tools/skinopen/run.sh <body>" >&2; exit 2; }
PKG="data/raw/bodyshape/out/$BODY-skin"
bun tools/skinopen/export-deep.ts "$BODY" "$PKG-open/deep-face.json"
data/raw/bodyshape/.venv/bin/python tools/skinopen/open_skin.py "$PKG" > "$PKG-open/open.log"
bun tools/skinopen/render.ts "$BODY" "$PKG-open"
