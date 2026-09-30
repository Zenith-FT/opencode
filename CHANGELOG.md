# Changelog

Tout changement notable est documenté ici. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/).

## [2.1.0] - 2026-09-30

### Ajouté
- `install.sh` idempotent (Termux + Linux) : prérequis, porte OpenCode V2,
  déclaration objet `{package, options}` sous `plugins` (dict ou liste migrée),
  copie de l'ancien état, `--dry-run`, `--alias` bashrc, `--service-env` sur
  confirmation explicite. `uninstall.sh` (+ `--purge`).
- `bin/opencode-tor` : `start/status/rotate/stop/logs/doctor` (liveness via
  `/proc`, SIGTERM via pidfile, HTTP via python3 sans dépendance).
- IP de sortie lue sur le port de contrôle Tor (`stream-status` →
  `circuit-status` → `ns/id/<fp>`, source `control`), écho HTTP en repli
  (`probe`), budget `/rotate` de 3 s, `exit_ip_source` dans `/status`.
- `plugin/package.json` ; `tests/test_install.sh` (24 cas hors ligne).

### Modifié
- Défauts proxy : `--max-tunnels 64`, `--idle-timeout 600` (10 min).
- Migration d'état en **copie** : l'ancien dossier est conservé (retour arrière).

### Corrigé
- Fuite de sockets SOCKS sur erreur de handshake ; ordre d'arrêt
  (`wait_closed` après annulation des handlers) ; fermeture des writers de test.

## [2.0.0] - 2026-09-30
- Plugin : config via `ctx.options` + repli env, garde-fou borné
  (5 rotations / 10 min), IP de sortie A→B, journal plafonné 1 Mo + 1 backup.
- Proxy : CLI+env, pidfile, arrêt propre SIGTERM, idle/max-tunnels,
  token `/rotate`, isolation de circuit `rot<epoch>`.
