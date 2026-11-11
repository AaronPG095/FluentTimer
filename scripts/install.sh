#!/usr/bin/env bash
# AI-Dev-Workflow Installer. Delegate the managed bundle to the pinned sync engine.
set -euo pipefail

PREFIX="${PREFIX:-PROJ}"
UPSTREAM="${UPSTREAM:-AaronPG095/AI-Dev-Workflow}"
BRANCH="${BRANCH:-main}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--prefix) PREFIX="$2"; shift 2 ;;
    -u|--upstream) UPSTREAM="$2"; shift 2 ;;
    -b|--branch) BRANCH="$2"; shift 2 ;;
    *) echo "Unknown installer option: $1" >&2; exit 2 ;;
  esac
done

release="$(node --input-type=module -e '
const [repo, ref] = process.argv.slice(1);
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Upstream must be owner/repository");
if (/^[0-9a-f]{40}$/i.test(ref)) console.log(ref);
else {
  const response = await fetch("https://api.github.com/repos/" + repo + "/commits/" + encodeURIComponent(ref), { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("Could not resolve upstream: HTTP " + response.status);
  const { sha } = await response.json();
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error("Invalid upstream SHA");
  console.log(sha);
}' -- "$UPSTREAM" "$BRANCH")"
bootstrap_dir="$(mktemp -d)"
trap 'rm -f -- "$bootstrap_dir/sync.mjs"; rmdir -- "$bootstrap_dir"' EXIT
curl -fsSL --max-time 30 "https://raw.githubusercontent.com/${UPSTREAM}/${release}/scripts/sync.mjs" -o "$bootstrap_dir/sync.mjs"
node "$bootstrap_dir/sync.mjs" --remote --upstream "$UPSTREAM" --branch "$release" --init-prefix "$PREFIX"

if hook_path="$(git rev-parse --git-path hooks/pre-push 2>/dev/null)" && [[ ! -e "$hook_path" ]]; then
  node scripts/ticket.mjs hook install
fi
echo "AI-Dev-Workflow successfully installed."
