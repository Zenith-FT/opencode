# Windows (PowerShell) — installation et pièges

`install.sh` et `bin/opencode-tor` sont des scripts **bash** (Linux / Termux) : ne les lancez pas sous
Windows. Utilisez `bin/opencode-tor.ps1` (PowerShell 5.1+), testé avec OpenCode **2.0.6**, tor 0.4.9
(scoop) et Python 3.12.

## 1. OpenCode 2
- Installer le binaire **officiel** (page https://opencode.ai/v2/docs, `opencode-windows-x64.zip`) en
  `opencode2.exe` dans un dossier du PATH (ex. `%USERPROFILE%\.local\bin`). Pas de scoop/choco pour la V2.
  Le paquet npm nommé `opencode2` est un dépôt **tiers** : ne pas l'utiliser.
- La V1 (`opencode`) et la V2 lisent les **mêmes** fichiers de config. Vérifié sur
  V1 1.18.34 : elle **ignore** la clé `plugins` sans erreur, donc la déclaration
  peut vivre dans la config **globale** et le plugin se charge depuis
  n'importe quel dossier.

## 2. Piège : `auth.json` avec BOM -> « Background service failed to start »
Symptôme : `opencode2` affiche `Background service failed to start`, `opencode2 service status` répond
`stopped`. Cause : la migration V2 lit `auth.json` (hérité de la V1) en JSON strict et échoue si le fichier
commence par un BOM UTF-8 (`EF BB BF`). Correctif (sauvegarde faite d'abord) :

```powershell
$p = "$env:USERPROFILE\.local\share\opencode\auth.json"
Copy-Item $p "$p.bak"
$b = [IO.File]::ReadAllBytes($p)
if ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) {
  [IO.File]::WriteAllBytes($p, [byte[]]$b[3..($b.Length - 1)])
}
```
Un processus `opencode2` resté coincé après l'échec doit être arrêté **à la main** (vérifier son nom/PID
avant) avant de relancer `opencode2 service start`.

## 3. Déclarer le plugin : `plugins` est un TABLEAU
Doc officielle (https://opencode.ai/v2/docs/plugins/) : tableau de textes ou d'objets `{package, options}`.
La forme objet `{"tor-rotate": {...}}` est **ignorée en silence** (`opencode2 debug config` la montre vide).

```json
{ "plugins": [ { "package": "C:\\Users\\VOUS\\Tools\\opencode-tor-rotate\\plugin",
                 "options": { "proxyUrl": "http://127.0.0.1:9253" } } ] }
```
- Un seul module sert le service **et** le TUI : pas besoin de `cli.json`.
- OpenCode cherche `opencode.json(c)` depuis le dossier courant **en remontant vers la racine**
  (jamais sur les côtés) : un fichier dans `Tools\opencode-tor-test` ne s'applique pas à `Tools\Mihon`.
  Mettre la déclaration dans le fichier **global** (`%USERPROFILE%\.config\opencode\opencode.json(c)`)
  fait fonctionner le plugin depuis n'importe quel dossier (la V1 1.18.34 ignore
  la clé `plugins` sans erreur), ou dans un dossier parent commun.
- **Ne déclarez le plugin qu'à UN endroit** (sinon il pourrait être chargé deux fois).
- Vérifier : `opencode2 debug config` (le plugin doit apparaître) ; `ctrl+p` -> plugin manager.

## 4. PowerShell : autoriser les scripts
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
Unblock-File <chemin>\bin\opencode-tor.ps1      # à refaire après chaque téléchargement
```
Sans cela : « n'est pas signé numériquement ».

## 5. Commande `opencode2` qui démarre tout (profil PowerShell)
```powershell
$p = $PROFILE
if (-not (Test-Path $p)) { New-Item -ItemType File -Force $p | Out-Null }
if (-not (Select-String -Path $p -Pattern '>>> opencode-tor >>>' -Quiet)) {
Add-Content $p @'

# >>> opencode-tor >>>
function opencode2 { & "C:\Users\VOUS\Tools\opencode-tor-rotate\bin\opencode-tor.ps1" -Action run -Rest $args }
function ot { & "C:\Users\VOUS\Tools\opencode-tor-rotate\bin\opencode-tor.ps1" @args }
# <<< opencode-tor <<<
'@
}
```
La fonction `opencode2` passe avant le `.exe` ; le script appelle l'exécutable par son chemin complet
(`%USERPROFILE%\.local\bin\opencode2.exe`, variable `OPENCODE2_EXE`) pour ne pas se rappeler lui-même.
`ot start | status | rotate | stop`. N'utilisez pas `ot stop` pendant qu'`opencode2` est ouvert.

## 6. Le trafic passe-t-il vraiment par Tor ?
`run` définit `HTTPS_PROXY` / `HTTP_PROXY` (= le proxy local) et `NO_PROXY=127.0.0.1,localhost`. Le service
d'arrière-plan **hérite de l'environnement au moment où il démarre** : s'il tournait déjà sans proxy,
faire une fois `opencode2 service restart` (ferme les sessions ouvertes ; l'historique reste).

Vérification (journal du proxy, une ligne par connexion) :
```powershell
Get-Content $env:USERPROFILE\.local\state\opencode-tor-rotate\proxy.log -Tail 20
```
`CONNECT opencode.ai:443 -> TOR` = OK. Seuls les domaines d'opencode.ai passent par Tor, le reste est direct
(un `curl` ordinaire montrera donc votre IP normale ou celle de votre VPN : c'est attendu).

## 7. Limites connues sous Windows
- Pas de SIGTERM : arrêter le proxy par `ot stop` (tue uniquement le PID noté par le script) laisse
  un fichier pid ; sans conséquence.
- Le test Python du SIGTERM est ignoré sous Windows (`skipIf`).
- Une rotation ferme **toutes** les connexions en cours vers opencode.ai (y compris celles des sous-agents).
