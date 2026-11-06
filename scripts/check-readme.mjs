#!/usr/bin/env node
// Fail if README.md names something that does not exist: a `make` target, a `scripts/` file, or a relative link.
// The README is the judge's instruction sheet; a command that does not exist is worse than none.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const makefile = fs.readFileSync(path.join(root, "Makefile"), "utf8");
const problems = [];

// Makefile targets: "name:" or "name1 name2:" at line start, plus the .PHONY list.
const targets = new Set();
for (const m of makefile.matchAll(/^([A-Za-z0-9_.-]+(?:\s+[A-Za-z0-9_.-]+)*)\s*:(?!=)/gm)) {
  for (const t of m[1].split(/\s+/)) targets.add(t);
}
for (const m of makefile.matchAll(/\.PHONY:([^\n]*(?:\\\n[^\n]*)*)/g)) {
  for (const t of m[1].replace(/\\\n/g, " ").split(/\s+/).filter(Boolean)) targets.add(t);
}

for (const m of readme.matchAll(/`([^`\n]+)`/g)) {
  const span = m[1];
  for (const mk of span.matchAll(/\bmake\s+((?:[a-z][a-z0-9-]*\s*)+)/g)) {
    for (const t of mk[1].trim().split(/\s+/)) {
      if (!targets.has(t)) problems.push(`make target not in Makefile: ${t}  (in \`${span}\`)`);
    }
  }
  for (const sc of span.matchAll(/(?:^|\s|\.\/)(scripts\/[A-Za-z0-9_.-]+)/g)) {
    if (!fs.existsSync(path.join(root, sc[1]))) problems.push(`missing script: ${sc[1]}  (in \`${span}\`)`);
  }
}

for (const m of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
  const href = m[1].split("#")[0];
  if (!href || /^[a-z]+:/i.test(href)) continue;
  if (!fs.existsSync(path.join(root, href))) problems.push(`broken relative link: ${href}`);
}

if (problems.length) {
  for (const p of problems) console.error("check-readme:", p);
  process.exit(1);
}
console.log(`check-readme: OK (${targets.size} make targets known)`);
