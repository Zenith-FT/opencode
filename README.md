# opencode-tor-rotate

Plugin OpenCode 2.x + proxy local : quand le fournisseur `opencode` répond
**rate limit** (429), le plugin demande un **nouveau circuit Tor** au proxy
puis fait retenter la requête. Seul `opencode.ai` passe par Tor, le reste va
en direct.

## Démarrage en 2 minutes

Tu as besoin d'OpenCode 2.x, `tor` et `python3` sur ton PATH.

**Linux / Termux :**

```bash
git clone https://github.com/Zenith-FT/opencode.git ~/projects/opencode-tor-rotate
cd ~/projects/opencode-tor-rotate
./install.sh --alias
source ~/.bashrc
opencode-tor start
opencode-tor status
```

L'installeur déclare le plugin dans ta config globale, sans toucher au reste.
Prévisualise avec `./install.sh --dry-run` si tu préfères voir avant.

**Windows (PowerShell) :** suis [docs/windows.md](docs/windows.md). Tu clones le
dépôt, tu débloques `bin\opencode-tor.ps1` (`Unblock-File`), tu ajoutes les
fonctions `opencode2` / `ot` à ton profil, tu déclares le plugin dans
`%USERPROFILE%\.config\opencode\opencode.jsonc`, puis tu tapes `opencode2`.

**Vérifie que ça passe par Tor :** cherche `CONNECT opencode.ai:443 -> TOR`
dans `~/.local/state/opencode-tor-rotate/proxy.log`
(`%USERPROFILE%\.local\state\opencode-tor-rotate\proxy.log` sous Windows).
Tu la vois après ton premier message dans OpenCode.

## Installation

```bash
git clone <url-du-dépôt> ~/projects/opencode-tor-rotate
cd ~/projects/opencode-tor-rotate
./install.sh --alias
source ~/.bashrc
opencode-tor doctor
```

Pas d'installeur `curl | bash` (rien à exécuter sans l'avoir lu). Options :
`--dry-run` (simule), `--alias` (alias shell dans `~/.bashrc`),
`--service-env` (déclare le proxy au service d'arrière-plan, sur confirmation
`OUI` explicite — le service doit redémarrer ensuite).
Voir [docs/config.md](docs/config.md) pour toutes les options.

L'installeur exige **OpenCode V2** (`opencode --version`) : la V1 ne charge pas
les plugins (clé `plugins` ignorée sans erreur, vérifié en 1.18.34 — la
déclaration peut donc vivre dans la config globale). Il déclare le plugin sous cette forme (un **tableau**,
comme l'exige la V2 : la forme objet `{"tor-rotate": {...}}` est ignorée en
silence), sans toucher au reste de `opencode.json` (ou `.jsonc`, sauvegarde avant
écriture). Une ancienne forme objet est convertie automatiquement :

```json
{ "plugins": [ {
  "package": "/home/vous/.local/share/opencode-tor-rotate/plugin",
  "options": { "proxyUrl": "http://127.0.0.1:9253" }
} ] }
```

**Windows (PowerShell)** : `install.sh` est un script bash. Voir
[docs/windows.md](docs/windows.md) et `bin/opencode-tor.ps1` (lance tor + proxy,
puis `opencode2`, depuis une simple commande `opencode2` via votre profil).

## Usage

```bash
opencode-tor start    # tor (si besoin) + proxy
opencode-tor status   # état JSON : epoch, tunnels, IP de sortie
opencode-tor rotate   # nouveau circuit tout de suite
opencode-tor stop     # arrêt propre du proxy (SIGTERM)
opencode-tor logs [proxy|tor]
opencode-tor doctor   # un contrôle par ligne
```

Fonctionnement : dès la **deuxième** erreur de quota d'affilée du fournisseur
`opencode` (429, `FreeUsageLimitError`, « Rate limit exceeded »). La première est
laissée à OpenCode, car un simple « trop vite » passe en retentant ; réglable avec
l'option `after` (ex. `1` pour tourner dès la première). Le compteur repart à zéro
dès qu'une requête réussit. Le plugin appelle
`/rotate` (nouvelle identité SOCKS `rot<epoch>` → nouveau circuit), attend
1,5 s et laisse OpenCode retenter. Garde-fou : **1 rotation max toutes les
15 secondes**, une alerte par fenêtre. L'IP de sortie est lue sur le port de
contrôle Tor (repli : écho externe `probe`) et journalisée avant → après.

## Affichage dans OpenCode (widget)

Le plugin ajoute un indicateur à l'écran, pour savoir **s'il est chargé et ce qu'il fait** :

| Où | Quoi |
|---|---|
| Écran d'accueil (`home.footer`) | ligne d'état |
| Barre du prompt (`prompt.footer.status`) | ligne d'état : `● Tor 185.x.x.x ↻2` |
| Barre latérale (`sidebar.content`) | panneau : état, IP, rotations `n/max`, erreurs d'affilée, requêtes OK, dernier événement, tunnels |
| Barre latérale, ligne en plus | **Reset du quota** : heure locale de la remise à zéro (`02:00 UTC+2`) et compte à rebours |
| Barre latérale, 2 lignes en plus | **Exits Tor disponibles** (nombre d'exits en marche) et **l'IP de sortie est-elle un noeud Tor ?** (oui / relais / NON) |
| Toasts | plugin actif · quota épuisé · **nouvelle IP A → B** · garde-fou · Tor hors ligne |

États : `● vert` prêt / nouvelle IP · `● jaune` quota épuisé, `◐` rotation en cours ·
`● rouge` Tor hors ligne, garde-fou atteint · `○ rouge` **plugin non chargé / arrêté**.

Le widget tourne dans le processus TUI ; il lit `plugin.state.json` (écrit par
le plugin, état dans `~/.local/state/opencode-tor-rotate/`) et interroge le
proxy en direct (`/status`, toutes les 5 s). Si le widget ne peut pas se
charger, un toast rouge « widget non chargé » donne la raison. Vérifier :
`ctrl+p` → **Open plugin manager dialog**, ou `opencode-tor doctor`.

Les deux lignes « exits » viennent d'**Onionoo**, l'API officielle du Tor Project
(`onionoo.torproject.org`) : 1 requête / 15 min pour le compte, 1 / 30 min par IP de
sortie. Si l'IP n'est PAS un noeud Tor connu, le widget passe en jaune `● <ip> ⚠ hors Tor`
(le trafic ne passe sans doute pas par Tor). `onionoo: false` coupe ces contrôles.

**Heure de remise à zéro du quota.** D'après le code public d'OpenCode
(`zen/util/ipRateLimiter.ts`), le compteur gratuit est **par IP et par jour UTC** et sa
clé expire à la prochaine minuit UTC : la remise à zéro a lieu à **00:00 UTC**, pour tout
le monde. Le widget la convertit dans le fuseau de ta machine, heure d'été/hiver comprise
(Paris : 02:00 en été, 01:00 en hiver). Deux réserves : c'est le code public, non vérifié
sur le service en production (mes réponses 429 n'avaient pas d'en-tête `retry-after`),
et la valeur de la limite quotidienne est secrète. **Changer d'IP donne un compteur neuf
tout de suite** : inutile d'attendre la remise à zéro. À la 1re erreur le pied de page
affiche `● limite de débit 1/2`, à la 2e `● quota épuisé · reset 02:00`.

Options (`options` de l'entrée `plugins`) : `toasts: false` (pas de toasts),
`timeZone` (ex. `"Europe/Paris"`, sinon le fuseau du système),
`pollMs` (rafraîchissement, 500 ms), `stateFile`. Le fichier livré
`plugin/tui.mjs` est généré depuis `plugin/tui.tsx` (`npm i && npm run build:tui`).

## Usage responsable

Soyons clairs : le quota gratuit est **par IP de sortie**. Changer d'IP pour
retenter après un rate limit **contourne une limite fixée par le fournisseur**.
Vérifiez les conditions d'utilisation du fournisseur avant d'utiliser cet
outil ; en cas de doute, ne l'utilisez pas.

Limites intégrées (ce ne sont pas des excuses, juste des freins) :
rotations plafonnées (**1 / 15 s**, c'est le vrai frein), seuil `after`
réglable (2 par défaut), détection limitée aux vraies erreurs de quota (un 403, un 500 ou une
surcharge ne déclenchent rien), **seul `opencode.ai` passe par Tor** (tout le reste en direct). Rien ici ne rend
quoi que ce soit « illimité ».

## Migration et retour arrière

L'installeur **copie** (ne déplace pas) l'ancien état `~/.opencode_check_tor`
vers `~/.local/state/opencode-tor-rotate`. L'original reste en place.

Retour à l'ancien layout (`~/opencode-tor` + `~/.opencode_check_tor`) :
1. `./uninstall.sh` (ou `--purge` pour aussi effacer le nouvel état),
2. retirez le bloc `opencode-tor-rotate` de `~/.bashrc` (fait par
   `uninstall.sh`) et rechargez le shell,
3. relancez l'ancien `~/opencode-tor/opencode-tor.sh` — vos fichiers
   (cookie tor, journaux) n'ont jamais été déplacés.

## Dépannage

- **Le service d'arrière-plan ignore le proxy.** `opencode serve` ne relit
  pas l'environnement tout seul : déclarez les variables avec
  `./install.sh --service-env` (confirmation `OUI`), puis redémarrez le
  service. Vérifiez avec `opencode-tor doctor`.
- **`opencode` ne semble pas passer par le proxy.** Un alias ou une fonction
  shell peut masquer le binaire : `command opencode --version` contourne
  l'alias et montre ce qui s'exécute vraiment.
- **`Connection refused` sur 127.0.0.1:9253.** Le proxy est arrêté :
  `opencode-tor start`, puis `opencode-tor status`. Si le port reste fermé,
  `opencode-tor logs proxy`.
- **TLS cassé / certificats invalides.** Les intercepteurs type Reqable, VPN
  avec inspection TLS ou antivirus MITM cassent les tunnels CONNECT :
  désactivez la capture pour `opencode.ai` (ou contournez le proxy pour
  tester : `TOR_PROXY_URL=http://127.0.0.1:1` le rend injoignable et le
  plugin se tait après un avertissement).
- **Règle d'or : ne laissez jamais un agent OpenCode arrêter tor, le proxy
  ou le service.** Ces processus portent votre connectivité : un agent qui
  les redémarre « pour dépanner » vous coupe en plein milieu. Dépannez à la
  main avec `opencode-tor doctor`.

## Feuille de route

- **Support OpenCode V1** : la V1 ignore la clé `plugins` sans erreur (vérifié
  en 1.18.34 ; singulier `plugin`, forme liste uniquement). Prévu : détection + écriture au bon
  format selon la version. En attendant, V2 exigée (l'installeur refuse V1).
- Piste : rotation préventive avant les gros lots de requêtes.

## Développement

```bash
npm test            # plugin + modèle du widget (node:test, 52 cas)
npm run test:tui    # rendu réel du widget (bun + OpenTUI, 6 cas)
npm run test:py     # proxy (unittest, 42 cas)
npm run test:install  # installateur (bash, 24 cas, HOME jetable + faux binaires)
```

Tests 100 % hors ligne : faux serveur SOCKS, faux port de contrôle, faux
écho d'IP, faux binaire `opencode`, ports de test 1925x (jamais 925x).
CI : shellcheck, `node --check` + tests, `py_compile` + unittest, validation
JSON (fichiers + fusion réelle dans un HOME jetable).

Licence MIT — voir [LICENSE](LICENSE). Changelog : [CHANGELOG.md](CHANGELOG.md).
