#!/usr/bin/env node
/**
 * Ensures every file listed in package.json `bin` starts with a Node shebang.
 *
 * TypeScript strips comments from the compiled output when a triple-slash
 * directive is not used, and the MCP stdio entry may also be invoked
 * directly. Running this after `tsc` guarantees npm creates working
 * symlinks in the user's global bin directory after `npm i -g devbrain-mcp`.
 */
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SHEBANG = "#!/usr/bin/env node\n";

const __filename = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(__filename), "..");
const pkg = JSON.parse(
  readFileSync(resolve(projectRoot, "package.json"), "utf-8"),
);

const binEntries = Object.values(pkg.bin ?? {});
// Also shebang the main MCP stdio entry so it can be chmod +x'd and invoked
// directly without `node <path>` prefix.
const mainEntry = pkg.main;
const targets = [...new Set([...binEntries, mainEntry].filter(Boolean))];

let patched = 0;
for (const rel of targets) {
  const abs = resolve(projectRoot, rel);
  if (!existsSync(abs)) {
    console.warn(`[add-shebang] skip missing: ${rel}`);
    continue;
  }
  const content = readFileSync(abs, "utf-8");
  if (content.startsWith("#!")) {
    // Already shebanged; still ensure executable bit.
    try {
      chmodSync(abs, 0o755);
    } catch {
      // ignore chmod errors on non-unix systems
    }
    continue;
  }
  writeFileSync(abs, SHEBANG + content, "utf-8");
  try {
    chmodSync(abs, 0o755);
  } catch {
    // ignore chmod errors on non-unix systems
  }
  patched++;
  console.log(`[add-shebang] patched ${rel}`);
}

console.log(`[add-shebang] done (${patched} file(s) patched)`);
