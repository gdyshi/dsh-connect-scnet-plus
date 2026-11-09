#!/usr/bin/env node
/**
 * Syntax gate: every shipped source file must parse, and every relative import
 * must point at a real file.
 *
 * Parse-only on purpose. The previous version `import()`-ed each module, which
 * executes top-level code — a "syntax check" that could start the loopback
 * shim or read ~/.sclaw, and that swallowed missing host peers as "parse-ok".
 * `node --check` respects package.json `"type": "module"`, never executes the
 * file, and runs identically in CI and locally.
 *
 * Both halves are checked: lib/*.js (shipped plugin code) and scripts/*.mjs
 * (gates and tests), so a typo in a test that this run does not select cannot
 * hide until someone runs that gate.
 *
 * Usage: node scripts/check-syntax.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TARGETS = [
  { dir: "lib", extensions: [".js"] },
  { dir: "scripts", extensions: [".mjs"] }
];
/** `from "..."`, `import "..."`, `export … from "..."`, `import("...")`. */
const RELATIVE_IMPORT = /(?:from\s*|import\s*\(?\s*)["'](\.{1,2}\/[^"']+)["']/g;

let failed = 0;
let checked = 0;
let importsResolved = 0;

function parseWithNode(absolutePath) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ["--check", absolutePath], { cwd: ROOT, stdio: "inherit" });
    child.on("error", () => resolvePromise(false));
    child.on("exit", (code) => resolvePromise(code === 0));
  });
}

/** Resolve a relative specifier the way Node would for these extensions. */
function resolves(absoluteBase, specifier) {
  const candidate = resolve(dirname(absoluteBase), specifier);
  if (existsSync(candidate)) return true;
  for (const suffix of [".js", ".mjs", ".json"]) {
    if (existsSync(candidate + suffix)) return true;
  }
  return existsSync(join(candidate, "index.js"));
}

async function main() {
  for (const { dir, extensions } of TARGETS) {
    const directory = join(ROOT, dir);
    if (!existsSync(directory)) continue;
    const files = readdirSync(directory)
      .filter((name) => extensions.includes(name.slice(name.lastIndexOf("."))))
      .sort();
    for (const name of files) {
      const relativePath = `${dir}/${name}`;
      const absolutePath = join(directory, name);
      checked += 1;
      const parsed = await parseWithNode(absolutePath);
      if (!parsed) {
        failed += 1;
        console.error(`FAIL ${relativePath}: does not parse`);
        continue;
      }
      const source = readFileSync(absolutePath, "utf8");
      let match;
      RELATIVE_IMPORT.lastIndex = 0;
      while ((match = RELATIVE_IMPORT.exec(source)) !== null) {
        importsResolved += 1;
        if (!resolves(absolutePath, match[1])) {
          failed += 1;
          console.error(`FAIL ${relativePath}: unresolved relative import ${match[1]}`);
        }
      }
      console.log("ok   ", relativePath);
    }
  }
  if (failed > 0) {
    console.error(`\n${failed} syntax/import error(s)`);
    process.exit(1);
  }
  console.log(`PASS syntax: ${checked} files parsed, ${importsResolved - failed} relative imports resolved`);
}

await main();
