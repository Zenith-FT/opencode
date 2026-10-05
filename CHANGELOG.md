# Changelog

Tout changement notable est documenté ici. Format inspiré de
[Keep a Changelog](https://keepachangelog.com/).

## [2.5.0] - 2026-10-05

Version de consolidation : regroupe 2.2.0 -> 2.4.0 (widget TUI, Onionoo, heure de reset, `after = 2`,
garde-fou 1 / 15 s) et corrige ce qui a été rencontré sur une vraie machine Windows.

### Corrigé
- **Affichage du garde-fou figé** : le widget restait sur `garde-fou 5/5` bien après la fin de la
  fenêtre, l'état n'étant écrit qu'à chaque événement. L'état publié contient maintenant les
  horodatages (`stamps`) ; le widget recompte en direct et repasse à « prêt » après `guardFreeAt`
  (+ toast de retour à la normale).
- **Installateur** : écrit `plugins` en **tableau** `[{package, options}]` (doc officielle V2). L'ancienne
  forme objet, ignorée en silence par la V2, est convertie automatiquement. Tests + README mis à jour.
- Tests Windows : chemins normalisés (`as_posix`, `path.join`), test SIGTERM ignoré sous Windows.

### Ajouté
- `bin/opencode-tor.ps1` (lance tor + proxy puis `opencode2`) et `docs/windows.md` (installation V2,
  piège du BOM dans `auth.json`, forme tableau, découverte de config vers le haut, politique d'exécution
  PowerShell, profil `opencode2`, vérification du trafic Tor).
- `tests/guard-display.test.mjs`.

### Connu
- `tests/test_install.sh` : le test `cli : status` échoue environ 1 fois sur 40 (course : `start` rend
  la main dès que le port est ouvert, avant que le proxy réponde en HTTP). Présent dès la v2.1.0.

## [2.4.0] - 2026-10-04

### Ajouté
- Widget : **heure de remise à zéro du quota gratuit** (00:00 UTC, d'après `ipRateLimiter.ts`)
  convertie dans le fuseau de la machine, changement d'heure compris, avec compte à rebours
  (`Reset du quota : 02:00 UTC+2 (dans 5 h 12 min)`). `quotaReset()` / `fmtCountdown()` ;
  option `timeZone` ; `tests/quota-reset.test.mjs`.
- Pied de page et toasts distinguent la **1re erreur** (« limite de débit 1/2 », on retente)
  de la **2e** (« quota épuisé · reset 02:00 »), cohérent avec `after = 2`.

## [2.3.1] - 2026-10-04

### Modifié
- **Défaut `after` : 1 -> 2** : il faut deux erreurs de quota d'affilée pour changer d'IP
  (la première, souvent un simple « trop vite », est laissée à OpenCode).
- **Garde-fou : 5 rotations / 10 min -> 1 rotation / 15 s** (`maxRotations: 1`, `windowMs: 15000`).
  Plus permissif : au pire une rotation toutes les 15 s, qui ferme les connexions en cours
  vers opencode.ai à chaque fois. Réglable (`maxRotations`, `windowMs`).
- Durées affichées en secondes sous la minute (« 15 s » au lieu de « 0 min »).

## [2.3.0] - 2026-10-04

### Ajouté
- Widget : **nombre d'exits Tor disponibles** et **vérification que l'IP de sortie est un noeud
  Tor**, via Onionoo (API officielle). IP absente de l'annuaire => état `notor`
  (`● <ip> ⚠ hors Tor`, toast d'avertissement). Cache et plafonds de requêtes
  (15 min / 30 min / 2 min après échec), correspondance d'IP exacte côté client.
- Options `onionoo` et `onionooUrl` ; `plugin/tor-net.js` ; `tests/tor-net.test.mjs`.

## [2.2.0] - 2026-10-04

### Ajouté
- **Widget TUI** (`plugin/tui.tsx` → `plugin/tui.mjs`) : ligne d'état sur l'écran
  d'accueil et près du prompt, panneau dans la barre latérale, toasts (actif,
  quota épuisé, nouvelle IP A → B, garde-fou, Tor hors ligne, plugin non chargé).
- `plugin.state.json` : le plugin publie son état (états `loaded/ready/ratelimited/
  rotating/rotated/guard/proxy_down/error`) pour le widget ; `createStateWriter`.
- Aiguillage serveur/TUI dans le module racine ; toast d'erreur si le widget
  ne peut pas se charger.
- `opencode-tor doctor` : contrôle du widget + ligne d'information sur l'état du plugin.
- Option `quotaRegex` ; tests de rendu réels (`tests/tui.render.test.ts`, bun).

### Modifié
- **Défaut `after` : 3 → 1** (rotation dès le premier quota épuisé). Le garde-fou
  5 rotations / 10 min est inchangé.
- Détection de quota : n'utilise plus le mot « opencode » comme motif d'erreur.
  Un 403 `FreeTierError` (« OpenCode's free tier… ») ne déclenchait pas de 429 mais
  matchait le texte ; avec `after = 1` cela aurait provoqué des rotations à tort.

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
