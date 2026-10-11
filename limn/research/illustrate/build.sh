#!/bin/sh
# 构建 David Goodsell 的 Illustrate（Apache-2.0）并渲染它自带的 2hhb 示例，
# 作为 compare.html 衡量 limn 的参照。
# 需要 gfortran（brew install gcc）。所有产物都放在 build/ 里，该目录已被忽略。
# Build David Goodsell's Illustrate (Apache-2.0) and render its own 2hhb
# example, as the reference that compare.html measures limn against.
# Needs gfortran (brew install gcc). Everything lands in build/, which is ignored.
set -eu
cd "$(dirname "$0")"
mkdir -p build
cd build
for f in illustrate.f 2hhb.pdb 2hhb.inp; do
  [ -f "$f" ] || curl -fsSL -o "$f" "https://raw.githubusercontent.com/ccsb-scripps/Illustrate/master/$f"
done
gfortran -O2 -std=legacy illustrate.f -o illustrate
./illustrate < 2hhb.inp > illustrate.out
echo "reference: $(pwd)/2hhb.pnm"
