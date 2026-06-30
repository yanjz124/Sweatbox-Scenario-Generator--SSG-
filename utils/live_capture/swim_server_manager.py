"""
Launch and supervise the bundled SwimReader ``SwimServer`` process.

SSG owns the local stack: it injects the user's SFDPS credentials as
environment variables, starts ``SwimServer.exe`` (which connects to FAA SWIM and
serves flight data on http://localhost:5001), waits for it to become reachable,
and stops it when capture is done.

Executable resolution order:
  1. ``SSG_SWIMSERVER_EXE`` env var (explicit override / dev).
  2. Bundled resource ``swimserver/SwimServer.exe`` via ``ssg_bridge.resource_path``
     (self-contained publish shipped with releases).
  3. ``dotnet`` + a configured project/dll path (dev fallback).
"""
from __future__ import annotations

import logging
import os
import subprocess
import time
from pathlib import Path
from typing import Optional

import requests

from utils.live_capture.swim_credentials import SwimCredentials

logger = logging.getLogger(__name__)

DEFAULT_HOST = "localhost"
DEFAULT_PORT = 5001


def _pid_file() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    d = Path(base) / "SSG"
    d.mkdir(parents=True, exist_ok=True)
    return d / "swimserver.pid"


def stop_persistent() -> bool:
    """Kill a detached SwimServer started by a previous bridge `connect` call
    (tracked via the PID file). Returns True if a process was signalled."""
    pf = _pid_file()
    if not pf.exists():
        return False
    try:
        pid = int(pf.read_text().strip())
    except (ValueError, OSError):
        pf.unlink(missing_ok=True)
        return False
    killed = False
    try:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                       capture_output=True, timeout=10)
        killed = True
    except Exception:  # noqa: BLE001
        try:
            os.kill(pid, 9)
            killed = True
        except OSError:
            killed = False
    pf.unlink(missing_ok=True)
    logger.info(f"stop_persistent: pid {pid} killed={killed}")
    return killed


class SwimServerManager:
    """Manages the lifecycle of a local SwimServer instance."""

    def __init__(self, credentials: SwimCredentials,
                 host: str = DEFAULT_HOST, port: int = DEFAULT_PORT,
                 exe_path: Optional[str] = None,
                 work_dir: Optional[str] = None):
        self.credentials = credentials
        self.host = host
        self.port = port
        self._exe_override = exe_path
        self._work_dir = Path(work_dir) if work_dir else None
        self._proc: Optional[subprocess.Popen] = None

    @property
    def base_url(self) -> str:
        return f"http://{self.host}:{self.port}"

    # ── executable resolution ────────────────────────────────────────────────
    def resolve_executable(self) -> Optional[list]:
        """Return the command (argv list) to launch SwimServer, or None if it
        can't be located. A list so the ``dotnet <dll>`` form works too."""
        if self._exe_override:
            return [self._exe_override]

        env_exe = os.environ.get("SSG_SWIMSERVER_EXE")
        if env_exe and Path(env_exe).exists():
            return [env_exe]

        # Bundled self-contained publish (packaged: <install>/resources/swimserver/).
        try:
            from ssg_bridge import resource_path
            bundled = resource_path("swimserver", "SwimServer.exe")
            if bundled.exists():
                return [str(bundled)]
        except Exception as e:  # noqa: BLE001
            logger.debug(f"resource_path lookup failed: {e}")

        # Dev: the build:swimserver script publishes to <repo>/dist/swimserver/.
        try:
            from ssg_bridge import REPO_ROOT
            dev = Path(REPO_ROOT) / "dist" / "swimserver" / "SwimServer.exe"
            if dev.exists():
                return [str(dev)]
        except Exception as e:  # noqa: BLE001
            logger.debug(f"dev swimserver lookup failed: {e}")

        # Dev fallback: `dotnet <dll>` if a project DLL path is provided.
        env_dll = os.environ.get("SSG_SWIMSERVER_DLL")
        if env_dll and Path(env_dll).exists():
            return ["dotnet", env_dll]

        logger.error(
            "Could not locate SwimServer executable. Set SSG_SWIMSERVER_EXE, "
            "bundle swimserver/SwimServer.exe, or set SSG_SWIMSERVER_DLL for dev."
        )
        return None

    def _data_dir(self) -> Path:
        """Writable working dir for SwimServer's persistence files."""
        if self._work_dir:
            self._work_dir.mkdir(parents=True, exist_ok=True)
            return self._work_dir
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        d = Path(base) / "SSG" / "swimserver"
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ── lifecycle ─────────────────────────────────────────────────────────────
    def is_reachable(self, timeout: float = 2.0) -> bool:
        """True if an HTTP server is answering on the SwimServer port."""
        try:
            r = requests.get(f"{self.base_url}/api/stats", timeout=timeout)
            return r.status_code == 200
        except requests.RequestException:
            return False

    def start(self, reuse_existing: bool = True, detached: bool = False) -> None:
        """Start SwimServer (unless one is already reachable).

        Args:
            reuse_existing: if a SwimServer is already answering on the port,
                attach to it instead of spawning a duplicate.
            detached: spawn so the process survives this (short-lived) bridge
                invocation, and record its PID for later ``stop_persistent``.
                Used by the "Connect" flow to keep the server warm.
        """
        if reuse_existing and self.is_reachable():
            logger.info(f"SwimServer already reachable at {self.base_url}; reusing it")
            return

        if not self.credentials.is_complete():
            raise ValueError(
                "SWIM credentials are incomplete. Set SFDPS user, password, and "
                "queue before starting SwimServer."
            )

        cmd = self.resolve_executable()
        if not cmd:
            raise FileNotFoundError("SwimServer executable not found (see logs).")

        env = dict(os.environ)
        env.update(self.credentials.to_env())

        # Run with cwd = the exe's own directory so ASP.NET's content root
        # resolves the published `wwwroot` (otherwise WebRootPath is null and
        # SwimServer throws at startup). `cmd[-1]` is the exe (or the .dll for
        # the `dotnet <dll>` dev form).
        exe_path = Path(cmd[-1]).resolve()
        work_dir = exe_path.parent if exe_path.exists() else self._data_dir()
        logger.info(f"Starting SwimServer: {cmd[0]} (cwd={work_dir}, detached={detached})")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        if detached:
            # Detach so the child outlives this bridge process (warm server).
            flags |= getattr(subprocess, "DETACHED_PROCESS", 0)
        # SwimServer is a console/web app; discard its stdio so it doesn't spam
        # the console.
        self._proc = subprocess.Popen(
            cmd,
            cwd=str(work_dir),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=flags,
        )
        if detached:
            try:
                _pid_file().write_text(str(self._proc.pid))
            except OSError as e:
                logger.warning(f"Could not write SwimServer PID file: {e}")

    def wait_until_ready(self, timeout: float = 60.0, poll: float = 1.0) -> bool:
        """Block until the HTTP server answers, or ``timeout`` elapses.

        Returns True if ready. Note: "ready" means the web server is up — the
        SWIM flight map fills over the following seconds/minutes as messages
        arrive, so callers that need a warm map should additionally wait for a
        non-empty snapshot (handled by the capture client).
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._proc is not None and self._proc.poll() is not None:
                raise RuntimeError(
                    f"SwimServer exited early with code {self._proc.returncode}. "
                    f"Check SWIM credentials and connectivity."
                )
            if self.is_reachable():
                logger.info(f"SwimServer ready at {self.base_url}")
                return True
            time.sleep(poll)
        logger.error(f"SwimServer did not become ready within {timeout}s")
        return False

    def is_running(self) -> bool:
        """True if we spawned a process that is still alive."""
        return self._proc is not None and self._proc.poll() is None

    def stop(self, timeout: float = 10.0) -> None:
        """Terminate the SwimServer process we started (no-op if we attached to
        an externally-run instance)."""
        if self._proc is None:
            return
        if self._proc.poll() is not None:
            self._proc = None
            return
        logger.info("Stopping SwimServer...")
        self._proc.terminate()
        try:
            self._proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            logger.warning("SwimServer did not stop gracefully; killing")
            self._proc.kill()
            self._proc.wait()
        self._proc = None

    # Context-manager sugar so callers can `with SwimServerManager(...) as m:`
    def __enter__(self) -> "SwimServerManager":
        self.start()
        self.wait_until_ready()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.stop()
