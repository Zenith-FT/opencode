"""Tests du proxy tor-split-proxy — 100 % hors-ligne.

Aucun Tor réel : un faux serveur SOCKS5, un faux port de contrôle Tor et un
faux serveur d'origine (écho d'IP + echo d'octets) font tous les contrôles.
"""
import asyncio
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

PROXY_PATH = Path(__file__).resolve().parent.parent / "proxy" / "tor-split-proxy.py"


def _load():
    spec = importlib.util.spec_from_file_location("tor_split_proxy", PROXY_PATH)
    mod = importlib.util.module_from_spec(spec)
    # dataclasses/typing ont besoin du module dans sys.modules (le nom de fichier
    # contient des tirets, d'où le chargement manuel plutôt qu'un simple import).
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


tp = _load()


# --------------------------------------------------------------------------- #
# Doublures
# --------------------------------------------------------------------------- #


async def _relay(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except (OSError, asyncio.CancelledError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


class OriginServer:
    """Faux serveur d'origine : répond à GET (écho d'IP) sinon renvoie les octets."""

    def __init__(self, ip="203.0.113.7"):
        self.ip = ip
        self.requests = []
        self.server = None

    async def start(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0)
        return self

    @property
    def port(self):
        return self.server.sockets[0].getsockname()[1]

    async def handle(self, r, w):
        try:
            first = await asyncio.wait_for(r.readline(), 5)
            if first.startswith(b"GET"):
                self.requests.append(first.decode("latin1").strip())
                body = f"{self.ip}\n".encode()
                w.write(
                    b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: "
                    + str(len(body)).encode()
                    + b"\r\nConnection: close\r\n\r\n"
                    + body
                )
                await w.drain()
            else:
                self.requests.append(first.decode("latin1").strip())
                w.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
                await w.drain()
                await _relay(r, w)
        except (OSError, asyncio.TimeoutError):
            pass
        finally:
            try:
                w.close()
            except OSError:
                pass

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()


class FakeSocks:
    """SOCKS5 avec user/pass qui accepte n'importe quel utilisateur `rot<epoch>`.

    Tout est ensuite redirigé vers le faux serveur d'origine : aucun DNS, aucun Tor.
    """

    def __init__(self, origin_port, fail=False):
        self.origin_port = origin_port
        self.fail = fail
        self.usernames = []  # un élément par connexion
        self.targets = []  # (hôte, port) demandés
        self.server = None
        self.tasks = set()

    async def start(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0)
        return self

    @property
    def port(self):
        return self.server.sockets[0].getsockname()[1]

    async def handle(self, r, w):
        task = asyncio.current_task()
        self.tasks.add(task)
        rr = rw = None  # côté « origine », à fermer même en cas d'erreur
        try:
            ver = await r.readexactly(2)
            if ver[0] != 5:
                return
            await r.readexactly(ver[1])  # méthodes proposées
            w.write(b"\x05\x02")
            await w.drain()
            head = await r.readexactly(2)
            user = (await r.readexactly(head[1])).decode("latin1")
            await r.readexactly((await r.readexactly(1))[0])  # mot de passe
            w.write(b"\x01\x00")  # Version=1, statut=succès
            await w.drain()
            req = await r.readexactly(4)
            atyp = req[3]
            if atyp == 3:
                host = (await r.readexactly((await r.readexactly(1))[0])).decode("latin1")
            elif atyp == 1:
                host = socket.inet_ntoa(await r.readexactly(4))
            else:
                host = socket.inet_ntop(socket.AF_INET6, await r.readexactly(16))
            port = int.from_bytes(await r.readexactly(2), "big")
            self.usernames.append(user)
            self.targets.append((host, port))
            if self.fail:
                w.write(b"\x05\x01\x00\x01" + socket.inet_aton("0.0.0.0") + b"\x00\x00")
                await w.drain()
                return
            rr, rw = await asyncio.open_connection("127.0.0.1", self.origin_port)
            w.write(b"\x05\x00\x00\x01" + socket.inet_aton("127.0.0.1") + port.to_bytes(2, "big"))
            await w.drain()
            await asyncio.gather(_relay(r, rw), _relay(rr, w))
        except (OSError, asyncio.IncompleteReadError, asyncio.CancelledError):
            pass
        finally:
            self.tasks.discard(task)
            # rr est un StreamReader (pas de close) : fermer les StreamWriter
            # ferme le transport partagé côté origine.
            for sock in (rw, w):
                if sock is not None:
                    try:
                        sock.close()
                    except Exception:  # noqa: BLE001
                        pass

    async def stop(self):
        self.server.close()
        for t in list(self.tasks):  # annuler avant wait_closed() (py >= 3.12)
            t.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.server.wait_closed()


FAKE_FP_A = "A" * 40
FAKE_FP_B = "B" * 40


def canned_ns(fp, ip):
    return f"r relai{fp[:4]} {fp} DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD 2026-09-30 10:00:00 {ip} 9001 0\ns entry\nw exit\np accept"


class FakeControl:
    """Faux port de contrôle : AUTHENTICATE / SIGNAL / GETINFO / QUIT.

    `getinfo` associe une clé ("stream-status", "circuit-status", "ns/id/...")
    à son corps multi-lignes. Une clé absente => erreur 552. `delay_getinfo`
    retarde les réponses GETINFO (test du budget de /rotate).
    """

    def __init__(self, getinfo=None, delay_getinfo=0.0):
        self.commands = []
        self.getinfo = dict(getinfo or {})
        self.delay_getinfo = delay_getinfo
        self.server = None
        self.tasks = set()

    async def start(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0)
        return self

    @property
    def port(self):
        return self.server.sockets[0].getsockname()[1]

    async def handle(self, r, w):
        task = asyncio.current_task()
        self.tasks.add(task)
        try:
            buf = b""
            while b"QUIT\r\n" not in buf:
                chunk = await asyncio.wait_for(r.read(65536), 10)
                if not chunk:
                    break
                buf += chunk
            for line in buf.decode("latin1").split("\r\n"):
                if not line:
                    continue
                cmd = line.split(" ")[0].upper()
                self.commands.append(cmd)
                if cmd == "GETINFO":
                    key = line[len("GETINFO "):]
                    if key not in self.getinfo:
                        w.write(f'552 Unrecognized key "{key}"\r\n'.encode())
                    else:
                        if self.delay_getinfo:
                            await asyncio.sleep(self.delay_getinfo)
                        body = self.getinfo[key]
                        w.write(f"250+{key}=\r\n".encode() + body.encode() + b"\r\n.\r\n250 OK\r\n")
                elif cmd == "QUIT":
                    w.write(b"250 OK\r\n")
                else:  # AUTHENTICATE, SIGNAL NEWNYM...
                    w.write(b"250 OK\r\n")
            await w.drain()
        except (OSError, asyncio.TimeoutError, asyncio.CancelledError):
            pass
        finally:
            self.tasks.discard(task)
            try:
                w.close()
            except OSError:
                pass

    async def stop(self):
        self.server.close()
        # Annuler AVANT wait_closed() : Python >= 3.12 attend les tâches de
        # handler(), sinon une tâche qui dort nous bloquerait (600 s ici).
        for t in list(self.tasks):
            t.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.server.wait_closed()


class StallServer:
    """Accepte les connexions TCP et ne répond jamais (test du budget de /rotate)."""

    def __init__(self):
        self.server = None
        self.tasks = set()

    async def start(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0)
        return self

    @property
    def port(self):
        return self.server.sockets[0].getsockname()[1]

    async def handle(self, r, w):
        task = asyncio.current_task()
        self.tasks.add(task)
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            pass
        finally:
            self.tasks.discard(task)
            try:
                w.close()
            except OSError:
                pass

    async def stop(self):
        self.server.close()
        # Annuler AVANT wait_closed() : Python >= 3.12 attend les tâches de
        # handler(), sinon une tâche qui dort nous bloquerait (600 s ici).
        for t in list(self.tasks):
            t.cancel()
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.server.wait_closed()


def canned_stream_status(*lines):
    return "\n".join(lines)


def canned_circuit_status(*lines):
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Cas de test
# --------------------------------------------------------------------------- #


class ProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cookie = Path(self.tmp.name) / "cookie"
        self.cookie.write_bytes(b"\x01\x02\x03fake-cookie")

        self.origin = await OriginServer().start()
        self.socks = await FakeSocks(self.origin.port).start()
        self.control = await FakeControl().start()
        for srv in (self.origin, self.socks, self.control):
            self.addAsyncCleanup(srv.stop)

        self.cfg = tp.Config(
            port=0,  # port éphémère
            socks_port=self.socks.port,
            control_port=self.control.port,
            cookie=self.cookie,
            domains=("opencode.ai",),
            max_tunnels=64,
            idle_timeout=30.0,
            ip_echo="http://ip.echo.test/",
            connect_timeout=5.0,
            exit_ip_timeout=5.0,
        )
        self.proxy = tp.Proxy(self.cfg)
        self.addAsyncCleanup(self.proxy.stop)
        await self.proxy.start()
        self.port = self.proxy.port

    # -- helpers --

    async def aget(self, path, headers=None, timeout=10):
        """GET asynchrone : un clientbloquant gèlerait la boucle qui sert le proxy."""
        r, w = await asyncio.wait_for(asyncio.open_connection("127.0.0.1", self.port), timeout)
        req = f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n"
        for k, v in (headers or {}).items():
            req += f"{k}: {v}\r\n"
        req += "\r\n"
        w.write(req.encode())
        await w.drain()
        raw = await asyncio.wait_for(r.read(65536), timeout)
        w.close()
        head, _, body = raw.partition(b"\r\n\r\n")
        status = int(head.split(b" ")[1])
        # Corps vide (404...) : b"" in b"{[" vaut True, on compare donc à la liste.
        if body[:1] in (b"{", b"["):
            return status, json.loads(body)
        return status, body.decode(errors="replace")

    async def open_tunnel(self, host="opencode.ai", port=443, read_reply=True):
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        # Chaque test ferme ses tunnels (sinon ResourceWarning au ramassage).
        self.addCleanup(w.close)
        w.write(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}\r\n\r\n".encode())
        await w.drain()
        reply = b""
        if read_reply:
            # read() bloquerait : la connexion reste ouverte après le 200.
            reply = await asyncio.wait_for(r.readuntil(b"\r\n\r\n"), 5)
        return r, w, reply

    # -- /status --

    async def test_status(self):
        status, body = await self.aget("/status")
        self.assertEqual(status, 200)
        self.assertEqual(body["epoch"], 0)
        self.assertEqual(body["tunnels"], 0)
        self.assertEqual(body["domains"], ["opencode.ai"])
        self.assertEqual(body["socks_username"], "rot0")
        self.assertIsNone(body["exit_ip"])
        self.assertFalse(body["token_required"])
        self.assertEqual(body["version"], tp.VERSION)
        self.assertEqual(body["pid"], os.getpid())

    async def test_health_and_404_and_405(self):
        self.assertEqual((await self.aget("/health"))[0], 200)
        self.assertEqual((await self.aget("/inconnu"))[0], 404)
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        w.write(b"POST /status HTTP/1.1\r\nHost: x\r\n\r\n")
        await w.drain()
        self.assertIn(b"405", await asyncio.wait_for(r.read(1024), 5))
        w.close()

    # -- routage --

    async def test_opencode_ai_passe_par_socks(self):
        r, w, reply = await self.open_tunnel()
        self.assertIn(b"200", reply)
        await asyncio.sleep(0.15)
        self.assertEqual(self.socks.usernames, ["rot0"], "un seul passage SOCKS, utilisateur rot0")
        self.assertEqual(self.socks.targets, [("opencode.ai", 443)])
        self.assertEqual((await self.aget("/status"))[1]["tunnels"], 1)
        w.close()

    async def test_sous_domaine_passe_par_socks(self):
        r, w, reply = await self.open_tunnel("zen.opencode.ai", 443)
        self.assertIn(b"200", reply)
        await asyncio.sleep(0.15)
        self.assertEqual(self.socks.targets, [("zen.opencode.ai", 443)])
        w.close()

    async def test_autre_domaine_en_direct(self):
        r, w, reply = await self.open_tunnel("127.0.0.1", self.origin.port)
        self.assertIn(b"200", reply)
        await asyncio.sleep(0.15)
        self.assertEqual(self.socks.usernames, [], "aucun passage par Tor")
        self.assertEqual((await self.aget("/status"))[1]["tunnels"], 0, "les tunnels directs ne sont pas comptés")
        w.close()

    async def test_connexion_refusee_502(self):
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        w.write(b"CONNECT opencode.ai:443 HTTP/1.1\r\n\r\n")
        await w.drain()
        self.socks.fail = True
        reply = await asyncio.wait_for(r.read(1024), 5)
        self.assertIn(b"502", reply)
        w.close()

    async def test_connect_sans_port_400(self):
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        w.write(b"CONNECT opencode.ai HTTP/1.1\r\n\r\n")
        await w.drain()
        self.assertIn(b"400", await asyncio.wait_for(r.read(1024), 5))
        w.close()

    # -- /rotate --

    async def test_rotate_ferme_les_tunnels_et_bump_l_epoch(self):
        _r, _w, reply = await self.open_tunnel("opencode.ai", 443)
        self.assertIn(b"200", reply)
        await asyncio.sleep(0.15)
        self.assertEqual((await self.aget("/status"))[1]["tunnels"], 1)

        status, body = await self.aget("/rotate")
        self.assertEqual(status, 200)
        self.assertEqual(body["epoch"], 1)
        self.assertEqual(body["closed"], 1, "le tunnel Tor ouvert est fermé")
        self.assertEqual(body["newnym"], "ok")
        self.assertEqual(body["exit_ip"], "203.0.113.7")
        self.assertIn("SIGNAL", self.control.commands)
        self.assertIn("AUTHENTICATE", self.control.commands)
        self.assertEqual((await self.aget("/status"))[1]["tunnels"], 0)

    async def test_rotate_change_le_nom_utilisateur_socks(self):
        """C'est le `rot<epoch>` qui force un nouveau circuit, pas NEWNYM."""
        await self.open_tunnel("opencode.ai", 443)
        await asyncio.sleep(0.1)
        await self.aget("/rotate")
        await self.aget("/rotate")
        await asyncio.sleep(0.15)
        r, w, reply = await self.open_tunnel("opencode.ai", 443)
        await asyncio.sleep(0.15)
        self.assertIn(b"200", reply)
        w.close()
        # rot0 pour le premier tunnel, rot2 pour celui d'après les rotations
        # (l'écho d'IP passe aussi par SOCKS, d'où les rot1/rot2 supplémentaires).
        self.assertEqual(self.socks.usernames[0], "rot0")
        self.assertIn("rot2", self.socks.usernames, f"attendu rot2 dans {self.socks.usernames}")
        self.assertEqual((await self.aget("/status"))[1]["socks_username"], "rot2")

    async def test_rotate_sans_cookie_signale_erreur_mais_repond_200(self):
        self.cookie.unlink()
        status, body = await self.aget("/rotate")
        self.assertEqual(status, 200)
        self.assertIn("error", body["newnym"])
        self.assertEqual(body["epoch"], 1)

    async def test_exit_via_control_prioritaire_au_probe(self):
        """GETINFO stream -> circuit -> ns/id : l'écho externe n'est pas utilisé."""
        self.control.getinfo.update({
            "stream-status": canned_stream_status(
                "7 OLD 0 93.184.216.34:443",
                "8 SUCCEEDED 0 opencode.ai:443",
                "9 SUCCEEDED 4 opencode.ai:443",
            ),
            "circuit-status": canned_circuit_status(
                f"4 BUILT ${FAKE_FP_A}=r1,${FAKE_FP_B}=r2 PURPOSE=GENERAL",
            ),
            f"ns/id/{FAKE_FP_B}": canned_ns(FAKE_FP_B, "198.51.100.9"),
        })
        self.origin.requests.clear()
        status, body = await self.aget("/rotate")
        self.assertEqual(status, 200)
        self.assertEqual(body["exit_ip"], "198.51.100.9")
        self.assertEqual(body["exit_ip_source"], "control")
        self.assertEqual(self.origin.requests, [], "aucun écho externe quand le contrôle répond")
        self.assertEqual((await self.aget("/status"))[1]["exit_ip_source"], "control")

    async def test_exit_repli_probe_quand_pas_de_flux(self):
        self.control.getinfo.update({"stream-status": ""})
        status, body = await self.aget("/rotate")
        self.assertEqual(status, 200)
        self.assertEqual(body["exit_ip"], "203.0.113.7")
        self.assertEqual(body["exit_ip_source"], "probe")
        self.assertTrue(self.origin.requests, "l'écho externe a servi de repli")

    async def test_exit_dernier_relais_malforme_ignore(self):
        self.control.getinfo.update({
            "stream-status": "9 SUCCEEDED 4 opencode.ai:443",
            "circuit-status": "4 BUILT $Z grand n'importe quoi",
        })
        status, body = await self.aget("/rotate")
        self.assertEqual(status, 200)
        # repli sur l'écho : le circuit malformé ne casse pas /rotate
        self.assertEqual(body["exit_ip"], "203.0.113.7")
        self.assertEqual(body["exit_ip_source"], "probe")

    async def test_exit_ip_null_sans_bloquer_rotate(self):
        """/rotate répond dans le budget même si tout est lent (plafond 3 s)."""
        self.control.delay_getinfo = 10.0
        stall = await StallServer().start()
        self.addAsyncCleanup(stall.stop)
        self.cfg.socks_port = stall.port
        self.cfg.exit_ip_timeout = 30.0  # le plafond dur de 3 s s'applique quand même
        start = asyncio.get_running_loop().time()
        status, body = await self.aget("/rotate", timeout=15)
        elapsed = asyncio.get_running_loop().time() - start
        self.assertEqual(status, 200)
        self.assertIsNone(body["exit_ip"])
        self.assertIsNone(body["exit_ip_source"])
        self.assertLess(elapsed, 8.0, f"/rotate ne doit pas attendre l'IP ({elapsed:.1f}s)")
        self.assertGreater(elapsed, 2.0, f"le budget de 3 s doit être utilisé ({elapsed:.1f}s)")

    async def test_determine_exit_ip_budget_zero(self):
        self.cfg.exit_ip_timeout = 0
        self.assertEqual(await self.proxy.determine_exit_ip(), (None, None))

    async def test_exit_ip_desactive(self):
        self.cfg.ip_echo = ""
        status, body = await self.aget("/rotate")
        self.assertIsNone(body["exit_ip"])
        self.assertIsNone((await self.aget("/status"))[1]["exit_ip"])

    async def test_exit_ip_null_si_tor_injoignable(self):
        await self.socks.stop()
        status, body = await self.aget("/rotate")
        self.assertEqual(status, 200, "une IP de sortie illisible ne doit pas casser /rotate")
        self.assertIsNone(body["exit_ip"])
        self.assertEqual(body["epoch"], 1)

    async def test_exit_ip_null_si_schema_non_supporte(self):
        self.cfg.ip_echo = "https://ip.echo.test/"
        self.assertIsNone((await self.aget("/rotate"))[1]["exit_ip"])

    async def test_status_expose_derniere_ip_connue(self):
        await self.aget("/rotate")
        self.assertEqual((await self.aget("/status"))[1]["exit_ip"], "203.0.113.7")

    # -- token --

    async def test_token_exige_pour_rotate(self):
        token = Path(self.tmp.name) / "token"
        token.write_text("s3cret\n")
        self.cfg.token_file = token

        self.assertEqual((await self.aget("/rotate"))[0], 403, "sans token")
        self.assertEqual((await self.aget("/rotate?token=mauvais"))[0], 403, "mauvais token")
        self.assertEqual((await self.aget("/status"))[0], 200, "/status reste public")
        status, body = await self.aget("/rotate", {"X-Tor-Rotate-Token": "s3cret"})
        self.assertEqual(status, 200)
        self.assertEqual(body["epoch"], 1)
        self.assertEqual((await self.aget("/rotate?token=s3cret"))[1]["epoch"], 2, "token en query string")

    async def test_token_fichier_illisible_refuse(self):
        self.cfg.token_file = Path(self.tmp.name) / "absent"
        self.assertEqual((await self.aget("/rotate"))[0], 403)

    # -- garde-fous --

    async def test_plafond_de_tunnels(self):
        self.cfg.max_tunnels = 1
        _r, _w, reply = await self.open_tunnel("opencode.ai", 443)
        self.assertIn(b"200", reply)
        await asyncio.sleep(0.1)
        self.assertEqual((await self.aget("/status"))[1]["tunnels"], 1)
        r, w, reply = await self.open_tunnel("opencode.ai", 443)
        self.assertIn(b"503", reply)
        w.close()
        self.assertEqual((await self.aget("/status"))[1]["tunnels"], 1, "le tunnel vivant n'est pas tué")

    async def test_inactivite_ferme_le_tunnel(self):
        self.cfg.idle_timeout = 0.3
        r, w, reply = await self.open_tunnel("opencode.ai", 443)
        self.assertIn(b"200", reply)
        self.assertEqual((await self.aget("/status"))[1]["tunnels"], 1)
        for _ in range(40):  # <= 4 s
            if (await self.aget("/status"))[1]["tunnels"] == 0:
                break
            await asyncio.sleep(0.1)
        self.assertEqual((await self.aget("/status"))[1]["tunnels"], 0, "le tunnel inactif doit être fermé")
        data = await asyncio.wait_for(r.read(10), 5)
        self.assertEqual(data, b"", "le client voit la fermeture")
        w.close()

    async def test_tunnel_libere_a_la_rotation_puis_reutilisable(self):
        self.cfg.max_tunnels = 1
        _r, _w, reply = await self.open_tunnel("opencode.ai", 443)
        self.assertIn(b"200", reply)
        await asyncio.sleep(0.1)
        await self.aget("/rotate")
        r, w, reply = await self.open_tunnel("opencode.ai", 443)
        self.assertIn(b"200", reply, "un nouveau tunnel est possible après rotation")
        w.close()

    # -- pidfile / arrêt --

    async def test_pidfile_ecrit_puis_retire(self):
        pidfile = Path(self.tmp.name) / "proxy.pid"
        self.cfg.pidfile = pidfile
        self.proxy.write_pidfile()
        self.assertEqual(pidfile.read_text().strip(), str(os.getpid()))
        await self.proxy.stop()
        self.assertFalse(pidfile.exists(), "le pidfile est retiré à l'arrêt propre")

    async def test_stop_ferme_les_tunnels(self):
        _r, _w, reply = await self.open_tunnel("opencode.ai", 443)
        self.assertIn(b"200", reply)
        await asyncio.sleep(0.1)
        self.assertEqual(len(self.proxy.tunnels), 1)
        await self.proxy.stop()
        self.assertEqual(len(self.proxy.tunnels), 0)


class SigtermTests(unittest.TestCase):
    """Arrêt propre sur SIGTERM (vrai sous-processus, vrai signal)."""

    def test_sigterm_arret_propre_et_pidfile_retire(self):
        with tempfile.TemporaryDirectory() as tmp:
            pidfile = Path(tmp) / "proxy.pid"
            proc = subprocess.Popen(
                [
                    sys.executable,
                    str(PROXY_PATH),
                    "--port", "0",
                    "--socks-port", "1",  # aucun Tor : le proxy démarre quand même
                    "--control-port", "1",
                    "--pidfile", str(pidfile),
                    "--ip-echo", "off",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
            )
            try:
                deadline = time.time() + 20
                line = ""
                while time.time() < deadline and "sur 127.0.0.1" not in line:
                    line = proc.stdout.readline()
                    if not line:
                        break
                self.assertIn("sur 127.0.0.1", line, f"démarrage: {line!r}")
                self.assertTrue(pidfile.exists(), "pidfile écrit")
                self.assertEqual(pidfile.read_text().strip(), str(proc.pid))
                proc.send_signal(signal.SIGTERM)
                out, _ = proc.communicate(timeout=20)
            finally:
                if proc.poll() is None:
                    proc.kill()
            self.assertEqual(proc.returncode, 0, out)
            self.assertIn("arrêt propre", out)
            self.assertIn("bye", out)
            self.assertFalse(pidfile.exists(), "pidfile retiré")
            port = int(line.rsplit(":", 1)[1].split()[0])
            with self.assertRaises(ConnectionRefusedError):
                socket.create_connection(("127.0.0.1", port), timeout=2).close()


class ConfigTests(unittest.TestCase):
    def test_defauts(self):
        c = tp.parse_args([], env={})
        self.assertEqual(c.port, 9253)
        self.assertEqual(c.socks_port, 9250)
        self.assertEqual(c.control_port, 9251)
        self.assertEqual(c.domains, ("opencode.ai",))
        self.assertEqual(c.idle_timeout, 600.0)
        self.assertEqual(c.max_tunnels, 64)
        self.assertEqual(c.ip_echo, tp.DEFAULT_IP_ECHO)
        self.assertIsNone(c.pidfile)
        self.assertIsNone(c.token_file)
        self.assertFalse(c.verbose)

    def test_env_ignore(self):
        c = tp.parse_args([], env={
            "TOR_PROXY_PORT": "1111",
            "TOR_SOCKS_PORT": "2222",
            "TOR_CONTROL_PORT": "3333",
            "TOR_DOMAINS": "OpenCode.AI, zen.example.com ,",
            "TOR_PROXY_VERBOSE": "1",
            "TOR_PROXY_PIDFILE": "/tmp/x.pid",
            "TOR_PROXY_MAX_TUNNELS": "3",
            "TOR_PROXY_IDLE_TIMEOUT": "12",
            "TOR_IP_ECHO": "off",
            "TOR_ROTATE_TOKEN": "/tmp/tok",
        })
        self.assertEqual(c.port, 1111)
        self.assertEqual(c.socks_port, 2222)
        self.assertEqual(c.control_port, 3333)
        self.assertEqual(c.domains, ("opencode.ai", "zen.example.com"))
        self.assertTrue(c.verbose)
        self.assertEqual(str(c.pidfile), "/tmp/x.pid")
        self.assertEqual(c.max_tunnels, 3)
        self.assertEqual(c.idle_timeout, 12.0)
        self.assertEqual(c.ip_echo, "")
        self.assertEqual(str(c.token_file), "/tmp/tok")

    def test_flags_prioritaires_sur_env(self):
        c = tp.parse_args(
            ["--port", "9999", "--socks-port", "8888", "--domains", "a.test,b.test", "--verbose"],
            env={"TOR_PROXY_PORT": "1111", "TOR_SOCKS_PORT": "2222", "TOR_DOMAINS": "c.test"},
        )
        self.assertEqual(c.port, 9999)
        self.assertEqual(c.socks_port, 8888)
        self.assertEqual(c.domains, ("a.test", "b.test"))
        self.assertTrue(c.verbose)

    def test_valeurs_invalides_ignorées(self):
        c = tp.parse_args(["--port", "nope", "--max-tunnels", "-4", "--idle-timeout", "0"], env={})
        self.assertEqual(c.port, 9253)
        self.assertEqual(c.max_tunnels, 64)
        self.assertEqual(c.idle_timeout, 600.0)

    def test_domaine_avec_mot_sauvage(self):
        c = tp.parse_args(["--domains", "*.opencode.ai"], env={})
        self.assertEqual(c.domains, ("opencode.ai",))

    def test_nom_utilisateur_socks(self):
        c = tp.parse_args([], env={})
        self.assertEqual(c.socks_username(0), "rot0")
        self.assertEqual(c.socks_username(7), "rot7")


class ParserTests(unittest.TestCase):
    STREAMS = (
        "1 SUCCEEDED 0 opencode.ai:443\n"
        "2 NEW 0 opencode.ai:443\n"
        "3 SUCCEEDED 5 93.184.216.34:443\n"
        "4 SUCCEEDED 6 zen.opencode.ai:443\n"
    )

    def test_pick_stream_prefere_le_domaine(self):
        cid = tp.pick_stream_circuit(self.STREAMS, "opencode.ai", ("opencode.ai",))
        self.assertEqual(cid, "6", "le flux vers le sous-domaine, le plus récent, gagne")

    def test_pick_stream_ignore_sans_circuit_et_non_succeeded(self):
        cid = tp.pick_stream_circuit("1 NEW 0 opencode.ai:443\n2 SUCCEEDED 0 x.test:443", "opencode.ai", ("opencode.ai",))
        self.assertIsNone(cid)

    def test_pick_stream_repli_plus_recent(self):
        # Tor affiche l'IP résolue : aucun domaine ne correspond, on prend le
        # flux établi le plus récent (souvent notre propre sonde).
        cid = tp.pick_stream_circuit(self.STREAMS, "opencode.ai", ("autre.test",))
        self.assertEqual(cid, "6")

    def test_pick_stream_vide(self):
        self.assertIsNone(tp.pick_stream_circuit("", "opencode.ai", ("opencode.ai",)))
        self.assertIsNone(tp.pick_stream_circuit("n'importe quoi\n", "opencode.ai", ("opencode.ai",)))

    def test_circuit_exit_fp(self):
        body = f"7 BUILT ${FAKE_FP_A}=r1,${FAKE_FP_B}=r2 PURPOSE=GENERAL\n8 BUILT ${FAKE_FP_A}=r1"
        self.assertEqual(tp.circuit_exit_fp(body, "7"), FAKE_FP_B)
        self.assertEqual(tp.circuit_exit_fp(body, "8"), FAKE_FP_A)
        self.assertIsNone(tp.circuit_exit_fp(body, "9"))
        self.assertIsNone(tp.circuit_exit_fp("7 BUILT pas-un-chemin", "7"))
        self.assertIsNone(tp.circuit_exit_fp("7 BUILT $TROP-COURT=r1", "7"))

    def test_ns_ip(self):
        body = canned_ns(FAKE_FP_B, "198.51.100.9")
        self.assertEqual(tp.ns_ip(body, FAKE_FP_B), "198.51.100.9")
        self.assertEqual(tp.ns_ip(body, FAKE_FP_B.lower()), "198.51.100.9")
        self.assertIsNone(tp.ns_ip(body, FAKE_FP_A))
        self.assertIsNone(tp.ns_ip("pas de ligne r\n", FAKE_FP_B))


class ControlGetinfoTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cookie = Path(self.tmp.name) / "cookie"
        self.cookie.write_bytes(b"\x01\x02cookie")

    def cfg_for(self, control):
        return tp.Config(control_port=control.port, cookie=self.cookie)

    async def test_getinfo_multiples_cles(self):
        control = await FakeControl(getinfo={
            "stream-status": "9 SUCCEEDED 4 opencode.ai:443",
            "circuit-status": "4 BUILT $%s=r" % FAKE_FP_A,
        }).start()
        self.addAsyncCleanup(control.stop)
        proxy = tp.Proxy(self.cfg_for(control))
        info = await proxy.control_getinfo("stream-status", "circuit-status")
        self.assertEqual(info["stream-status"], "9 SUCCEEDED 4 opencode.ai:443")
        self.assertIn(FAKE_FP_A, info["circuit-status"])
        self.assertNotIn("ns/id/xyz", info)

    async def test_getinfo_cle_inconnue_absente(self):
        control = await FakeControl(getinfo={}).start()
        self.addAsyncCleanup(control.stop)
        cfg = tp.Config(control_port=control.port, cookie=Path("/inexistant"))
        proxy = tp.Proxy(self.cfg_for(control))
        self.assertEqual(await proxy.control_getinfo("stream-status"), {})


class HelperTests(unittest.TestCase):
    def test_parse_headers(self):
        head = b"GET /rotate?token=x HTTP/1.1\r\nHost: 127.0.0.1:9253\r\nX-Tor-Rotate-Token: abc\r\n\r\n"
        h = tp.parse_headers(head)
        self.assertEqual(h["host"], "127.0.0.1:9253")
        self.assertEqual(h["x-tor-rotate-token"], "abc")
        self.assertEqual(tp.parse_headers(b"GET / HTTP/1.1\r\n\r\n"), {})


if __name__ == "__main__":
    unittest.main()
