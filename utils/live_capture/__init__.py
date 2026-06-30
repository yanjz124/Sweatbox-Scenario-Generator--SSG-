"""
Live SWIM sector-capture / replay support.

This package integrates SSG with the user's SwimReader project: it launches and
supervises the bundled ``SwimServer`` process (fed by FAA SWIM), captures live
traffic in a chosen enroute sector over a time window, and turns that capture
into a vNAS replay scenario.

Modules:
  - swim_credentials   : store/load the SFDPS credentials SwimServer needs.
  - swim_server_manager: locate, launch, health-check and stop SwimServer.
  - swim_ws            : (Phase 3) WebSocket capture client → capture file.
"""
from utils.live_capture.swim_credentials import SwimCredentials, CredentialStore
from utils.live_capture.swim_server_manager import SwimServerManager, stop_persistent

__all__ = ["SwimCredentials", "CredentialStore", "SwimServerManager", "stop_persistent"]
