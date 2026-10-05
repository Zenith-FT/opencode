// Tests hors ligne : contrôles Onionoo (compte d'exits, IP = noeud Tor ?) et leur affichage.
import assert from "node:assert/strict"
import test from "node:test"

import { createNetChecker, isIpLike, parseExitCount, parseIpCheck, stripPort } from "../plugin/tor-net.js"
import { fmtInt, fmtWindow, toastFor, viewModel } from "../plugin/tui-model.js"

// --- analyse des documents ---------------------------------------------------
test("parseExitCount : liste + relays_truncated, ou format inattendu", () => {
  assert.equal(parseExitCount({ relays: [{}, {}, {}] }), 3)
  assert.equal(parseExitCount({ relays: [], relays_truncated: 2143 }), 2143, "limit=0 : tout est dans relays_truncated")
  assert.equal(parseExitCount({ relays: [{}], relays_truncated: 10 }), 11)
  assert.equal(parseExitCount({}), null)
  assert.equal(parseExitCount(null), null)
})

test("stripPort / isIpLike", () => {
  assert.equal(stripPort("1.2.3.4:9001"), "1.2.3.4")
  assert.equal(stripPort("[2001:DB8::1]:9001"), "2001:db8::1")
  assert.equal(stripPort("5.6.7.8"), "5.6.7.8")
  assert.equal(isIpLike("9.9.9.9"), true)
  assert.equal(isIpLike("2001:db8::1"), true)
  for (const bad of ["", "abc", "9.9.9.9/../x", "9.9.9.9?x=1", null, 42]) assert.equal(isIpLike(bad), false, String(bad))
})

const relay = (over = {}) => ({ nickname: "TestExit", flags: ["Exit", "Fast", "Running"], or_addresses: ["9.9.9.9:9001"], ...over })

test("parseIpCheck : exit / relais / aucun", () => {
  assert.deepEqual(parseIpCheck({ relays: [relay()] }, "9.9.9.9"), { kind: "exit", nick: "TestExit" })
  assert.deepEqual(parseIpCheck({ relays: [relay({ flags: ["Fast"] })] }, "9.9.9.9"), { kind: "relay", nick: "TestExit" })
  assert.deepEqual(parseIpCheck({ relays: [] }, "9.9.9.9"), { kind: "none", nick: null })
  assert.equal(parseIpCheck({}, "9.9.9.9"), null)
})

test("parseIpCheck : correspondance EXACTE (une adresse voisine ne compte pas)", () => {
  const near = relay({ or_addresses: ["9.9.9.90:9001"] })
  assert.equal(parseIpCheck({ relays: [near] }, "9.9.9.9").kind, "none")
})

test("parseIpCheck : adresse de SORTIE différente de l'adresse de routage", () => {
  const r = relay({ or_addresses: ["1.1.1.1:9001"], exit_addresses: ["9.9.9.9"] })
  assert.equal(parseIpCheck({ relays: [r] }, "9.9.9.9").kind, "exit")
})

test("parseIpCheck : IPv6, BadExit, champs d'adresse absents", () => {
  assert.equal(parseIpCheck({ relays: [relay({ or_addresses: ["[2001:db8::1]:9001"] })] }, "2001:DB8::1").kind, "exit")
  assert.equal(parseIpCheck({ relays: [relay({ flags: ["Exit", "BadExit"] })] }, "9.9.9.9").kind, "relay", "BadExit n'est pas un exit utilisable")
  const noAddr = { nickname: "x", flags: ["Exit"] }
  assert.equal(parseIpCheck({ relays: [noAddr] }, "9.9.9.9").kind, "exit", "on ne peut pas contredire la recherche")
})

// --- vérificateur avec faux fetch --------------------------------------------
function fakeOnionoo({ count = 2143, ipRelays = [relay()], fail = false } = {}) {
  const urls = []
  const fetchImpl = async (url) => {
    urls.push(url)
    if (fail) throw new Error("réseau coupé")
    const u = new URL(url)
    const body = u.pathname === "/summary" ? { relays: [], relays_truncated: count } : { relays: ipRelays }
    return { ok: true, status: 200, json: async () => body }
  }
  fetchImpl.urls = urls
  return fetchImpl
}
const checker = (f, over = {}) => {
  let t = 1_000_000
  const c = createNetChecker({ fetchImpl: f, now: () => t, baseUrl: "https://onion.test/", ...over })
  return { c, advance: (ms) => (t += ms) }
}

test("requêtes envoyées : bonnes URL, compte et IP renseignés", async () => {
  const f = fakeOnionoo()
  const { c } = checker(f)
  await c.refresh("9.9.9.9")
  assert.equal(f.urls.length, 2)
  assert.ok(f.urls.some((u) => u === "https://onion.test/summary?flag=Exit&running=true&type=relay&limit=0"))
  const d = f.urls.find((u) => u.includes("/details"))
  assert.match(d, /search=9\.9\.9\.9&type=relay&running=true&fields=nickname,flags,or_addresses,exit_addresses$/)
  assert.deepEqual({ n: c.state().exitCount, k: c.state().ipKind, nick: c.state().ipNick }, { n: 2143, k: "exit", nick: "TestExit" })
})

test("cache : pas de nouvelle requête avant l'expiration, puis rafraîchissement", async () => {
  const f = fakeOnionoo()
  const { c, advance } = checker(f)
  await c.refresh("9.9.9.9")
  await c.refresh("9.9.9.9")
  assert.equal(f.urls.length, 2, "rien de plus pendant le TTL")
  advance(16 * 60_000)
  await c.refresh("9.9.9.9")
  assert.equal(f.urls.length, 3, "le compte (15 min) est relu, l'IP (30 min) non")
  advance(20 * 60_000)
  await c.refresh("9.9.9.9")
  assert.equal(f.urls.length, 5, "compte + IP relus après 30 min")
})

test("nouvelle IP : vérifiée tout de suite", async () => {
  const f = fakeOnionoo()
  const { c } = checker(f)
  await c.refresh("9.9.9.9")
  await c.refresh("8.8.8.8")
  assert.equal(f.urls.filter((u) => u.includes("/details")).length, 2)
})

test("IP invalide ou absente : seul le compte est demandé, jamais d'URL construite avec n'importe quoi", async () => {
  const f = fakeOnionoo()
  const { c } = checker(f)
  await c.refresh("9.9.9.9/../etc")
  await c.refresh(null)
  assert.equal(f.urls.filter((u) => u.includes("/details")).length, 0)
  assert.equal(c.state().exitCount, 2143)
})

test("échec réseau : valeur conservée, nouvel essai après 2 min (pas de rafale)", async () => {
  const ok = fakeOnionoo()
  let mode = ok
  const f = (u) => mode(u)
  const { c, advance } = checker(f)
  await c.refresh("9.9.9.9")
  advance(16 * 60_000)
  const bad = fakeOnionoo({ fail: true })
  mode = bad
  await c.refresh("9.9.9.9")
  assert.equal(c.state().exitCount, 2143, "dernière valeur connue conservée")
  const n = bad.urls.length
  await c.refresh("9.9.9.9")
  assert.equal(bad.urls.length, n, "pas de nouvel essai immédiat")
  advance(2 * 60_000 + 1)
  await c.refresh("9.9.9.9")
  assert.ok(bad.urls.length > n, "nouvel essai après le délai")
})

test("échec sur une NOUVELLE IP : statut inconnu (null), jamais 'none'", async () => {
  const { c } = checker(fakeOnionoo({ fail: true }))
  await c.refresh("9.9.9.9")
  assert.equal(c.state().ip, "9.9.9.9")
  assert.equal(c.state().ipKind, null)
})

test("appels simultanés dédupliqués", async () => {
  const f = fakeOnionoo()
  const { c } = checker(f)
  await Promise.all([c.refresh("9.9.9.9"), c.refresh("9.9.9.9"), c.refresh("9.9.9.9")])
  assert.equal(f.urls.length, 2)
})

test("document inattendu : traité comme un échec, pas comme 'none'", async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ pas: "un document onionoo" }) })
  const { c } = checker(f)
  await c.refresh("9.9.9.9")
  assert.equal(c.state().exitCount, null)
  assert.equal(c.state().ipKind, null)
})

// --- affichage -----------------------------------------------------------------
const st = (over = {}) => ({
  v: 1, pid: 1, state: "ready", message: "ok", stateAt: 1_000_000, after: 1, streak: 0, rotations: 0,
  inWindow: 0, maxRotations: 5, windowMs: 600_000, guardFreeAt: 0, lastExit: "9.9.9.9", proxyOk: true, okCount: 3, ...over,
})
const view = (net, over = {}) => viewModel({ st: st(over), now: 1_001_000, net })

test("fmtInt : espace comme séparateur de milliers", () => {
  assert.equal(fmtInt(2143), "2 143")
  assert.equal(fmtInt(12), "12")
  assert.equal(fmtInt(1234567), "1 234 567")
})

test("panneau : exits disponibles + IP = noeud Tor", () => {
  const v = view({ exitCount: 2143, ipKind: "exit", ipNick: "TestExit" })
  const text = v.lines.join("\n")
  assert.match(text, /Exits Tor disponibles : 2 143/)
  assert.match(text, /Noeud Tor : oui, exit \(TestExit\)/)
  assert.equal(v.tone, "ok")
})

test("IP absente de l'annuaire => alerte jaune 'hors Tor' (+ toast)", () => {
  const v = view({ exitCount: 2143, ipKind: "none" })
  assert.equal(v.key, "notor")
  assert.equal(v.tone, "warn")
  assert.match(v.short, /9\.9\.9\.9 ⚠ hors Tor/)
  assert.match(v.lines.join("\n"), /Noeud Tor : NON/)
  assert.equal(toastFor("ready", v, st()).variant, "warning")
  assert.equal(toastFor("notor", view({ exitCount: 1, ipKind: "exit" }), st()).variant, "success", "retour à la normale")
})

test("vérification impossible (null) : pas d'alerte, '?' et 'vérification…'", () => {
  const v = view({ exitCount: null, ipKind: null })
  assert.equal(v.key, "ready")
  assert.equal(v.tone, "ok")
  assert.match(v.lines.join("\n"), /Exits Tor disponibles : \?/)
  assert.match(v.lines.join("\n"), /vérification…/)
})

test("relais non-exit : information, pas d'alerte ; sans IP : en attente", () => {
  const r = view({ exitCount: 5, ipKind: "relay", ipNick: "R" })
  assert.equal(r.tone, "ok")
  assert.match(r.lines.join("\n"), /relais, exit non confirmé/)
  const none = viewModel({ st: st({ lastExit: null }), now: 1_001_000, net: { exitCount: 5, ipKind: null } })
  assert.match(none.lines.join("\n"), /en attente d'une IP/)
})

test("contrôles désactivés (net = null) : aucune des deux lignes", () => {
  const text = viewModel({ st: st(), now: 1_001_000, net: null }).lines.join("\n")
  assert.doesNotMatch(text, /Exits Tor|Noeud Tor/)
})

test("fenêtre du garde-fou affichée en secondes sous la minute (pas '0 min')", () => {
  assert.equal(fmtWindow(15_000), "15 s")
  assert.equal(fmtWindow(600_000), "10 min")
  const v = viewModel({ st: st({ rotations: 1, inWindow: 1, maxRotations: 1, windowMs: 15_000 }), now: 1_001_000, net: null })
  assert.match(v.lines.join("\n"), /Rotations : 1 \(1\/1 sur 15 s\)/)
})
