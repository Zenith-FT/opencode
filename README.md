# opencode-tor-rotate

Plugin OpenCode 2.x + proxy local : quand le fournisseur `opencode` répond
**rate limit** (429), le plugin demande un **nouveau circuit Tor** au proxy
puis fait retenter la requête. Seul `opencode.ai` passe par Tor, le reste va
en direct.

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

L'installeur exige **OpenCode V2** (`opencode --version`) : la V1 rejette la
clé plurielle `plugins`. Il déclare le plugin sous cette forme, sans toucher
au reste de `opencode.json` (ou `.jsonc`, sauvegarde avant écriture) :

```json
{ "plugins": { "tor-rotate": {
  "package": "/home/vous/.local/share/opencode-tor-rotate/plugin",
  "options": { "proxyUrl": "http://127.0.0.1:9253" }
} } }
```

## Usage

```bash
opencode-tor start    # tor (si besoin) + proxy
opencode-tor status   # état JSON : epoch, tunnels, IP de sortie
opencode-tor rotate   # nouveau circuit tout de suite
opencode-tor stop     # arrêt propre du proxy (SIGTERM)
opencode-tor logs [proxy|tor]
opencode-tor doctor   # un contrôle par ligne
```

Fonctionnement : après 3 rate limits **d'affilée** du fournisseur `opencode`
(le compteur repart à zéro dès qu'une requête réussit), le plugin appelle
`/rotate` (nouvelle identité SOCKS `rot<epoch>` → nouveau circuit), attend
1,5 s et laisse OpenCode retenter. Garde-fou : **5 rotations max par
10 minutes**, une alerte par fenêtre. L'IP de sortie est lue sur le port de
contrôle Tor (repli : écho externe `probe`) et journalisée avant → après.

## Usage responsable

Soyons clairs : le quota gratuit est **par IP de sortie**. Changer d'IP pour
retenter après un rate limit **contourne une limite fixée par le fournisseur**.
Vérifiez les conditions d'utilisation du fournisseur avant d'utiliser cet
outil ; en cas de doute, ne l'utilisez pas.

Limites intégrées (ce ne sont pas des excuses, juste des freins) :
rotations plafonnées (5 / 10 min), 3 erreurs d'affilée exigées, **seul
`opencode.ai` passe par Tor** (tout le reste en direct). Rien ici ne rend
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

- **Support OpenCode V1** : la V1 rejette la clé `plugins` (singulier
  `plugin`, forme liste uniquement). Prévu : détection + écriture au bon
  format selon la version. En attendant, V2 exigée (l'installeur refuse V1).
- Piste : rotation préventive avant les gros lots de requêtes.

## Développement

```bash
npm test            # plugin (node:test, 29 cas)
npm run test:py     # proxy (unittest, 42 cas)
npm run test:install  # installateur (bash, 24 cas, HOME jetable + faux binaires)
```

Tests 100 % hors ligne : faux serveur SOCKS, faux port de contrôle, faux
écho d'IP, faux binaire `opencode`, ports de test 1925x (jamais 925x).
CI : shellcheck, `node --check` + tests, `py_compile` + unittest, validation
JSON (fichiers + fusion réelle dans un HOME jetable).

Licence MIT — voir [LICENSE](LICENSE). Changelog : [CHANGELOG.md](CHANGELOG.md).
