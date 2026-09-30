// opencode-tor-rotate — plugin OpenCode 2.x
//
// Quand le fournisseur `opencode` (Zen) répond RATE LIMIT (429, "Rate limit
// exceeded", FreeUsageLimitError, "Free usage exceeded"), on demande une NOUVELLE
// IP au proxy local (tor-split-proxy.py /rotate) puis on dit à OpenCode de
// RETENTER la requête.
//
// Un rate limit isolé est souvent passager : on ne change d'IP qu'après AFTER (3)
// erreurs de rate limit D'AFFILÉE. Le compteur repart à zéro dès qu'une requête
// opencode.ai réussit (hook http.response 2xx) ou après RESET_MS sans nouvelle
// erreur. Les rate limits d'un autre fournisseur (Anthropic, OpenAI...) sont
// ignorés.
//
// NB : Plugin.define() est l'identité => un simple `export default { id, setup }`
// est équivalent et évite d'importer @opencode/plugin.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const DEFAULTS = {
  after: 3, // rate limits d'affilée avant rotation
  resetMs: 5 * 60_000, // sans nouvelle erreur -> compteur à 0
  cooldownMs: 4_000, // pas 2 rotations à moins de N ms
  settleMs: 1_500, // délai avant le retry après rotation
  maxRotations: 5, // garde-fou : maxRotations rotations...
  windowMs: 10 * 60_000, // ...par windowMs
  proxyUrl: "http://127.0.0.1:9253",
  providerRegex: "opencode", // providerID (et URL) qui déclenchent la rotation
  logFile: "", // calculé par defaultLogFile()
  logMaxBytes: 1024 * 1024, // plafond du journal
  logBackups: 1, // ...et 1 fichier de sauvegarde
  tokenFile: "", // secret partagé pour /rotate (optionnel)
  fetchTimeoutMs: 8_000, // timeout des appels au proxy
  statusTimeoutMs: 2_000, // timeout du contrôle /status au chargement
}

// Journal par défaut : nouvel emplacement d'état, sauf si l'ancien
// (~/.opencode_check_tor) existe encore et pas le nouveau => on continue
// d'écrire là où l'install précédente écrivait (migration sans casse).
export function defaultLogFile(env = process.env, home = os.homedir()) {
  if (env.TOR_ROTATE_LOG) return env.TOR_ROTATE_LOG
  const next = path.join(home, ".local", "state", "opencode-tor-rotate", "plugin.log")
  const old = path.join(home, ".opencode_check_tor", "plugin.log")
  try {
    if (!fs.existsSync(path.dirname(next)) && fs.existsSync(path.dirname(old))) return old
  } catch {}
  return next
}

// Nombre >= 0 attendu ; undefined / "" / "abc" / négatif => repli sur `fallback`.
const num = (v, fallback) => {
  if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) return fallback
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function compileRegex(value, fallback) {
  if (value instanceof RegExp) return value
  const raw = String(value ?? fallback)
  try {
    return new RegExp(raw, "i")
  } catch {
    return new RegExp(fallback, "i")
  }
}

// Options du plugin (opencode.json : { "package": "...", "options": { ... } })
// avec repli sur les variables d'environnement.
export function resolveConfig(options = {}, env = process.env) {
  const o = options ?? {}
  const d = DEFAULTS
  return {
    after: Math.max(1, num(o.after, num(env.TOR_ROTATE_AFTER, d.after))),
    resetMs: num(o.resetMs, num(env.TOR_ROTATE_RESET_MS, d.resetMs)),
    cooldownMs: num(o.cooldownMs, num(env.TOR_ROTATE_COOLDOWN_MS, d.cooldownMs)),
    settleMs: num(o.settleMs, num(env.TOR_ROTATE_WAIT_MS, d.settleMs)),
    maxRotations: Math.max(1, num(o.maxRotations, num(env.TOR_ROTATE_MAX, d.maxRotations))),
    windowMs: Math.max(1, num(o.windowMs, num(env.TOR_ROTATE_WINDOW_MS, d.windowMs))),
    proxyUrl: String(o.proxyUrl ?? env.TOR_PROXY_URL ?? d.proxyUrl).replace(/\/+$/, ""),
    providerRegex: compileRegex(o.providerRegex ?? env.TOR_ROTATE_PROVIDER_REGEX, d.providerRegex),
    logFile: String(o.logFile ?? env.TOR_ROTATE_LOG ?? defaultLogFile(env)).trim(),
    logMaxBytes: num(o.logMaxBytes, d.logMaxBytes),
    logBackups: num(o.logBackups, d.logBackups),
    tokenFile: String(o.tokenFile ?? env.TOR_ROTATE_TOKEN_FILE ?? d.tokenFile).trim(),
    fetchTimeoutMs: num(o.fetchTimeoutMs, d.fetchTimeoutMs),
    statusTimeoutMs: num(o.statusTimeoutMs, d.statusTimeoutMs),
  }
}

// Journal sur fichier (pas de console.log : ça abîmerait l'affichage du TUI),
// avec plafond de taille : une rotation, backups conservés.
export function createLogger(file, { maxBytes = DEFAULTS.logMaxBytes, backups = DEFAULTS.logBackups } = {}) {
  const rotateFile = () => {
    if (backups < 1) {
      try {
        fs.truncateSync(file, 0)
      } catch {}
      return
    }
    for (let i = backups; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${i - 1}`
      const to = `${file}.${i}`
      try {
        fs.unlinkSync(to)
      } catch {}
      try {
        fs.renameSync(from, to)
      } catch {}
    }
  }
  return function log(msg) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const line = `${new Date().toISOString()} ${msg}\n`
      let size = 0
      try {
        size = fs.statSync(file).size
      } catch {}
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) rotateFile()
      fs.appendFileSync(file, line)
    } catch {}
  }
}

const asText = (x) => {
  try {
    return typeof x === "string" ? x : JSON.stringify(x)
  } catch {
    return String(x)
  }
}

// Rate limit ? (statut 429 ou message connu). providerRe == null => jamais.
export function isRateLimit(error, providerRe) {
  if (!providerRe) return false
  return error?.status === 429 || providerRe.test(asText(error))
}

// Machine à état de rotation, séparée de `setup` pour être testable hors OpenCode.
export function createRotator({ cfg, log, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  let inflight = null // rotation en cours (partagée entre sessions/sous-agents)
  let lastDone = 0
  let stamps = [] // horodatages des rotations dans la fenêtre glissante
  let rotations = 0 // compteur MONOTONE (jamais remis à zéro par la fenêtre)
  let lastExit = null // dernière IP de sortie connue
  let guardFreeAt = 0 // 0 = on peut encore signaler le garde-fou
  let streak = 0 // rate limits d'affilée (la limite de quota est liée à l'IP)
  let lastErr = 0
  let lastProvider = "?"

  const readToken = () => {
    if (!cfg.tokenFile) return null
    try {
      return fs.readFileSync(cfg.tokenFile, "utf8").trim() || null
    } catch {
      return null
    }
  }

  async function proxyGet(ep, timeoutMs) {
    const headers = {}
    const token = readToken()
    if (token) headers["X-Tor-Rotate-Token"] = token
    const res = await fetchImpl(`${cfg.proxyUrl}${ep}`, { signal: AbortSignal.timeout(timeoutMs), headers })
    if (!res.ok) throw new Error(`proxy ${ep} -> HTTP ${res.status}`)
    return res.json()
  }

  const status = () => proxyGet("/status", cfg.statusTimeoutMs)
  const rotateCircuit = () => proxyGet("/rotate", cfg.fetchTimeoutMs)

  function rotateOnce() {
    if (inflight) return inflight
    const run = (async () => {
      try {
        const t = now()
        stamps = stamps.filter((s) => t - s < cfg.windowMs)
        if (stamps.length >= cfg.maxRotations) {
          // Garde-fou : UNE seule ligne par fenêtre, avec l'heure de libération,
          // et le compteur de rate limits reste figé (pas de dérive incontrôlée).
          const freesAt = stamps[0] + cfg.windowMs
          if (t >= guardFreeAt) {
            guardFreeAt = freesAt
            log(
              `garde-fou: ${cfg.maxRotations} rotations en ${Math.round(cfg.windowMs / 60000)} min, ` +
                `on laisse OpenCode gérer (libère à ${new Date(freesAt).toTimeString().slice(0, 8)})`,
            )
          }
          streak = Math.min(streak, cfg.after)
          return "limit"
        }
        stamps.push(t)
        const info = await rotateCircuit()
        lastDone = now()
        rotations++
        const exit = info?.exit_ip ?? null
        log(
          `rotation #${rotations} OK (epoch ${info?.epoch}, ${info?.closed} tunnel(s) fermé(s), ` +
            `newnym ${info?.newnym}) — exit ${lastExit ?? "?"} -> ${exit ?? "?"}`,
        )
        if (exit) lastExit = exit
        return "rotated"
      } catch (e) {
        log(`rotation échouée: ${e?.message ?? e}`)
        return "error"
      }
    })()
    // On vide `inflight` APRÈS l'affectation : le corps ci-dessus peut se
    // terminer de façon synchrone (garde-fou atteint) et un `finally` placé
    // dedans écraserait cette affectation par `null`... en laissant à la place
    // une promesse déjà résolue qui bloquerait définitivement les rotations
    // suivantes. Le test d'identité évite qu'une rotation déjà finie efface
    // celle qui l'a remplacée entre-temps.
    inflight = run
    const clear = () => {
      if (inflight === run) inflight = null
    }
    run.then(clear, clear)
    return run
  }

  // Contrôle du proxy au chargement : une ligne, jamais d'exception.
  async function checkProxy() {
    try {
      const info = await status()
      lastExit = info?.exit_ip ?? null
      log(`proxy OK (${cfg.proxyUrl}, epoch ${info?.epoch}, ${info?.tunnels} tunnel(s), exit ${lastExit ?? "?"})`)
    } catch (e) {
      log(
        `AVERTISSEMENT: proxy local injoignable (${cfg.proxyUrl}/status: ${e?.message ?? e}). ` +
          `Les rotations échoueront tant qu'il n'est pas lancé : \`opencode-tor start\`.`,
      )
    }
  }

  async function onRetry(event) {
    const raw = asText(event.error)
    if (!isRateLimit(event.error, cfg.providerRegex)) return // décision par défaut d'OpenCode
    const pid = event.model?.providerID
    lastProvider = typeof pid === "string" ? pid : "?"
    if (typeof pid === "string" && !cfg.providerRegex.test(pid)) return // autre fournisseur

    // Une rotation est en cours (autre session/sous-agent) : on l'attend puis on retente.
    if (inflight) {
      if ((await inflight) === "rotated") event.decision = { retry: true, delay: cfg.settleMs }
      return
    }
    // Rotation toute récente : cette erreur vient d'une requête partie avant. Pas comptée.
    const t = now()
    if (lastDone && t - lastDone < cfg.cooldownMs) {
      event.decision = { retry: true, delay: cfg.cooldownMs }
      return
    }

    // Compteur de rate limits d'affilée, borné par `after` (pas de dérive).
    if (lastErr && t - lastErr > cfg.resetMs) streak = 0
    lastErr = t
    const before = streak
    streak = Math.min(streak + 1, cfg.after)
    if (streak < cfg.after) {
      log(
        `erreur rate limit ${streak}/${cfg.after} (provider ${lastProvider}, session ${event.sessionID}, ` +
          `status ${event.error?.status}): ${raw.slice(0, 120)}`,
      )
    } else if (before < cfg.after) {
      log(`seuil atteint: ${cfg.after} rate limits d'affilée, rotation demandée`)
    }
    if (streak < cfg.after) return // rate limit isolé -> décision par défaut d'OpenCode

    const r = await rotateOnce()
    if (r === "rotated") {
      streak = 0
      event.decision = { retry: true, delay: cfg.settleMs }
    }
    // "limit" / "error" : on ne touche pas à la décision d'OpenCode
  }

  // Une requête opencode.ai réussie => ce n'était qu'un rate limit passager : compteur à zéro.
  function onResponse(event) {
    const st = event.response?.status
    if (!(st >= 200 && st < 300) || !streak) return
    const url = event.response?.url
    if (url && !cfg.providerRegex.test(url)) return // succès d'un autre fournisseur
    log(`requête ${lastProvider} réussie, compteur remis à zéro (était ${streak})`)
    streak = 0
  }

  return {
    onRetry,
    onResponse,
    checkProxy,
    rotateOnce,
    info: () => ({ streak, rotations, lastExit, guardFreeAt, inWindow: stamps.length }),
  }
}

export default {
  id: "tor-rotate",
  async setup(ctx) {
    const cfg = resolveConfig(ctx?.options ?? {})
    const log = createLogger(cfg.logFile, { maxBytes: cfg.logMaxBytes, backups: cfg.logBackups })
    const rot = createRotator({ cfg, log })

    await ctx.session.hook("retry", (event) => rot.onRetry(event))

    // Une version plus ancienne d'OpenCode peut ignorer ce hook : pas fatal, le
    // compteur se remettra alors à zéro par le seul délai (resetMs).
    try {
      await ctx.session.hook("http.response", (event) => rot.onResponse(event))
    } catch (e) {
      log(`hook http.response indisponible (${e?.message ?? e}) : reset du compteur par délai uniquement`)
    }

    await rot.checkProxy()
    log(
      `plugin chargé (proxy ${cfg.proxyUrl}, rotation après ${cfg.after} erreurs d'affilée, ` +
        `max ${cfg.maxRotations}/${Math.round(cfg.windowMs / 60000)} min, log ${cfg.logFile})`,
    )
  },
}
