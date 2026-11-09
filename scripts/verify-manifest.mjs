#!/usr/bin/env node
/**
 * Manifest gate: the plugin's three sources of truth must agree.
 *
 *   1. package.json        — identity, exports, engines, peer ranges;
 *   2. cordis.patch.yml    — the bundle patch that inserts the plugin;
 *   3. locale/{en,zh}.json — display metadata incl. meta.detail documents.
 *
 * A DSH plugin fails at install time (or worse, renders an empty page) when
 * these drift: patch id different from package name, locale key missing in one
 * language, meta.detail pointing at a document that is not shipped. This gate
 * catches all three before a release. Keep it pure: repository files only.
 *
 * Usage: node scripts/verify-manifest.mjs
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const errors = [];
const fail = (message) => errors.push(message);
const read = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8");

const packageJson = JSON.parse(read("package.json"));

// --- package identity -------------------------------------------------------
if (packageJson.name !== "dsh-connect-scnet-plus") fail(`package.json: unexpected name ${packageJson.name}`);
if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  fail(`package.json: version is not semver: ${packageJson.version}`);
}
if (packageJson.license !== "MIT") fail(`package.json: expected MIT license, got ${packageJson.license}`);
if (!existsSync(join(ROOT, "LICENSE"))) fail("LICENSE: missing");
else if (!/\bMIT License\b/.test(read("LICENSE"))) fail("LICENSE: does not look like an MIT license");
if (typeof packageJson.engines?.node !== "string" || !packageJson.engines.node.includes("22.19.0")) {
  fail("package.json: engines.node must declare the supported 22.19+ / 24+ range");
}
if (packageJson.type !== "module") fail("package.json: type must be module (ESM plugin)");

// --- exports / bin / bundle patch ------------------------------------------
for (const [label, target] of [
  ["main", packageJson.main],
  ["bin", packageJson.bin?.["dsh-connect-scnet-plus"]]
]) {
  if (typeof target !== "string" || !existsSync(join(ROOT, target))) fail(`package.json: ${label} target missing (${target})`);
}
const requiredExports = { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" };
for (const [subpath, target] of Object.entries(requiredExports)) {
  if (packageJson.exports?.[subpath] !== target) fail(`package.json: exports["${subpath}"] must be ${target}`);
}
if (packageJson.dsh?.bundle?.patch !== "./cordis.patch.yml") fail("package.json: dsh.bundle.patch must be ./cordis.patch.yml");
if (!Array.isArray(packageJson.dsh?.client?.inject) || packageJson.dsh.client.inject.length === 0) {
  fail("package.json: dsh.client.inject must list the host client packages");
}

// --- cordis patch -----------------------------------------------------------
const patch = read("cordis.patch.yml");
if (!/^- insert:/m.test(patch)) fail("cordis.patch.yml: must start with an `- insert:` entry");
if (!new RegExp(`^\\s+- id: ${packageJson.name}$`, "m").test(patch)) fail(`cordis.patch.yml: missing id: ${packageJson.name}`);
if (!new RegExp(`^\\s+name: ${packageJson.name}$`, "m").test(patch)) fail(`cordis.patch.yml: missing name: ${packageJson.name}`);
if (/modelSwitches/.test(patch)) fail("cordis.patch.yml: modelSwitches must not be persisted in the patch (it blanks the picker when stale)");

// --- locale parity ----------------------------------------------------------
function flatten(value, prefix = "") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flatten(child, prefix === "" ? key : `${prefix}.${key}`));
}

const locales = {};
for (const language of ["en", "zh"]) {
  const path = `locale/${language}.json`;
  if (!existsSync(join(ROOT, path))) {
    fail(`${path}: missing`);
    continue;
  }
  try {
    locales[language] = JSON.parse(read(path));
  } catch (error) {
    fail(`${path}: invalid JSON (${error.message})`);
  }
}
if (locales.en !== undefined && locales.zh !== undefined) {
  const englishKeys = flatten(locales.en).sort();
  const chineseKeys = flatten(locales.zh).sort();
  const missingInChinese = englishKeys.filter((key) => !chineseKeys.includes(key));
  const missingInEnglish = chineseKeys.filter((key) => !englishKeys.includes(key));
  if (missingInChinese.length > 0) fail(`locale/zh.json: missing keys ${missingInChinese.join(", ")}`);
  if (missingInEnglish.length > 0) fail(`locale/en.json: missing keys ${missingInEnglish.join(", ")}`);
}

for (const language of ["en", "zh"]) {
  const meta = locales[language]?.meta;
  if (meta === undefined) {
    fail(`locale/${language}.json: meta is required`);
    continue;
  }
  for (const key of ["title", "description", "detail"]) {
    if (typeof meta[key] !== "string" || meta[key].trim() === "") fail(`locale/${language}.json: meta.${key} must be a non-empty string`);
  }
  if (typeof meta.detail === "string" && !existsSync(join(ROOT, meta.detail))) {
    fail(`locale/${language}.json: meta.detail points at a missing document (${meta.detail})`);
  }
  if (language === "zh" && typeof meta.detail === "string" && !meta.detail.endsWith(".zh.md")) {
    fail(`locale/zh.json: meta.detail should point at the Chinese document (${meta.detail})`);
  }
}

// --- release notes / version sync ------------------------------------------
const releaseNotes = read("RELEASE_NOTES.md");
if (!releaseNotes.includes(`# dsh-connect-scnet-plus ${packageJson.version} `)) {
  fail(`RELEASE_NOTES.md: missing heading for the current version ${packageJson.version}`);
}

// --- generated artifacts must never be committed ---------------------------
const gitignore = read(".gitignore");
for (const pattern of ["node_modules/", "*.tgz", "gate-report.json"]) {
  if (!gitignore.includes(pattern)) fail(`.gitignore: must ignore ${pattern}`);
}
if (!existsSync(join(ROOT, "package-lock.json"))) {
  fail("package-lock.json: missing (CI installs with `npm ci`, which requires it)");
}

if (errors.length > 0) {
  for (const error of errors) console.error("FAIL", error);
  console.error(`\n${errors.length} manifest error(s)`);
  process.exit(1);
}
console.log(`PASS manifest: ${packageJson.name}@${packageJson.version}, patch + ${Object.keys(locales).length} locales in sync`);
