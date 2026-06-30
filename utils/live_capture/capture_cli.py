"""
Command-line entry to capture a live sector into a capture file.

Examples:
    # Attach to an already-running SwimServer (or one started by SSG):
    python -m utils.live_capture.capture_cli --facility ZTL --sector 2 \
        --window 1800 --kml "C:/.../AllSectors.kml" --out ztl2.capture.json

    # Let SSG launch SwimServer using stored SFDPS credentials, warm up 60s:
    python -m utils.live_capture.capture_cli --facility ZTL --sector 2 \
        --start-server --warmup 60 --window 1800 --out ztl2.capture.json

The capture file feeds the Phase-4 LiveReplayScenario.
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

logger = logging.getLogger("ssg.live_capture")


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Capture a live sector from SwimServer into a capture file.")
    p.add_argument("--facility", required=True, help="ARTCC id, e.g. ZTL")
    p.add_argument("--sector", default=None,
                   help="Sector id, e.g. 2. Omit (or 'ALL') to capture every sector in the facility.")
    p.add_argument("--window", type=int, default=1800, help="Capture window in seconds (default 1800 = 30 min)")
    p.add_argument("--out", required=True, help="Output capture file path")
    p.add_argument("--kml", help="Path to AllSectors KML for the geometry fallback / boundary")
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=5001)
    p.add_argument("--start-server", action="store_true",
                   help="Launch SwimServer via SSG (uses stored SFDPS credentials)")
    p.add_argument("--warmup", type=int, default=0,
                   help="Seconds to let the flight map fill after the server is ready, "
                        "before the capture window starts (improves the t=0 baseline)")
    p.add_argument("--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
    )

    facility_wide = not args.sector or args.sector.upper() == "ALL"

    # KML boundary (geometry fallback). Defaults to the bundled AllSectors.kml.
    kml = args.kml
    if not kml:
        try:
            from ssg_bridge import resource_path
            cand = resource_path("airport_data", "AllSectors.kml")
            kml = str(cand) if cand.exists() else None
        except Exception:  # noqa: BLE001
            kml = None

    boundary = None
    boundary_name = None
    if kml:
        from parsers.kml_parser import parse_sectors_kml
        index = parse_sectors_kml(kml)
        boundary_name = Path(kml).name
        if facility_wide:
            boundary = index.sectors_for(args.facility) or None
            logger.info(f"Facility-wide capture: {len(boundary or [])} sector polygons for {args.facility}")
        else:
            boundary = index.get(args.facility, args.sector)
            if boundary is None:
                logger.warning(f"Sector {args.facility}/{args.sector} not in KML; ownership-only membership")

    # Optionally launch/await SwimServer.
    manager = None
    if args.start_server:
        from utils.live_capture import CredentialStore, SwimServerManager
        creds = CredentialStore().load()
        manager = SwimServerManager(creds, host=args.host, port=args.port)
        manager.start()  # reuses an already-running instance if reachable
        if not manager.wait_until_ready(timeout=90):
            logger.error("SwimServer did not become ready; aborting.")
            return 2
        if args.warmup > 0:
            logger.info(f"Warming up {args.warmup}s to let the flight map fill...")
            time.sleep(args.warmup)

    from utils.live_capture.swim_ws import SwimCaptureClient

    client = SwimCaptureClient(
        facility=args.facility, sector=args.sector,
        host=args.host, port=args.port,
        boundary=boundary, boundary_kml_name=boundary_name,
    )

    def progress(elapsed, total, n, sectors):
        pct = 100.0 * elapsed / total if total else 0
        sys.stderr.write(
            f"\r  capturing… {int(elapsed)}/{total}s ({pct:4.1f}%)  recorded={n}  sectors={sectors}   "
        )
        sys.stderr.flush()

    try:
        result = client.capture(args.window, progress_callback=progress)
    finally:
        sys.stderr.write("\n")
        if manager is not None:
            manager.stop()

    out = result.write(args.out)
    print(f"Captured {len(result.aircraft)} aircraft -> {out}")
    print(f"Diagnostics: {result.diagnostics}")
    if not result.aircraft:
        print(
            "No aircraft captured. If 'seenSectorsTop' shows your sector under a "
            "different id format, adjust --sector to match, or supply --kml for "
            "geometry fallback.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
