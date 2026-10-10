#!/usr/bin/env bash
# 把指定路径下的改动作为一个 PR 提交，由 GitHub Actions 自动合并。
#
#   tools/pr.sh "<标题>" <路径>...
#   COMMIT_BODY="正文" tools/pr.sh "soma: 加入剖切面" soma
#
# 多个 Claude 会话共用这一个工作目录，所以这个脚本不切分支、不动共享的暂存区：
# 它用临时 index 在 origin/main 之上直接造一个提交，推到新分支再开 PR。
# 只有列出的路径会进入提交，别的项目未提交的改动不受影响。
set -euo pipefail

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

if [ $# -lt 2 ]; then
  echo "用法: tools/pr.sh \"<标题>\" <路径>..." >&2
  exit 2
fi
title="$1"; shift

for p in "$@"; do
  case "$p" in
    .|./|/*|..*) echo "路径必须是仓库内的相对路径，且不能是整个仓库: $p" >&2; exit 2 ;;
  esac
  if [ -d "$p" ]; then
    nested="$(find "$p" \( -name node_modules -o -name .venv -o -name .git-nested \) -prune -o -name .git -print -quit)"
    if [ -n "$nested" ]; then
      echo "发现嵌套仓库 $nested。先把它改名保留: mv $nested ${nested%/.git}/.git-nested" >&2
      exit 1
    fi
  fi
done

git fetch -q origin main
base="$(git rev-parse origin/main)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export GIT_INDEX_FILE="$tmp/index"
git read-tree "$base"
git add -A -- "$@"

if git diff --cached --quiet "$base"; then
  echo "相对 origin/main 没有改动，不开 PR。"
  exit 0
fi

limit=$((50 * 1024 * 1024))
big=""
while IFS= read -r -d '' f; do
  size="$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")"
  if [ "$size" -gt "$limit" ]; then
    big="$big  $f ($((size / 1048576))MB)"$'\n'
  fi
done < <(git diff --cached --name-only --diff-filter=AM -z "$base")
if [ -n "$big" ]; then
  printf '以下文件超过 50MB，不能提交（加进 .gitignore 或换一种存放方式）:\n%s' "$big" >&2
  exit 1
fi

message="$title"
if [ -n "${COMMIT_BODY:-}" ]; then
  message="$title"$'\n\n'"$COMMIT_BODY"
fi
tree="$(git write-tree)"
commit="$(git commit-tree "$tree" -p "$base" -m "$message")"
unset GIT_INDEX_FILE

scope="${1%%/*}"
scope="$(printf '%s' "${scope%.*}" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-' '-' | sed 's/^-*//; s/-*$//')"
branch="${scope:-change}/$(date +%Y%m%d-%H%M%S)-$$"
git push -q origin "$commit:refs/heads/$branch"

url="$(gh pr create --base main --head "$branch" --title "$title" \
  --body "${PR_BODY:-${COMMIT_BODY:-由 tools/pr.sh 创建。}}")"
echo "PR: $url"

state=""
for _ in $(seq 1 40); do
  state="$(gh pr view "$url" --json state --jq .state)"
  [ "$state" = "MERGED" ] && break
  [ "$state" = "CLOSED" ] && break
  sleep 3
done

if [ "$state" = "MERGED" ]; then
  git fetch -q origin main
  # 只移动 main 和暂存区，不碰工作目录里的文件。
  if [ "$(git symbolic-ref --short -q HEAD)" = "main" ]; then
    git reset -q origin/main || true
  fi
  echo "已合并。"
else
  echo "还没有合并（状态: ${state:-未知}）。用 gh pr checks $url 看原因；有冲突就重新运行本脚本。" >&2
  exit 1
fi
