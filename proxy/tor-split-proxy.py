#!/usr/bin/env python3
"""tor-split-proxy — proxy HTTP/HTTPS local avec routage par domaine.

  CONNECT vers un domaine de --domains (défaut: opencode.ai) -> Tor via SOCKS5
  tout le reste (MCP, npm, LSP, models.dev...)                     -> direct
  GET /rotate : ferme les tunnels Tor ouverts + nouveau circuit, puis renvoie
                l'IP de sortie vue depuis Tor (best effort, null si indisponible)
  GET /status : état (epoch, tunnels, IP de sortie connue...)

Pourquoi fermer les tunnels : un client HTTP garde sa connexion ouverte
(keep-alive / HTTP2). Un simple NEWNYM ne touche que les NOUVELLES connexions,
l'ancienne resterait sur l'ancienne IP. En coupant le tunnel, le client se
reconnecte via un nouveau CONNECT -> nouveau circuit -> nouvelle IP.

L'IDENTIFIANT SOCKS `rot<epoch>` EST CE QUI FORCE L'ISOLATION DU CIRCUIT.
Tor met en cache une connexion SOCKS par couple (client, utilisateur,
destination) : tant que l'utilisateur ne change pas, la socket est réutilisée
et l'IP de sortie aussi. Faire tourner `epoch` donne un utilisateur inédit à
chaque rotation, donc une nouvelle socket -> un nouveau circuit -> une nouvelle
IP de sortie. NEWNYM seul ne suffit pas : il ne ferme pas les circuits déjà
utilisés, il n'agit que sur les futures constructions de circuit.

Aucune dépendance hors bibliothèque standard.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hmac
import json
import os
import re
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import urlsplit

VERSION = "2.1.0"
IP_RE = re.compile(r"\b(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F]{0,4}:[0-9a-fA-F:]{2,})\b")
DEFAULT_IP_ECHO = "http://api.ipify.org"
OFF_VALUES = {"", "off", "none", "no", "0", "false", "disable", "disabled"}


def _int(value, fallback: int) -> int:
    try:
        n = int(str(value).strip())
        return n if n >= 0 else fallback
    except (TypeError, ValueError):
        return fallback


def _float(value, fallback: float) -> float:
    try:
        n = float(str(value).strip())
        return n if n > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def _off(value) -> bool:
    return str(value).strip().lower() in OFF_VALUES


@dataclass
class Config:
    """Configuration résolue : drapeaux CLI > variables d'environnement > défauts."""

    host: str = "127.0.0.1"
    port: int = 9253
    socks_port: int = 9250
    control_host: str = "127.0.0.1"
    control_port: int = 9251
    cookie: Path = field(default_factory=lambda: Path.home() / ".opencode_check_tor" / "cookie")
    domains: tuple = ("opencode.ai",)
    verbose: bool = False
    pidfile: Optional[Path] = None
    max_tunnels: int = 64
    idle_timeout: float = 600.0
    ip_echo: str = DEFAULT_IP_ECHO
    token_file: Optional[Path] = None
    connect_timeout: float = 15.0
    exit_ip_timeout: float = 4.0

    @property
    def socks(self) -> tuple:
        return ("127.0.0.1", self.socks_port)

    @property
    def socks_user(self) -> str:  # cf. docstring : c'est ça qui isole les circuits
        return "rot0"  # remplacé par la valeur courante via socks_username()

    def socks_username(self, epoch: int) -> str:
        return f"rot{epoch}"


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="tor-split-proxy.py",
        description="Proxy CONNECT : opencode.ai via Tor, le reste en direct.",
    )
    p.add_argument("--host", help="adresse d'écoute (défaut 127.0.0.1)")
    p.add_argument("--port", help="port d'écoute (défaut 9253)")
    p.add_argument("--socks-port", help="port SOCKS de Tor (défaut 9250)")
    p.add_argument("--control-port", help="port de contrôle Tor (défaut 9251)")
    p.add_argument("--control-host", help="hôte du port de contrôle (défaut 127.0.0.1)")
    p.add_argument("--cookie", help="fichier de cookie Tor (défaut ~/.opencode_check_tor/cookie)")
    p.add_argument("--domains", help="domaines routés via Tor, séparés par des virgules")
    p.add_argument("--verbose", action="store_true", help="journalise aussi le trafic direct")
    p.add_argument("--pidfile", help="écrit le PID ici, le retire à l'arrêt propre")
    p.add_argument("--max-tunnels", help="tunnels Tor simultanés maximum (défaut 64)")
    p.add_argument("--idle-timeout", help="secondes d'inactivité avant de fermer un tunnel (défaut 600)")
    p.add_argument("--ip-echo", help=f"URL d'écho d'IP (défaut {DEFAULT_IP_ECHO}, 'off' pour désactiver)")
    p.add_argument("--token-file", help="secret partagé exigé pour /rotate")
    p.add_argument("--connect-timeout", help="timeout de connexion, secondes (défaut 15)")
    p.add_argument("--exit-ip-timeout", help="timeout de la lecture d'IP de sortie, secondes (défaut 4)")
    p.add_argument("--version", action="version", version=f"tor-split-proxy {VERSION}")
    return p


def parse_args(argv=None, env=None) -> Config:
    env = os.environ if env is None else env
    args = build_parser().parse_args(argv if argv is not None else sys.argv[1:])

    def pick(flag, var, default):
        value = getattr(args, flag) if flag else None
        if value in (None, False):
            value = env.get(var) or default
        return value

    domains_raw = pick("domains", "TOR_DOMAINS", "opencode.ai")
    domains = tuple(d.strip().lower().lstrip("*.") for d in str(domains_raw).split(",") if d.strip())

    verbose = bool(args.verbose) or str(env.get("TOR_PROXY_VERBOSE", "")) == "1"
    ip_echo = pick("ip_echo", "TOR_IP_ECHO", DEFAULT_IP_ECHO)
    pidfile = pick("pidfile", "TOR_PROXY_PIDFILE", None)
    token = pick("token_file", "TOR_ROTATE_TOKEN", None)

    return Config(
        host=str(pick("host", "TOR_PROXY_HOST", "127.0.0.1")),
        port=_int(pick("port", "TOR_PROXY_PORT", 9253), 9253),
        socks_port=_int(pick("socks_port", "TOR_SOCKS_PORT", 9250), 9250),
        control_host=str(pick("control_host", "TOR_CONTROL_HOST", "127.0.0.1")),
        control_port=_int(pick("control_port", "TOR_CONTROL_PORT", 9251), 9251),
        cookie=Path(str(pick("cookie", "TOR_COOKIE", Path.home() / ".opencode_check_tor" / "cookie"))),
        domains=domains,
        verbose=verbose,
        pidfile=Path(str(pidfile)) if pidfile else None,
        max_tunnels=_int(pick("max_tunnels", "TOR_PROXY_MAX_TUNNELS", 64), 64),
        idle_timeout=_float(pick("idle_timeout", "TOR_PROXY_IDLE_TIMEOUT", 600.0), 600.0),
        ip_echo="" if _off(ip_echo) else str(ip_echo).strip(),
        token_file=Path(str(token)) if token else None,
        connect_timeout=_float(pick("connect_timeout", "TOR_PROXY_CONNECT_TIMEOUT", 15.0), 15.0),
        exit_ip_timeout=_float(pick("exit_ip_timeout", "TOR_PROXY_EXIT_IP_TIMEOUT", 4.0), 4.0),
    )


def parse_headers(head: bytes) -> dict:
    """En-têtes HTTP en minuscules à partir de la requête lue par handle()."""
    out = {}
    for line in head.split(b"\r\n")[1:]:
        if b":" in line:
            k, _, v = line.decode("latin1").partition(":")
            out[k.strip().lower()] = v.strip()
    return out


def log(msg: str) -> None:
    """Une ligne horodatée par message (le lanceur redirige stdout vers un fichier)."""
    print(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {msg}", flush=True)


class Proxy:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.epoch = 0
        self.tunnels: dict = {}  # id -> {"client", "remote", "host", "last"}
        self.last_exit_ip: Optional[str] = None
        self.started = time.time()
        self.rotations = 0
        self.server: Optional[asyncio.AbstractServer] = None
        self._next_id = 0
        self._sweeper: Optional[asyncio.Task] = None
        self._stopping = asyncio.Event()

    # --- utilitaires -----------------------------------------------------

    def via_tor(self, host: str) -> bool:
        h = host.lower().rstrip(".")
        return any(h == d or h.endswith("." + d) for d in self.cfg.domains)

    def token_ok(self, headers: dict, query: str) -> bool:
        if not self.cfg.token_file:
            return True
        try:
            expected = self.cfg.token_file.read_text().strip()
        except OSError as e:
            log(f"[auth] fichier de token illisible: {e}")
            return False
        if not expected:
            return False
        # parse_headers() met les clés en minuscules.
        given = headers.get("x-tor-rotate-token", "")
        if not given and query:
            for part in query.split("&"):
                if part.startswith("token="):
                    given = part[6:]
        return hmac.compare_digest(given.encode(), expected.encode())

    def socks_username(self) -> str:
        # Le nom d'utilisateur SOCKS porte l'epoch : c'est lui qui force un
        # nouveau circuit (et donc une nouvelle IP), pas le NEWNYM.
        return self.cfg.socks_username(self.epoch)

    # --- SOCKS5 ----------------------------------------------------------

    async def socks5_connect(self, host: str, port: int):
        user = self.socks_username().encode()
        r, w = await asyncio.wait_for(asyncio.open_connection(*self.cfg.socks), self.cfg.connect_timeout)
        w.write(b"\x05\x01\x02")  # VERSION, 1 méthode, user/pass
        await w.drain()
        if await r.readexactly(2) != b"\x05\x02":
            w.close()
            raise OSError("SOCKS: méthode refusée")
        w.write(b"\x01" + bytes([len(user)]) + user + b"\x01x")  # VER=1, user, pass
        await w.drain()
        if await r.readexactly(2) != b"\x01\x00":
            w.close()
            raise OSError("SOCKS: login refusé")
        h = host.encode()
        w.write(b"\x05\x01\x00\x03" + bytes([len(h)]) + h + port.to_bytes(2, "big"))
        await w.drain()
        rep = await r.readexactly(4)
        if rep[1] != 0:
            w.close()
            raise OSError(f"SOCKS: échec (code {rep[1]})")
        n = {1: 4, 4: 16}.get(rep[3])
        if n is None:
            n = (await r.readexactly(1))[0]
        await r.readexactly(n + 2)  # adresse + port
        return r, w

    # --- contrôle Tor ----------------------------------------------------

    async def newnym(self) -> str:
        try:
            cookie = self.cfg.cookie.read_bytes().hex()
        except OSError as e:
            return f"error: cookie illisible ({e})"
        try:
            r, w = await asyncio.wait_for(
                asyncio.open_connection(self.cfg.control_host, self.cfg.control_port), 5
            )
            w.write(f"AUTHENTICATE {cookie}\r\nSIGNAL NEWNYM\r\nQUIT\r\n".encode())
            await w.drain()
            out = await asyncio.wait_for(r.read(), 5)
            w.close()
            return "ok" if out.decode(errors="replace").count("250 OK") >= 2 else "refused"
        except Exception as e:  # noqa: BLE001 - on ne veut jamais faire tomber /rotate
            return f"error: {e}"

    # --- IP de sortie (best effort) --------------------------------------

    async def fetch_exit_ip(self) -> Optional[str]:
        if not self.cfg.ip_echo:
            return None
        parts = urlsplit(self.cfg.ip_echo)
        if parts.scheme != "http":
            log(f"[exit-ip] schéma {parts.scheme!r} non supporté, IP ignorée")
            return None
        host = parts.hostname
        if not host:
            return None
        port = parts.port or 80
        path = parts.path or "/"
        try:
            r, w = await asyncio.wait_for(self.socks5_connect(host, port), self.cfg.exit_ip_timeout)
        except Exception as e:  # noqa: BLE001
            log(f"[exit-ip] connexion échouée: {e}")
            return None
        try:
            req = (
                f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: {VERSION}\r\n"
                f"Connection: close\r\nAccept: text/plain\r\n\r\n"
            )
            w.write(req.encode())
            await w.drain()
            raw = await asyncio.wait_for(r.read(8192), self.cfg.exit_ip_timeout)
        except Exception as e:  # noqa: BLE001
            log(f"[exit-ip] lecture échouée: {e}")
            return None
        finally:
            with contextlib.suppress(Exception):
                w.close()
        head, _, body = raw.partition(b"\r\n\r\n")
        if not body:  # réponse sans corps : on relit ce qui reste
            body = raw
        if not head.startswith(b"HTTP/1.") or b" 200" not in head.split(b"\r\n")[0]:
            log(f"[exit-ip] réponse inattendue: {head.splitlines()[:1]}")
            return None
        try:
            text = body.decode("utf-8", "replace")
        except Exception:  # noqa: BLE001 # pragma: no cover
            return None
        match = IP_RE.search(text)
        return match.group(0) if match else None

    # --- tunnels ---------------------------------------------------------

    def _sweep(self) -> None:
        now = time.time()
        for tid, t in list(self.tunnels.items()):
            if now - t["last"] >= self.cfg.idle_timeout:
                log(f"[tunnel {tid}] fermé (inactif depuis {int(now - t['last'])}s) {t['host']}")
                self._close_tunnel(tid)

    def _close_tunnel(self, tid: int) -> int:
        t = self.tunnels.pop(tid, None)
        if t is None:
            return 0
        for sock in (t["client"], t["remote"]):
            with contextlib.suppress(Exception):
                sock.close()
        return 1

    def _close_all_tunnels(self) -> int:
        return sum(self._close_tunnel(tid) for tid in list(self.tunnels))

    async def _sweeper_loop(self) -> None:
        interval = max(0.05, min(30.0, self.cfg.idle_timeout / 2))
        while not self._stopping.is_set():
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self._stopping.wait(), interval)
            self._sweep()

    # --- points de contrôle HTTP ----------------------------------------

    async def _rotate(self, payload: dict) -> None:
        self.epoch += 1
        self.rotations += 1
        closed = self._close_all_tunnels()
        nym = await self.newnym()
        exit_ip = await self.fetch_exit_ip()
        if exit_ip:
            self.last_exit_ip = exit_ip
        log(
            f"[rotate] epoch={self.epoch}  tunnels fermés={closed}  newnym={nym}  "
            f"exit={exit_ip or '?'}"
        )
        payload.update(
            {
                "epoch": self.epoch,
                "closed": closed,
                "newnym": nym,
                "exit_ip": exit_ip,
                "tunnels": len(self.tunnels),
            }
        )

    def _status(self) -> dict:
        return {
            "version": VERSION,
            "pid": os.getpid(),
            "epoch": self.epoch,
            "rotations": self.rotations,
            "tunnels": len(self.tunnels),
            "domains": list(self.cfg.domains),
            "exit_ip": self.last_exit_ip,
            "socks_port": self.cfg.socks_port,
            "socks_username": self.socks_username(),
            "control_port": self.cfg.control_port,
            "ip_echo": self.cfg.ip_echo or None,
            "token_required": bool(self.cfg.token_file),
            "max_tunnels": self.cfg.max_tunnels,
            "idle_timeout": self.cfg.idle_timeout,
            "uptime": round(time.time() - self.started, 1),
        }

    # --- tunnelisation ---------------------------------------------------

    async def _pipe(self, src, dst, tunnel: Optional[dict]) -> None:
        try:
            while True:
                try:
                    # Un tunnel Tor sans trafic pendant idle_timeout est coupé :
                    # sinon les connexions s'accumulent et fuient (sockets, FD).
                    data = await asyncio.wait_for(src.read(65536), self.cfg.idle_timeout)
                except asyncio.TimeoutError:
                    return
                if not data:
                    break
                if tunnel is not None:
                    tunnel["last"] = time.time()
                dst.write(data)
                await dst.drain()
        except (OSError, asyncio.CancelledError):
            pass
        finally:
            with contextlib.suppress(Exception):
                dst.close()
            if tunnel is not None and not dst.is_closing():
                with contextlib.suppress(Exception):
                    dst.write_eof()

    async def handle(self, cr, cw) -> None:
        tunnel_id = None
        try:
            try:
                head = await asyncio.wait_for(cr.readuntil(b"\r\n\r\n"), self.cfg.connect_timeout)
            except Exception:  # noqa: BLE001
                cw.close()
                return
            parts = head.split(b"\r\n", 1)[0].decode("latin1").split(" ")
            if len(parts) < 2:
                cw.close()
                return
            method, target = parts[0], parts[1]
            if method == "GET" and target.startswith("/"):
                await self.control(target, parse_headers(head), cw)
                return
            if method != "CONNECT":
                await reply(cw, "405 Method Not Allowed")
                return
            host, _, port_s = target.rpartition(":")
            host = host.strip("[]")
            try:
                port = int(port_s)
            except ValueError:
                await reply(cw, "400 Bad Request")
                return

            tor = self.via_tor(host)
            if tor and len(self.tunnels) >= self.cfg.max_tunnels:
                # On refuse plutôt que de tuer un tunnel vivant : Tor n'a qu'un
                # petit nombre de circuits, on ne veut pas d'échauffement.
                log(f"[refus] {host}:{port} — {len(self.tunnels)} tunnels Tor ouverts (max {self.cfg.max_tunnels})")
                await reply(cw, "503 Service Unavailable", b"too many concurrent Tor tunnels")
                return
            if tor or self.cfg.verbose:
                log(f"CONNECT {host}:{port} -> {'TOR (epoch %d)' % self.epoch if tor else 'direct'}")
            try:
                connector = self.socks5_connect if tor else asyncio.open_connection
                rr, rw = await asyncio.wait_for(connector(host, port), self.cfg.connect_timeout)
            except Exception as e:  # noqa: BLE001
                log(f"  x {host}:{port}: {e}")
                await reply(cw, "502 Bad Gateway")
                return

            cw.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
            await cw.drain()
            tunnel = None
            if tor:
                self._next_id += 1
                tunnel_id = self._next_id
                tunnel = {
                    "client": cw,
                    "remote": rw,
                    "host": f"{host}:{port}",
                    "last": time.time(),
                }
                self.tunnels[tunnel_id] = tunnel
            await asyncio.gather(
                self._pipe(cr, rw, tunnel),
                self._pipe(rr, cw, tunnel),
            )
            for w in (cw, rw):
                with contextlib.suppress(Exception):
                    w.close()
        finally:
            if tunnel_id is not None:
                self._close_tunnel(tunnel_id)

    async def control(self, target: str, headers: dict, cw) -> None:
        path, _, query = target.partition("?")
        if path == "/rotate":
            if not self.token_ok(headers, query):
                log("[rotate] refus : token absent ou incorrect")
                await reply(cw, "403 Forbidden", b"bad or missing token")
                return
            payload: dict = {}
            await self._rotate(payload)
            await reply(cw, "200 OK", json.dumps(payload).encode(), "application/json")
        elif path == "/status":
            await reply(cw, "200 OK", json.dumps(self._status()).encode(), "application/json")
        elif path in ("/", "/health"):
            await reply(cw, "200 OK", b"ok")
        else:
            await reply(cw, "404 Not Found")

    # --- cycle de vie ----------------------------------------------------

    def write_pidfile(self) -> None:
        if not self.cfg.pidfile:
            return
        self.cfg.pidfile.parent.mkdir(parents=True, exist_ok=True)
        self.cfg.pidfile.write_text(f"{os.getpid()}\n")

    def remove_pidfile(self) -> None:
        path = self.cfg.pidfile
        if not path:
            return
        try:
            if path.read_text().strip() == str(os.getpid()):
                path.unlink()
        except OSError:
            pass

    async def start(self) -> asyncio.AbstractServer:
        self.server = await asyncio.start_server(self.handle, self.cfg.host, self.cfg.port)
        self.write_pidfile()
        if self.cfg.pidfile:
            log(f"[pid] {os.getpid()} -> {self.cfg.pidfile}")
        self._sweeper = asyncio.create_task(self._sweeper_loop())
        host, port = self.server.sockets[0].getsockname()[:2]
        log(
            f"tor-split-proxy {VERSION} sur {host}:{port} — Tor(SOCKS {self.cfg.socks_port}, "
            f"utilisateur {self.socks_username()}) pour {list(self.cfg.domains)}, direct pour le reste"
        )
        log(
            f"[garde-fous] tunnels max={self.cfg.max_tunnels}  inactivité max={self.cfg.idle_timeout}s  "
            f"écho d'IP={'désactivé' if not self.cfg.ip_echo else self.cfg.ip_echo}"
            f"{'  token exigé' if self.cfg.token_file else ''}"
        )
        return self.server

    @property
    def port(self) -> int:
        if self.server is None:
            return self.cfg.port
        return self.server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        self._stopping.set()
        if self._sweeper:
            self._sweeper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._sweeper
        if self.server:
            self.server.close()
            with contextlib.suppress(Exception):
                await self.server.wait_closed()
        closed = self._close_all_tunnels()
        self.remove_pidfile()
        log(f"[arrêt] tunnels fermés={closed} — bye")

    async def serve_forever(self) -> None:
        await self.start()
        await self.server.serve_forever()


async def reply(w, code: str, body: bytes = b"", ctype: str = "text/plain") -> None:
    w.write(
        f"HTTP/1.1 {code}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
        f"Connection: close\r\n\r\n".encode()
        + body
    )
    with contextlib.suppress(OSError):
        await w.drain()
    w.close()


async def amain(cfg: Config) -> int:
    proxy = Proxy(cfg)
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def request_stop(signame: str) -> None:
        # SIGTERM/SIGINT : on arrête proprement le serveur, on ferme les tunnels
        # et on retire le pidfile. On ne touche à rien d'autre.
        log(f"[signal] {signame} reçu, arrêt propre")
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(sig, request_stop, sig.name)

    await proxy.start()
    server_task = asyncio.create_task(proxy.server.serve_forever())
    stop_task = asyncio.create_task(stop_event.wait())
    done, pending = await asyncio.wait({server_task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    for task in done:
        exc = task.exception() if not task.cancelled() else None
        if exc and not isinstance(exc, asyncio.CancelledError):
            await proxy.stop()
            raise exc
    await proxy.stop()
    return 0


def main(argv=None) -> int:
    cfg = parse_args(argv)
    if cfg.host not in ("127.0.0.1", "::1", "localhost"):
        log(f"[avertissement] écoute sur {cfg.host} : le proxy devient accessible à d'autres machines")
    try:
        return asyncio.run(amain(cfg))
    except KeyboardInterrupt:
        return 0
    except OSError as e:
        log(f"[fatal] {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
