#!/usr/bin/env bash
# tests/test_install.sh — installateur testé HORS LIGNE uniquement.
# Chaque cas utilise HOME=$(mktemp -d) + faux `opencode`/`tor` sur PATH.
# Ne touche jamais au vrai $HOME, au vrai tor, ni au vrai service opencode.
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
PASS=0; FAIL=0

ok() { PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$PASS" "$*"; }
ko() { FAIL=$((FAIL + 1)); printf 'KO %s\n' "$*" >&2; }

# HOME jetable + faux binaires. $1 = version opencode simulée (défaut 2.5.0).
new_home() {
  local ver="${1:-2.5.0}"
  THOME="$(mktemp -d)" || exit 1
  export HOME="$THOME"
  mkdir -p "$HOME/fakebin"
  cat > "$HOME/fakebin/opencode" <<EOF
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo "opencode $ver"; exit 0; fi
printf '%s\n' "\$*" >> "\$HOME/fake-calls.log"
exit 0
EOF
  cat > "$HOME/fakebin/tor" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$HOME/fake-tor-calls.log"
exit 0
EOF
  chmod +x "$HOME"/fakebin/opencode "$HOME"/fakebin/tor
  export PATH="$HOME/fakebin:$PATH"
  # Ports de test : jamais ceux du stack réel (925x).
  export TOR_PROXY_PORT=19253 TOR_SOCKS_PORT=19250 TOR_CONTROL_PORT=19251
  export TOR_PROXY_TIMEOUT=10 TOR_BOOT_TIMEOUT=3
}

end_home() { rm -rf "${THOME:-/nexiste-pas}"; }

# --- 1. installation fraîche V2 -------------------------------------------
new_home
bash "$SRC/install.sh" --alias >/dev/null || ko "install fraîche : code retour"
[ -x "$HOME/.local/share/opencode-tor-rotate/bin/opencode-tor" ] && ok "install : CLI copié" || ko "install : CLI copié"
[ -f "$HOME/.local/share/opencode-tor-rotate/plugin/index.js" ] && ok "install : plugin copié" || ko "install : plugin copié"
[ -f "$HOME/.local/share/opencode-tor-rotate/proxy/tor-split-proxy.py" ] && ok "install : proxy copié" || ko "install : proxy copié"
grep -q "alias opencode-tor=" "$HOME/.bashrc" 2>/dev/null && ok "install : alias créé" || ko "install : alias créé"
[ -d "$HOME/.local/state/opencode-tor-rotate" ] && ok "install : état créé" || ko "install : état créé"
if python3 - "$HOME/.config/opencode/opencode.json" <<'PY'; then
import json, sys
cfg = json.load(open(sys.argv[1]))
e = cfg["plugins"]["tor-rotate"]
assert e["package"].endswith("opencode-tor-rotate/plugin"), e
assert e["options"]["proxyUrl"] == "http://127.0.0.1:9253", e
PY
  ok "install : forme objet {package, options}"
else
  ko "install : forme objet {package, options}"
fi
[ -f "$HOME/fake-calls.log" ] && ko "install : service non appelé par défaut" || ok "install : service non appelé par défaut"

# --- 2. idempotence (2e passage : config identique, pas de doublon) --------
cp "$HOME/.config/opencode/opencode.json" "$THOME/once.json"
bash "$SRC/install.sh" >/dev/null || ko "réinstall : code retour"
cmp -s "$THOME/once.json" "$HOME/.config/opencode/opencode.json" && ok "idempotence : config inchangée" || ko "idempotence : config inchangée"
n=$(grep -c '"tor-rotate":' "$HOME/.config/opencode/opencode.json" 2>/dev/null || echo 0); [ "$n" -eq 1 ] && ok "idempotence : pas de doublon" || ko "idempotence : pas de doublon"

# --- 3. autres clés préservées + migration forme liste ---------------------
cat > "$HOME/.config/opencode/opencode.json" <<'JSON'
{"model": "x", "plugins": ["/chez/moi/autre-plugin", "/opt/opencode-tor/plugin"]}
JSON
bash "$SRC/install.sh" >/dev/null || ko "migration liste : code retour"
if python3 - "$HOME/.config/opencode/opencode.json" <<'PY'; then
import json, sys
cfg = json.load(open(sys.argv[1]))
assert cfg["model"] == "x", cfg
plugs = cfg["plugins"]
assert "/chez/moi/autre-plugin" in plugs, plugs
assert not any(isinstance(e, str) and "opencode-tor" in e for e in plugs), plugs
assert any(isinstance(e, dict) and e.get("package", "").endswith("opencode-tor-rotate/plugin") for e in plugs), plugs
PY
  ok "migration liste : autre gardé, vieux retiré, objet ajouté"
else
  ko "migration liste : autre gardé, vieux retiré, objet ajouté"
fi

# --- 4. migration de l'état -------------------------------------------------
mkdir -p "$HOME/.opencode_check_tor" && echo marqueur > "$HOME/.opencode_check_tor/plugin.log"
rm -rf "$HOME/.local/state/opencode-tor-rotate"
bash "$SRC/install.sh" >/dev/null || ko "migration état : code retour"
[ -f "$HOME/.local/state/opencode-tor-rotate/plugin.log" ] && [ ! -e "$HOME/.opencode_check_tor" ] \
  && ok "migration état : déplacé" || ko "migration état : déplacé"

# --- 5. --service-env avec --yes --------------------------------------------
bash "$SRC/install.sh" --service-env --yes >/dev/null || ko "service-env : code retour"
grep -q "HTTPS_PROXY=http://127.0.0.1:9253" "$HOME/fake-calls.log" \
  && ok "service-env : variables transmises" || ko "service-env : variables transmises"

# --- 6. cycle CLI (proxy réel, tor simulé) ----------------------------------
export TOR_SKIP_TOR=1 TOR_IP_ECHO=off
CLI="bash $HOME/.local/share/opencode-tor-rotate/bin/opencode-tor"
$CLI start >/dev/null || ko "cli : start"
$CLI status 2>/dev/null | grep -q '"version"' && ok "cli : status" || ko "cli : status"
$CLI rotate 2>/dev/null | grep -q "epoch=1" && ok "cli : rotate" || ko "cli : rotate"
$CLI logs proxy 2>/dev/null | grep -q "sur 127.0.0.1:19253" && ok "cli : logs" || ko "cli : logs"
$CLI stop >/dev/null || ko "cli : stop"
[ ! -f "$HOME/.local/state/opencode-tor-rotate/proxy.pid" ] && ok "cli : pidfile retiré" || ko "cli : pidfile retiré"
unset TOR_SKIP_TOR

# --- 7. désinstallation ------------------------------------------------------
bash "$SRC/uninstall.sh" >/dev/null || ko "uninstall : code retour"
[ ! -e "$HOME/.local/share/opencode-tor-rotate" ] && ok "uninstall : share supprimé" || ko "uninstall : share supprimé"
! grep -q "opencode-tor-rotate" "$HOME/.bashrc" 2>/dev/null && ok "uninstall : alias supprimé" || ko "uninstall : alias supprimé"
if python3 - "$HOME/.config/opencode/opencode.json" <<'PY'; then
import json, sys
raw = open(sys.argv[1]).read()
assert "tor-rotate" not in raw, raw
PY
  ok "uninstall : entrée retirée, reste intact"
else
  ko "uninstall : entrée retirée, reste intact"
fi
[ -d "$HOME/.local/state/opencode-tor-rotate" ] && ok "uninstall : état conservé sans --purge" || ko "uninstall : état conservé sans --purge"
bash "$SRC/uninstall.sh" --purge >/dev/null
[ ! -e "$HOME/.local/state/opencode-tor-rotate" ] && ok "uninstall --purge : état supprimé" || ko "uninstall --purge : état supprimé"
end_home

# --- 8. --dry-run ne change rien ---------------------------------------------
new_home
bash "$SRC/install.sh" --dry-run >/dev/null || ko "dry-run : code retour"
[ ! -e "$HOME/.local" ] && [ ! -e "$HOME/.config" ] && [ ! -e "$HOME/.bashrc" ] && ok "dry-run : rien créé" || ko "dry-run : quelque chose créé ($(ls -A "$HOME"))"
end_home

# --- 9. porte V1 (major < 2 => abandon) ---------------------------------------
new_home "1.9.9"
if bash "$SRC/install.sh" >/dev/null 2>&1; then ko "porte V1 : aurait dû refuser"; else ok "porte V1 : refuse la V1"; fi
[ ! -e "$HOME/.local/share/opencode-tor-rotate" ] && [ ! -e "$HOME/.config/opencode" ] \
  && ok "porte V1 : rien installé" || ko "porte V1 : rien installé"
end_home

printf '\n%d ok, %d KO\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
