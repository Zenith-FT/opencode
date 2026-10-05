// Test de RENDU du widget TUI avec le vrai moteur OpenTUI (testRender), hors ligne.
// Lancer :  bun test tests/tui.render.test.ts      (nécessite `npm i` + `npm run build:tui`)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

let server: http.Server
let proxyPort = 0
let dir = ""
let stateFile = ""
let liveExit = "9.9.9.9"

const baseState = (over: Record<string, unknown> = {}) => ({
  v: 1, pid: process.pid, loadedAt: Date.now(), updatedAt: Date.now(),
  state: "ready", message: "proxy Tor joignable", stateAt: Date.now(),
  after: 1, streak: 0, rotations: 0, inWindow: 0, maxRotations: 5, windowMs: 600000,
  guardFreeAt: 0, lastExit: null, proxyUrl: "x", proxyOk: true, okCount: 7, lastOkAt: Date.now(),
  ...over,
})
const writeState = (o: Record<string, unknown> = {}) => fs.writeFileSync(stateFile, JSON.stringify(baseState(o)))

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "otr-render-"))
  stateFile = path.join(dir, "plugin.state.json")
  // Un seul faux serveur : le proxy (/status) ET un faux Onionoo (/summary, /details).
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json")
    const u = new URL(req.url ?? "/", "http://x")
    if (u.pathname === "/summary") return void res.end(JSON.stringify({ relays: [], relays_truncated: 2143 }))
    if (u.pathname === "/details") {
      const ip = u.searchParams.get("search")
      const relays = ip === "9.9.9.9"
        ? [{ nickname: "TestExit", flags: ["Exit", "Fast"], or_addresses: ["9.9.9.9:9001"] }]
        : []
      return void res.end(JSON.stringify({ relays }))
    }
    res.end(JSON.stringify({ epoch: 1, tunnels: 2, exit_ip: liveExit }))
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  proxyPort = (server.address() as any).port
})
afterAll(() => server.close())

async function harness() {
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  ensureSolidTransformPlugin()
  const { RGBA } = await import("@opentui/core")
  const { testRender } = await import("@opentui/solid")
  const mod: any = await import("../plugin/tui.mjs")
  const c = RGBA.fromInts(255, 255, 255, 255)
  const theme = { text: { default: c, subdued: c, feedback: { error: { default: c }, warning: { default: c }, success: { default: c }, info: { default: c } } } }
  const claims: any[] = []
  const toasts: any[] = []
  const ctx = {
    options: { stateFile, proxyUrl: `http://127.0.0.1:${proxyPort}`, onionooUrl: `http://127.0.0.1:${proxyPort}`, timeZone: "Europe/Paris", pollMs: 50 },
    theme,
    data: { on: () => () => {} },
    ui: { slot: (cl: any) => (claims.push(cl), () => {}), toast: { show: (t: any) => toasts.push(t) } },
  }
  const cleanup = mod.default.setup(ctx)
  const find = (where: string) => claims.find((cl) => cl.after === where || cl.append === where)
  const frame = async (cl: any, w = 70, h = 10) => {
    const s = await testRender(() => cl.render({}), { width: w, height: h })
    await s.flush()
    return s.captureCharFrame()
  }
  const mount = async (cl: any, w = 70, h = 6) => {
    const s = await testRender(() => cl.render({}), { width: w, height: h })
    await s.flush()
    return s
  }
  return { claims, toasts, cleanup, find, frame, mount }
}

describe("widget TUI opencode-tor-rotate", () => {
  it("revendique les 3 emplacements", async () => {
    writeState()
    const h = await harness()
    expect(h.find("prompt.footer.status")).toBeTruthy()
    expect(h.find("home.footer")).toBeTruthy()
    expect(h.find("sidebar.content")).toBeTruthy()
    h.cleanup()
  })

  it("affiche l'état prêt avec l'IP du proxy (live)", async () => {
    writeState()
    const h = await harness()
    await delay(400)
    const f = await h.frame(h.find("prompt.footer.status"))
    expect(f).toContain("● Tor 9.9.9.9")
    h.cleanup()
  })

  it("affiche 'plugin non chargé' si aucun état n'existe", async () => {
    fs.rmSync(stateFile, { force: true })
    const h = await harness()
    await delay(200)
    const f = await h.frame(h.find("home.footer"))
    expect(f).toContain("plugin non chargé")
    h.cleanup()
  })

  it("un widget DÉJÀ affiché se met à jour tout seul quand l'état change (+ toast)", async () => {
    writeState()
    const h = await harness()
    await delay(300)
    const mounted = await h.mount(h.find("prompt.footer.status"))
    expect(mounted.captureCharFrame()).toContain("● Tor 9.9.9.9")
    // l'état change APRÈS l'affichage : aucun nouveau rendu manuel
    writeState({ state: "rotated", rotations: 1, lastExit: "5.5.5.5", message: "rotation #1 : 9.9.9.9 -> 5.5.5.5", stateAt: Date.now() })
    await delay(400)
    await mounted.flush()
    expect(mounted.captureCharFrame()).toContain("nouvelle IP")
    expect(h.toasts.some((t) => t.title === "Nouvelle IP Tor")).toBe(true)
    h.cleanup()
  })

  it("affiche le garde-fou en rouge-état et le détail dans la barre latérale", async () => {
    writeState({ state: "guard", inWindow: 5, rotations: 5, message: "garde-fou: 5 rotations / 10 min", guardFreeAt: Date.now() + 60000 })
    const h = await harness()
    await delay(300)
    expect(await h.frame(h.find("prompt.footer.status"))).toContain("garde-fou 5/5")
    const side = await h.frame(h.find("sidebar.content"), 70, 18)
    expect(side).toContain("Rotations : 5 (5/5 sur 10 min)")
    expect(side).toContain("Garde-fou libre à")
    h.cleanup()
  })

  it("signale un processus plugin disparu", async () => {
    writeState({ pid: 2 ** 22 - 1 }) // pid presque sûrement inexistant
    const h = await harness()
    await delay(300)
    expect(await h.frame(h.find("prompt.footer.status"))).toContain("plugin arrêté")
    h.cleanup()
  })

  it("affiche le nombre d'exits Tor et confirme que l'IP est un noeud Tor (Onionoo)", async () => {
    liveExit = "9.9.9.9"
    writeState()
    const h = await harness()
    await delay(700)
    const side = await h.frame(h.find("sidebar.content"), 70, 18)
    expect(side).toContain("Exits Tor disponibles : 2 143")
    expect(side).toContain("Noeud Tor : oui, exit (TestExit)")
    // heure de remise à zéro du quota : minuit UTC dans le fuseau demandé (Paris)
    expect(side).toMatch(/Reset du quota : 0[12]:00 UTC\+[12] \(dans /)
    h.cleanup()
  })

  it("alerte quand l'IP de sortie n'est PAS un noeud Tor connu", async () => {
    liveExit = "5.5.5.5"
    writeState()
    const h = await harness()
    await delay(700)
    expect(await h.frame(h.find("prompt.footer.status"))).toContain("hors Tor")
    expect(h.toasts.some((t) => t.title === "IP hors Tor ?")).toBe(true)
    h.cleanup()
    liveExit = "9.9.9.9"
  })
})
