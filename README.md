# opencode-tor-rotate

Tu utilises les modèles gratuits d'OpenCode (le canal Zen) et tu tombes sur
`Rate limit exceeded` en pleine journée ? Ce plugin change ton IP de sortie
via Tor quand le quota est épuisé, et OpenCode retente ta requête. Seul le
trafic vers `opencode.ai` passe par Tor. Tout le reste va en direct.

Le quota gratuit se compte **par IP et par jour** (remise à zéro à 00:00 UTC).
Changer d'IP te rend un compteur neuf tout de suite.

## Démarrage en 2 minutes

Il te faut OpenCode 2.x, `tor` et `python3` installés.

**Linux / macOS :**

```bash
git clone https://github.com/Zenith-FT/opencode.git ~/projects/opencode-tor-rotate
cd ~/projects/opencode-tor-rotate
./install.sh --alias
source ~/.bashrc
opencode-tor start
opencode-tor status
```

L'installeur déclare le plugin dans ta config globale, sans toucher au reste.
Ajoute `--dry-run` pour voir ce qu'il ferait sans rien changer.

**Windows (PowerShell) :**

1. Clone le dépôt où tu veux, par exemple `C:\Users\Toi\Tools\opencode-tor-rotate`.
2. `Unblock-File .\bin\opencode-tor.ps1` (Windows bloque les scripts téléchargés).
3. Ajoute ces deux fonctions à ton profil PowerShell (`$PROFILE`) :
```powershell
function opencode2 { & "C:\Users\Toi\Tools\opencode-tor-rotate\bin\opencode-tor.ps1" -Action run -Rest $args }
function ot { & "C:\Users\Toi\Tools\opencode-tor-rotate\bin\opencode-tor.ps1" @args }
```
4. Déclare le plugin dans `%USERPROFILE%\.config\opencode\opencode.jsonc` :
```jsonc
"plugins": [
  { "package": "C:\\Users\\Toi\\Tools\\opencode-tor-rotate\\plugin",
    "options": { "proxyUrl": "http://127.0.0.1:9253" } }
]
```
5. Redémarre le service d'arrière-plan une fois (`opencode2 service restart`),
   puis lance `opencode2` normalement et vérifie avec `ot status`.

Détails et pièges Windows : [docs/windows.md](docs/windows.md).

## Comment tu vois que ça marche

Le plugin ajoute un indicateur dans OpenCode :

| Où | Ce que tu vois |
|---|---|
| Pied de l'écran d'accueil | ligne d'état |
| Barre du prompt | `● Tor 185.x.x.x ↻2` |
| Barre latérale | état, IP de sortie, rotations `n/max`, erreurs d'affilée, dernier événement |
| Barre latérale | heure du reset quota + compte à rebours, nombre d'exits Tor, IP vérifiée comme noeud Tor |
| Notifications | plugin actif, quota épuisé, nouvelle IP, garde-fou, Tor hors ligne |

Couleurs : `●` vert (prêt), `●` jaune (quota épuisé), `◐` (rotation en cours),
`●` rouge (Tor hors ligne ou garde-fou atteint), `○` rouge (plugin non chargé).
Si le widget ne charge pas, un toast rouge explique pourquoi. Tu peux aussi
ouvrir `ctrl+p` → **Open plugin manager dialog**.

Preuve que le trafic passe par Tor : cherche `CONNECT opencode.ai:443 -> TOR`
dans le journal du proxy (`~/.local/state/opencode-tor-rotate/proxy.log`,
sous Windows `%USERPROFILE%\.local\state\opencode-tor-rotate\proxy.log`).
Tu vois cette ligne après ton premier message dans OpenCode.

## Comment ça marche

1. OpenCode reçoit une erreur 429 du fournisseur `opencode`. La première erreur
   ne fait rien : elle passe souvent en retentant.
2. À la **deuxième erreur d'affilée**, le plugin demande un nouveau circuit Tor
   au proxy local (port 9253), attend 1,5 seconde et laisse OpenCode retenter.
3. Dès qu'une requête réussit, le compteur repart à zéro.

Sécurités intégrées : **1 rotation maximum toutes les 15 secondes** ; seules
les vraies erreurs de quota déclenchent une rotation (un 403, un 500 ou une
surcharge ne font rien) ; **seul `opencode.ai` passe par Tor**.

## Commandes utiles

```bash
opencode-tor start    # démarre tor (si besoin) + proxy
opencode-tor status   # état : epoch, tunnels, IP de sortie
opencode-tor rotate   # change d'IP tout de suite
opencode-tor stop     # arrête le proxy proprement
opencode-tor logs [proxy|tor]
opencode-tor doctor   # un contrôle par ligne
```

Sous Windows, remplace `opencode-tor` par `ot`.

Réglages (`options` de l'entrée `plugins`) : `after` (erreurs d'affilée avant
rotation, 2 par défaut), `toasts: false` (coupe les notifications),
`timeZone` (ex. `"Europe/Paris"`), `pollMs` (rafraîchissement du widget),
`stateFile`, `onionoo: false` (coupe la vérification des noeuds Tor).
Voir [docs/config.md](docs/config.md) pour la liste complète.

## Dépannage

- **`Connection refused` sur 127.0.0.1:9253.** Le proxy est arrêté :
  `opencode-tor start` (ou `ot start` sous Windows), puis `status`.
- **OpenCode ignore le proxy.** Le service a démarré sans les variables
  d'environnement : `./install.sh --service-env` (confirmation `OUI`), puis
  redémarre le service. Vérifie avec `opencode-tor doctor`.
- **`opencode` ne semble pas passer par Tor.** Un alias peut masquer le
  binaire : `command opencode --version` montre ce qui s'exécute vraiment.
- **Certificats invalides / TLS cassé.** Un antivirus ou un outil d'inspection
  TLS casse les tunnels : désactive la capture pour `opencode.ai`.
- **Ne laisse jamais un agent OpenCode arrêter tor, le proxy ou le service.**
  Dépanne à la main avec `opencode-tor doctor`.

## Usage responsable

Le quota gratuit se compte par IP. Changer d'IP pour retenter après un rate
limit contourne une limite du fournisseur. Lis ses conditions d'utilisation
avant d'utiliser cet outil ; en cas de doute, ne l'utilise pas. Rien ici ne
rend quoi que ce soit illimité : les rotations restent plafonnées et seuls
les domaines d'OpenCode passent par Tor.

## Retour en arrière

L'installeur **copie** l'ancien état vers le nouvel emplacement, il ne le
déplace pas. Pour revenir en arrière : `./uninstall.sh` (ajoute `--purge`
pour effacer aussi le nouvel état), retire le bloc du plugin de ta config,
recharge ton shell.

## Développement

```bash
npm test            # plugin + widget (node:test, 95 cas)
npm run test:tui    # rendu réel du widget (bun + OpenTUI, 8 cas)
npm run test:py     # proxy (unittest, 42 cas)
npm run test:install  # installateur (bash, HOME jetable + faux binaires)
```

Tests 100 % hors ligne : faux serveur SOCKS, faux port de contrôle, faux
binaire `opencode`. Le fichier `plugin/tui.mjs` se génère depuis
`plugin/tui.tsx` (`npm i && npm run build:tui`).

Pistes : rotation préventive avant les gros lots de requêtes.

Licence MIT — voir [LICENSE](LICENSE). Changelog : [CHANGELOG.md](CHANGELOG.md).
