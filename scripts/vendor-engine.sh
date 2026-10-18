#!/bin/sh
# Copies the extension's engine into vendor/engine at one commit of ~/gatekeeper-app (or $APP), and records it.
# The account runs this copy unchanged. Usage: scripts/vendor-engine.sh <commit>
set -eu
COMMIT="${1:?usage: scripts/vendor-engine.sh <commit>}"
APP="${APP:-$HOME/gatekeeper-app}"
DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/engine"
FULL="$(git -C "$APP" rev-parse "$COMMIT^{commit}")"
mkdir -p "$DIR"
for f in $(git -C "$APP" ls-tree --name-only "$FULL" extension/engine/); do
  case "$f" in *.js) git -C "$APP" show "$FULL:$f" > "$DIR/$(basename "$f")" ;; esac
done
cat > "$DIR/SOURCE.md" <<MD
# The engine, vendored

Copied unchanged from \`~/gatekeeper-app/extension/engine/\` at commit \`$FULL\` by \`scripts/vendor-engine.sh\`.
Do not edit these files here: change the engine in gatekeeper-app, then run \`scripts/vendor-engine.sh <commit>\` again.
MD
echo "vendored $FULL"
