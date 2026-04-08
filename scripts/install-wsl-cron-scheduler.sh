#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RUNNER_SCRIPT="$REPO_DIR/scripts/run-scheduled-scrape.sh"
SCHEDULER_NAME="${ARK_SCRAPER_SCHEDULER_NAME:-default}"
CRON_SCHEDULE="${ARK_SCRAPER_CRON_SCHEDULE:-0 5 * * *}"
BOOT_SCHEDULE="${ARK_SCRAPER_BOOT_SCHEDULE:-@reboot}"
LOG_DIR="${ARK_SCRAPER_LOG_DIR:-$HOME/.local/state/ark-scraper}"
TARGET_ARGS=()
LEGACY_START_LINE="# BEGIN ark-scraper-scheduler"
LEGACY_END_LINE="# END ark-scraper-scheduler"

build_log_file_path() {
  local scheduler_name="$1"
  local base_name="scheduler"
  if [[ "$scheduler_name" != "default" ]]; then
    base_name+="-$scheduler_name"
  fi

  printf '%s/%s.log' "$LOG_DIR" "$base_name"
}

LOG_FILE="$(build_log_file_path "$SCHEDULER_NAME")"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      SCHEDULER_NAME="$2"
      LOG_FILE="$(build_log_file_path "$SCHEDULER_NAME")"
      shift 2
      ;;
    --cron)
      CRON_SCHEDULE="$2"
      shift 2
      ;;
    --boot)
      BOOT_SCHEDULE="$2"
      shift 2
      ;;
    --log-dir)
      LOG_DIR="$2"
      LOG_FILE="$(build_log_file_path "$SCHEDULER_NAME")"
      shift 2
      ;;
    --target)
      TARGET_ARGS+=("$2")
      shift 2
      ;;
    --no-boot)
      BOOT_SCHEDULE=""
      shift
      ;;
    --no-cron)
      CRON_SCHEDULE=""
      shift
      ;;
    --help|-h)
      cat <<EOF
Usage: $(basename "$0") [--name default] [--cron '0 5 * * *'] [--boot @reboot] [--no-boot] [--target ark-memory] [--log-dir /path/to/log-dir]

Examples:
  $(basename "$0")
  $(basename "$0") --name standard --cron '0 5 * * *'
  $(basename "$0") --name ark --cron '30 6,12,18 * * *' --no-boot --target ark-memory --target ark-ssd
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BOOT_SCHEDULE" && -z "$CRON_SCHEDULE" ]]; then
  echo "At least one of --boot or --cron must be configured." >&2
  exit 1
fi

if [[ ! "$SCHEDULER_NAME" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Scheduler name may only contain letters, numbers, dot, underscore, and hyphen." >&2
  exit 1
fi

START_LINE="# BEGIN ark-scraper-scheduler:${SCHEDULER_NAME}"
END_LINE="# END ark-scraper-scheduler:${SCHEDULER_NAME}"
REMOVE_LEGACY_BLOCK=0
if [[ "$SCHEDULER_NAME" == "default" ]]; then
  REMOVE_LEGACY_BLOCK=1
fi

mkdir -p "$LOG_DIR"
chmod +x "$RUNNER_SCRIPT"

TMP_CRON="$(mktemp)"
trap 'rm -f "$TMP_CRON"' EXIT

{ crontab -l 2>/dev/null || true; } | awk \
  -v start="$START_LINE" \
  -v end="$END_LINE" \
  -v legacyStart="$LEGACY_START_LINE" \
  -v legacyEnd="$LEGACY_END_LINE" \
  -v removeLegacy="$REMOVE_LEGACY_BLOCK" '
  $0 == start { skip=1; next }
  $0 == end { skip=0; next }
  removeLegacy == 1 && $0 == legacyStart { skip=1; next }
  removeLegacy == 1 && $0 == legacyEnd { skip=0; next }
  skip != 1 { print }
' > "$TMP_CRON"

RUNNER_COMMAND="$(printf '%q ' "$RUNNER_SCRIPT" "${TARGET_ARGS[@]}")"
RUNNER_COMMAND="${RUNNER_COMMAND% }"
CRON_COMMAND="cd $(printf '%q' "$REPO_DIR") && $RUNNER_COMMAND >> $(printf '%q' "$LOG_FILE") 2>&1"

{
  echo "$START_LINE"
  echo 'MAILTO=""'
  if [[ -n "$BOOT_SCHEDULE" ]]; then
    echo "$BOOT_SCHEDULE $CRON_COMMAND"
  fi
  if [[ -n "$CRON_SCHEDULE" ]]; then
    echo "$CRON_SCHEDULE $CRON_COMMAND"
  fi
  echo "$END_LINE"
} >> "$TMP_CRON"

crontab "$TMP_CRON"

echo
echo "Installed cron schedule for ark-scraper"
echo "  name:         $SCHEDULER_NAME"
echo "  boot trigger: $BOOT_SCHEDULE"
echo "  periodic:     $CRON_SCHEDULE"
if [[ ${#TARGET_ARGS[@]} -eq 0 ]]; then
  echo "  targets:      default"
else
  echo "  targets:      ${TARGET_ARGS[*]}"
fi
echo "  log file:     $LOG_FILE"
echo
crontab -l