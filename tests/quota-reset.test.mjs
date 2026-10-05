// Heure de remise à zéro du quota gratuit (00:00 UTC) : calcul, fuseaux, changement d'heure, affichage.
// Le fuseau est TOUJOURS passé explicitement : aucun test ne dépend de la machine.
import assert from "node:assert/strict"
import test from "node:test"

import { DAY_MS, fmtCountdown, quotaReset, toastFor, viewModel } from "../plugin/tui-model.js"

const at = (iso, timeZone) => quotaReset({ now: Date.parse(iso), timeZone })
const H = 3_600_000

test("Paris, heure d'été : minuit UTC = 02:00 (UTC+2)", () => {
  const r = at("2026-10-04T14:00:00Z", "Europe/Paris")
  assert.equal(r.localTime, "02:00")
  assert.equal(r.utcOffset, "UTC+2")
  assert.equal(r.timeZone, "Europe/Paris")
  assert.equal(r.resetAtMs, Date.UTC(2026, 9, 5))
  assert.equal(r.inMs, 10 * H)
})

test("Paris, passage à l'heure d'hiver (25/10/2026, 01:00 UTC)", () => {
  // la remise à zéro du 25 tombe AVANT le changement : encore l'heure d'été
  assert.deepEqual([at("2026-10-24T12:00:00Z", "Europe/Paris").localTime, at("2026-10-24T12:00:00Z", "Europe/Paris").utcOffset], ["02:00", "UTC+2"])
  // celle du 26 tombe APRÈS : heure d'hiver
  for (const now of ["2026-10-25T12:00:00Z", "2026-10-26T12:00:00Z"]) {
    const r = at(now, "Europe/Paris")
    assert.deepEqual([r.localTime, r.utcOffset], ["01:00", "UTC+1"], now)
  }
})

test("Paris, passage à l'heure d'été (29/03/2026, 01:00 UTC)", () => {
  assert.deepEqual([at("2026-03-28T12:00:00Z", "Europe/Paris").localTime, at("2026-03-28T12:00:00Z", "Europe/Paris").utcOffset], ["01:00", "UTC+1"])
  assert.deepEqual([at("2026-03-29T12:00:00Z", "Europe/Paris").localTime, at("2026-03-29T12:00:00Z", "Europe/Paris").utcOffset], ["02:00", "UTC+2"])
})

test("autres fuseaux : négatif, demi-heure, quart d'heure, UTC", () => {
  const cases = [
    ["America/New_York", "20:00", "UTC-4"],
    ["Asia/Tokyo", "09:00", "UTC+9"],
    ["Asia/Kolkata", "05:30", "UTC+5:30"],
    ["America/St_Johns", "21:30", "UTC-2:30"],
    ["Asia/Kathmandu", "05:45", "UTC+5:45"],
    ["UTC", "00:00", "UTC"],
  ]
  for (const [tz, time, off] of cases) {
    const r = at("2026-10-04T14:00:00Z", tz)
    assert.deepEqual([r.localTime, r.utcOffset], [time, off], tz)
  }
})

test("à minuit pile : une journée complète ; une ms avant : 1 ms (comme le serveur)", () => {
  assert.equal(quotaReset({ now: Date.UTC(2026, 9, 5), timeZone: "UTC" }).inMs, DAY_MS)
  assert.equal(quotaReset({ now: Date.UTC(2026, 9, 5) - 1, timeZone: "UTC" }).inMs, 1)
  assert.equal(quotaReset({ now: Date.UTC(2026, 9, 5) + 1, timeZone: "UTC" }).inMs, DAY_MS - 1)
})

test("fuseau invalide ou absent : repli sur le système, jamais d'exception", () => {
  for (const timeZone of ["Mars/Olympus", "", undefined, null]) {
    const r = quotaReset({ now: Date.parse("2026-10-04T14:00:00Z"), timeZone })
    assert.match(r.localTime, /^\d\d:\d\d$/)
    assert.match(r.utcOffset, /^UTC([+-]\d+(:\d\d)?)?$/)
  }
})

test("fmtCountdown", () => {
  assert.equal(fmtCountdown(10 * H), "10 h")
  assert.equal(fmtCountdown(5 * H + 12 * 60_000), "5 h 12 min")
  assert.equal(fmtCountdown(61 * 60_000), "1 h 1 min")
  assert.equal(fmtCountdown(42 * 60_000), "42 min")
  assert.equal(fmtCountdown(59 * 60_000 + 59_000), "59 min")
  assert.equal(fmtCountdown(30_000), "moins d'une minute")
  assert.equal(fmtCountdown(0), "moins d'une minute")
  assert.equal(fmtCountdown(-5), "moins d'une minute")
})

// --- affichage -------------------------------------------------------------------
const NOW = Date.parse("2026-10-04T14:00:00Z")
const st = (over = {}) => ({
  v: 1, pid: 1, state: "ready", message: "ok", stateAt: NOW, after: 2, streak: 0, rotations: 0,
  inWindow: 0, maxRotations: 1, windowMs: 15_000, guardFreeAt: 0, lastExit: "9.9.9.9", proxyOk: true, okCount: 3, ...over,
})
const view = (over, extra = {}) => viewModel({ st: st(over), now: NOW + 1000, tz: "Europe/Paris", ...extra })

test("panneau : ligne de remise à zéro dans le fuseau demandé", () => {
  const v = view({})
  assert.ok(v.lines.includes("Reset du quota : 02:00 UTC+2 (dans 9 h 59 min)"), v.lines.join(" | "))
  assert.equal(v.reset.localTime, "02:00")
  const ny = viewModel({ st: st(), now: NOW + 1000, tz: "America/New_York" })
  assert.ok(ny.lines.some((l) => l.startsWith("Reset du quota : 20:00 UTC-4")))
})

test("2e erreur d'affilée : 'quota épuisé · reset HH:MM' dans le pied de page", () => {
  const v = view({ state: "ratelimited", streak: 2 })
  assert.equal(v.short, "● quota épuisé · reset 02:00")
  assert.equal(v.tone, "warn")
})

test("1re erreur seulement : 'limite de débit 1/2', pas d'heure de reset", () => {
  const v = view({ state: "ratelimited", streak: 1 })
  assert.equal(v.short, "● limite de débit 1/2")
  assert.doesNotMatch(v.short, /reset/)
})

test("toasts : limite de débit (retente) vs quota épuisé (heure de reset)", () => {
  const first = toastFor("ready", view({ state: "ratelimited", streak: 1 }), st({ state: "ratelimited", streak: 1 }))
  assert.equal(first.title, "Limite de débit (1/2)")
  assert.match(first.message, /avant de changer d'IP/)
  const second = toastFor("ready", view({ state: "ratelimited", streak: 2 }), st({ state: "ratelimited", streak: 2 }))
  assert.equal(second.title, "Quota épuisé")
  assert.match(second.message, /reset à 02:00, ou nouvelle IP tout de suite/)
})

test("les états sans panneau détaillé (absent, arrêté) ne plantent pas", () => {
  assert.equal(viewModel({ st: null, tz: "Europe/Paris" }).key, "absent")
  assert.equal(viewModel({ st: st(), alive: false, tz: "Europe/Paris" }).key, "stopped")
})
