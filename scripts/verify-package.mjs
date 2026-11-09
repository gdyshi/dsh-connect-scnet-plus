#!/usr/bin/env node
/**
 * Package gate: what `npm pack` would actually ship must be what the plugin
 * needs at install time — and nothing else (no scripts, no CI, no research).
 *
 * The tarball is the release artifact people install with
 * `dsh plugin add file:...tgz`, so `files` in package.json and the exports map
 * are load-bearing. This gate asks npm itself (`npm pack --dry-run --json`)
 * instead of re-implementing its file-selection rules.
 *
 * Runs without `npm install`; needs only the npm CLI that ships with Node.
 *
 * Usage: node scripts/verify-package.mjs
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const errors = [];
const fail = (message) => errors.push(message);
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// --- exports map must point at real files ----------------------------------
const exportTargets = new Map();
for (const [subpath, target] of Object.entries(packageJson.exports ?? {})) {
  if (typeof target === "string" && !target.includes("*")) exportTargets.set(subpath, target);
}
exportTargets.set("main", packageJson.main);
exportTargets.set("bin", packageJson.bin?.["dsh-connect-scnet-plus"]);
for (const [label, target] of exportTargets) {
  if (typeof target !== "string" || !existsSync(join(ROOT, target))) fail(`package.json: ${label} -> ${target} does not exist`);
}

// --- dependency policy ------------------------------------------------------
const dependencies = packageJson.dependencies ?? {};
const runtimeNames = Object.keys(dependencies);
if (runtimeNames.length === 0) fail("package.json: expected at least the schemastery runtime dependency");
for (const [name, range] of Object.entries(dependencies)) {
  if (typeof range !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(range)) {
    fail(`package.json: dependency ${name} must be pinned to an exact version (got ${range})`);
  }
}
for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-llm-pi-ai", "@earendil-works/pi-ai"]) {
  if (typeof packageJson.peerDependencies?.[name] !== "string") fail(`package.json: peerDependencies.${name} is required`);
}
if (packageJson.peerDependenciesMeta?.["@earendil-works/pi-ai"]?.optional !== true) {
  fail("package.json: @earendil-works/pi-ai must stay an optional peer (host may bundle it)");
}
if (packageJson.private === true) fail("package.json: must not be private (the plugin is distributed)");

// --- files whitelist must cover the shipped surface ------------------------
const files = packageJson.files;
if (!Array.isArray(files) || files.length === 0) fail("package.json: files whitelist is required");
else {
  for (const entry of files) {
    const cleaned = entry.replace(/^\.\//, "").replace(/\/$/, "");
    if (!existsSync(join(ROOT, cleaned))) fail(`package.json: files entry ${entry} does not exist`);
  }
  for (const required of ["lib", "locale", "docs", "cordis.patch.yml"]) {
    const covered = files.some((entry) => {
      const cleaned = entry.replace(/^\.\//, "").replace(/\/$/, "");
      return cleaned === required || cleaned.startsWith(`${required}/`) || (required.endsWith(".yml") && cleaned === required);
    });
    if (!covered) fail(`package.json: files whitelist must ship ${required}`);
  }
  if (files.includes("scripts") || files.some((entry) => entry.startsWith("scripts/"))) fail("package.json: scripts must not be shipped");
}

/** Run npm pack --dry-run in a shell so stdout can be redirected to a file. */
function packFileList() {
  const workDir = mkdtempSync(join(tmpdir(), "scnet-pack-"));
  const output = join(workDir, "pack.json");
  const cache = join(workDir, "npm-cache");
  const command = [
    "npm pack --dry-run --json --ignore-scripts --no-audit --no-fund --loglevel=error",
    `--cache "${cache}"`,
    `> "${output}"`
  ].join(" ");
  return new Promise((resolvePromise) => {
    const child = spawn(command, { cwd: ROOT, shell: true, stdio: "inherit", timeout: 110_000 });
    child.on("exit", (code) => {
      if (code !== 0) {
        fail(`npm pack --dry-run failed with exit code ${code}`);
        resolvePromise(undefined);
        return;
      }
      try {
        // npm >= 11 prints an object keyed by package name; npm 10 prints an
        // array. Windows shells may redirect as UTF-16, so honor the BOM.
        const raw = readFileSync(output);
        let text;
        if (raw[0] === 0xff && raw[1] === 0xfe) text = raw.toString("utf16le");
        else if (raw[0] === 0xfe && raw[1] === 0xff) text = Buffer.from(raw.subarray(2)).swap16().toString("utf16le");
        else text = raw.toString("utf8");
        text = text.replace(/^\uFEFF/, "").trim();
        const parsed = JSON.parse(text);
        const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
        resolvePromise(entry);
      } catch (error) {
        fail(`npm pack: cannot parse output (${error.message})`);
        resolvePromise(undefined);
      }
    });
  });
}

const packed = await packFileList();
if (packed === undefined) {
  fail("npm pack: no package entry in the output; the tarball was not verified");
} else {
  const filename = `${packageJson.name}-${packageJson.version}.tgz`;
  if (typeof packed.filename !== "string") fail("npm pack: output has no filename");
  else if (packed.filename !== filename) fail(`npm pack: expected ${filename}, got ${packed.filename}`);
  if (!Array.isArray(packed.files) || packed.files.length === 0) {
    fail("npm pack: output has no files array; refusing to report a green tarball");
  } else {
    const shipped = new Set(packed.files.map((file) => file.path.replace(/^\.\//, "")));
    // Every runtime lib module is required, derived from disk: adding a module
    // can never silently drop it from the tarball contract.
    const runtimeLibFiles = readdirSync(join(ROOT, "lib"))
      .filter((name) => name.endsWith(".js"))
      .map((name) => `lib/${name}`)
      .sort();
    const required = [
      "package.json",
      "README.md",
      "LICENSE",
      "cordis.patch.yml",
      ...runtimeLibFiles,
      "locale/en.json",
      "locale/zh.json",
      "docs/detail.md",
      "docs/detail.zh.md",
      "docs/TECHNICAL.md",
      "docs/AUTOMATION.md",
      "docs/AUTOMATION.zh.md"
    ];
    for (const path of required) if (!shipped.has(path)) fail(`npm pack: ${path} is missing from the tarball`);
    for (const path of shipped) {
      if (/^(scripts\/|\.github\/|node_modules\/|research\/|AGENTS\.md$)/.test(path)) fail(`npm pack: build-only file ${path} must not ship`);
      if (/\.(tgz|log)$/.test(path) || path.startsWith(".gate-report")) fail(`npm pack: stray artifact ${path} must not ship`);
    }
    console.log(`pack: ${shipped.size} files, ${(packed.size ?? 0)} bytes`);
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error("FAIL", error);
  console.error(`\n${errors.length} packaging error(s)`);
  process.exit(1);
}
console.log(`PASS package: ${packageJson.name}@${packageJson.version} exports, deps and tarball contents are consistent`);
