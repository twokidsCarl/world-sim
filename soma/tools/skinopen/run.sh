#!/bin/sh
# 对一个人体的皮肤包重做：导出深层部件 →（可选）移植 → 开口裂和睑裂 → 渲染检查图。皮肤包重新发布后重跑即可。
# 第二个参数是 graft.py 的步骤（逗号分隔），省略则不移植。
# Re-does the skin package of one body: export the deep parts → (optional) grafts → mouth and eye openings →
# check renders. Run it again whenever the skin package is re-issued. The second argument lists the steps of
# graft.py (comma-separated); without it nothing is grafted.
#
#   tools/skinopen/run.sh male "" -next       (在 soma/ 目录下运行 / run from soma/)
#   tools/skinopen/run.sh female vulva,toes -next
#   tools/skinopen/run.sh male genital,toes -next     第三个参数是输出目录的后缀：写到 …-skin-grafted-next/ 和 …-skin-open-next/，
#                                                     不碰已经发布的 …-skin-grafted/ 和 …-skin-open/
#                                                     the third argument is a suffix for the output directories: it writes
#                                                     …-skin-grafted-next/ and …-skin-open-next/ and leaves the shipped
#                                                     …-skin-grafted/ and …-skin-open/ alone
set -e
BODY="$1"
STEPS="$2"
SUFFIX="$3"
[ -n "$BODY" ] || { echo "usage: tools/skinopen/run.sh <body> [graft steps] [suffix]" >&2; exit 2; }
# 护栏：不带后缀会覆盖已经发布的 …-skin-grafted/ 和 …-skin-open/（下游直接读它们）。除非明确设了
# SKINOPEN_WRITE_SHIPPED=1，否则拒绝。后缀只许字母、数字、点、下划线和连字符，免得写到别处去。
# Guard: without a suffix this would overwrite the shipped …-skin-grafted/ and …-skin-open/ (downstream reads them
# as they are). It refuses unless SKINOPEN_WRITE_SHIPPED=1 is set explicitly. A suffix may hold only letters,
# digits, dot, underscore and hyphen, so that it cannot point anywhere else.
case "$BODY" in *[!A-Za-z0-9_-]*) echo "run.sh: body \"$BODY\" has characters other than letters, digits, _ and -" >&2; exit 2;; esac
case "$SUFFIX" in *[!A-Za-z0-9._-]*|*..*) echo "run.sh: suffix \"$SUFFIX\" may hold only letters, digits, dot, underscore and hyphen" >&2; exit 2;; esac
if [ -z "$SUFFIX" ] && [ "$SKINOPEN_WRITE_SHIPPED" != "1" ]; then
  echo "run.sh: refusing to write the shipped $BODY-skin-grafted/ and $BODY-skin-open/ (no suffix given)." >&2
  echo "        Give a suffix as third argument, e.g.  tools/skinopen/run.sh $BODY ${STEPS:-<steps>} -next" >&2
  echo "        or set SKINOPEN_WRITE_SHIPPED=1 to overwrite the shipped directories on purpose." >&2
  exit 3
fi
PY=data/raw/bodyshape/.venv/bin/python
PKG="data/raw/bodyshape/out/$BODY-skin"
OUT="$PKG-open$SUFFIX"
GR="$PKG-grafted$SUFFIX"
mkdir -p "$OUT"
bun tools/skinopen/export-deep.ts "$BODY" "$OUT/deep-face.json"
IN="$PKG"
if [ -n "$STEPS" ]; then
  $PY tools/skinopen/graft.py "$PKG" --steps "$STEPS" --deep "$OUT/deep-face.json" --out "$GR" > "$GR.log"
  mv "$GR.log" "$GR/graft.log"
  mkdir -p "$GR/renders"
  bun tools/skinopen/render-graft.ts "$GR"
  # 定位了但没有接进去的片，单独画出来 / patches that were fitted but not grafted are drawn on their own
  for f in "$GR"/vulva-patch.obj "$GR"/toes-fit-L.obj "$GR"/toes-fit-R.obj; do
    [ -f "$f" ] && bun tools/skinopen/render-patch.ts "$f" "$GR/renders/$(basename "$f" .obj).png" "$GR/skin.obj"
  done
  # graft.py 写出的检查图说明 / the check-render specs written by graft.py
  for f in "$GR"/render-*.json; do
    [ -f "$f" ] && bun tools/skinopen/render-scene.ts "$f"
  done
  IN="$GR"
fi
$PY tools/skinopen/open_skin.py "$IN" --out "$OUT" --deep "$OUT/deep-face.json" > "$OUT/open.log"
bun tools/skinopen/render.ts "$BODY" "$OUT"
