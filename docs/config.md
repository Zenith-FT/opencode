# Configuration — référence

Priorité générale : **drapeaux CLI > options `opencode.json` > variables
d'environnement > défauts**.

## Plugin (`options` de l'entrée du tableau `plugins` dans `opencode.json`)

| Option | Env | Défaut | Rôle |
|---|---|---|---|
| `after` | `TOR_ROTATE_AFTER` | `2` | quotas épuisés d'affilée avant rotation (2 = la première est laissée à OpenCode, 1 = dès la première) |
| `resetMs` | `TOR_ROTATE_RESET_MS` | `300000` | sans erreur → compteur à 0 |
| `cooldownMs` | `TOR_ROTATE_COOLDOWN_MS` | `4000` | délai mini entre 2 rotations |
| `settleMs` | `TOR_ROTATE_WAIT_MS` | `1500` | attente avant retry après rotation |
| `maxRotations` | `TOR_ROTATE_MAX` | `1` | garde-fou : max rotations... |
| `windowMs` | `TOR_ROTATE_WINDOW_MS` | `15000` | ...par fenêtre (15 s) |
| `proxyUrl` | `TOR_PROXY_URL` | `http://127.0.0.1:9253` | proxy local |
| `providerRegex` | `TOR_ROTATE_PROVIDER_REGEX` | `opencode` | fournisseur surveillé |
| `quotaRegex` | `TOR_ROTATE_QUOTA_REGEX` | `FreeUsageLimitError\|free usage exceeded\|…` | texte reconnu comme quota (en plus du statut 429) ; ne contient volontairement pas « opencode » |
| `logFile` | `TOR_ROTATE_LOG` | état `plugin.log` | journal du plugin |
| `stateFile` | `TOR_ROTATE_STATE_FILE` | état `plugin.state.json` | état lu par le widget TUI |
| `toasts` (widget) | — | `true` | `false` : aucun toast |
| `timeZone` (widget) | — | fuseau du système | fuseau IANA (`Europe/Paris`) pour l'heure de remise à zéro du quota (00:00 UTC) |
| `onionoo` (widget) | — | `true` | `false` : pas de contrôle Onionoo (compte d'exits, IP = noeud Tor ?) |
| `onionooUrl` (widget) | — | `https://onionoo.torproject.org` | pour les tests / un miroir |
| `pollMs` (widget) | — | `500` | rafraîchissement du widget |
| `tokenFile` | `TOR_ROTATE_TOKEN_FILE` | `""` | secret partagé pour `/rotate` |
| `fetchTimeoutMs` | — | `8000` | timeout des appels proxy |
| `statusTimeoutMs` | — | `2000` | timeout du contrôle au chargement |

Journal plafonné : 1 Mo + 1 backup (`logMaxBytes`, `logBackups`).

## Proxy (`tor-split-proxy.py` — drapeau ou `TOR_*`)

| Drapeau | Env | Défaut |
|---|---|---|
| `--port` | `TOR_PROXY_PORT` | `9253` |
| `--socks-port` | `TOR_SOCKS_PORT` | `9250` |
| `--control-port` / `--control-host` | `TOR_CONTROL_PORT` / `TOR_CONTROL_HOST` | `9251` / `127.0.0.1` |
| `--cookie` | `TOR_COOKIE` | état `tor/cookie` |
| `--domains` | `TOR_DOMAINS` | `opencode.ai` |
| `--max-tunnels` | `TOR_PROXY_MAX_TUNNELS` | `64` |
| `--idle-timeout` | `TOR_PROXY_IDLE_TIMEOUT` | `600` (10 min) |
| `--ip-echo` (`off` désactive) | `TOR_IP_ECHO` | écho externe (repli `probe`) |
| `--token-file` | `TOR_ROTATE_TOKEN` | aucun |
| `--connect-timeout` | `TOR_PROXY_CONNECT_TIMEOUT` | `15` |
| `--exit-ip-timeout` (plafond 3 s) | `TOR_PROXY_EXIT_IP_TIMEOUT` | `3` |
| `--pidfile` | `TOR_PROXY_PIDFILE` | aucun |
| `--verbose` | `TOR_PROXY_VERBOSE=1` | non |

## CLI (`opencode-tor` — env uniquement)

| Variable | Défaut | Rôle |
|---|---|---|
| `TOR_BOOT_TIMEOUT` | `90` | attente max du port de contrôle au `start` |
| `TOR_PROXY_TIMEOUT` | `15` | attente max du proxy au `start` |
| `TOR_SKIP_TOR` | non défini | si défini, `start` ne gère pas tor |
| `XDG_STATE_HOME` / `XDG_DATA_HOME` | `~/.local/state` / `~/.local/share` | racines d'état et d'install |
| `TOR_ROTATE_TOKEN_FILE` | non défini | token envoyé en `x-tor-rotate-token` par `rotate` |

## Fichiers

- Install : `~/.local/share/opencode-tor-rotate/` (`plugin/`, `proxy/`, `bin/`).
- État : `~/.local/state/opencode-tor-rotate/` (`proxy.pid`, `proxy.log`,
  `plugin.log`, `plugin.state.json`, `tor/` : `cookie`, `data/`, `tor.log`).
- Config : `~/.config/opencode/opencode.json` (ou `.jsonc`), clé `plugins` (**tableau**).
