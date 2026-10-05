#!/usr/bin/env bash
# install.sh — installe opencode-tor-rotate (plugin OpenCode 2.x + proxy Tor).
#
#   ./install.sh [--dry-run] [--alias] [--service-env] [--yes]
#
#   --dry-run      affiche ce qui serait fait, ne change rien
#   --alias        ajoute un alias `opencode-tor` dans ~/.bashrc
#   --service-env  déclare aussi HTTPS_PROXY/NO_PROXY au service d'arrière-plan
#                  `opencode service set env` (confirmation explicite exigée,
#                  le service doit redémarrer pour prendre en compte)
#   --yes          répond oui à la confirmation (non interactif)
#
# Testé hors ligne uniquement : HOME=$(mktemp -d) + faux `opencode`/`tor` sur PATH.
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SHARE="${XDG_DATA_HOME:-$HOME/.local/share}/opencode-tor-rotate"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-tor-rotate"
OLD_STATE="$HOME/.opencode_check_tor"
CONF_DIR="$HOME/.config/opencode"

DRY=0; ALIAS=0; SERVICE_ENV=0; YES=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --alias) ALIAS=1 ;;
    --service-env) SERVICE_ENV=1 ;;
    --yes) YES=1 ;;
    -h | --help) sed -n '2,14p' "$0"; exit 0 ;;
    *) printf 'option inconnue : %s\n' "$a" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" -eq 1 ]; then printf '[dry-run] %s\n' "$*"; else eval "$*"; fi; }
backup() { # backup <fichier> : copie horodatée avant modification
  [ -e "$1" ] || return 0
  local b
  b="$1.bak.$(date +%Y%m%d-%H%M%S)"
  say "sauvegarde : $1 -> $b"
  run "cp -a '$1' '$b'"
}

say "== opencode-tor-rotate : installation =="

# 1. Prérequis -------------------------------------------------------------
command -v python3 >/dev/null || { printf 'erreur : python3 introuvable\n' >&2; exit 1; }
command -v tor >/dev/null || { printf 'erreur : tor introuvable (pkg install tor / apt install tor)\n' >&2; exit 1; }
command -v opencode >/dev/null || { printf 'erreur : opencode introuvable sur PATH\n' >&2; exit 1; }

# 2. Version d'OpenCode : le pluriel `plugins` est refusé par la V1 ---------
ver="$(opencode --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
[ -n "$ver" ] || { printf 'erreur : `opencode --version` illisible\n' >&2; exit 1; }
major="${ver%%.*}"
say "opencode détecté : $ver"
if [ "$major" -lt 2 ] 2>/dev/null; then
  printf 'erreur : OpenCode V1 (%s) rejette la clé plurielle `plugins` ; passez en V2.\n' "$ver" >&2
  exit 1
fi

# 3. Fichiers -> ~/.local/share/opencode-tor-rotate -------------------------
say "destination : $SHARE"
for d in plugin proxy bin; do
  [ -d "$SRC/$d" ] || { printf 'erreur : %s manquant dans %s\n' "$d" "$SRC" >&2; exit 1; }
done
run "mkdir -p '$SHARE'"
run "cp -a '$SRC/plugin' '$SRC/proxy' '$SRC/bin' '$SHARE/'"
run "chmod +x '$SHARE/bin/opencode-tor'"

# 4. État -> ~/.local/state/... (migration de l'ancien dossier) -------------
if [ -d "$OLD_STATE" ] && [ ! -d "$STATE_DIR" ]; then
  # COPIE, pas déplacement : l'ancien dossier reste en place (retour en
  # arrière possible : il suffit de relancer l'ancien ~/opencode-tor).
  say "migration de l'état : copie $OLD_STATE -> $STATE_DIR (original conservé)"
  run "mkdir -p '$(dirname "$STATE_DIR")'"
  run "cp -a '$OLD_STATE' '$STATE_DIR'"
elif [ -d "$OLD_STATE" ] && [ -d "$STATE_DIR" ]; then
  say "état : $OLD_STATE et $STATE_DIR coexistent, on ne touche à rien (voir doctor)"
else
  run "mkdir -p '$STATE_DIR'"
fi

# 5. Déclaration du plugin (opencode.json ou .jsonc, sans toucher le reste) --
PKG="$SHARE/plugin"
OPTS_PY="$(cat <<'PY'
import json, os, sys
conf_dir, pkg = sys.argv[1], sys.argv[2]
best = None
for name in ("opencode.json", "opencode.jsonc"):
    p = os.path.join(conf_dir, name)
    if os.path.exists(p):
        best = p
        break
if best is None:
    best = os.path.join(conf_dir, "opencode.json")
    cfg = {}
    fresh = True
else:
    raw = open(best, errors="replace").read()
    fresh = False
    try:
        cfg = json.loads(raw)
    except Exception:
        # .jsonc : on retire les commentaires hors chaînes, puis on recharge.
        out, i, n, instr = [], 0, len(raw), None
        while i < n:
            c = raw[i]
            if instr:
                out.append(c)
                if c == "\\":
                    if i + 1 < n:
                        out.append(raw[i + 1]); i += 2; continue
                elif c == instr:
                    instr = None
                i += 1
            elif c in ("\"", "'"):
                instr = c; out.append(c); i += 1
            elif c == "/" and i + 1 < n and raw[i + 1] == "/":
                while i < n and raw[i] != "\n":
                    i += 1
            elif c == "/" and i + 1 < n and raw[i + 1] == "*":
                i += 2
                while i + 1 < n and not (raw[i] == "*" and raw[i + 1] == "/"):
                    i += 1
                i += 2
            else:
                out.append(c); i += 1
        try:
            cfg = json.loads("".join(out))
        except Exception as e:
            print(f"config illisible : {best} ({e})", file=sys.stderr)
            sys.exit(1)
        print(f"note : commentaires de {best} normalisés (sauvegarde faite avant)", file=sys.stderr)
if not isinstance(cfg, dict):
    print(f"config inattendue (pas un objet) : {best}", file=sys.stderr)
    sys.exit(1)
entry = {"package": pkg, "options": {"proxyUrl": "http://127.0.0.1:9253"}}
# OpenCode 2 : `plugins` est un TABLEAU d'éléments texte ou {package, options} (doc officielle,
# opencode.ai/v2/docs/plugins). La forme objet {"tor-rotate": {...}} est IGNORÉE EN SILENCE.
plugs = cfg.get("plugins", None)
if plugs is None:
    cfg["plugins"] = [entry]
elif isinstance(plugs, dict):
    # Ancienne forme objet (v2.1 / v2.2) : convertie en tableau, nos entrées remplacées, le reste gardé.
    cfg["plugins"] = [v for k, v in plugs.items()
                      if k != "tor-rotate" and isinstance(v, (str, dict))] + [entry]
elif isinstance(plugs, list):
    # Forme liste (ancien format) : on remplace nos vieilles entrées, on garde le reste.
    kept = [e for e in plugs
            if not (isinstance(e, str) and ("opencode-tor" in e or "opencode_check_tor" in e))
            and not (isinstance(e, dict) and e.get("package", "") == pkg)]
    kept.append(entry)
    cfg["plugins"] = kept
else:
    print(f"`plugins` inattendu dans {best}, on ne touche à rien", file=sys.stderr)
    sys.exit(1)
os.makedirs(conf_dir, exist_ok=True)
with open(best, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(f"plugin déclaré dans {best}")
print(fresh)
PY
)"
if [ "$DRY" -eq 1 ]; then
  say "[dry-run] déclaration du plugin {package: $PKG} dans $CONF_DIR/opencode.json(c)"
else
  run "mkdir -p '$CONF_DIR'"
  for f in "$CONF_DIR/opencode.json" "$CONF_DIR/opencode.jsonc"; do [ -f "$f" ] && backup "$f"; done
  # Exécution réelle du script de fusion (stdin = le programme python) :
  LAST="$(printf '%s' "$OPTS_PY" | python3 - "$CONF_DIR" "$PKG" | tail -n 2 | head -n 1)" || exit 1
  say "$LAST"
fi

# 6. Alias shell (pas de symlink : /usr/bin/env n'existe pas sous Termux) --
if [ "$ALIAS" -eq 1 ]; then
  say "alias shell : opencode-tor (bloc dans ~/.bashrc)"
  if [ "$DRY" -eq 1 ]; then
    say "[dry-run] bloc alias ajoute a $HOME/.bashrc"
  else
    touch "$HOME/.bashrc"
    awk 'BEGIN{skip=0} /# >>> opencode-tor-rotate >>>/{skip=1; next} /# <<< opencode-tor-rotate <<</{skip=0; next} !skip{print}' \
      "$HOME/.bashrc" > "$HOME/.bashrc.tmp" \
      && printf '# >>> opencode-tor-rotate >>>\n%s\n# <<< opencode-tor-rotate <<<\n' \
        "alias opencode-tor='bash \"$SHARE/bin/opencode-tor\"" >> "$HOME/.bashrc.tmp" \
      && mv "$HOME/.bashrc.tmp" "$HOME/.bashrc"
    say "rechargez votre shell (source ~/.bashrc) pour utiliser opencode-tor"
  fi
fi

# 7. Variables du service d'arrière-plan (confirmation explicite exigée) -----
if [ "$SERVICE_ENV" -eq 1 ]; then
  say "ATTENTION : le service doit redémarrer pour prendre les variables en compte."
  say "  opencode service set env HTTPS_PROXY=http://127.0.0.1:9253 NO_PROXY=127.0.0.1,localhost,::1"
  ok=""
  if [ "$YES" -eq 1 ]; then
    ok="OUI"
  else
    printf 'Taper OUI pour appliquer au service : '
    read -r ok || ok=""
  fi
  if [ "$ok" = "OUI" ]; then
    run "opencode service set env 'HTTPS_PROXY=http://127.0.0.1:9253' 'NO_PROXY=127.0.0.1,localhost,::1'"
    say "redémarrez le service pour appliquer (opencode service restart)"
  else
    say "service inchangé (confirmation refusée)"
  fi
else
  say "(service inchangé ; relancez avec --service-env pour déclarer le proxy au service)"
fi

say '== terminé : essayez bash $SHARE/bin/opencode-tor doctor (ou opencode-tor doctor avec --alias) =='
