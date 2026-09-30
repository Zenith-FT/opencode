#!/usr/bin/env bash
# Lance Tor + le proxy split (opencode.ai via Tor, reste en direct), puis opencode.
HERE="$(cd "$(dirname "$0")" && pwd)"
D="$HOME/.opencode_check_tor"
up() { (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null; }
mkdir -p "$D/data"

if ! up 9251; then
  rm -f "$D/cookie"; : > "$D/tor.log"
  tor --RunAsDaemon 1 \
      --SocksPort 127.0.0.1:9250 --ControlPort 127.0.0.1:9251 \
      --CookieAuthentication 1 --CookieAuthFile "$D/cookie" \
      --DataDirectory "$D/data" --Log "notice file $D/tor.log" || { echo "tor n'a pas démarré"; exit 1; }
  echo "Attente du bootstrap Tor..."
  for _ in $(seq 1 90); do grep -q "Bootstrapped 100%" "$D/tor.log" 2>/dev/null && break; sleep 1; done
  grep -q "Bootstrapped 100%" "$D/tor.log" || { echo "Bootstrap incomplet, voir $D/tor.log"; exit 1; }
fi

PROXY_PID=""
if ! up 9253; then
  python3 "$HERE/tor-split-proxy.py" >"$D/proxy.log" 2>&1 &
  PROXY_PID=$!
  for _ in $(seq 1 20); do up 9253 && break; sleep 0.5; done
  up 9253 || { echo "proxy non démarré, voir $D/proxy.log"; exit 1; }
fi
[ -n "$PROXY_PID" ] && trap 'kill $PROXY_PID 2>/dev/null' EXIT

# Le service d'arrière-plan `opencode serve` fait les vrais appels aux modèles.
# S'il tourne sans proxy, il contourne Tor : on l'arrête pour qu'il redémarre avec.
for p in $(pgrep -f "opencode serve" 2>/dev/null); do
  if ! tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | grep -q '^HTTPS_PROXY=http://127.0.0.1:9253$'; then
    echo "Service OpenCode (PID $p) lancé sans proxy : redémarrage"
    kill "$p" 2>/dev/null; sleep 1
  fi
done

export HTTPS_PROXY=http://127.0.0.1:9253 https_proxy=http://127.0.0.1:9253
export NO_PROXY=127.0.0.1,localhost,::1 no_proxy=127.0.0.1,localhost,::1
echo "opencode.ai -> Tor | reste -> direct   (log proxy: $D/proxy.log)"
opencode "$@"
