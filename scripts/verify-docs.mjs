#!/usr/bin/env node
/**
 * Documentation gate: links, anchors, fence balance, bilingual pairing and
 * size budgets — the parts of "docs are code" that DeepSeek Harness enforces
 * with scripts/verify-md-links.ts and scripts/verify-doc-budgets.ts.
 *
 * Design notes:
 * - No network. External links are counted, not fetched: CI must stay
 *   deterministic (a dead third-party site must not fail the build).
 * - Anchors are resolved against the heading slugs of the target file, so a
 *   renamed section breaks the gate instead of shipping a dead link.
 * - Paired docs (English + Chinese) must keep the same heading count; that is
 *   the cheapest guard against translating half a document.
 *
 * Usage: node scripts/verify-docs.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Lines are cheap; two screens on pkg readme, one on the detail page. */
const BUDGETS = new Map([
  ["README.md", 170],
  ["docs/detail.md", 40],
  ["docs/detail.zh.md", 40],
  ["docs/AUTOMATION.md", 220],
  ["docs/AUTOMATION.zh.md", 220]
]);

/** Documents that must exist in both languages and stay structurally paired. */
const PAIRS = [
  ["docs/detail.md", "docs/detail.zh.md"],
  ["docs/AUTOMATION.md", "docs/AUTOMATION.zh.md"]
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".github", "dist", "coverage"]);

const errors = [];
const fail = (message) => errors.push(message);

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      files.push(join(dir, entry.name));
    }
  }
}

const files = [];
walk(ROOT);

/** Minimal GitHub-style heading slug (good enough for this repository's docs). */
function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*~]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Blank out fenced code blocks: links and anchors inside examples are not links. */
function stripFences(markdown) {
  let fence = null;
  return markdown
    .split("\n")
    .map((line) => {
      const match = /^\s{0,3}(```+|~~~+)/.exec(line);
      if (match !== null) {
        if (fence === null) fence = match[1][0];
        else if (match[1][0] === fence) fence = null;
        return "";
      }
      return fence === null ? line : "";
    })
    .join("\n");
}

function headingSlugs(markdown) {
  const slugs = new Set();
  let fence = null;
  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (fenceMatch !== null) {
      if (fence === null) fence = fenceMatch[1][0];
      else if (fenceMatch[1][0] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) slugs.add(slug(heading[1]));
  }
  return slugs;
}

function checkFences(relativePath, markdown) {
  let open = null;
  let lineNumber = 0;
  for (const line of markdown.split("\n")) {
    lineNumber += 1;
    const match = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (match === null) continue;
    if (open === null) open = { marker: match[1][0], line: lineNumber };
    else if (match[1][0] === open.marker) open = null;
  }
  if (open !== null) fail(`${relativePath}: unclosed code fence opened at line ${open.line}`);
}

const LINK_PATTERN = /(!?\[[^\]]*\]\()([^)]+)(\))/g;
const REFERENCE_PATTERN = /^\s{0,3}\[[^\]]+\]:\s*(\S+)\s*$/gm;
const HTML_ANCHOR_PATTERN = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;

function linksIn(markdown) {
  const found = [];
  for (const line of markdown.split("\n")) {
    let match;
    LINK_PATTERN.lastIndex = 0;
    while ((match = LINK_PATTERN.exec(line)) !== null) found.push(match[2].trim());
  }
  let ref;
  REFERENCE_PATTERN.lastIndex = 0;
  while ((ref = REFERENCE_PATTERN.exec(markdown)) !== null) found.push(ref[1].trim());
  let anchor;
  HTML_ANCHOR_PATTERN.lastIndex = 0;
  while ((anchor = HTML_ANCHOR_PATTERN.exec(markdown)) !== null) found.push(anchor[1].trim());
  return found;
}

const slugCache = new Map();
function slugsOf(absolutePath) {
  if (!slugCache.has(absolutePath)) slugCache.set(absolutePath, headingSlugs(readFileSync(absolutePath, "utf8")));
  return slugCache.get(absolutePath);
}

let linkCount = 0;
let externalCount = 0;

for (const absolutePath of files) {
  const relativePath = relative(ROOT, absolutePath).split("\\").join("/");
  const markdown = readFileSync(absolutePath, "utf8");
  checkFences(relativePath, markdown);

  const budget = BUDGETS.get(relativePath);
  if (budget !== undefined) {
    const lines = markdown.split("\n").length;
    if (lines > budget) fail(`${relativePath}: ${lines} lines exceeds budget ${budget}`);
  }

  for (const rawLink of linksIn(stripFences(markdown))) {
    linkCount += 1;
    const target = rawLink.replace(/^<|>$/g, "");
    if (/^(https?:|mailto:|data:|tel:)/i.test(target)) {
      externalCount += 1;
      continue;
    }
    if (target.startsWith("#")) {
      const anchor = target.slice(1);
      if (anchor !== "" && !slugsOf(absolutePath).has(anchor)) fail(`${relativePath}: missing anchor #${anchor}`);
      continue;
    }
    if (target === "") continue;
    const [pathPart, anchorPart] = target.split("#");
    const decoded = decodeURIComponent(pathPart);
    const targetPath = resolve(dirname(absolutePath), decoded);
    let stats;
    try {
      stats = statSync(targetPath);
    } catch {
      fail(`${relativePath}: broken link ${target}`);
      continue;
    }
    if (anchorPart !== undefined && anchorPart !== "" && stats.isFile() && extname(targetPath) === ".md") {
      const anchor = decodeURIComponent(anchorPart);
      if (!slugsOf(targetPath).has(anchor)) fail(`${relativePath}: missing anchor ${target}`);
    }
  }
}

for (const [english, chinese] of PAIRS) {
  const englishPath = join(ROOT, english);
  const chinesePath = join(ROOT, chinese);
  let englishText;
  let chineseText;
  try {
    englishText = readFileSync(englishPath, "utf8");
    chineseText = readFileSync(chinesePath, "utf8");
  } catch {
    fail(`pairing: both ${english} and ${chinese} must exist`);
    continue;
  }
  const englishHeadings = headingSlugs(englishText).size;
  const chineseHeadings = headingSlugs(chineseText).size;
  if (englishHeadings !== chineseHeadings) {
    fail(`pairing: ${english} has ${englishHeadings} headings, ${chinese} has ${chineseHeadings}`);
  }
  if (chineseText.trim().length === 0) fail(`pairing: ${chinese} is empty`);
}

if (errors.length > 0) {
  for (const error of errors) console.error("FAIL", error);
  console.error(`\n${errors.length} documentation error(s)`);
  process.exit(1);
}
console.log(`PASS docs: ${files.length} markdown files, ${linkCount} links (${externalCount} external, not fetched), paired docs in sync`);
