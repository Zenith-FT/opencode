# opencode-tor.ps1 - lance tor + le proxy du plugin tor-rotate sous Windows (PowerShell 5.1+).
#
#   .\opencode-tor.ps1 start      # tor + proxy en arriere-plan (fenetres cachees)
#   .\opencode-tor.ps1 status     # ports + etat du proxy (IP de sortie, tunnels)
#   .\opencode-tor.ps1 rotate     # nouveau circuit Tor tout de suite
#   .\opencode-tor.ps1 stop       # arrete UNIQUEMENT les processus lances par ce script
#   .\opencode-tor.ps1 run        # start + lance opencode2 avec le proxy declare
#   .\opencode-tor.ps1 run C:\mon\projet   # les arguments apres "run" vont a opencode2
#
# Avec les fonctions du profil PowerShell (voir le message d'installation), il suffit de taper
#   opencode2        (demarre tor + proxy si besoin, puis lance opencode2)
#   ot status | ot rotate | ot stop
#
# Fichier volontairement en ASCII : PowerShell 5.1 lit mal l'UTF-8 sans BOM.
# Mode d'emploi complet (profil PowerShell, pieges Windows) : docs/windows.md
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'rotate', 'run')]
  [string]$Action = 'status',
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)
$ErrorActionPreference = 'Stop'

# --- reglages (modifiables par variables d'environnement) -----------------
# Depot du plugin : OTR_REPO, sinon le dossier parent de bin\, sinon %USERPROFILE%\Tools\opencode-tor-rotate.
$RepoCandidates = @($env:OTR_REPO)
if ($PSScriptRoot) { $RepoCandidates += (Split-Path -Parent $PSScriptRoot) }
$RepoCandidates += (Join-Path $env:USERPROFILE 'Tools\opencode-tor-rotate')
$RepoCandidates = @($RepoCandidates | Where-Object { $_ })
$Repo = $RepoCandidates | Where-Object { Test-Path (Join-Path $_ 'proxy\tor-split-proxy.py') } | Select-Object -First 1
if (-not $Repo) { $Repo = $RepoCandidates[0] }
$SocksPort   = if ($env:TOR_SOCKS_PORT) { [int]$env:TOR_SOCKS_PORT } else { 9250 }
$ControlPort = if ($env:TOR_CONTROL_PORT) { [int]$env:TOR_CONTROL_PORT } else { 9251 }
$ProxyPort   = if ($env:TOR_PROXY_PORT) { [int]$env:TOR_PROXY_PORT } else { 9253 }

$State    = Join-Path $env:USERPROFILE '.local\state\opencode-tor-rotate'
$TorDir   = Join-Path $State 'tor'
$TorData  = Join-Path $TorDir 'data'
$Cookie   = Join-Path $TorDir 'cookie'
$TorLog   = Join-Path $TorDir 'tor.log'
$ProxyLog = Join-Path $State 'proxy.log'
$ProxyErr = Join-Path $State 'proxy.err.log'
$TorPid   = Join-Path $State 'tor.win.pid'
$ProxyPid = Join-Path $State 'proxy.win.pid'
$ProxyPy  = Join-Path $Repo 'proxy\tor-split-proxy.py'
# Chemin COMPLET du vrai programme : indispensable si une fonction "opencode2" existe dans le
# profil, sinon le script s'appellerait lui-meme a l'infini.
$Opencode2 = if ($env:OPENCODE2_EXE) { $env:OPENCODE2_EXE } else { Join-Path $env:USERPROFILE '.local\bin\opencode2.exe' }

function Say([string]$m) { Write-Host $m }

function Test-Port([int]$Port, [int]$TimeoutMs = 500) {
  $c = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $c.EndConnect($iar)
    return $true
  } catch { return $false } finally { $c.Close() }
}

function Wait-Port([int]$Port, [int]$Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-Port $Port) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

# GET sans passer par un proxy (le proxy lui-meme !). Renvoie le texte.
function Get-Local([string]$Path) {
  $wc = New-Object System.Net.WebClient
  $wc.Proxy = $null
  return $wc.DownloadString("http://127.0.0.1:$ProxyPort$Path")
}

function Start-Tor([int]$BootSeconds = 60) {
  if (Test-Port $ControlPort) { Say "tor deja en ecoute (controle :$ControlPort)"; return }
  $tor = Get-Command tor.exe -ErrorAction SilentlyContinue
  if (-not $tor) { throw "tor.exe introuvable dans le PATH (scoop install tor ?)" }
  New-Item -ItemType Directory -Force -Path $TorData | Out-Null
  Say "demarrage de tor (SOCKS :$SocksPort, controle :$ControlPort)..."
  $torArgs = @(
    '--SocksPort', "127.0.0.1:$SocksPort",
    '--ControlPort', "127.0.0.1:$ControlPort",
    '--CookieAuthentication', '1',
    '--CookieAuthFile', "`"$Cookie`"",
    '--DataDirectory', "`"$TorData`"",
    '--Log', "`"notice file $TorLog`""
  )
  $p = Start-Process -FilePath $tor.Source -ArgumentList $torArgs -WindowStyle Hidden -PassThru
  Set-Content -Path $TorPid -Value $p.Id
  if (-not (Wait-Port $ControlPort 90)) { throw "tor ne repond pas sur :$ControlPort (voir $TorLog)" }
  $boot = $false
  for ($i = 0; $i -lt $BootSeconds; $i++) {
    if ((Test-Path $TorLog) -and (Select-String -Path $TorLog -Pattern 'Bootstrapped 100%' -Quiet)) { $boot = $true; break }
    Start-Sleep -Seconds 1
  }
  if ($boot) { Say "tor pret (bootstrap 100 %)" } else { Say "tor se connecte encore en arriere-plan (voir $TorLog)" }
}

function Start-Proxy {
  if (Test-Port $ProxyPort) { Say "proxy deja en ecoute (:$ProxyPort)"; return }
  if (-not (Test-Path $ProxyPy)) { throw "proxy introuvable : $ProxyPy (variable OTR_REPO ?)" }
  $py = Get-Command python -ErrorAction SilentlyContinue
  if (-not $py) { throw "python introuvable dans le PATH" }
  Say "demarrage du proxy (:$ProxyPort)..."
  $proxyArgs = @(
    "`"$ProxyPy`"",
    '--port', "$ProxyPort",
    '--socks-port', "$SocksPort",
    '--control-port', "$ControlPort",
    '--cookie', "`"$Cookie`""
  )
  $p = Start-Process -FilePath $py.Source -ArgumentList $proxyArgs -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $ProxyLog -RedirectStandardError $ProxyErr
  Set-Content -Path $ProxyPid -Value $p.Id
  if (-not (Wait-Port $ProxyPort 15)) { throw "proxy non demarre (voir $ProxyLog et $ProxyErr)" }
  Say "proxy en cours (PID $($p.Id), :$ProxyPort)"
}

# N'arrete QUE le PID enregistre par ce script, et seulement si le nom correspond.
function Stop-Saved([string]$PidFile, [string]$NamePattern, [string]$Label) {
  if (-not (Test-Path $PidFile)) { Say "$Label : rien a arreter (pas de $PidFile)"; return }
  $id = [int](Get-Content $PidFile)
  $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -match $NamePattern) {
    Stop-Process -Id $id
    Say "$Label arrete (PID $id)"
  } else {
    Say "$Label : le PID $id n'existe plus ou n'est pas le notre, on n'y touche pas"
  }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
}

switch ($Action) {
  'start' { Start-Tor; Start-Proxy }

  'stop' {
    Stop-Saved $ProxyPid 'python' 'proxy'
    Stop-Saved $TorPid 'tor' 'tor'
  }

  'status' {
    Say ("tor SOCKS   :{0}  {1}" -f $SocksPort, $(if (Test-Port $SocksPort) { 'OK' } else { 'ferme' }))
    Say ("tor controle:{0}  {1}" -f $ControlPort, $(if (Test-Port $ControlPort) { 'OK' } else { 'ferme' }))
    Say ("proxy       :{0}  {1}" -f $ProxyPort, $(if (Test-Port $ProxyPort) { 'OK' } else { 'ferme' }))
    if (Test-Port $ProxyPort) { Say (Get-Local '/status') }
  }

  'rotate' { Say (Get-Local '/rotate') }

  'run' {
    if (-not (Test-Path $Opencode2)) { throw "opencode2.exe introuvable : $Opencode2 (variable OPENCODE2_EXE ?)" }
    # Au plus 20 s d'attente du bootstrap : tor finit de se connecter pendant que opencode2 demarre.
    Start-Tor 20
    Start-Proxy
    # OpenCode (Bun) lit ces variables ; le proxy n'envoie que opencode.ai par Tor, le reste en direct.
    $env:HTTPS_PROXY = "http://127.0.0.1:$ProxyPort"
    $env:HTTP_PROXY  = "http://127.0.0.1:$ProxyPort"
    $env:NO_PROXY    = '127.0.0.1,localhost'
    & $Opencode2 @Rest
  }
}
