#!/usr/bin/env bash
# AI-Dev-Workflow One-line Installer & Bootstrapper (POSIX / Linux / macOS / WSL)
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/AaronPG095/AI-Dev-Workflow/main/scripts/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/AaronPG095/AI-Dev-Workflow/main/scripts/install.sh | bash -s -- --prefix MYP
#   ./scripts/install.sh --prefix MYP

set -euo pipefail

PREFIX="${PREFIX:-PROJ}"
UPSTREAM="${UPSTREAM:-AaronPG095/AI-Dev-Workflow}"
BRANCH="${BRANCH:-main}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--prefix)
      PREFIX="$2"
      shift 2
      ;;
    -u|--upstream)
      UPSTREAM="$2"
      shift 2
      ;;
    -b|--branch)
      BRANCH="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

echo "================================================="
echo "   AI-Dev-Workflow Installer (Multi-Machine)     "
echo "================================================="
echo "Target directory: $(pwd)"
echo "Project prefix:   ${PREFIX}"
echo "Upstream source:  ${UPSTREAM} (${BRANCH})"
echo ""

BASE_URL="https://raw.githubusercontent.com/${UPSTREAM}/${BRANCH}"

FILES=(
  "scripts/ticket.mjs"
  "scripts/ticket.test.mjs"
  "scripts/sync.mjs"
  "scripts/install.ps1"
  "scripts/install.sh"
  "docs/plans/_template.plan.md"
  ".agents/skills/dev-workflow/SKILL.md"
  ".agents/skills/quick-review/SKILL.md"
  ".claude/skills/dev-workflow/SKILL.md"
  ".claude/skills/quick-review/SKILL.md"
  ".github/workflows/plan-check.yml"
  ".github/workflows/ticket-done.yml"
  ".github/workflows/workflow-sync.yml"
  ".github/pull_request_template.md"
)

download() {
  local url="$1"
  local dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    echo "Error: curl or wget is required." >&2
    exit 1
  fi
}

for file in "${FILES[@]}"; do
  dest="$(pwd)/$file"
  mkdir -p "$(dirname "$dest")"
  echo "  -> Fetching $file..."
  url="${BASE_URL}/${file}"
  
  if download "$url" "$dest"; then
    if [[ "$file" == *"dev-workflow"* ]]; then
      if command -v sed >/dev/null 2>&1; then
        sed -i.bak "s/ADW-Plan-/${PREFIX}-Plan-/g" "$dest" && rm -f "${dest}.bak"
      fi
    fi
    if [[ "$file" == *.sh ]]; then
      chmod +x "$dest" 2>/dev/null || true
    fi
  else
    echo "  [warning] Could not fetch $file" >&2
  fi
done

CFG_PATH="$(pwd)/scripts/ticket.config.json"
if [ ! -f "$CFG_PATH" ]; then
  cat <<EOF > "$CFG_PATH"
{
  "prefix": "${PREFIX}",
  "tracker": "local",
  "timeZone": "Europe/Berlin",
  "plansDir": "docs/plans",
  "protectedBranches": ["main"],
  "captureSources": ["Claude", "Codex", "Gemini", "ChatGPT", "Notion AI", "Other"],
  "verifyCommand": "npm test",
  "requireReview": false,
  "noPlan": {
    "maxChangedLines": 40,
    "noNewFilesUnder": ["src"]
  }
}
EOF
  echo "  -> Created scripts/ticket.config.json (Prefix: ${PREFIX})"
fi

if [ -d ".git" ]; then
  echo "  -> Installing pre-push guardrail hook..."
  if command -v node >/dev/null 2>&1; then
    node scripts/ticket.mjs hook install || echo "  [warning] Could not run hook installer."
  fi
fi

echo ""
echo "AI-Dev-Workflow successfully installed!"
echo "Start by creating a plan: node scripts/ticket.mjs new <Topic> [--branch]"
