// Tests du modèle d'affichage du widget (logique pure) et de l'aiguillage serveur/TUI.
import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"

import plugin, { isTuiContext } from "../plugin/index.js"
import { ago, defaultStateFile, pidAlive, readState, toastFor, viewModel } from "../plugin/tui-model.js"

const NOW = 1_000_000
const st = (over = {}) => ({
  v: 1, pid: 123, state: "ready", message: "proxy Tor joignable", stateAt: NOW,
  after: 1, streak: 0, rotations: 0, inWindow: 0, maxRotations: 5, windowMs: 600_000,
  guardFreeAt: 0, lastExit: null, proxyOk: true, okCount: 3, ...over,
})
const vm = (over, extra = {}) => viewModel({ st: st(over), now: NOW + 1000, ...extra })

test("aucun état => plugin non chargé (tone bad)", () => {
  const v = viewModel({ st: null, now: NOW })
  assert.equal(v.key, "absent")
  assert.equal(v.tone, "bad")
  assert.match(v.short, /plugin non chargé/)
})

test("processus mort => plugin arrêté", () => {
  const v = viewModel({ st: st(), alive: false, now: NOW })
  assert.equal(v.key, "stopped")
  assert.match(v.short, /plugin arrêté/)
})

test("prêt : IP et nombre de rotations", () => {
  assert.equal(vm({ lastExit: "1.2.3.4" }).short, "● Tor 1.2.3.4")
  assert.equal(vm({ lastExit: "1.2.3.4", rotations: 2 }).short, "● Tor 1.2.3.4 ↻2")
  assert.equal(vm({}).short, "● Tor prêt")
})

test("l'IP du proxy en direct prime sur celle de l'état", () => {
  const v = vm({ lastExit: "1.1.1.1" }, { live: { ok: true, exit_ip: "9.9.9.9" } })
  assert.match(v.short, /9\.9\.9\.9/)
})

test("quota épuisé et rotation en cours (warn, spinner animé)", () => {
  assert.equal(vm({ state: "ratelimited" }).tone, "warn")
  assert.match(vm({ state: "ratelimited" }).short, /^● quota épuisé · reset \d\d:\d\d$/)
  const a = vm({ state: "rotating" }, { frame: 0 })
  const b = vm({ state: "rotating" }, { frame: 1 })
  assert.equal(a.tone, "warn")
  assert.notEqual(a.short, b.short, "le spinner change à chaque image")
})

test("nouvelle IP mise en avant 10 s puis retour à prêt", () => {
  const fresh = viewModel({ st: st({ state: "rotated", lastExit: "5.5.5.5", rotations: 1 }), now: NOW + 3000 })
  assert.equal(fresh.key, "rotated")
  assert.match(fresh.short, /nouvelle IP 5\.5\.5\.5/)
  const old = viewModel({ st: st({ state: "rotated", lastExit: "5.5.5.5", rotations: 1 }), now: NOW + 60_000 })
  assert.equal(old.key, "ready")
  assert.match(old.short, /Tor 5\.5\.5\.5/)
})

test("garde-fou, proxy hors ligne et erreur sont en rouge", () => {
  assert.deepEqual([vm({ state: "guard", inWindow: 5 }).tone, vm({ state: "guard", inWindow: 5 }).short], ["bad", "● garde-fou 5/5"])
  assert.equal(vm({ state: "proxy_down" }).tone, "bad")
  assert.equal(vm({ state: "error" }).tone, "bad")
  // proxy mort détecté EN DIRECT alors que le plugin se croit prêt
  const live = vm({ state: "ready" }, { live: { ok: false } })
  assert.equal(live.key, "proxy_down")
  assert.equal(live.tone, "bad")
})

test("proxy mort en direct n'écrase pas une rotation en cours", () => {
  assert.equal(vm({ state: "rotating" }, { live: { ok: false } }).key, "rotating")
})

test("lignes de la barre latérale : détail complet", () => {
  const v = vm({ state: "guard", inWindow: 5, rotations: 5, okCount: 42, guardFreeAt: NOW + 60_000, lastExit: "8.8.8.8" }, { live: { ok: true, tunnels: 3 } })
  const text = v.lines.join("\n")
  assert.match(text, /IP de sortie : 8\.8\.8\.8/)
  assert.match(text, /Rotations : 5 \(5\/5 sur 10 min\)/)
  assert.match(text, /Requêtes OK : 42/)
  assert.match(text, /Garde-fou libre à \d\d:\d\d:\d\d/)
  assert.match(text, /Tunnels Tor ouverts : 3/)
})

test("toasts : seulement sur changement d'état utile", () => {
  assert.equal(toastFor("ready", vm({}), st()), null, "pas de toast si rien ne change")
  assert.equal(toastFor(undefined, vm({}), st()).variant, "success", "premier état valide")
  assert.equal(toastFor("proxy_down", vm({}), st()).variant, "success", "retour à la normale")
  assert.equal(toastFor("ready", vm({ state: "ratelimited" }), st()).variant, "warning")
  assert.equal(toastFor("ratelimited", vm({ state: "rotated", lastExit: "5.5.5.5" }), st({ message: "rotation #1 : a -> b" })).title, "Nouvelle IP Tor")
  assert.equal(toastFor("ready", vm({ state: "guard" }), st()).variant, "error")
  assert.equal(toastFor("ready", vm({ state: "error" }), st()).variant, "error")
})

test("readState : JSON valide uniquement, au bon format", () => {
  const fsOk = { readFileSync: () => JSON.stringify({ v: 1, state: "ready" }) }
  assert.equal(readState("x", fsOk).state, "ready")
  assert.equal(readState("x", { readFileSync: () => "pas du json" }), null)
  assert.equal(readState("x", { readFileSync: () => JSON.stringify({ v: 2, state: "ready" }) }), null)
  assert.equal(readState("x", { readFileSync: () => { throw new Error("ENOENT") } }), null)
})

test("pidAlive : existe / n'existe pas / interdit", () => {
  assert.equal(pidAlive(1, () => {}), true)
  assert.equal(pidAlive(1, () => { throw Object.assign(new Error(), { code: "ESRCH" }) }), false)
  assert.equal(pidAlive(1, () => { throw Object.assign(new Error(), { code: "EPERM" }) }), true)
  assert.equal(pidAlive(0), false)
  assert.equal(pidAlive("abc"), false)
})

test("ago et chemin d'état par défaut", () => {
  assert.equal(ago(12_000), "12s")
  assert.equal(ago(180_000), "3min")
  // path.join : séparateurs de l'OS (\\ sous Windows), le test ne doit pas coder "/" en dur
  assert.equal(
    defaultStateFile({}, path.join("home", "u")),
    path.join("home", "u", ".local", "state", "opencode-tor-rotate", "plugin.state.json"),
  )
  assert.equal(defaultStateFile({ TOR_ROTATE_STATE_FILE: "/x/s.json" }, "/home/u"), "/x/s.json")
})

test("aiguillage : contexte TUI reconnu, contexte serveur non", () => {
  assert.equal(isTuiContext({ ui: { slot() {} }, data: { on() {} } }), true)
  assert.equal(isTuiContext({ session: { hook() {} } }), false)
  assert.equal(isTuiContext(undefined), false)
})

test("contexte TUI sans moteur de rendu : ne lève jamais d'exception", async () => {
  const toasts = []
  const ctx = { ui: { slot() { return () => {} }, toast: { show: (t) => toasts.push(t) } }, data: { on() {} } }
  await assert.doesNotReject(async () => {
    await plugin.setup(ctx)
  })
})
