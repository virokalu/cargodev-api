// A static scan for Prisma calls whose OWN where clause does not name org_id. Used by tests/org-scoped-writes.test.ts.
//
// It reads every .ts file under src/ (recursively, so a new file is covered with no change here), finds each call on a table
// client (`tx.user.updateMany(`, `getPrisma().faq.findMany(`, `db.brand.update(`...), extracts the call's `where` expression and
// requires org_id as a TOP-LEVEL key of it: `where: { id, org_id: x }`. A nested org_id (inside a relation filter such as
// `activityLogs: { some: { org_id } }`) does not count, and neither does `org_id` as the tail of a value (`user.org_id`).
//
// Accepted without a top-level org_id, because there is no org to filter on or it is scoped another way:
//   - a credential lookup keyed by a secret the caller must hold (tokenHash, expoPushToken);
//   - the compound unique keys that contain org_id (org_id_prefix, org_id_email);
//   - photos and documents (no org column), which must be scoped through the vehicle: `vehicle: { org_id }`;
//   - a where that is not an object literal (a ternary of literals): org_id must then appear in it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const WRITE_METHODS = ["update", "updateMany", "delete", "deleteMany", "upsert"] as const;
export const READ_METHODS = ["findMany", "findFirst", "findFirstOrThrow", "count", "groupBy", "aggregate"] as const;

const CALL = new RegExp(`\\b(?:tx|prisma|db|getPrisma\\(\\))\\.(\\w+)\\.(${[...WRITE_METHODS, ...READ_METHODS].join("|")})\\(`, "g");

export interface ScannedCall {
  file: string;
  line: number;
  model: string;
  method: string;
  isWrite: boolean;
  /** The text of the where expression, or null when the call has none. */
  where: string | null;
  /** The text a name was declared with (nearest `const name = ...` before the call in the same file), or null. */
  declared: (name: string) => string | null;
}

export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

/** The text between the bracket at `open` and its match, brackets included. */
function balanced(source: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < source.length; i += 1) {
    const c = source[i]!;
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return source.slice(open, i + 1);
    }
  }
  return source.slice(open);
}

/** The where expression inside the argument object of a call (text from the "(" of the call). */
function whereExpression(callText: string): string | null {
  // Walk the argument object at depth 1 only, so a nested "where" (inside a relation filter) is never mistaken for the call's own.
  let depth = 0;
  for (let i = 0; i < callText.length; i += 1) {
    const c = callText[i]!;
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (depth === 2 && callText.startsWith("where", i) && !/\w/.test(callText[i - 1] ?? "") && !/\w/.test(callText[i + 5] ?? "")) {
      let j = i + 5;
      while (/\s/.test(callText[j] ?? "")) j += 1;
      if (callText[j] !== ":") return "where"; // shorthand: `{ where }`, a variable defined elsewhere
      j += 1;
      while (/\s/.test(callText[j] ?? "")) j += 1;
      if (callText[j] === "{") return balanced(callText, j);
      // Not an object literal: take the expression up to the next comma or closing bracket at this depth.
      let d = 0;
      let k = j;
      for (; k < callText.length; k += 1) {
        const ch = callText[k]!;
        if (ch === "(" || ch === "{" || ch === "[") d += 1;
        else if (ch === ")" || ch === "}" || ch === "]") {
          if (d === 0) break;
          d -= 1;
        } else if (ch === "," && d === 0) break;
      }
      return callText.slice(j, k).trim();
    }
  }
  return null;
}

/** An object literal with everything nested deeper than its own keys blanked out: what is left is the top-level text. */
export function topLevel(objectText: string): string {
  let depth = 0;
  let out = "";
  for (const c of objectText) {
    if (c === "{" || c === "(" || c === "[") {
      depth += 1;
      if (depth === 1) continue;
    } else if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      if (depth === 0) continue;
    }
    if (depth <= 1) out += c;
  }
  return out;
}

/**
 * A where that is just a name (`{ where }`, `where: filters`) is resolved to the object literal it was declared with, the
 * nearest `const name = {...}` before the call. If it cannot be resolved to a literal, it stays a bare name, which is NOT scoped.
 */
function resolveVariable(source: string, callIndex: number, expression: string): string {
  const name = expression.trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) return expression;
  const before = source.slice(0, callIndex);
  const declaration = new RegExp(`(?:const|let)\\s+${name}\\b[^=\\n]*=\\s*\\{`, "g");
  let last = -1;
  for (const m of before.matchAll(declaration)) last = (m.index ?? 0) + m[0].length - 1;
  return last < 0 ? expression : balanced(source, last);
}

/** The expression a `const` or `let` was initialised with, for the nearest declaration before `beforeIndex`. */
function declaredAs(source: string, beforeIndex: number, name: string): string | null {
  const before = source.slice(0, beforeIndex);
  const declaration = new RegExp(`(?:const|let)\\s+${name}\\b[^=\\n]*=\\s*`, "g");
  let last: { end: number } | null = null;
  for (const m of before.matchAll(declaration)) last = { end: (m.index ?? 0) + m[0].length };
  if (!last) return null;
  if (source[last.end] === "{") return balanced(source, last.end);
  let depth = 0;
  let k = last.end;
  for (; k < source.length; k += 1) {
    const c = source[k]!;
    if ("({[".includes(c)) depth += 1;
    else if (")}]".includes(c)) depth -= 1;
    else if (c === ";" && depth === 0) break;
  }
  return source.slice(last.end, k).trim();
}

export function scanSource(source: string, file: string): ScannedCall[] {
  const calls: ScannedCall[] = [];
  for (const m of source.matchAll(CALL)) {
    const index = m.index ?? 0;
    const open = index + m[0].length - 1;
    const method = m[2]!;
    const where = whereExpression(balanced(source, open));
    calls.push({
      file,
      line: source.slice(0, index).split("\n").length,
      model: m[1]!,
      method,
      isWrite: (WRITE_METHODS as readonly string[]).includes(method),
      where: where === null ? null : resolveVariable(source, index, where),
      declared: (name) => declaredAs(source, index, name),
    });
  }
  return calls;
}

export function scanDirectory(dir: string): ScannedCall[] {
  const files = sourceFiles(dir).map((file) => ({ file: file.replaceAll("\\", "/"), source: readFileSync(file, "utf8") }));
  helperBodies.clear();
  for (const { source } of files) collectHelpers(source);
  return files.flatMap(({ file, source }) => scanSource(source, file));
}

/** Functions that build a where clause (`customerVehicleWhere(...)`): name -> their text. Filled by scanDirectory. */
const helperBodies = new Map<string, string>();

function collectHelpers(source: string): void {
  for (const m of source.matchAll(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?)\(/g)) {
    const name = m[1] ?? m[2]!;
    const params = balanced(source, (m.index ?? 0) + m[0].length - 1);
    const afterParams = (m.index ?? 0) + m[0].length - 1 + params.length;
    const arrow = source.slice(afterParams, afterParams + 200).search(/=>\s*[({]|\{/);
    if (arrow < 0) continue;
    const start = afterParams + arrow;
    const open = source.slice(start).search(/[({]/) + start;
    helperBodies.set(name, params + source.slice(afterParams, start) + balanced(source, open));
  }
}

const TOP_LEVEL_ORG = /(?<![.\w])org_id(?:_\w+)?\b/; // org_id, or a compound key such as org_id_prefix
const ANY_ORG = /(?<![.\w])org_id\b/;
const CREDENTIAL = /(?<![.\w])(?:tokenHash|expoPushToken)\b/;
const THROUGH_VEHICLE = /(?<![.\w])vehicle\s*:\s*\{\s*org_id\b/;

/** Does this call's own where clause scope it to an org (or is it one of the accepted exceptions)? */
export function isScoped(call: ScannedCall, orgModels: ReadonlySet<string>): boolean {
  const vehicleScoped = call.model === "vehiclePhoto" || call.model === "vehicleDocument";
  if (!orgModels.has(call.model) && !vehicleScoped) return true; // a table with no org column and no vehicle: not an org-scoped table
  if (call.where === null) return false;
  if (vehicleScoped) return THROUGH_VEHICLE.test(call.where) || (call.where.trim().startsWith("{") && CREDENTIAL.test(topLevel(call.where)));
  if (!call.where.trim().startsWith("{")) return ANY_ORG.test(call.where) || helperScopes(call.where); // a ternary, a variable or a helper call
  return objectScopes(call.where, call, 0);
}

/** `customerVehicleWhere(customer)`: a function whose own text names org_id builds a scoped where. */
function helperScopes(expression: string): boolean {
  const name = /^\s*(\w+)\s*\(/.exec(expression)?.[1];
  const body = name ? helperBodies.get(name) : undefined;
  return body !== undefined && ANY_ORG.test(body);
}

/** An object literal scopes if org_id is a top-level key, or a top-level spread / AND element scopes (to a small depth). */
function objectScopes(objectText: string, call: ScannedCall, depth: number): boolean {
  const top = topLevel(objectText);
  if (TOP_LEVEL_ORG.test(top) || CREDENTIAL.test(top)) return true;
  if (depth > 3) return false;
  // ...name (a declared object) or ...helper(...) (a function that builds a scoped where)
  for (const spread of objectText.matchAll(/\.\.\.\s*(\w+)(\s*\()?/g)) {
    if (!isTopLevelAt(objectText, spread.index ?? 0)) continue;
    const name = spread[1]!;
    if (spread[2]) {
      if (helperScopes(`${name}(`)) return true;
      continue;
    }
    const declared = call.declared(name);
    if (declared && (declared.startsWith("{") ? objectScopes(declared, call, depth + 1) : helperScopes(declared))) return true;
  }
  // AND: [ ...elements ] (or AND: name, a declared array): one scoped element scopes the whole query
  const andName = /(?<![.\w])AND\s*:\s*([A-Za-z_]\w*)\s*[,}]/.exec(objectText);
  const named = andName && isTopLevelAt(objectText, andName.index) ? call.declared(andName[1]!) : null;
  const and = named?.startsWith("[") ? { index: 0, 0: "[", array: named } : /(?<![.\w])AND\s*:\s*\[/.exec(objectText);
  if (and && (named?.startsWith("[") || isTopLevelAt(objectText, and.index))) {
    const array = named?.startsWith("[") ? named : balanced(objectText, and.index + and[0].length - 1);
    for (const element of splitTopLevel(array.slice(1, -1))) {
      const e = element.trim();
      if (e.startsWith("{") ? objectScopes(e, call, depth + 1) : helperScopes(e)) return true;
      const name = /^(\w+)$/.exec(e)?.[1];
      const declared = name ? call.declared(name) : null;
      if (declared?.startsWith("[") && splitTopLevel(declared.slice(1, -1)).some((el) => el.trim().startsWith("{") && objectScopes(el.trim(), call, depth + 1))) return true;
      if (declared && (declared.startsWith("{") ? objectScopes(declared, call, depth + 1) : helperScopes(declared))) return true;
    }
  }
  return false;
}

function isTopLevelAt(text: string, index: number): boolean {
  let depth = 0;
  for (let i = 0; i < index; i += 1) {
    if ("({[".includes(text[i]!)) depth += 1;
    else if (")}]".includes(text[i]!)) depth -= 1;
  }
  return depth === 1;
}

function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i]!;
    if ("({[".includes(c)) depth += 1;
    else if (")}]".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(inner.slice(from));
  return parts.filter((p) => p.trim() !== "");
}

/** Which tables have an org_id column, read from the Prisma schema (camelCase model names, like the client). */
export function orgModelsFromSchema(schemaPath = "prisma/schema.prisma"): Set<string> {
  const schema = readFileSync(schemaPath, "utf8");
  const out = new Set<string>();
  for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    if (/^\s*org_id\s/m.test(m[2] ?? "")) out.add(m[1]!.charAt(0).toLowerCase() + m[1]!.slice(1));
  }
  return out;
}
