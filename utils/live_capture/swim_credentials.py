"""
SWIM (SFDPS) credential storage for the live-capture feature.

For enroute sector capture SSG only needs the **SFDPS** feed that powers
SwimReader's SwimServer (port 5001). The user supplies three secrets — user,
password, queue — while host/VPN have working FAA defaults. These are injected
as environment variables into the SwimServer subprocess (see
``swim_server_manager``); SwimServer reads them via ``SFDPS_*`` env vars
(tools/SwimServer/Program.cs).

Storage strategy (dependency-light, upgrades gracefully):
  - Non-secret fields (user, queue, host, vpn) live in a JSON config under the
    per-user app-data dir (``%LOCALAPPDATA%/SSG/swim_credentials.json``).
  - The password is stored in the OS keyring (Windows Credential Manager) when
    the optional ``keyring`` package is importable; otherwise it falls back to
    the same JSON file with a logged warning.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Optional secure backend. Absent in minimal installs; we degrade to file
# storage rather than hard-failing.
try:
    import keyring  # type: ignore
    _KEYRING_AVAILABLE = True
except Exception:  # noqa: BLE001 - any import/backend error means "no keyring"
    keyring = None  # type: ignore
    _KEYRING_AVAILABLE = False

_KEYRING_SERVICE = "SSG-SWIM-SFDPS"
_KEYRING_USERNAME = "sfdps-password"

# FAA defaults that almost never change — keep them out of the user's way.
DEFAULT_SFDPS_HOST = "tcps://ems2.swim.faa.gov:55443"
DEFAULT_SFDPS_VPN = "FDPS"


def _app_data_dir() -> Path:
    """Per-user writable config dir, created on demand."""
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    d = Path(base) / "SSG"
    d.mkdir(parents=True, exist_ok=True)
    return d


@dataclass
class SwimCredentials:
    """The SFDPS connection settings SwimServer needs."""
    user: str = ""
    password: str = ""
    queue: str = ""
    host: str = DEFAULT_SFDPS_HOST
    vpn: str = DEFAULT_SFDPS_VPN

    def is_complete(self) -> bool:
        """True when the three required secrets are all present."""
        return bool(self.user.strip() and self.password.strip() and self.queue.strip())

    def to_env(self) -> dict:
        """Render as the ``SFDPS_*`` environment variables SwimServer reads."""
        return {
            "SFDPS_HOST": self.host or DEFAULT_SFDPS_HOST,
            "SFDPS_VPN": self.vpn or DEFAULT_SFDPS_VPN,
            "SFDPS_USER": self.user,
            "SFDPS_PASS": self.password,
            "SFDPS_QUEUE": self.queue,
        }


class CredentialStore:
    """Load/save :class:`SwimCredentials`, keeping the password out of plaintext
    when an OS keyring is available."""

    def __init__(self, config_path: Optional[Path] = None):
        self.config_path = Path(config_path) if config_path else (_app_data_dir() / "swim_credentials.json")

    # ── load ────────────────────────────────────────────────────────────────
    def load(self) -> SwimCredentials:
        creds = SwimCredentials()
        if self.config_path.exists():
            try:
                data = json.loads(self.config_path.read_text("utf-8"))
            except Exception as e:  # noqa: BLE001
                logger.warning(f"Failed to read SWIM credentials file: {e}")
                data = {}
            creds.user = data.get("user", "")
            creds.queue = data.get("queue", "")
            creds.host = data.get("host", DEFAULT_SFDPS_HOST)
            creds.vpn = data.get("vpn", DEFAULT_SFDPS_VPN)
            # Password may live in the file (fallback path) or keyring.
            file_pass = data.get("password", "")
            if file_pass:
                creds.password = file_pass

        if _KEYRING_AVAILABLE and not creds.password:
            try:
                kp = keyring.get_password(_KEYRING_SERVICE, _KEYRING_USERNAME)
                if kp:
                    creds.password = kp
            except Exception as e:  # noqa: BLE001
                logger.warning(f"keyring read failed, password unavailable: {e}")

        return creds

    # ── save ────────────────────────────────────────────────────────────────
    def save(self, creds: SwimCredentials) -> None:
        payload = {
            "user": creds.user,
            "queue": creds.queue,
            "host": creds.host or DEFAULT_SFDPS_HOST,
            "vpn": creds.vpn or DEFAULT_SFDPS_VPN,
        }

        stored_in_keyring = False
        if _KEYRING_AVAILABLE:
            try:
                keyring.set_password(_KEYRING_SERVICE, _KEYRING_USERNAME, creds.password or "")
                stored_in_keyring = True
            except Exception as e:  # noqa: BLE001
                logger.warning(f"keyring write failed, falling back to file storage: {e}")

        if not stored_in_keyring:
            logger.warning(
                "Storing SWIM password in plaintext config (no OS keyring "
                "available). Install the 'keyring' package for secure storage."
            )
            payload["password"] = creds.password or ""

        tmp = self.config_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.config_path)
        logger.info(
            f"Saved SWIM credentials to {self.config_path} "
            f"(password in {'keyring' if stored_in_keyring else 'file'})"
        )

    def clear(self) -> None:
        """Remove stored credentials (file + keyring password)."""
        if _KEYRING_AVAILABLE:
            try:
                keyring.delete_password(_KEYRING_SERVICE, _KEYRING_USERNAME)
            except Exception:  # noqa: BLE001
                pass
        if self.config_path.exists():
            try:
                self.config_path.unlink()
            except OSError as e:
                logger.warning(f"Failed to delete credentials file: {e}")
