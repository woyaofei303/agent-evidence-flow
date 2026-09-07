#!/usr/bin/env bash
set -euo pipefail

WORKFLOW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$WORKFLOW_DIR/scripts/install.mjs" "$@"
