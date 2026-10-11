#!/usr/bin/env bash
# 跑一个或几个子项目的测试，和 idea-loom 的作业在提交前跑的是同一套：
#   有 pyproject.toml          uv run --project <目录> pytest -q <目录>/tests
#   <目录> 或 <目录>/web 有 package.json   bun install，然后跑它有的 typecheck 和 test
#
# Run the tests of one or more subprojects, the same set an idea-loom job runs before
# submitting: pytest where there is a pyproject.toml, and for a package.json in <dir> or
# <dir>/web, bun install followed by whichever of typecheck and test it defines.
#
#   tools/ci.sh strata polis
#
# 全部跑完再报告，有一个没过就以非零退出。
# Everything runs before the report; the exit status is non-zero if anything failed.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

failed=()
run() {
  echo
  echo "▶ $*"
  if ! "$@"; then failed+=("$*"); fi
}

for dir in "$@"; do
  dir="${dir%/}"
  [ -d "$dir" ] || { echo "跳过 $dir：没有这个目录 / skipping $dir: no such directory"; continue; }
  if [ -f "$dir/pyproject.toml" ] && [ -d "$dir/tests" ]; then
    run uv run --project "$dir" pytest -q "$dir/tests"
  fi
  for sub in "$dir" "$dir/web"; do
    [ -f "$sub/package.json" ] || continue
    run bun install --cwd "$sub" --frozen-lockfile
    for script in typecheck test; do
      if grep -q "\"$script\"[[:space:]]*:" "$sub/package.json"; then run bun run --cwd "$sub" "$script"; fi
    done
  done
done

echo
if [ "${#failed[@]}" -gt 0 ]; then
  echo "没过的 / failed:"
  printf '  %s\n' "${failed[@]}"
  exit 1
fi
echo "全部通过 / all passed"
