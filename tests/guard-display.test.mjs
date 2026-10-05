// Garde-fou : l'affichage ne doit pas rester figé sur "5/5" une fois la fenêtre écoulée.
import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import fs from "node:fs"
import os from "node:os"

import { createRotator, resolveConfig } from "../plugin/index.js"
import { toastFor, viewModel } from "../plugin/tui-model.js"

const T0 = 1_000_000_000_000
const st = (over = {}) => ({
  v: 1, pid: 1, state: "guard", message: "garde-fou: 1 rotation(s) / 15 s", stateAt: T0, after: 2, streak: 2,
  rotations: 10, inWindow: 1, maxRotations: 1, windowMs: 15_000, guardFreeAt: T0 + 10_000,
  lastExit: "9.9.9.9", proxyOk: true, okCount: 379, ...over,
})
const view = (now, over = {}) => viewModel({ st: st(over), now, tz: "UTC" })

test("avant l'heure de libération : garde-fou affiché", () => {
  const v = view(T0 + 5_000)
  assert.equal(v.key, "guard")
  assert.equal(v.tone, "bad")
  assert.equal(v.short, "● garde-fou 1/1")
  assert.match(v.lines.join("\n"), /Garde-fou libre à \d\d:\d\d:\d\d/)
})

test("APRÈS l'heure de libération : plus de garde-fou, retour à 'prêt' (le cas de la capture d'écran)", () => {
  const v = view(T0 + 11_000)
  assert.equal(v.key, "ready")
  assert.equal(v.tone, "ok")
  assert.match(v.short, /^● Tor 9\.9\.9\.9/)
  assert.doesNotMatch(v.lines.join("\n"), /Garde-fou libre/)
})

test("10 minutes plus tard (ancien garde-fou 5 / 10 min figé sur 5/5) : de nouveau 'prêt'", () => {
  const old = st({ inWindow: 5, maxRotations: 5, windowMs: 600_000, guardFreeAt: T0 + 120_000 })
  const v = viewModel({ st: old, now: T0 + 15 * 60_000, tz: "UTC" })
  assert.equal(v.key, "ready")
  // un ancien fichier d'état n'a pas d'horodatages : le compte affiché reste celui de l'état, mais l'état redevient "prêt"
  assert.match(v.lines.join("\n"), /Rotations : 10 \(5\/5 sur 10 min\)/)
})

test("sans horodatage (ancien fichier d'état) : on garde inWindow tel quel", () => {
  assert.match(view(T0 + 1_000, { inWindow: 1 }).lines.join("\n"), /\(1\/1 sur 15 s\)/)
})

test("avec horodatages : le compte de la fenêtre est recalculé en direct", () => {
  const stamps = [T0 - 5_000]
  assert.match(view(T0 + 1_000, { stamps, inWindow: 1 }).lines.join("\n"), /\(1\/1 sur 15 s\)/, "encore dans la fenêtre")
  assert.match(view(T0 + 12_000, { stamps, inWindow: 1 }).lines.join("\n"), /\(0\/1 sur 15 s\)/, "sorti de la fenêtre")
})

test("guardFreeAt = 0 (jamais bloqué) ne déclenche pas le retour automatique", () => {
  assert.equal(view(T0 + 99_000, { guardFreeAt: 0 }).key, "guard")
})

test("toast de retour à la normale quand le garde-fou est levé", () => {
  const v = view(T0 + 11_000)
  assert.equal(toastFor("guard", v, st()).variant, "success")
})

test("le plugin publie les horodatages des rotations de la fenêtre courante", async () => {
  let t = T0
  const cfg = resolveConfig({ logFile: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "otr-g-")), "p.log"), cooldownMs: 0, after: 1 }, {})
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ epoch: 1, closed: 0, newnym: "ok" }), text: async () => "{}" })
  const rot = createRotator({ cfg, log: () => {}, fetchImpl, now: () => t })
  await rot.onRetry({ sessionID: "s", attempt: 1, error: { status: 429, message: "Rate limit exceeded" }, model: { providerID: "opencode" } })
  assert.deepEqual(rot.snapshot().stamps, [T0])
  t += 20_000
  assert.deepEqual(rot.snapshot().stamps, [], "hors fenêtre (15 s) : retiré")
})
