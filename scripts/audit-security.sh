#!/usr/bin/env bash
# Grep-style security audit of the contract source (plan: Security-sentinel results, Phase 2).
# Usage: scripts/audit-security.sh [ROOT]   (default: <repo>/contract/src)
# Rules (each violation prints "VIOLATION <rule>: <file>:<line> <why>"; exit 1 if any):
#   S1  the string literal "sign" appears exactly once; sign_promise has exactly 2 call sites
#   S2  every `pub fn ... &mut self` in a #[near]/#[near_bindgen] impl is #[private] or owner/relayer/delegate
#       gated; the gate must sit at the top level of the fn body (not in a nested block such as `if false {}`).
#       A tree with zero such impl blocks fails.
#   S3  every `pub fn on_*` is #[private]
#   S4  propose_payment / propose_evm: no Promise::new( / ::ext( / sign_promise( before the LAST open_reservation(
#   S7  no 64-hex literal and no ed25519:<80+ base58> literal
#   S8  no #[payable] / #[near_sdk::payable] except the allowlist below
# Heuristic limits: S2 is textual (a top-level gate call/comparison is trusted, its logic is not evaluated);
# S4 is intra-function (a promise built by a helper called before open_reservation( is not seen).
# Everything from the first `#[cfg(test)]` in a file onward, and files named tests.rs, are ignored.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:-$SCRIPT_DIR/../contract/src}"
[ -d "$ROOT" ] || { echo "audit-security: not a directory: $ROOT" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "audit-security: node is required" >&2; exit 2; }

# S2 exceptions: "fn_name:reason". Initially empty; real code needed none.
S2_EXCEPTIONS=""
# S8 allowlist: "fn_name:reason".
PAYABLE_ALLOW=""

AUDIT_ROOT="$ROOT" AUDIT_S2_EXC="$S2_EXCEPTIONS" AUDIT_PAYABLE_ALLOW="$PAYABLE_ALLOW" node -e '
const fs = require("fs"), path = require("path");
const root = process.env.AUDIT_ROOT;
const names = (s) => s.split(" ").filter(Boolean).map((x) => x.split(":")[0]);
const s2Exc = new Set(names(process.env.AUDIT_S2_EXC || ""));
const payAllow = new Set(names(process.env.AUDIT_PAYABLE_ALLOW || ""));
const viol = [];
const v = (rule, f, line, msg) => viol.push(`VIOLATION ${rule}: ${path.relative(root, f) || f}:${line} ${msg}`);

function walk(d) {
  let out = [];
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out = out.concat(walk(p));
    else if (e.name.endsWith(".rs") && e.name !== "tests.rs") out.push(p);
  }
  return out.sort();
}
// Blank comments (keeps strings and all offsets/newlines). With blankStr, string contents are blanked too.
function scrub(src, blankStr) {
  let o = "", i = 0, n = src.length;
  const keep = (c) => (c === "\n" ? "\n" : " ");
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") { o += " "; i++; } }
    else if (c === "/" && d === "*") {
      let depth = 0;
      while (i < n) {
        if (src[i] === "/" && src[i + 1] === "*") { depth++; o += "  "; i += 2; }
        else if (src[i] === "*" && src[i + 1] === "/") { depth--; o += "  "; i += 2; if (!depth) break; }
        else { o += keep(src[i]); i++; }
      }
    } else if (c === "\"") {
      o += c; i++;
      while (i < n && src[i] !== "\"") {
        if (src[i] === "\\") { o += blankStr ? "  " : src.substr(i, 2); i += 2; continue; }
        o += blankStr ? keep(src[i]) : src[i]; i++;
      }
      if (i < n) { o += "\""; i++; }
    } else { o += c; i++; }
  }
  return o;
}
const lineOf = (s, idx) => s.slice(0, idx).split("\n").length;
function match(s, open, idx) { // idx at opening bracket; returns index of its closer or -1
  const close = open === "{" ? "}" : ")";
  let d = 0;
  for (let i = idx; i < s.length; i++) {
    if (s[i] === open) d++;
    else if (s[i] === close && --d === 0) return i;
  }
  return -1;
}

// Body text with every nested {...} block blanked, so only depth-1 statements remain (dead-code gates drop out).
function topLevel(body) {
  let o = "", d = 0;
  for (const c of body) {
    if (c === "{") { d++; o += d === 1 ? c : " "; }
    else if (c === "}") { o += d === 1 ? c : " "; d--; }
    else o += d > 1 && c !== "\n" ? " " : c;
  }
  return o;
}

const files = walk(root).map((f) => {
  let raw = fs.readFileSync(f, "utf8");
  const t = raw.search(/^[ \t]*#\[cfg\(test\)\]/m);
  if (t >= 0) raw = raw.slice(0, t);
  return { f, lit: scrub(raw, false), code: scrub(raw, true) };
});
if (!files.length) { console.error("audit-security: no .rs files under " + root); process.exit(2); }

// S1
let signSites = [], promiseCalls = [];
for (const { f, lit, code } of files) {
  for (const m of lit.matchAll(/"sign"/g)) signSites.push([f, lineOf(lit, m.index)]);
  for (const m of code.matchAll(/\bsign_promise\s*\(/g)) {
    if (/\bfn\s+$/.test(code.slice(Math.max(0, m.index - 6), m.index))) continue;
    promiseCalls.push([f, lineOf(code, m.index)]);
  }
}
if (signSites.length !== 1) {
  const at = signSites.map(([f, l]) => `${path.relative(root, f)}:${l}`).join(", ");
  v("S1", root, 0, `the string "sign" must appear exactly once, found ${signSites.length}${at ? " (" + at + ")" : ""}`);
}
if (promiseCalls.length !== 2) {
  const at = promiseCalls.map(([f, l]) => `${path.relative(root, f)}:${l}`).join(", ");
  v("S1", root, 0, `sign_promise must have exactly 2 call sites, found ${promiseCalls.length}${at ? " (" + at + ")" : ""}`);
}

const gate = /assert_owner\s*\(|assert_owner_or_relayer\s*\(|assert_delegate_authorized\s*\(|predecessor_account_id\s*\(\s*\)\s*==\s*self\.owner|\b(caller|predecessor|sender)\s*==\s*self\.owner|self\.owner\s*==\s*(caller|predecessor|sender|\&)/;
let nearImpls = 0;
const fnRe = /\bpub\s+fn\s+(\w+)\s*(<[^>(]*>)?\s*\(/g;
for (const { f, code } of files) {
  // #[near] impl blocks
  for (const im of code.matchAll(/#\[\s*(?:near_sdk\s*::\s*)?(?:near_bindgen|near)\s*(?:\([^)]*\))?\s*\]\s*impl\b[^{]*\{/g)) {
    nearImpls++;
    const bo = im.index + im[0].length - 1, bc = match(code, "{", bo);
    if (bc < 0) continue;
    const block = code.slice(bo, bc + 1);
    for (const fm of block.matchAll(fnRe)) {
      const name = fm[1], at = bo + fm.index;
      const po = at + fm[0].length - 1, pc = match(code, "(", po);
      if (pc < 0) continue;
      const params = code.slice(po, pc + 1);
      const bs = code.indexOf("{", pc), semi = code.indexOf(";", pc);
      if (bs < 0 || (semi >= 0 && semi < bs)) continue;
      const be = match(code, "{", bs);
      const body = code.slice(bs, be + 1);
      // attribute block: text back to the previous item boundary
      let k = at - 1;
      while (k > bo && !"{};".includes(code[k])) k--;
      const attrs = code.slice(k + 1, at);
      const priv = /#\[\s*private\s*\]/.test(attrs);
      const line = lineOf(code, at);
      if (/&\s*mut\s+self\b/.test(params) && !priv && !gate.test(topLevel(body)) && !s2Exc.has(name))
        v("S2", f, line, `pub fn ${name}(&mut self) is not #[private] and has no owner/relayer/delegate gate`);
      if (/^on_/.test(name) && !priv) v("S3", f, line, `callback ${name} lacks #[private]`);
    }
  }
  // on_* callbacks anywhere (outside #[near] impl too)
  // S8 payable
  for (const pm of code.matchAll(/#\[\s*(?:near_sdk\s*::\s*)?payable\s*\]/g)) {
    const rest = code.slice(pm.index + pm[0].length);
    const fn = (rest.match(/\bfn\s+(\w+)/) || [])[1] || "?";
    if (!payAllow.has(fn)) v("S8", f, lineOf(code, pm.index), `#[payable] on ${fn} is not in the allowlist`);
  }
}
if (!nearImpls) v("S2", root, 0, "zero #[near] / #[near_bindgen] impl blocks found (S2/S3 scanned nothing; attribute renamed?)");
// S3 for pub fn on_* outside #[near] impl blocks is not meaningful (not callable), skipped.

// S4
for (const target of ["propose_payment", "propose_evm"]) {
  let found = false;
  for (const { f, code } of files) {
    const re = new RegExp("\\bfn\\s+" + target + "\\b[^({]*(\\(|<)", "g");
    for (const m of code.matchAll(re)) {
      const po = code.indexOf("(", m.index);
      const pc = match(code, "(", po);
      const bs = code.indexOf("{", pc);
      const be = match(code, "{", bs);
      if (pc < 0 || bs < 0 || be < 0) continue;
      found = true;
      const body = code.slice(bs, be + 1);
      const r = body.lastIndexOf("open_reservation(");
      const line = lineOf(code, m.index);
      if (r < 0) { v("S4", f, line, `${target} never calls open_reservation(`); continue; }
      const bad = /Promise::new\s*\(|::ext\s*\(|\bsign_promise\s*\(/.exec(body.slice(0, r));
      if (bad) v("S4", f, lineOf(code, bs + bad.index), `${target}: "${bad[0]}" appears before the last open_reservation(`);
    }
  }
  if (!found) v("S4", root, 0, `function ${target} not found (renamed? update the audit)`);
}

// S7
for (const { f, lit } of files) {
  for (const m of lit.matchAll(/"[^"\n]*"/g)) {
    const s = m[0];
    if (/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(s)) v("S7", f, lineOf(lit, m.index), "64-hex literal looks like a secret/key");
    if (/ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/.test(s)) v("S7", f, lineOf(lit, m.index), "ed25519 secret-key-looking literal");
  }
}

if (viol.length) { console.error(viol.join("\n")); console.error(`audit-security: FAILED (${viol.length} violation(s))`); process.exit(1); }
console.log(`audit-security: OK (${files.length} files under ${root})`);
'
