#!/usr/bin/env bash
# forge-codebase mega-collection script
# Usage: bash <path>/codebase-collect.sh <roots...>
# Output: structured sections separated by ::LABEL:: markers

set -euo pipefail

ROOTS="${@:-.}"
IGNORE="node_modules|dist|build|coverage|\.venv|target|\.git|\.gsd|\.claude|\.github|\.storybook|storybook-static|\.next|\.turbo"
TMP="/tmp/_fc_$$.txt"

# Collect file list once
find $ROOTS -type f \( \
  -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
  -o -name '*.py' -o -name '*.go' -o -name '*.rb' -o -name '*.rs' \
  -o -name '*.java' -o -name '*.kt' -o -name '*.cs' \
  -o -name '*.cpp' -o -name '*.c' -o -name '*.h' -o -name '*.hpp' \
  -o -name '*.css' -o -name '*.scss' \
  -o -name '*.vue' -o -name '*.svelte' \
\) 2>/dev/null | grep -Ev "$IGNORE" | sort | head -500 > "$TMP"

COUNT=$(wc -l < "$TMP" | tr -d ' ')

echo "::FINGERPRINT::"
if [ "$COUNT" -gt 0 ]; then
  xargs stat -f '%N %m %z' < "$TMP" 2>/dev/null | sort | shasum -a 256 | cut -d' ' -f1
else
  echo "empty"
fi

echo "::FILES::"
cat "$TMP"

echo "::LINES::"
if [ "$COUNT" -gt 0 ]; then
  xargs wc -l < "$TMP" 2>/dev/null | sort -rn | head -40
fi

echo "::EXPORTS::"
if grep -qE '\.(tsx|ts|jsx|js)$' "$TMP" 2>/dev/null; then
  grep -E '\.(tsx|ts|jsx|js)$' "$TMP" | while IFS= read -r f; do
    c=$(grep -c "^export " "$f" 2>/dev/null || echo "0")
    [ "$c" -gt 0 ] && echo "$f:$c"
  done | sort -t: -k2 -rn | head -30
fi

echo "::DEFS::"
if grep -qE '\.py$' "$TMP" 2>/dev/null; then
  grep -E '\.py$' "$TMP" | while IFS= read -r f; do
    c=$(grep -c "^def " "$f" 2>/dev/null || echo "0")
    [ "$c" -gt 0 ] && echo "$f:$c"
  done | sort -t: -k2 -rn | head -30
fi

echo "::FUNCS::"
if [ "$COUNT" -gt 0 ]; then
  xargs grep -hn \
    -e 'function [A-Za-z0-9_]*' \
    -e 'const [A-Za-z0-9_]* *= *\(async \)\?(' \
    -e '^def [A-Za-z0-9_]*' < "$TMP" 2>/dev/null | head -300
fi

echo "::PROMPT_SIZES::"
wc -c CLAUDE.md .gsd/AUTO-MEMORY.md .gsd/CODING-STANDARDS.md 2>/dev/null || true

echo "::MD_SIZES::"
find commands .gsd -name '*.md' 2>/dev/null | xargs wc -c 2>/dev/null | sort -rn | head -10 || true

echo "::LARGE_FILES::"
find $ROOTS -type f -size +1M 2>/dev/null | grep -Ev "$IGNORE" || true

echo "::FRONTEND::"
FE_COMPONENTS=$(grep -cE '\.(tsx|jsx|vue|svelte)$' "$TMP" 2>/dev/null || echo "0")
FE_STYLES=$(grep -cE '\.(css|scss)$' "$TMP" 2>/dev/null || echo "0")
echo "components=$FE_COMPONENTS styles=$FE_STYLES"
if [ "$FE_COMPONENTS" -gt 0 ]; then
  echo "---IMG_TAGS---"
  grep -E '\.(tsx|jsx|vue|svelte)$' "$TMP" | xargs grep -n '<img' 2>/dev/null | head -30 || true
  echo "---DIV_HANDLERS---"
  grep -E '\.(tsx|jsx|vue|svelte)$' "$TMP" | xargs grep -n '<div.*on[A-Z]' 2>/dev/null | head -20 || true
  echo "---USE_CLIENT---"
  grep -E '\.(tsx|jsx|ts|js)$' "$TMP" | xargs grep -l "^.use client" 2>/dev/null || true
fi

rm -f "$TMP"
