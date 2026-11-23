#!/bin/sh
set -eu

BASE_URL=${DEPLODASH_INSTALL_URL:-https://raw.githubusercontent.com/concertypin/deplodash/main/apps/api/scripts}
TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/deplodash-install-XXXXXX")
TEMP_SCRIPT="$TEMP_DIR/install-credential-helper.ts"
trap 'rm -rf "$TEMP_DIR"' EXIT
curl -fsSL "$BASE_URL/install-credential-helper.ts" -o "$TEMP_SCRIPT"
node "$TEMP_SCRIPT" "$@"
