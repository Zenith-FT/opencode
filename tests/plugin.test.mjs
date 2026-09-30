// Tests du plugin opencode-tor-rotate — 100 % hors-ligne.
// Le "proxy" est soit un faux fetch, soit un vrai serveur HTTP local sans Tor.
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import plugin, {
  DEFAULTS,
  createLogger,
  createRotator,
  defaultLogFile,
  isRateLimit,
  resolveConfig,
} from "../plugin/index.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "otr-test-"))

function collector() {
  const lines = []
  const log = (m) => lines.push(m)
  log.text = () => lines.join("\n")
  return log
}

// --- faux proxy -------------------------------------------------------------

function fakeProxy(routes = {}) {
  const calls = []
  const gates = new Map()
  const fetchImpl = async (url, opts = {}) => {
    const ep = new URL(url).pathname
    calls.push({ ep, headers: opts.headers ?? {} })
    if (gates.has(ep)) await gates.get(ep).promise
    const r = routes[ep]
    if (r === undefined) return { ok: false, status: 404, json: async () => ({}) }
    if (r.throw) throw new Error(r.throw)
    return { ok: true, status: 200, json: async () => r }
  }
  fetchImpl.calls = calls
  fetchImpl.gate = (ep) => {
    let release
    const p = new Promise((r) => (release = r))
    gates.set(ep, { promise: p })
    return () => {
      gates.delete(ep)
      release()
    }
  }
  return fetchImpl
}

const rotate = (n = 1, extra = {}) => ({ epoch: n, closed: n, newnym: "ok", ...extra })
const opencodeRetry = (over = {}) => ({
  sessionID: "ses_test",
  attempt: 1,
  error: { status: 429, type: "provider.rate-limit", message: "Rate limit exceeded" },
  model: { providerID: "opencode", id: "big-pickle" },
  ...over,
})

function rotator(over = {}, routes = { "/rotate": rotate() }) {
  const env = { ...process.env }
  delete env.TOR_ROTATE_LOG
  const cfg = resolveConfig({ logFile: path.join(tmp(), "plugin.log"), ...over }, env)
  const log = collector()
  const fetchImpl = fakeProxy(routes)
  let t = 1_000_000
  const rot = createRotator({ cfg, log, fetchImpl, now: () => t })
  return { rot, log, cfg, fetchImpl, advance: (ms) => (t += ms), now: () => t }
}

const rotates = (h) => h.fetchImpl.calls.filter((c) => c.ep === "/rotate").length

// --- 1. N d'affilée ---------------------------------------------------------

test("rotation seulement après N rate limits consécutifs", async () => {
  const h = rotator({ after: 3, cooldownMs: 0 })
  for (const want of [1, 2]) {
    const ev = opencodeRetry()
    await h.rot.onRetry(ev)
    assert.equal(h.rot.info().streak, want, `streak doit être ${want}`)
    assert.equal(ev.decision, undefined, "aucune décision avant le seuil")
  }
  assert.equal(rotates(h), 0, "aucun appel /rotate avant le seuil")

  const ev = opencodeRetry()
  await h.rot.onRetry(ev)
  assert.equal(rotates(h), 1, "un appel /rotate au seuil")
  assert.deepEqual(ev.decision, { retry: true, delay: DEFAULTS.settleMs })
  assert.equal(h.rot.info().streak, 0, "compteur remis à zéro après rotation")
  assert.equal(h.rot.info().rotations, 1)
})

test("after: 1 => une seule erreur suffit", async () => {
  const h = rotator({ after: 1, cooldownMs: 0 })
  const ev = opencodeRetry()
  await h.rot.onRetry(ev)
  assert.equal(rotates(h), 1)
  assert.deepEqual(ev.decision, { retry: true, delay: DEFAULTS.settleMs })
})

// --- 2. reset sur 2xx -------------------------------------------------------

test("une réponse 2xx opencode.ai remet le compteur à zéro", async () => {
  const h = rotator({ after: 3, cooldownMs: 0 })
  await h.rot.onRetry(opencodeRetry())
  await h.rot.onRetry(opencodeRetry())
  assert.equal(h.rot.info().streak, 2)

  h.rot.onResponse({ response: { status: 200, url: "https://opencode.ai/zen/v1/chat" } })
  assert.equal(h.rot.info().streak, 0)

  // le compteur repart de zéro : 2 erreurs ne suffisent plus
  await h.rot.onRetry(opencodeRetry())
  const ev = opencodeRetry()
  await h.rot.onRetry(ev)
  assert.equal(rotates(h), 0, "pas de rotation après reset")
  assert.equal(ev.decision, undefined)
})

test("2xx d'un autre fournisseur ne remet PAS le compteur à zéro", async () => {
  const h = rotator({ after: 3, cooldownMs: 0 })
  await h.rot.onRetry(opencodeRetry())
  h.rot.onResponse({ response: { status: 200, url: "https://api.anthropic.com/v1/messages" } })
  assert.equal(h.rot.info().streak, 1)
})

test("le compteur retombe à zéro après resetMs sans nouvelle erreur", async () => {
  const h = rotator({ after: 3, cooldownMs: 0, resetMs: 1000 })
  await h.rot.onRetry(opencodeRetry())
  await h.rot.onRetry(opencodeRetry())
  h.advance(5000)
  await h.rot.onRetry(opencodeRetry())
  assert.equal(h.rot.info().streak, 1, "compteur remis à zéro par le délai seul")
})

// --- 3. cooldown ------------------------------------------------------------

test("cooldown : pas de 2e rotation, on impose notre délai", async () => {
  const h = rotator({ after: 3, cooldownMs: 4000, settleMs: 1500 })
  for (let i = 0; i < 3; i++) await h.rot.onRetry(opencodeRetry())
  assert.equal(rotates(h), 1)

  h.advance(1000) // < cooldown
  const ev = opencodeRetry()
  await h.rot.onRetry(ev)
  assert.equal(rotates(h), 1, "pas de 2e rotation pendant le cooldown")
  assert.deepEqual(ev.decision, { retry: true, delay: 4000 })

  h.advance(4000) // cooldown écoulé
  const ev2 = opencodeRetry()
  await h.rot.onRetry(ev2)
  assert.equal(h.rot.info().streak, 1, "compteur remis à zéro par la rotation")
  assert.equal(ev2.decision, undefined)
})

// --- 4. déduplication -------------------------------------------------------

test("rotations concurrentes dédupliquées (un seul /rotate)", async () => {
  const h = rotator({ after: 3, cooldownMs: 0 })
  for (let i = 0; i < 2; i++) await h.rot.onRetry(opencodeRetry())
  assert.equal(h.rot.info().streak, 2)

  const open = h.fetchImpl.gate("/rotate")
  const e1 = opencodeRetry({ sessionID: "ses_a" })
  const e2 = opencodeRetry({ sessionID: "ses_b" })
  const p1 = h.rot.onRetry(e1) // déclenche la rotation, bloquée sur le gate
  const p2 = h.rot.onRetry(e2) // doit rejoindre la rotation en cours
  await new Promise((r) => setTimeout(r, 20))
  open()
  await Promise.all([p1, p2])

  assert.equal(rotates(h), 1)
  assert.deepEqual(e1.decision, { retry: true, delay: DEFAULTS.settleMs })
  assert.deepEqual(e2.decision, { retry: true, delay: DEFAULTS.settleMs })
})

// --- 5. plafond de rotations ------------------------------------------------

test("plafond de rotations : blocage, un seul log par fenêtre avec l'heure de libération", async () => {
  const h = rotator({ after: 1, cooldownMs: 0, maxRotations: 2, windowMs: 600_000 })
  for (let i = 0; i < 2; i++) await h.rot.onRetry(opencodeRetry())
  assert.equal(h.rot.info().rotations, 2)

  for (let i = 0; i < 4; i++) {
    const ev = opencodeRetry()
    await h.rot.onRetry(ev)
    assert.equal(ev.decision, undefined, "décision d'OpenCode conservée quand bloqué")
  }
  assert.equal(rotates(h), 2, "aucun /rotate supplémentaire")
  assert.equal(h.rot.info().rotations, 2, "compteur monotone")

  const guards = h.log.text().split("\n").filter((l) => l.includes("garde-fou"))
  assert.equal(guards.length, 1, `un seul log de garde-fou, obtenu ${guards.length}`)
  assert.match(guards[0], /libère à \d{2}:\d{2}:\d{2}/)
  assert.equal(h.rot.info().streak, 1, "streak figé, pas de dérive")
})

test("après la fenêtre, une nouvelle rotation est possible et le compteur continue", async () => {
  const h = rotator({ after: 1, cooldownMs: 0, maxRotations: 1, windowMs: 1000 })
  await h.rot.onRetry(opencodeRetry())
  assert.equal(h.rot.info().rotations, 1)
  await h.rot.onRetry(opencodeRetry())
  assert.equal(h.rot.info().rotations, 1, "bloqué")
  h.advance(1500)
  await h.rot.onRetry(opencodeRetry())
  assert.equal(h.rot.info().rotations, 2, "nouvelle rotation permise après la fenêtre")
  assert.match(h.log.text(), /rotation #2 OK/, "compteur monotone, jamais remis à 1")
})

test("le compteur de streak ne dépasse jamais `after`", async () => {
  const h = rotator({ after: 2, cooldownMs: 0, maxRotations: 1, windowMs: 600_000 })
  for (let i = 0; i < 50; i++) await h.rot.onRetry(opencodeRetry())
  assert.ok(h.rot.info().streak <= 2, `streak borné (obtenu ${h.rot.info().streak})`)
  const throttled = h.log.text().split("\n").filter((l) => l.includes("erreur rate limit"))
  assert.ok(throttled.length <= 2, `pas de log en boucle (${throttled.length})`)
})

// --- 6/8. proxy injoignable + IP de sortie ----------------------------------

test("proxy injoignable : la rotation échoue sans toucher à la décision", async () => {
  const h = rotator({ after: 1, cooldownMs: 0 }, { "/rotate": { throw: "ConnectionRefused" } })
  const ev = opencodeRetry()
  await h.rot.onRetry(ev)
  assert.equal(ev.decision, undefined, "OpenCode garde sa décision")
  assert.match(h.log.text(), /rotation échouée: ConnectionRefused/)
})

test("HTTP != 200 sur /rotate est traité comme un échec", async () => {
  const h = rotator({ after: 1, cooldownMs: 0 }, {})
  const ev = opencodeRetry()
  await h.rot.onRetry(ev)
  assert.equal(ev.decision, undefined)
  assert.match(h.log.text(), /rotation échouée: proxy \/rotate -> HTTP 404/)
})

test("exit IP : A -> B journalisé, /status mémorise la dernière connue", async () => {
  const h = rotator({ after: 1, cooldownMs: 0 }, {
    "/status": { epoch: 7, tunnels: 1, exit_ip: "10.0.0.1" },
    "/rotate": rotate(8, { exit_ip: "10.0.0.2" }),
  })
  await h.rot.checkProxy()
  assert.equal(h.rot.info().lastExit, "10.0.0.1")
  assert.match(h.log.text(), /proxy OK .*exit 10\.0\.0\.1/)

  await h.rot.onRetry(opencodeRetry())
  assert.equal(h.rot.info().lastExit, "10.0.0.2")
  assert.match(h.log.text(), /exit 10\.0\.0\.1 -> 10\.0\.0\.2/)
})

test("exit IP inconnue => '?' toléré, la rotation reste successful", async () => {
  const h = rotator({ after: 1, cooldownMs: 0 }, { "/rotate": rotate(1) })
  const ev = opencodeRetry()
  await h.rot.onRetry(ev)
  assert.deepEqual(ev.decision, { retry: true, delay: DEFAULTS.settleMs })
  assert.match(h.log.text(), /exit \? -> \?/)
})

test("le secret de token est envoyé quand tokenFile est défini", async () => {
  const tokenFile = path.join(tmp(), "token")
  fs.writeFileSync(tokenFile, "s3cret\n")
  const h = rotator({ after: 1, cooldownMs: 0, tokenFile })
  await h.rot.onRetry(opencodeRetry())
  assert.equal(h.fetchImpl.calls[0].headers["X-Tor-Rotate-Token"], "s3cret")
})

// --- 7. autres fournisseurs / erreurs ---------------------------------------

test("un 429 d'un autre fournisseur est ignoré", async () => {
  const h = rotator({ after: 1, cooldownMs: 0 })
  for (const providerID of ["anthropic", "openai", "github-copilot"]) {
    const ev = opencodeRetry({ model: { providerID, id: "x" } })
    await h.rot.onRetry(ev)
    assert.equal(ev.decision, undefined, `${providerID} ignoré`)
  }
  assert.equal(h.rot.info().streak, 0, "rien n'est compté pour un autre fournisseur")
  assert.equal(h.fetchImpl.calls.length, 0)
})

test("une erreur non-rate-limit est ignorée (connexion refusée)", async () => {
  const h = rotator({ after: 1, cooldownMs: 0 })
  const ev = opencodeRetry({
    error: { type: "provider.transport", message: "ConnectionRefused: Unable to connect" },
  })
  await h.rot.onRetry(ev)
  assert.equal(ev.decision, undefined)
  assert.equal(h.rot.info().streak, 0)
  assert.equal(h.fetchImpl.calls.length, 0)
})

test("providerID absent => on ne rejette pas (compat)", async () => {
  const h = rotator({ after: 1, cooldownMs: 0 })
  await h.rot.onRetry(opencodeRetry({ model: undefined }))
  assert.equal(rotates(h), 1)
})

test("messages de quota connus détectés sans status 429", () => {
  const re = /rate.?limit|too many requests|FreeUsageLimitError|Free usage exceeded/i
  for (const message of [
    "FreeUsageLimitError: free usage exceeded",
    "Free usage exceeded for this model",
    "Error from provider: Rate limit exceeded",
    "429 Too Many Requests",
  ]) {
    assert.equal(isRateLimit({ message }, re), true, message)
  }
  assert.equal(isRateLimit({ message: "boom" }, re), false)
  assert.equal(isRateLimit({ message: "boom" }, null), false)
})

// --- configuration ----------------------------------------------------------

test("resolveConfig : options > env > défauts", () => {
  const c = resolveConfig({ after: 2, proxyUrl: "http://127.0.0.1:2222/" }, {
    TOR_ROTATE_AFTER: "7",
    TOR_PROXY_URL: "http://127.0.0.1:1111/",
    TOR_ROTATE_LOG: "/tmp/env.log",
  })
  assert.equal(c.after, 2, "option prioritaire")
  assert.equal(c.proxyUrl, "http://127.0.0.1:2222", "slash final retiré")
  assert.equal(c.logFile, "/tmp/env.log")
  assert.equal(c.cooldownMs, DEFAULTS.cooldownMs)
  assert.equal(c.settleMs, DEFAULTS.settleMs)
  assert.equal(c.maxRotations, DEFAULTS.maxRotations)
  assert.equal(c.windowMs, DEFAULTS.windowMs)
  assert.ok(c.providerRegex.test("opencode"))
})

test("resolveConfig : valeurs invalides ignorées, bornes respectées", () => {
  const c = resolveConfig({ after: -3, resetMs: "nope", maxRotations: 0 }, {
    TOR_ROTATE_AFTER: "abc",
    TOR_ROTATE_RESET_MS: "",
    TOR_ROTATE_COOLDOWN_MS: "250",
  })
  assert.equal(c.after, DEFAULTS.after, "after borné à >= 1")
  assert.equal(c.resetMs, DEFAULTS.resetMs, "chaîne vide => défaut")
  assert.equal(c.maxRotations, 1, "maxRotations: 0 => borne à 1")
  assert.equal(c.cooldownMs, 250, "env numérique valide conservé")
  assert.equal(c.providerRegex instanceof RegExp, true)
})

test("providerRegex personnalisable", () => {
  assert.ok(resolveConfig({ providerRegex: "^zen$" }, {}).providerRegex.test("zen"))
  assert.ok(!resolveConfig({ providerRegex: "^zen$" }, {}).providerRegex.test("opencode"))
  assert.equal(resolveConfig({ providerRegex: "[" }, {}).providerRegex.source, "opencode", "regex invalide => défaut")
})

test("defaultLogFile : ancien répertoire si le nouveau n'existe pas", () => {
  const home = tmp()
  const next = path.join(home, ".local", "state", "opencode-tor-rotate", "plugin.log")
  const old = path.join(home, ".opencode_check_tor", "plugin.log")
  assert.equal(defaultLogFile({}, home), next)
  fs.mkdirSync(path.join(home, ".opencode_check_tor"), { recursive: true })
  assert.equal(defaultLogFile({}, home), old)
  fs.mkdirSync(path.join(home, ".local", "state", "opencode-tor-rotate"), { recursive: true })
  assert.equal(defaultLogFile({}, home), next)
  assert.equal(defaultLogFile({ TOR_ROTATE_LOG: "/x/y.log" }, home), "/x/y.log")
})

// --- journal ----------------------------------------------------------------

test("le journal est plafonné avec 1 sauvegarde", () => {
  const file = path.join(tmp(), "plugin.log")
  const log = createLogger(file, { maxBytes: 512, backups: 1 })
  for (let i = 0; i < 200; i++) log(`ligne ${i} ` + "x".repeat(40))
  const size = fs.statSync(file).size
  assert.ok(size <= 512 + 200, `fichier plafonné (obtenu ${size})`)
  assert.ok(fs.existsSync(`${file}.1`), "sauvegarde .1 présente")
  assert.ok(fs.statSync(`${file}.1`).size > 0)
})

test("createLogger n'explose jamais (chemin non inscriptible)", () => {
  const dir = tmp()
  const blocker = path.join(dir, "blocker")
  fs.writeFileSync(blocker, "je suis un fichier, pas un dossier\n")
  const log = createLogger(path.join(blocker, "sub", "x.log"))
  assert.doesNotThrow(() => log("ignoré"))
  assert.doesNotThrow(() => log("encore"))
})

// --- setup() ----------------------------------------------------------------

function fakeCtx(options = {}, { httpResponse = true } = {}) {
  const hooks = {}
  return {
    options,
    hooks,
    session: {
      hook: async (name, fn) => {
        if (name === "http.response" && !httpResponse) throw new Error("hook inconnu")
        ;(hooks[name] ??= []).push(fn)
        return { dispose() {} }
      },
    },
  }
}

const readLog = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "")

async function fakeServer(handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    seen.push(req.url)
    handler(req, res)
  })
  await new Promise((r) => server.listen(0, "127.0.0.1", r))
  return { seen, port: server.address().port, close: () => new Promise((r) => server.close(r)) }
}

const json = (res, body) => {
  res.writeHead(200, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

test("setup : proxy joignable => journal 'plugin chargé' et /status appelé", async () => {
  const s = await fakeServer((_q, res) => json(res, { epoch: 3, tunnels: 2, exit_ip: "9.9.9.9" }))
  const logFile = path.join(tmp(), "plugin.log")
  const ctx = fakeCtx({ proxyUrl: `http://127.0.0.1:${s.port}`, logFile })
  try {
    await plugin.setup(ctx)
  } finally {
    await s.close()
  }
  assert.deepEqual(s.seen, ["/status"])
  assert.equal(ctx.hooks.retry.length, 1)
  assert.equal(ctx.hooks["http.response"].length, 1)
  const text = await readLog(logFile)
  assert.match(text, /plugin chargé/)
  assert.match(text, /proxy OK .*epoch 3, .*exit 9\.9\.9\.9/)
  assert.doesNotMatch(text, /AVERTISSEMENT/)
})

test("setup : proxy injoignable => UN avertissement clair, aucune exception", async () => {
  const logFile = path.join(tmp(), "plugin.log")
  const ctx = fakeCtx({ proxyUrl: "http://127.0.0.1:1", logFile })
  await plugin.setup(ctx) // ne doit pas jeter
  const text = await readLog(logFile)
  assert.equal(text.split("\n").filter((l) => l.includes("AVERTISSEMENT")).length, 1)
  assert.match(text, /opencode-tor start/)
  assert.match(text, /plugin chargé/)
})

test("setup : le hook http.response absent ne casse rien", async () => {
  const logFile = path.join(tmp(), "plugin.log")
  const ctx = fakeCtx({ proxyUrl: "http://127.0.0.1:1", logFile }, { httpResponse: false })
  await plugin.setup(ctx)
  assert.match(await readLog(logFile), /hook http\.response indisponible/)
})

test("setup + hooks branchés : 3 rate limits déclenchent vraiment une rotation", async () => {
  const s = await fakeServer((req, res) =>
    json(
      res,
      req.url === "/rotate" ? { epoch: 2, closed: 1, newnym: "ok", exit_ip: "5.5.5.5" } : { epoch: 1, tunnels: 0 },
    ),
  )
  const logFile = path.join(tmp(), "plugin.log")
  const ctx = fakeCtx({
    proxyUrl: `http://127.0.0.1:${s.port}`,
    logFile,
    after: 3,
    cooldownMs: 0,
    settleMs: 42,
  })
  await plugin.setup(ctx)
  const fire = async (ev) => {
    for (const fn of ctx.hooks.retry) await fn(ev)
    return ev
  }
  const a = await fire(opencodeRetry())
  const b = await fire(opencodeRetry())
  const c = await fire(opencodeRetry())
  await s.close()
  assert.equal(a.decision, undefined)
  assert.equal(b.decision, undefined)
  assert.deepEqual(c.decision, { retry: true, delay: 42 })
  assert.match(await readLog(logFile), /exit \? -> 5\.5\.5\.5/)
  assert.match(await readLog(logFile), /rotation #1 OK/)
})
