// Widget TUI opencode-tor-rotate (OpenCode 2.x) — SOURCE. Le fichier livré est plugin/tui.mjs,
// généré par `npm run build:tui` (bun + transformation Solid d'OpenTUI).
//
// Le TUI tourne dans un autre processus que le plugin de rotation : on lit donc
// `plugin.state.json` (écrit par le plugin) et, en direct, `GET <proxy>/status`.
import { createMemo, createSignal, For, Show } from "solid-js"
import fs from "node:fs"
import { defaultStateFile, pidAlive, readState, toastFor, viewModel } from "./tui-model.js"
import { createNetChecker } from "./tor-net.js"

type Tone = "ok" | "warn" | "bad" | "dim"

const toneColor = (theme: any, tone: Tone) => {
  switch (tone) {
    case "ok":
      return theme.text.feedback.success.default
    case "warn":
      return theme.text.feedback.warning.default
    case "bad":
      return theme.text.feedback.error.default
    default:
      return theme.text.subdued
  }
}

// Une ligne compacte : prompt (statut) et écran d'accueil.
function StatusLine(props: { theme: any; vm: () => any }) {
  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={toneColor(props.theme, props.vm().tone)}>{props.vm().short}</text>
    </box>
  )
}

// Panneau détaillé de la barre latérale.
function SidebarPanel(props: { theme: any; vm: () => any }) {
  const lines = createMemo<string[]>(() => props.vm().lines)
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={lines()}>
        {(line, i) => (
          <text fg={i() === 0 ? props.theme.text.subdued : i() === 1 ? toneColor(props.theme, props.vm().tone) : props.theme.text.default}>
            {line}
          </text>
        )}
      </For>
    </box>
  )
}

export function setupTui(ctx: any): (() => void) | void {
  const opts: Record<string, unknown> = ctx?.options ?? {}
  const stateFile = String(opts.stateFile ?? defaultStateFile())
  const proxyUrl = String(opts.proxyUrl ?? process.env.TOR_PROXY_URL ?? "http://127.0.0.1:9253").replace(/\/+$/, "")
  const pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : 500
  const toasts = opts.toasts !== false
  // Fuseau pour l'heure de remise à zéro du quota ("Europe/Paris") ; absent = fuseau du système.
  const tz = typeof opts.timeZone === "string" && opts.timeZone.trim() ? opts.timeZone.trim() : undefined
  // Contrôles Onionoo (API officielle du Tor Project) : `onionoo: false` les coupe.
  const net =
    opts.onionoo === false
      ? null
      : createNetChecker({ baseUrl: typeof opts.onionooUrl === "string" ? opts.onionooUrl : undefined })

  let frame = 0
  let live: { ok: boolean; exit_ip?: string; tunnels?: number } | null = null
  let prevKey: string | undefined
  let lastLive = 0
  let everSeen = false

  const compute = () => {
    const st = readState(stateFile, fs)
    const alive = st ? pidAlive(st.pid) : false
    return { st, vm: viewModel({ st, live, alive, now: Date.now(), frame, net: net ? net.state() : null, tz }) }
  }
  const [model, setModel] = createSignal(compute())
  const vm = () => model().vm

  const notify = (t: ReturnType<typeof toastFor>) => {
    if (!t || !toasts) return
    try {
      ctx.ui?.toast?.show({ ...t, duration: 4000 })
    } catch {}
  }

  const refresh = async () => {
    frame++
    // Proxy en direct (toutes les 5 s) : indique si Tor répond VRAIMENT, indépendamment du plugin.
    if (Date.now() - lastLive > 5000) {
      lastLive = Date.now()
      try {
        const res = await fetch(`${proxyUrl}/status`, { signal: AbortSignal.timeout(1500) })
        live = res.ok ? { ok: true, ...(await res.json()) } : { ok: false }
      } catch {
        live = { ok: false }
      }
    }
    const next = compute()
    setModel(() => next)
    // Seulement si le plugin est chargé ; les TTL internes évitent de répéter les requêtes.
    if (net && next.st) void net.refresh(live?.exit_ip || next.st.lastExit || null)
    if (next.st) everSeen = true
    // Pas de toast "absent" tant qu'on n'a pas laissé 5 s au plugin pour écrire son premier état.
    if (next.vm.key === "absent" && everSeen === false && Date.now() - startedAt < 5000) return
    if (next.vm.key !== prevKey) {
      notify(toastFor(prevKey, next.vm, next.st))
      prevKey = next.vm.key
    }
  }

  const startedAt = Date.now()
  const timer = setInterval(() => void refresh(), pollMs)
  ;(timer as any).unref?.()
  void refresh()

  const disposers: Array<() => void> = []
  const claim = (label: string, slot: () => () => void) => {
    try {
      const d = slot()
      if (typeof d === "function") disposers.push(d)
    } catch {
      void label // un emplacement indisponible ne doit pas faire échouer le chargement
    }
  }

  // Statut près du prompt : `after` (frère du bloc) plutôt qu'`append`, pour ne pas être
  // écrasé par le spinner d'OpenCode (même raisonnement que le plugin tps-meter).
  claim("prompt.footer.status", () =>
    ctx.ui.slot({ after: "prompt.footer.status", render: () => <StatusLine theme={ctx.theme} vm={vm} /> }),
  )
  claim("home.footer", () =>
    ctx.ui.slot({ append: "home.footer", render: () => <StatusLine theme={ctx.theme} vm={vm} /> }),
  )
  claim("sidebar.content", () =>
    ctx.ui.slot({ append: "sidebar.content", render: () => <SidebarPanel theme={ctx.theme} vm={vm} /> }),
  )

  return () => {
    clearInterval(timer)
    for (const d of disposers) d()
    disposers.length = 0
  }
}

export default { id: "tor-rotate-tui", setup: setupTui }
