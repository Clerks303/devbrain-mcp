#!/usr/bin/env node
/**
 * Copies the plain-JS Claude Code hook scripts into dist/ after `tsc`.
 *
 * The hooks in src/hooks/*.js are intentionally dependency-free JavaScript
 * (they run standalone under `node` from ~/.devbrain/hooks), so tsc never
 * compiles them. But the npm tarball only ships `dist/**`, and
 * `devbrain-install-hooks` resolves hook sources from dist/src/hooks first
 * — without this copy step the installer only works from a git checkout.
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), "..");
const src = resolve(projectRoot, "src", "hooks");
const dest = resolve(projectRoot, "dist", "src", "hooks");

if (!existsSync(src)) {
  console.error(`[copy-hooks] missing source directory: ${src}`);
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-hooks] copied src/hooks -> dist/src/hooks`);
