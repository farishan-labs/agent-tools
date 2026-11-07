#!/usr/bin/env bash
#
# Installs the plugins from this repo into OpenCode's plugin directory.
#
# Files are symlinked, not copied, so `git pull` updates the live plugins.
# Any pre-existing file with the same name is backed up first.
#
# Usage:
#   ./scripts/install.sh            install or update every plugin
#   ./scripts/install.sh sweep      install only the named plugins
#   ./scripts/install.sh --uninstall remove the symlinks this script made

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/plugins"

ALL_PLUGINS=(sweep doctor sh optmem)

# sweep and doctor now live in the sweep dependency; sh and optmem stay here.
find_plugin_source() {
  local name="$1"
  for base in "$REPO_DIR/plugins" "$REPO_DIR/node_modules/sweep/plugins"; do
    if [[ -f "$base/$name.ts" ]]; then
      echo "$base/$name.ts"
      return 0
    fi
  done
  return 1
}

mkdir -p "$PLUGIN_DIR"

if [[ "${1:-}" == "--uninstall" ]]; then
  for plugin in "${ALL_PLUGINS[@]}"; do
    target="$PLUGIN_DIR/$plugin.ts"
    if [[ -L "$target" && "$(readlink "$target")" == "$REPO_DIR/plugins/"* ]]; then
      rm "$target"
      echo "removed $plugin.ts"
    fi
  done
  echo "Done."
  exit 0
fi

if [[ $# -gt 0 ]]; then
  PLUGINS=("$@")
else
  PLUGINS=("${ALL_PLUGINS[@]}")
fi

for plugin in "${PLUGINS[@]}"; do
  source_file="$(find_plugin_source "$plugin" || true)"
  target="$PLUGIN_DIR/$plugin.ts"

  if [[ -z "$source_file" || ! -f "$source_file" ]]; then
    echo "skip  $plugin.ts (not found)"
    continue
  fi

  # Back up a real file that is already there, so nothing is lost.
  if [[ -e "$target" && ! -L "$target" ]]; then
    backup="$target.backup"
    counter=1
    while [[ -e "$backup" ]]; do
      backup="$target.backup.$counter"
      counter=$((counter + 1))
    done
    mv "$target" "$backup"
    echo "saved $plugin.ts -> $(basename "$backup")"
  fi

  ln -sfn "$source_file" "$target"
  echo "linked $plugin.ts"
done

cat <<EOF

Done. Plugins are live in $PLUGIN_DIR

If these tools prompt for permission on every call, add this to
opencode.json:

  "permissions": [
    { "action": "sweep",  "resource": "*", "effect": "allow" },
    { "action": "doctor", "resource": "*", "effect": "allow" }
  ]
EOF
