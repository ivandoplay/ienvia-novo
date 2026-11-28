#!/usr/bin/env node
import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const GENERATED = new Set(['.arena','.cache','.local','.mypy_cache','.next','.nox','.npm','.nuxt','.output','.parcel-cache','.playwright-cli','.pytest_cache','.ruff_cache','.svelte-kit','.tox','.turbo','.venv','.vite','__pycache__','build','coverage','dist','node_modules','out','target']);
export async function measure(root) {
  let bytes = 0, files = 0;
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!GENERATED.has(e.name)) await walk(p); }
      else if (e.isFile()) { bytes += (await lstat(p)).size; files++; }
    }
  }
  await walk(root);
  return { bytes, files, megabytes: +(bytes / 1_000_000).toFixed(2), maxBytes: 128_000_000, maxFiles: 10_000, ok: bytes <= 128_000_000 && files <= 10_000 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] || process.cwd());
  const result = await measure(root);
  console.log(JSON.stringify({ root, ...result }, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
