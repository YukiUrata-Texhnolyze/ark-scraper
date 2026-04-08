#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
TARGET_ARGS=("$@")

build_target_label() {
  if [[ $# -eq 0 ]]; then
    printf 'default'
    return
  fi

  printf '%s\n' "$@" \
    | tr '[:space:]' '-' \
    | tr -cs '[:alnum:]._-' '-' \
    | sed -e 's/^-*//' -e 's/-*$//'
}

TARGET_LABEL="$(build_target_label "${TARGET_ARGS[@]}")"
LOCK_FILE="${ARK_SCRAPER_LOCK_FILE:-/tmp/ark-scraper-scheduled-${TARGET_LABEL}.lock}"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[scheduler] Previous scrape run is still active for '${TARGET_LABEL}'. Skipping this cycle."
  exit 0
fi

export HOME="${HOME:-/home/urata}"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  echo "[scheduler] nvm.sh was not found at $NVM_DIR. Aborting." >&2
  exit 1
fi

# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"
nvm use --silent default >/dev/null

cd "$REPO_DIR"

if [[ ! -f dist/main.js ]] \
  || [[ package.json -nt dist/main.js ]] \
  || [[ package-lock.json -nt dist/main.js ]] \
  || [[ tsconfig.json -nt dist/main.js ]] \
  || find src -type f -newer dist/main.js -print -quit | grep -q .; then
  echo "[scheduler] Sources changed. Building before run."
  npm run build
fi

if [[ ${#TARGET_ARGS[@]} -eq 0 ]]; then
  echo "[scheduler] Starting scrape run at $(date --iso-8601=seconds) (targets: default)"
else
  echo "[scheduler] Starting scrape run at $(date --iso-8601=seconds) (targets: ${TARGET_ARGS[*]})"
fi

node -r dotenv/config dist/main.js "${TARGET_ARGS[@]}"

if [[ ${#TARGET_ARGS[@]} -eq 0 ]]; then
  echo "[scheduler] Finished scrape run at $(date --iso-8601=seconds) (targets: default)"
else
  echo "[scheduler] Finished scrape run at $(date --iso-8601=seconds) (targets: ${TARGET_ARGS[*]})"
fi