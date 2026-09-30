#!/usr/bin/env python3
"""
tor-split-proxy.py — proxy HTTPS local avec routage par domaine.

  CONNECT vers un domaine de TOR_DOMAINS (défaut: opencode.ai) -> via Tor (SOCKS5)
  tout le reste (MCP, npm, LSP, models.dev...)                 -> direct
  GET /rotate : ferme les tunnels Tor ouverts + nouveau circuit
                (NEWNYM + identifiants SOCKS neufs = circuit isolé)
  GET /status : état

Pourquoi fermer les tunnels : un client HTTP garde sa connexion TLS ouverte
(keep-alive / HTTP2). Un simple NEWNYM ne touche que les NOUVELLES connexions,
l'ancienne resterait sur l'ancienne IP. En coupant le tunnel, le client se
reconnecte via un nouveau CONNECT -> nouveau circuit -> nouvelle IP.

Env : TOR_DOMAINS=opencode.ai,autre.com  TOR_PROXY_PORT=9253  TOR_SOCKS_PORT=9250
      TOR_CONTROL_PORT=9251  TOR_COOKIE=...  ;  TOR_PROXY_VERBOSE=1 : logue aussi le trafic direct
"""
import asyncio
import json
import os
import sys
from pathlib import Path

LISTEN_PORT  = int(os.getenv("TOR_PROXY_PORT", 9253))
SOCKS        = ("127.0.0.1", int(os.getenv("TOR_SOCKS_PORT", 9250)))
CONTROL_PORT = int(os.getenv("TOR_CONTROL_PORT", 9251))
COOKIE       = Path(os.getenv("TOR_COOKIE", Path.home() / ".opencode_check_tor" / "cookie"))
DOMAINS      = [d.strip().lower() for d in os.getenv("TOR_DOMAINS", "opencode.ai").split(",") if d.strip()]
VERBOSE      = "-v" in sys.argv or os.getenv("TOR_PROXY_VERBOSE") == "1"

epoch = 0          # change à chaque rotation -> identifiants SOCKS différents -> circuit isolé
tunnels: set = set()


def log(msg: str) -> None:
    print(msg, flush=True)


def via_tor(host: str) -> bool:
    h = host.lower().rstrip(".")
    return any(h == d or h.endswith("." + d) for d in DOMAINS)


async def socks5_connect(host: str, port: int):
    r, w = await asyncio.open_connection(*SOCKS)
    user = f"rot{epoch}".encode()
    w.write(b"\x05\x01\x02"); await w.drain()                       # méthode user/pass
    if await r.readexactly(2) != b"\x05\x02":
        raise OSError("SOCKS: méthode refusée")
    w.write(b"\x01" + bytes([len(user)]) + user + b"\x01x"); await w.drain()
    if await r.readexactly(2) != b"\x01\x00":
        raise OSError("SOCKS: login refusé")
    h = host.encode()
    w.write(b"\x05\x01\x00\x03" + bytes([len(h)]) + h + port.to_bytes(2, "big")); await w.drain()
    rep = await r.readexactly(4)
    if rep[1] != 0:
        raise OSError(f"SOCKS: échec (code {rep[1]})")
    n = {1: 4, 4: 16}.get(rep[3])
    if n is None:
        n = (await r.readexactly(1))[0]
    await r.readexactly(n + 2)
    return r, w


async def newnym() -> str:
    try:
        cookie = COOKIE.read_bytes().hex()
        r, w = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", CONTROL_PORT), 5)
        w.write(f"AUTHENTICATE {cookie}\r\nSIGNAL NEWNYM\r\nQUIT\r\n".encode()); await w.drain()
        out = await asyncio.wait_for(r.read(), 5)
        w.close()
        return "ok" if out.decode(errors="replace").count("250 OK") >= 2 else "refused"
    except Exception as e:
        return f"error: {e}"


async def pipe(src, dst):
    try:
        while True:
            data = await src.read(65536)
            if not data:
                break
            dst.write(data)
            await dst.drain()
    except (OSError, asyncio.CancelledError):
        pass
    finally:
        try: dst.close()
        except Exception: pass


async def reply(w, code: str, body: bytes = b"", ctype: str = "text/plain") -> None:
    w.write(f"HTTP/1.1 {code}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n".encode() + body)
    try: await w.drain()
    except OSError: pass
    w.close()


async def control(path: str, cw) -> None:
    global epoch
    path = path.split("?")[0]
    if path == "/rotate":
        epoch += 1
        victims = list(tunnels)
        for c, r in victims:
            c.close(); r.close()
        nym = await newnym()
        log(f"[rotate] epoch={epoch}  tunnels fermés={len(victims)}  newnym={nym}")
        await reply(cw, "200 OK", json.dumps({"epoch": epoch, "closed": len(victims), "newnym": nym}).encode(), "application/json")
    elif path == "/status":
        await reply(cw, "200 OK", json.dumps({"epoch": epoch, "tunnels": len(tunnels), "domains": DOMAINS}).encode(), "application/json")
    else:
        await reply(cw, "404 Not Found")


async def handle(cr, cw) -> None:
    entry = None
    try:
        try:
            head = await asyncio.wait_for(cr.readuntil(b"\r\n\r\n"), 15)
        except Exception:
            cw.close(); return
        parts = head.split(b"\r\n", 1)[0].decode("latin1").split(" ")
        if len(parts) < 2:
            cw.close(); return
        method, target = parts[0], parts[1]
        if method == "GET" and target.startswith("/"):
            await control(target, cw); return
        if method != "CONNECT":
            await reply(cw, "405 Method Not Allowed"); return
        host, _, port_s = target.rpartition(":")
        host = host.strip("[]")
        try:
            port = int(port_s)
        except ValueError:
            await reply(cw, "400 Bad Request"); return

        tor = via_tor(host)
        if tor or VERBOSE:
            log(f"CONNECT {host}:{port} -> {'TOR (epoch %d)' % epoch if tor else 'direct'}")
        try:
            rr, rw = await (socks5_connect(host, port) if tor else asyncio.open_connection(host, port))
        except Exception as e:
            log(f"  ✗ {host}:{port}: {e}")
            await reply(cw, "502 Bad Gateway"); return

        cw.write(b"HTTP/1.1 200 Connection established\r\n\r\n"); await cw.drain()
        if tor:
            entry = (cw, rw); tunnels.add(entry)
        await asyncio.gather(pipe(cr, rw), pipe(rr, cw))
        for w in (cw, rw):
            try: w.close()
            except Exception: pass
    finally:
        if entry is not None:
            tunnels.discard(entry)


async def main() -> None:
    server = await asyncio.start_server(handle, "127.0.0.1", LISTEN_PORT)
    log(f"tor-split-proxy: 127.0.0.1:{LISTEN_PORT}  Tor(SOCKS {SOCKS[1]}) pour {DOMAINS}, direct pour le reste")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
