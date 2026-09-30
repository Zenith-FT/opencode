#!/usr/bin/env bash
# uninstall.sh — retire opencode-tor-rotate.
#
#   ./uninstall.sh [--dry-run] [--purge]
#
#   --dry-run  affiche ce qui serait fait, ne change rien
#   --purge    supprime aussi l'état (~/.local/state/opencode-tor-rotate :
#              journaux, pid, fichiers tor) ; sinon l'état est conservé.
set -uo pipefail

SHARE="${XDG_DATA_HOME:-$HOME/.local/share}/opencode-tor-rotate"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-tor-rotate"
CONF_DIR="$HOME/.config/opencode"

DRY=0; PURGE=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --purge) PURGE=1 ;;
    -h | --help) sed -n '2,8p' "$0"; exit 0 ;;
    *) printf 'option inconnue : %s\n' "$a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" -eq 1 ]; then printf '[dry-run] %s\n' "$*"; else eval "$*"; fi; }

say "== opencode-tor-rotate : désinstallation =="

# 1. Arrêt du proxy qu'on a lancé (jamais celui d'une autre install) --------
if [ -x "$SHARE/bin/opencode-tor" ]; then
  say "arrêt du proxy (s'il tourne)..."
  if [ "$DRY" -eq 1 ]; then say "[dry-run] bash $SHARE/bin/opencode-tor stop"; else bash "$SHARE/bin/opencode-tor" stop || true; fi
elif [ -f "$STATE_DIR/proxy.pid" ]; then
  say "proxy.pid orphelin ($STATE_DIR/proxy.pid) : arrêt manuel requis (voir doctor)"
fi

# 2. Retrait de la déclaration plugin (sauvegarde avant) ---------------------
for f in "$CONF_DIR/opencode.json" "$CONF_DIR/opencode.jsonc"; do
  if [ -f "$f" ]; then
    if [ "$DRY" -eq 1 ]; then
      say "[dry-run] retrait de tor-rotate dans $f"
    else
      cp -a "$f" "$f.bak.$(date +%Y%m%d-%H%M%S)"
      if python3 - "$f" <<'PY'; then
import json, sys
p = sys.argv[1]
cfg = json.load(open(p, errors="replace"))
plugs = cfg.get("plugins")
if isinstance(plugs, dict):
    plugs.pop("tor-rotate", None)
elif isinstance(plugs, list):
    cfg["plugins"] = [e for e in plugs
                       if not (isinstance(e, str) and "opencode-tor" in e)
                       and not (isinstance(e, dict) and "tor-rotate" in str(e.get("package", "")))]
with open(p, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
PY
        say "retiré de $f"
      else
        say "attention : $f illisible ou sans JSON pur, on ne touche à rien (sauvegarde faite)"
      fi
    fi
  fi
done

# 3. Fichiers installés + alias ----------------------------------------------
[ -e "$SHARE" ] && { say "suppression : $SHARE"; run "rm -rf '$SHARE'"; }
if [ -L "$HOME/.local/bin/opencode-tor" ]; then
  say "suppression du symlink ~/.local/bin/opencode-tor (ancien format)"
  run "rm -f '$HOME/.local/bin/opencode-tor'"
fi
if [ -f "$HOME/.bashrc" ] && grep -q "opencode-tor-rotate" "$HOME/.bashrc" 2>/dev/null; then
  say "suppression du bloc alias dans ~/.bashrc"
  if [ "$DRY" -eq 1 ]; then
    say "[dry-run] bloc alias retire de $HOME/.bashrc"
  else
    awk 'BEGIN{skip=0} /# >>> opencode-tor-rotate >>>/{skip=1; next} /# <<< opencode-tor-rotate <<</{skip=0; next} !skip{print}' \
      "$HOME/.bashrc" > "$HOME/.bashrc.tmp" && mv "$HOME/.bashrc.tmp" "$HOME/.bashrc"
  fi
fi

# 4. État --------------------------------------------------------------------
if [ "$PURGE" -eq 1 ]; then
  [ -e "$STATE_DIR" ] && { say "purge : $STATE_DIR"; run "rm -rf '$STATE_DIR'"; }
else
  [ -e "$STATE_DIR" ] && say "(état conservé : $STATE_DIR ; relancez avec --purge pour le supprimer)"
fi

say "== terminé =="
