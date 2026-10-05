// Modèle d'affichage du widget TUI — logique pure, sans dépendance, testée hors rendu.
//
// Le plugin de rotation (processus serveur) écrit `plugin.state.json` ; le widget
// (processus TUI) le relit et le transforme ici en texte + ton (ok / warn / bad / dim).
import os from "node:os"
import path from "node:path"

export const FRESH_ROTATION_MS = 10_000 // "nouvelle IP" reste mis en avant 10 s
export const SPINNER = ["◐", "◓", "◑", "◒"]

export function defaultStateFile(env = process.env, home = os.homedir()) {
  if (env.TOR_ROTATE_STATE_FILE) return env.TOR_ROTATE_STATE_FILE
  return path.join(home, ".local", "state", "opencode-tor-rotate", "plugin.state.json")
}

// Lit l'état écrit par le plugin. null si absent / illisible / pas notre format.
export function readState(file, fsImpl) {
  try {
    const st = JSON.parse(fsImpl.readFileSync(file, "utf8"))
    return st && st.v === 1 && typeof st.state === "string" ? st : null
  } catch {
    return null
  }
}

// Le processus du plugin est-il encore vivant ? (signal 0 = simple test d'existence)
export function pidAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (e) {
    return e?.code === "EPERM" // existe mais appartient à un autre utilisateur
  }
}

// --- Remise à zéro du quota gratuit ------------------------------------------------------
// Source : code public d'OpenCode (zen/util/ipRateLimiter.ts). Le compteur est PAR IP et PAR JOUR
// UTC (clé = date UTC `YYYYMMDD`), et la clé expire à la prochaine minuit UTC :
//   getRetryAfterDay(now) = ceil((86_400_000 - (now % 86_400_000)) / 1000)
// => remise à zéro à 00:00 UTC pour tout le monde (à minuit pile : une journée complète).
// L'heure locale ET le décalage sont lus à l'instant exact de la remise à zéro via Intl :
// le passage heure d'été / heure d'hiver est donc géré sans décalage fixe.
export const DAY_MS = 86_400_000

function localParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
  const o = {}
  for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, tz: fmt.resolvedOptions().timeZone }
}

// 0 -> "UTC", 120 -> "UTC+2", 330 -> "UTC+5:30", -150 -> "UTC-2:30"
function fmtOffset(min) {
  if (min === 0) return "UTC"
  const sign = min < 0 ? "-" : "+"
  const a = Math.abs(min)
  const m = a % 60
  return `UTC${sign}${Math.floor(a / 60)}${m ? `:${String(m).padStart(2, "0")}` : ""}`
}

// timeZone : nom IANA ("Europe/Paris") ; absent ou invalide => fuseau du système (jamais d'exception).
export function quotaReset({ now = Date.now(), timeZone } = {}) {
  const resetAtMs = (Math.floor(now / DAY_MS) + 1) * DAY_MS
  let p
  try {
    p = localParts(resetAtMs, timeZone || undefined)
  } catch {
    p = localParts(resetAtMs, undefined)
  }
  const offsetMin = Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(resetAtMs / 60_000) * 60_000) / 60_000)
  return {
    resetAtMs,
    inMs: resetAtMs - now,
    localTime: `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`,
    utcOffset: fmtOffset(offsetMin),
    timeZone: p.tz,
  }
}

// 18_720_000 -> "5 h 12 min", 2_520_000 -> "42 min", 30_000 -> "moins d'une minute"
export function fmtCountdown(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / 60_000)
  if (totalMin < 1) return "moins d'une minute"
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

// 15000 -> "15 s", 600000 -> "10 min"
export const fmtWindow = (ms) =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`

// 2143 -> "2 143"
export const fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ")

export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}min` : `${Math.round(m / 60)}h`
}

const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8)

// st: état du plugin (ou null) ; live: { ok, exit_ip, tunnels } du proxy (ou null) ;
// alive: le processus du plugin tourne-t-il ; now: Date.now() ; frame: compteur d'animation ;
// net: contrôles Onionoo { exitCount, ipKind: exit|relay|none|null, ipNick } (ou null).
export function viewModel({ st, live = null, alive = true, now = Date.now(), frame = 0, net = null, tz }) {
  if (!st) {
    return {
      key: "absent",
      tone: "bad",
      dot: "○",
      label: "plugin de rotation non chargé",
      short: "○ Tor : plugin non chargé",
      lines: [
        "Tor rotate",
        "○ plugin de rotation non chargé",
        "→ lance : opencode-tor doctor",
      ],
    }
  }
  if (!alive) {
    return {
      key: "stopped",
      tone: "bad",
      dot: "○",
      label: "plugin arrêté",
      short: "○ Tor : plugin arrêté",
      lines: ["Tor rotate", "○ plugin arrêté (service OpenCode fermé ?)", `dernier état : ${st.state}`],
    }
  }

  const ip = live?.exit_ip || st.lastExit || null
  const rot = st.rotations > 0 ? ` ↻${st.rotations}` : ""
  const proxyDown = live ? live.ok === false : st.proxyOk === false
  // Garde-fou : le plugin n'écrit son état qu'à chaque événement. Une fois l'heure de libération
  // passée on n'affiche donc plus "garde-fou" (sinon "5/5" resterait figé jusqu'à la prochaine
  // erreur), et le nombre de rotations de la fenêtre est recompté en direct.
  const stampsList = Array.isArray(st.stamps) ? st.stamps : null
  const inWin = stampsList ? stampsList.filter((s) => now - s < st.windowMs).length : st.inWindow
  const guardOver = st.state === "guard" && st.guardFreeAt > 0 && now >= st.guardFreeAt
  const stateName = guardOver ? "ready" : st.state
  const busy = stateName === "rotating" || stateName === "ratelimited"
  const reset = quotaReset({ now, timeZone: tz })

  let key = stateName
  let tone = "ok"
  let dot = "●"
  let label = "actif"
  let short = ""

  if (stateName === "guard") {
    tone = "bad"
    label = `garde-fou (${inWin}/${st.maxRotations})`
    short = `● garde-fou ${inWin}/${st.maxRotations}`
  } else if (stateName === "rotating") {
    tone = "warn"
    dot = SPINNER[frame % SPINNER.length]
    label = "rotation du circuit Tor…"
    short = `${dot} rotation Tor…`
  } else if (stateName === "ratelimited") {
    tone = "warn"
    if (st.streak >= 1 && st.streak < st.after) {
      // 1re erreur : peut-être un simple "trop vite", on ne change pas encore d'IP.
      label = `limite de débit (${st.streak}/${st.after})`
      short = `● limite de débit ${st.streak}/${st.after}`
    } else {
      label = "quota épuisé"
      short = `● quota épuisé · reset ${reset.localTime}`
    }
  } else if (stateName === "error" || stateName === "proxy_down" || (proxyDown && !busy)) {
    key = stateName === "ready" || stateName === "loaded" ? "proxy_down" : st.state
    tone = "bad"
    label = "proxy Tor hors ligne"
    short = "● Tor hors ligne"
  } else if (stateName === "rotated" && now - st.stateAt < FRESH_ROTATION_MS) {
    label = `nouvelle IP ${ip ?? "?"}`
    short = `● nouvelle IP ${ip ?? "?"}`
  } else {
    key = "ready"
    label = ip ? `prêt · ${ip}` : "prêt"
    short = `● Tor ${ip ?? "prêt"}${rot}`
  }

  // IP de sortie ABSENTE de l'annuaire Tor (Onionoo) : le trafic ne passe sans doute pas par Tor.
  // Seul un "none" certain déclenche l'alerte ; une vérification impossible (null) ne dit rien.
  if (ip && net?.ipKind === "none" && (key === "ready" || key === "rotated")) {
    key = "notor"
    tone = "warn"
    label = "IP non reconnue comme noeud Tor"
    short = `● ${ip} ⚠ hors Tor`
  }

  const lines = [
    "Tor rotate",
    `${dot} ${label}`,
    `IP de sortie : ${ip ?? "?"}`,
    ...(net ? [ipCheckLine(ip, net), `Exits Tor disponibles : ${net.exitCount == null ? "?" : fmtInt(net.exitCount)}`] : []),
    `Rotations : ${st.rotations} (${inWin}/${st.maxRotations} sur ${fmtWindow(st.windowMs)})`,
    `Quota épuisé d'affilée : ${st.streak}/${st.after}`,
    `Reset du quota : ${reset.localTime} ${reset.utcOffset} (dans ${fmtCountdown(reset.inMs)})`,
    `Requêtes OK : ${st.okCount}`,
    `Dernier : ${st.message} (il y a ${ago(now - st.stateAt)})`,
  ]
  if (stateName === "guard" && st.guardFreeAt) lines.push(`Garde-fou libre à ${hhmmss(st.guardFreeAt)}`)
  if (live && live.tunnels !== undefined) lines.push(`Tunnels Tor ouverts : ${live.tunnels}`)

  return { key, tone, dot, label, short, lines, reset }
}

function ipCheckLine(ip, net) {
  if (!ip) return "Noeud Tor : en attente d'une IP"
  switch (net?.ipKind) {
    case "exit":
      return `Noeud Tor : oui, exit${net.ipNick ? ` (${net.ipNick})` : ""}`
    case "relay":
      return "Noeud Tor : relais, exit non confirmé"
    case "none":
      return "Noeud Tor : NON (absente de l'annuaire)"
    default:
      return "Noeud Tor : vérification…"
  }
}

// Faut-il afficher un toast quand on passe de la clé `prev` à `next` ? null = non.
export function toastFor(prev, vm, st) {
  if (!vm || prev === vm.key) return null
  switch (vm.key) {
    case "ready":
      // Premier état valide, ou retour à la normale après une panne.
      return prev === undefined || ["absent", "stopped", "proxy_down", "error", "notor", "guard"].includes(prev)
        ? { variant: "success", title: "Tor rotate", message: `actif — ${vm.label}` }
        : null
    case "ratelimited":
      if (st && st.streak >= 1 && st.streak < st.after) {
        return { variant: "warning", title: `Limite de débit (${st.streak}/${st.after})`, message: "on retente avant de changer d'IP" }
      }
      return {
        variant: "warning",
        title: "Quota épuisé",
        message: vm.reset ? `reset à ${vm.reset.localTime}, ou nouvelle IP tout de suite` : "changement d'IP en cours…",
      }
    case "rotated":
      return { variant: "success", title: "Nouvelle IP Tor", message: st?.message ?? vm.label }
    case "guard":
      return { variant: "error", title: "Garde-fou Tor", message: vm.label }
    case "notor":
      return { variant: "warning", title: "IP hors Tor ?", message: "l'IP de sortie n'est pas un noeud Tor connu : vérifie le proxy" }
    case "proxy_down":
    case "error":
      return { variant: "error", title: "Tor hors ligne", message: "lance : opencode-tor start" }
    case "absent":
    case "stopped":
      return { variant: "warning", title: "Tor rotate", message: vm.label }
    default:
      return null
  }
}
