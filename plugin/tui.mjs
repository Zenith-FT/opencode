// plugin/tui.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createMemo, createSignal, For } from "solid-js";
import fs from "node:fs";

// plugin/tui-model.js
import os from "node:os";
import path from "node:path";
var FRESH_ROTATION_MS = 1e4;
var SPINNER = ["◐", "◓", "◑", "◒"];
function defaultStateFile(env = process.env, home = os.homedir()) {
  if (env.TOR_ROTATE_STATE_FILE)
    return env.TOR_ROTATE_STATE_FILE;
  return path.join(home, ".local", "state", "opencode-tor-rotate", "plugin.state.json");
}
function readState(file, fsImpl) {
  try {
    const st = JSON.parse(fsImpl.readFileSync(file, "utf8"));
    return st && st.v === 1 && typeof st.state === "string" ? st : null;
  } catch {
    return null;
  }
}
function pidAlive(pid, kill = process.kill.bind(process)) {
  if (!Number.isInteger(pid) || pid <= 0)
    return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
var DAY_MS = 86400000;
function localParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const o = {};
  for (const p of fmt.formatToParts(new Date(ms)))
    o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, tz: fmt.resolvedOptions().timeZone };
}
function fmtOffset(min) {
  if (min === 0)
    return "UTC";
  const sign = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  const m = a % 60;
  return `UTC${sign}${Math.floor(a / 60)}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}
function quotaReset({ now = Date.now(), timeZone } = {}) {
  const resetAtMs = (Math.floor(now / DAY_MS) + 1) * DAY_MS;
  let p;
  try {
    p = localParts(resetAtMs, timeZone || undefined);
  } catch {
    p = localParts(resetAtMs, undefined);
  }
  const offsetMin = Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(resetAtMs / 60000) * 60000) / 60000);
  return {
    resetAtMs,
    inMs: resetAtMs - now,
    localTime: `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`,
    utcOffset: fmtOffset(offsetMin),
    timeZone: p.tz
  };
}
function fmtCountdown(ms) {
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  if (totalMin < 1)
    return "moins d'une minute";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0)
    return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
var fmtWindow = (ms) => ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`;
var fmtInt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60)
    return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}min` : `${Math.round(m / 60)}h`;
}
var hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);
function viewModel({ st, live = null, alive = true, now = Date.now(), frame = 0, net = null, tz }) {
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
        "→ lance : opencode-tor doctor"
      ]
    };
  }
  if (!alive) {
    return {
      key: "stopped",
      tone: "bad",
      dot: "○",
      label: "plugin arrêté",
      short: "○ Tor : plugin arrêté",
      lines: ["Tor rotate", "○ plugin arrêté (service OpenCode fermé ?)", `dernier état : ${st.state}`]
    };
  }
  const ip = live?.exit_ip || st.lastExit || null;
  const rot = st.rotations > 0 ? ` ↻${st.rotations}` : "";
  const proxyDown = live ? live.ok === false : st.proxyOk === false;
  const stampsList = Array.isArray(st.stamps) ? st.stamps : null;
  const inWin = stampsList ? stampsList.filter((s) => now - s < st.windowMs).length : st.inWindow;
  const guardOver = st.state === "guard" && st.guardFreeAt > 0 && now >= st.guardFreeAt;
  const stateName = guardOver ? "ready" : st.state;
  const busy = stateName === "rotating" || stateName === "ratelimited";
  const reset = quotaReset({ now, timeZone: tz });
  let key = stateName;
  let tone = "ok";
  let dot = "●";
  let label = "actif";
  let short = "";
  if (stateName === "guard") {
    tone = "bad";
    label = `garde-fou (${inWin}/${st.maxRotations})`;
    short = `● garde-fou ${inWin}/${st.maxRotations}`;
  } else if (stateName === "rotating") {
    tone = "warn";
    dot = SPINNER[frame % SPINNER.length];
    label = "rotation du circuit Tor…";
    short = `${dot} rotation Tor…`;
  } else if (stateName === "ratelimited") {
    tone = "warn";
    if (st.streak >= 1 && st.streak < st.after) {
      label = `limite de débit (${st.streak}/${st.after})`;
      short = `● limite de débit ${st.streak}/${st.after}`;
    } else {
      label = "quota épuisé";
      short = `● quota épuisé · reset ${reset.localTime}`;
    }
  } else if (stateName === "error" || stateName === "proxy_down" || proxyDown && !busy) {
    key = stateName === "ready" || stateName === "loaded" ? "proxy_down" : st.state;
    tone = "bad";
    label = "proxy Tor hors ligne";
    short = "● Tor hors ligne";
  } else if (stateName === "rotated" && now - st.stateAt < FRESH_ROTATION_MS) {
    label = `nouvelle IP ${ip ?? "?"}`;
    short = `● nouvelle IP ${ip ?? "?"}`;
  } else {
    key = "ready";
    label = ip ? `prêt · ${ip}` : "prêt";
    short = `● Tor ${ip ?? "prêt"}${rot}`;
  }
  if (ip && net?.ipKind === "none" && (key === "ready" || key === "rotated")) {
    key = "notor";
    tone = "warn";
    label = "IP non reconnue comme noeud Tor";
    short = `● ${ip} ⚠ hors Tor`;
  }
  const lines = [
    "Tor rotate",
    `${dot} ${label}`,
    `IP de sortie : ${ip ?? "?"}`,
    ...net ? [ipCheckLine(ip, net), `Exits Tor disponibles : ${net.exitCount == null ? "?" : fmtInt(net.exitCount)}`] : [],
    `Rotations : ${st.rotations} (${inWin}/${st.maxRotations} sur ${fmtWindow(st.windowMs)})`,
    `Quota épuisé d'affilée : ${st.streak}/${st.after}`,
    `Reset du quota : ${reset.localTime} ${reset.utcOffset} (dans ${fmtCountdown(reset.inMs)})`,
    `Requêtes OK : ${st.okCount}`,
    `Dernier : ${st.message} (il y a ${ago(now - st.stateAt)})`
  ];
  if (stateName === "guard" && st.guardFreeAt)
    lines.push(`Garde-fou libre à ${hhmmss(st.guardFreeAt)}`);
  if (live && live.tunnels !== undefined)
    lines.push(`Tunnels Tor ouverts : ${live.tunnels}`);
  return { key, tone, dot, label, short, lines, reset };
}
function ipCheckLine(ip, net) {
  if (!ip)
    return "Noeud Tor : en attente d'une IP";
  switch (net?.ipKind) {
    case "exit":
      return `Noeud Tor : oui, exit${net.ipNick ? ` (${net.ipNick})` : ""}`;
    case "relay":
      return "Noeud Tor : relais, exit non confirmé";
    case "none":
      return "Noeud Tor : NON (absente de l'annuaire)";
    default:
      return "Noeud Tor : vérification…";
  }
}
function toastFor(prev, vm, st) {
  if (!vm || prev === vm.key)
    return null;
  switch (vm.key) {
    case "ready":
      return prev === undefined || ["absent", "stopped", "proxy_down", "error", "notor", "guard"].includes(prev) ? { variant: "success", title: "Tor rotate", message: `actif — ${vm.label}` } : null;
    case "ratelimited":
      if (st && st.streak >= 1 && st.streak < st.after) {
        return { variant: "warning", title: `Limite de débit (${st.streak}/${st.after})`, message: "on retente avant de changer d'IP" };
      }
      return {
        variant: "warning",
        title: "Quota épuisé",
        message: vm.reset ? `reset à ${vm.reset.localTime}, ou nouvelle IP tout de suite` : "changement d'IP en cours…"
      };
    case "rotated":
      return { variant: "success", title: "Nouvelle IP Tor", message: st?.message ?? vm.label };
    case "guard":
      return { variant: "error", title: "Garde-fou Tor", message: vm.label };
    case "notor":
      return { variant: "warning", title: "IP hors Tor ?", message: "l'IP de sortie n'est pas un noeud Tor connu : vérifie le proxy" };
    case "proxy_down":
    case "error":
      return { variant: "error", title: "Tor hors ligne", message: "lance : opencode-tor start" };
    case "absent":
    case "stopped":
      return { variant: "warning", title: "Tor rotate", message: vm.label };
    default:
      return null;
  }
}

// plugin/tor-net.js
var ONIONOO_URL = "https://onionoo.torproject.org";
var IP_RE = /^[0-9a-fA-F:.]{3,45}$/;
var isIpLike = (s) => typeof s === "string" && IP_RE.test(s) && (s.includes(".") || s.includes(":"));
function stripPort(addr) {
  const s = String(addr).trim().toLowerCase();
  const v6 = s.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (v6)
    return v6[1];
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s))
    return s.slice(0, s.lastIndexOf(":"));
  return s;
}
function parseExitCount(doc) {
  if (!doc || !Array.isArray(doc.relays))
    return null;
  const cut = Number.isInteger(doc.relays_truncated) ? doc.relays_truncated : 0;
  return doc.relays.length + cut;
}
function relayHasIp(relay, ip) {
  const lists = [relay?.or_addresses, relay?.exit_addresses];
  if (lists.every((l) => !Array.isArray(l)))
    return true;
  const want = ip.toLowerCase();
  return lists.some((l) => Array.isArray(l) && l.some((a) => stripPort(a) === want));
}
function parseIpCheck(doc, ip) {
  if (!doc || !Array.isArray(doc.relays))
    return null;
  const hits = doc.relays.filter((r) => relayHasIp(r, ip));
  if (hits.length === 0)
    return { kind: "none", nick: null };
  const exit = hits.find((r) => Array.isArray(r.flags) && r.flags.includes("Exit") && !r.flags.includes("BadExit"));
  if (exit)
    return { kind: "exit", nick: exit.nickname ?? null };
  return { kind: "relay", nick: hits[0].nickname ?? null };
}
function createNetChecker({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  baseUrl = ONIONOO_URL,
  countTtlMs = 15 * 60000,
  ipTtlMs = 30 * 60000,
  failRetryMs = 2 * 60000,
  timeoutMs = 8000
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  let count = null;
  let countAt = 0;
  let countNext = 0;
  let countBusy = false;
  let ip = null;
  let ipKind = null;
  let ipNick = null;
  let ipAt = 0;
  let ipNext = 0;
  let ipBusy = false;
  async function getJson(pathAndQuery) {
    const res = await fetchImpl(`${base}${pathAndQuery}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" }
    });
    if (!res.ok)
      throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  async function refreshCount() {
    if (countBusy || now() < countNext)
      return;
    countBusy = true;
    try {
      const n = parseExitCount(await getJson("/summary?flag=Exit&running=true&type=relay&limit=0"));
      if (n === null)
        throw new Error("format inattendu");
      count = n;
      countAt = now();
      countNext = countAt + countTtlMs;
    } catch {
      countNext = now() + failRetryMs;
    } finally {
      countBusy = false;
    }
  }
  async function refreshIp(exitIp) {
    if (!isIpLike(exitIp) || ipBusy)
      return;
    if (exitIp === ip && now() < ipNext)
      return;
    ipBusy = true;
    try {
      const q = `/details?search=${encodeURIComponent(exitIp)}&type=relay&running=true` + "&fields=nickname,flags,or_addresses,exit_addresses";
      const r = parseIpCheck(await getJson(q), exitIp);
      if (r === null)
        throw new Error("format inattendu");
      ip = exitIp;
      ipKind = r.kind;
      ipNick = r.nick;
      ipAt = now();
      ipNext = ipAt + ipTtlMs;
    } catch {
      if (exitIp !== ip) {
        ip = exitIp;
        ipKind = null;
        ipNick = null;
      }
      ipNext = now() + failRetryMs;
    } finally {
      ipBusy = false;
    }
  }
  return {
    refresh: (exitIp) => Promise.all([refreshCount(), refreshIp(exitIp)]).then(() => {
      return;
    }),
    state: () => ({ exitCount: count, countAt, ip, ipKind, ipNick, ipAt })
  };
}

// plugin/tui.tsx
var toneColor = (theme, tone) => {
  switch (tone) {
    case "ok":
      return theme.text.feedback.success.default;
    case "warn":
      return theme.text.feedback.warning.default;
    case "bad":
      return theme.text.feedback.error.default;
    default:
      return theme.text.subdued;
  }
};
function StatusLine(props) {
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "flexShrink", 0);
    _$insert(_el$2, () => props.vm().short);
    _$effect((_$p) => _$setProp(_el$2, "fg", toneColor(props.theme, props.vm().tone), _$p));
    return _el$;
  })();
}
function SidebarPanel(props) {
  const lines = createMemo(() => props.vm().lines);
  return (() => {
    var _el$3 = _$createElement("box");
    _$setProp(_el$3, "flexDirection", "column");
    _$setProp(_el$3, "flexShrink", 0);
    _$insert(_el$3, _$createComponent(For, {
      get each() {
        return lines();
      },
      children: (line, i) => (() => {
        var _el$4 = _$createElement("text");
        _$insert(_el$4, line);
        _$effect((_$p) => _$setProp(_el$4, "fg", i() === 0 ? props.theme.text.subdued : i() === 1 ? toneColor(props.theme, props.vm().tone) : props.theme.text.default, _$p));
        return _el$4;
      })()
    }));
    return _el$3;
  })();
}
function setupTui(ctx) {
  const opts = ctx?.options ?? {};
  const stateFile = String(opts.stateFile ?? defaultStateFile());
  const proxyUrl = String(opts.proxyUrl ?? process.env.TOR_PROXY_URL ?? "http://127.0.0.1:9253").replace(/\/+$/, "");
  const pollMs = Number(opts.pollMs) > 0 ? Number(opts.pollMs) : 500;
  const toasts = opts.toasts !== false;
  const tz = typeof opts.timeZone === "string" && opts.timeZone.trim() ? opts.timeZone.trim() : undefined;
  const net = opts.onionoo === false ? null : createNetChecker({
    baseUrl: typeof opts.onionooUrl === "string" ? opts.onionooUrl : undefined
  });
  let frame = 0;
  let live = null;
  let prevKey;
  let lastLive = 0;
  let everSeen = false;
  const compute = () => {
    const st = readState(stateFile, fs);
    const alive = st ? pidAlive(st.pid) : false;
    return {
      st,
      vm: viewModel({
        st,
        live,
        alive,
        now: Date.now(),
        frame,
        net: net ? net.state() : null,
        tz
      })
    };
  };
  const [model, setModel] = createSignal(compute());
  const vm = () => model().vm;
  const notify = (t) => {
    if (!t || !toasts)
      return;
    try {
      ctx.ui?.toast?.show({
        ...t,
        duration: 4000
      });
    } catch {}
  };
  const refresh = async () => {
    frame++;
    if (Date.now() - lastLive > 5000) {
      lastLive = Date.now();
      try {
        const res = await fetch(`${proxyUrl}/status`, {
          signal: AbortSignal.timeout(1500)
        });
        live = res.ok ? {
          ok: true,
          ...await res.json()
        } : {
          ok: false
        };
      } catch {
        live = {
          ok: false
        };
      }
    }
    const next = compute();
    setModel(() => next);
    if (net && next.st)
      net.refresh(live?.exit_ip || next.st.lastExit || null);
    if (next.st)
      everSeen = true;
    if (next.vm.key === "absent" && everSeen === false && Date.now() - startedAt < 5000)
      return;
    if (next.vm.key !== prevKey) {
      notify(toastFor(prevKey, next.vm, next.st));
      prevKey = next.vm.key;
    }
  };
  const startedAt = Date.now();
  const timer = setInterval(() => void refresh(), pollMs);
  timer.unref?.();
  refresh();
  const disposers = [];
  const claim = (label, slot) => {
    try {
      const d = slot();
      if (typeof d === "function")
        disposers.push(d);
    } catch {}
  };
  claim("prompt.footer.status", () => ctx.ui.slot({
    after: "prompt.footer.status",
    render: () => _$createComponent(StatusLine, {
      get theme() {
        return ctx.theme;
      },
      vm
    })
  }));
  claim("home.footer", () => ctx.ui.slot({
    append: "home.footer",
    render: () => _$createComponent(StatusLine, {
      get theme() {
        return ctx.theme;
      },
      vm
    })
  }));
  claim("sidebar.content", () => ctx.ui.slot({
    append: "sidebar.content",
    render: () => _$createComponent(SidebarPanel, {
      get theme() {
        return ctx.theme;
      },
      vm
    })
  }));
  return () => {
    clearInterval(timer);
    for (const d of disposers)
      d();
    disposers.length = 0;
  };
}
var tui_default = {
  id: "tor-rotate-tui",
  setup: setupTui
};
export {
  tui_default as default,
  setupTui
};
