# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the SSG Python bridge (ssg_bridge.exe).

Builds a one-file console exe bundling the scenario generators + the live-SWIM
capture/replay code. Dynamic-ish imports (lazy `from x import y` inside
functions, keyring backends) are listed explicitly so they survive packaging.

Built by electron-app/scripts/build-bridge.mjs (`npm run build:bridge`) and the
GitHub Actions release workflow.
"""
import os
from PyInstaller.utils.hooks import collect_submodules

# --- bundled data (fallback copies; resource_path prefers the outer resources/) ---
datas = [
    ('config.json', '.'),
    ('utils/artcc_boundaries.geojson', 'utils'),
]
for f in os.listdir('airport_data'):
    if f.endswith('.geojson') or f == 'FAACIFP18' or f == 'AllSectors.kml':
        datas.append((os.path.join('airport_data', f), 'airport_data'))

# --- hidden imports: packages PyInstaller's static scan can miss ---
hiddenimports = []
for pkg in ('utils.live_capture', 'utils.data_pipeline', 'scenarios', 'parsers', 'models', 'generators'):
    hiddenimports += collect_submodules(pkg)
hiddenimports += [
    'websocket',            # websocket-client (live capture)
    'diskcache',
    'ulid',
    'requests',
    # keyring backends are loaded dynamically; bundle the Windows one (others
    # are harmless if absent — credential storage falls back to file).
    'keyring.backends.Windows',
    'keyring.backends.chainer',
    'keyring.backends.fail',
]

a = Analysis(
    ['ssg_bridge.py'],
    pathex=['.'],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'PyQt5', 'PyQt6', 'matplotlib'],
    noarchive=False,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='ssg_bridge',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
