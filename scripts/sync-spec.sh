#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC_DIR="$ROOT_DIR/spec"
PATHS_DIR="$SPEC_DIR/paths"

mkdir -p "$PATHS_DIR"

curl -Ls "https://raw.githubusercontent.com/splitwise/api-docs/main/splitwise.yaml" -o "$SPEC_DIR/splitwise.yaml"
curl -Ls "https://raw.githubusercontent.com/splitwise/api-docs/main/paths/index.yaml" -o "$PATHS_DIR/index.yaml"

path_files=()
while IFS= read -r file; do
  path_files+=("$file")
done < <(
  curl -Ls "https://api.github.com/repos/splitwise/api-docs/contents/paths?ref=main" \
    | jq -r '.[].name' \
    | rg '\.yaml$' \
    | rg -v '^index\.yaml$'
)

count=0
for file in "${path_files[@]:-}"; do
  if [[ -z "$file" ]]; then
    continue
  fi
  curl -Ls "https://raw.githubusercontent.com/splitwise/api-docs/main/paths/$file" -o "$PATHS_DIR/$file"
  count=$((count + 1))
done

echo "Synced $count Splitwise path specs to $PATHS_DIR"

# These files define the expense request contracts used by body-schemas.ts.
mkdir -p "$SPEC_DIR/schemas/expense"
for file in common.yaml by_shares.yaml equal_group_split.yaml; do
  curl -fLs "https://raw.githubusercontent.com/splitwise/api-docs/main/schemas/expense/$file" -o "$SPEC_DIR/schemas/expense/$file"
done
