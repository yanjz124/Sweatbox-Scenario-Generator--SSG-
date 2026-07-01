#!/usr/bin/env node
/**
 * Build a self-contained SwimServer.exe (the user's SwimReader project) and
 * stage it for electron-builder. SSG launches this at runtime to pull live
 * FAA SWIM data for the live-replay capture feature.
 *
 * The SwimReader source lives in a SEPARATE repo. Point at it with
 * SWIMREADER_ROOT; defaults to a sibling `../SwimReader` of this repo.
 *
 *     SWIMREADER_ROOT=C:/path/to/SwimReader npm run build:swimserver
 *
 * Output: <repo-root>/dist/swimserver/SwimServer.exe  (+ its self-contained
 * runtime files). electron-builder copies this whole dir to
 * resources/swimserver/ (see electron-builder.yml), where the bridge's
 * resource_path('swimserver', 'SwimServer.exe') resolves it.
 *
 * The ERAM scope's KML video maps (AllSectors.kml, etc.) ride along: SwimServer's
 * csproj copies them next to the exe on publish and resolves them from the app base
 * dir, so the map works in this bundled build (no .git-anchored repo root here).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const swimRoot =
  process.env.SWIMREADER_ROOT || path.resolve(repoRoot, '..', 'SwimReader');
const project = path.join(swimRoot, 'tools', 'SwimServer', 'SwimServer.csproj');
const outDir = path.join(repoRoot, 'dist', 'swimserver');

if (!existsSync(project)) {
  console.error(
    `[build-swimserver] SwimServer project not found: ${project}\n` +
      `Set SWIMREADER_ROOT to your SwimReader checkout.`,
  );
  process.exit(1);
}

console.log(`[build-swimserver] publishing ${project} -> ${outDir}`);

const args = [
  'publish',
  project,
  '-c',
  'Release',
  '-r',
  'win-x64',
  '--self-contained',
  'true',
  '-p:PublishSingleFile=true',
  '-p:IncludeNativeLibrariesForSelfExtract=true',
  '-o',
  outDir,
];

const proc = spawn('dotnet', args, { cwd: swimRoot, stdio: 'inherit' });

proc.on('error', err => {
  console.error(`[build-swimserver] failed to start dotnet: ${err.message}`);
  process.exit(1);
});
proc.on('exit', code => {
  if (code !== 0) {
    console.error(`[build-swimserver] dotnet publish exited ${code}`);
    process.exit(code ?? 1);
  }
  const exe = path.join(outDir, 'SwimServer.exe');
  if (!existsSync(exe)) {
    console.error(`[build-swimserver] expected output missing: ${exe}`);
    process.exit(1);
  }
  console.log(`[build-swimserver] done: ${exe}`);
});
