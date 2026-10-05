// Contrôles réseau Tor via Onionoo (API officielle du Tor Project) — logique pure, fetch injectable.
//
//  1. Nombre d'exits disponibles : /summary?flag=Exit&running=true&type=relay&limit=0
//     On lit `relays` (liste renvoyée) + `relays_truncated` (ce que `limit` a retiré) : le total
//     est correct que `limit=0` renvoie une liste vide ou la liste entière.
//  2. L'IP de sortie est-elle un noeud Tor ? : /details?search=<ip>&type=relay&running=true
//     La doc Onionoo précise que la recherche par IP couvre "toutes les adresses utilisées pour
//     le routage ET pour sortir vers Internet". On revérifie la correspondance EXACTE côté
//     client (une recherche peut aussi renvoyer des adresses voisines).
//
// Politesse envers un service public : 1 requête / 15 min pour le compte, 1 / 30 min par IP,
// 2 min d'attente après un échec, jamais deux requêtes du même type en parallèle.
export const ONIONOO_URL = "https://onionoo.torproject.org"

const IP_RE = /^[0-9a-fA-F:.]{3,45}$/
export const isIpLike = (s) => typeof s === "string" && IP_RE.test(s) && (s.includes(".") || s.includes(":"))

// "1.2.3.4:9001" | "[2001:db8::1]:9001" | "1.2.3.4" -> "1.2.3.4" | "2001:db8::1" (minuscules)
export function stripPort(addr) {
  const s = String(addr).trim().toLowerCase()
  const v6 = s.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (v6) return v6[1]
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) return s.slice(0, s.lastIndexOf(":"))
  return s
}

// Total d'exits à partir d'un document /summary. null si le format est inattendu.
export function parseExitCount(doc) {
  if (!doc || !Array.isArray(doc.relays)) return null
  const cut = Number.isInteger(doc.relays_truncated) ? doc.relays_truncated : 0
  return doc.relays.length + cut
}

// Ce relais possède-t-il exactement cette IP ? Si Onionoo ne donne aucune adresse (champ absent),
// on ne peut pas contredire la recherche : on l'accepte.
function relayHasIp(relay, ip) {
  const lists = [relay?.or_addresses, relay?.exit_addresses]
  if (lists.every((l) => !Array.isArray(l))) return true
  const want = ip.toLowerCase()
  return lists.some((l) => Array.isArray(l) && l.some((a) => stripPort(a) === want))
}

// Résultat d'une recherche /details pour `ip` :
//   exit  : relais en marche avec le drapeau Exit      relay : relais en marche, exit non confirmé
//   none  : aucune correspondance (l'IP n'est pas un noeud Tor connu)      null : format inattendu
export function parseIpCheck(doc, ip) {
  if (!doc || !Array.isArray(doc.relays)) return null
  const hits = doc.relays.filter((r) => relayHasIp(r, ip))
  if (hits.length === 0) return { kind: "none", nick: null }
  const exit = hits.find((r) => Array.isArray(r.flags) && r.flags.includes("Exit") && !r.flags.includes("BadExit"))
  if (exit) return { kind: "exit", nick: exit.nickname ?? null }
  return { kind: "relay", nick: hits[0].nickname ?? null }
}

export function createNetChecker({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  baseUrl = ONIONOO_URL,
  countTtlMs = 15 * 60_000,
  ipTtlMs = 30 * 60_000,
  failRetryMs = 2 * 60_000,
  timeoutMs = 8_000,
} = {}) {
  const base = String(baseUrl).replace(/\/+$/, "")
  let count = null
  let countAt = 0
  let countNext = 0
  let countBusy = false
  let ip = null
  let ipKind = null
  let ipNick = null
  let ipAt = 0
  let ipNext = 0
  let ipBusy = false

  async function getJson(pathAndQuery) {
    const res = await fetchImpl(`${base}${pathAndQuery}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json()
  }

  async function refreshCount() {
    if (countBusy || now() < countNext) return
    countBusy = true
    try {
      const n = parseExitCount(await getJson("/summary?flag=Exit&running=true&type=relay&limit=0"))
      if (n === null) throw new Error("format inattendu")
      count = n
      countAt = now()
      countNext = countAt + countTtlMs
    } catch {
      countNext = now() + failRetryMs // on garde la dernière valeur connue
    } finally {
      countBusy = false
    }
  }

  async function refreshIp(exitIp) {
    if (!isIpLike(exitIp) || ipBusy) return
    if (exitIp === ip && now() < ipNext) return
    ipBusy = true
    try {
      const q = `/details?search=${encodeURIComponent(exitIp)}&type=relay&running=true` +
        "&fields=nickname,flags,or_addresses,exit_addresses"
      const r = parseIpCheck(await getJson(q), exitIp)
      if (r === null) throw new Error("format inattendu")
      ip = exitIp
      ipKind = r.kind
      ipNick = r.nick
      ipAt = now()
      ipNext = ipAt + ipTtlMs
    } catch {
      if (exitIp !== ip) {
        // Nouvelle IP dont on n'a pas pu vérifier le statut : inconnu (jamais "non").
        ip = exitIp
        ipKind = null
        ipNick = null
      }
      ipNext = now() + failRetryMs
    } finally {
      ipBusy = false
    }
  }

  return {
    // exitIp peut être null/invalide : seul le compte est alors rafraîchi.
    refresh: (exitIp) => Promise.all([refreshCount(), refreshIp(exitIp)]).then(() => undefined),
    state: () => ({ exitCount: count, countAt, ip, ipKind, ipNick, ipAt }),
  }
}
