// ----------- USAGE -----------
// Using command line (in the directory that this file is located) run:
// node extract-functions.js "PATH TO JS/TYPESCRIPT FILE"


import fs from "fs";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import generateModule from "@babel/generator";
import clipboardy from "clipboardy";


const generate = generateModule.default ?? generateModule;


const traverse = traverseModule.default ?? traverseModule;

// ---------- helpers ----------

function escapeForTemplateLiteral(s) {
  // escape backticks and ${} so template literals are safe
  return String(s ?? "")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

function toJsLiteral(value, indent = 0) {
  const pad = "  ".repeat(indent);
  const pad2 = "  ".repeat(indent + 1);

  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "[\n" + value.map(v => pad2 + toJsLiteral(v, indent + 1)).join(",\n") + "\n" + pad + "]";
  }

  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";

    // Special-case: src as template literal for readability
    const lines = [];
    for (const k of keys) {
      const v = value[k];
      if (k === "src" && typeof v === "string") {
        lines.push(`${pad2}${JSON.stringify(k)}: \`\n${escapeForTemplateLiteral(v)}\n\``);
      } else {
        lines.push(`${pad2}${JSON.stringify(k)}: ${toJsLiteral(v, indent + 1)}`);
      }
    }
    return "{\n" + lines.join(",\n") + "\n" + pad + "}";
  }

  return "null";
}


function trimCommonIndent(block) {
  if (block == null) return null;
  let s = String(block);

  s = s.replace(/^\s*\n/, "").replace(/\n\s*$/, "");

  const lines = s.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return "";

  let min = Infinity;
  for (const l of nonEmpty) {
    const m = l.match(/^[ \t]*/)?.[0]?.length ?? 0;
    if (m < min) min = m;
  }
  if (!Number.isFinite(min) || min <= 0) return lines.join("\n");

  return lines.map((l) => (l.trim().length ? l.slice(min) : "")).join("\n");
}


function escapeHeader(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function buildClipboardTextFromNodes(nodes, opts) {
  const { includeChildren, includedIds, fullDetailIds, callRefMode, idToNode } = opts;
  const parts = [];

  function refFor(id) {
    const n = idToNode.get(id);
    if (!n) return callRefMode === "id" ? id : "(unknown)";
    if (callRefMode === "id") return id;
    if (callRefMode === "name") return n.name ?? "(anonymous)";
    return `${n.name ?? "(anonymous)"} (${id})`;
  }

  function walk(n, indent) {
    if (!includedIds.has(n.id)) return;

    const pad = includeChildren ? "  ".repeat(indent) : "";
    const title = `${escapeHeader(n.name)}  (${escapeHeader(n.id)})`;

    if (fullDetailIds.has(n.id)) {
      const prettySrc = prettyPrintNode(n.astNode) ?? trimCommonIndent(n.src) ?? "";
      parts.push(`${pad}// ==== ${title} ====`);
      parts.push(prettySrc);

      const calls = (n.calls ?? []).filter((id) => includedIds.has(id)).map(refFor);
      const calledBy = (n.calledBy ?? []).filter((id) => includedIds.has(id)).map(refFor);

      if (calls.length) parts.push(`${pad}// calls: ${calls.join(", ")}`);
      if (calledBy.length) parts.push(`${pad}// calledBy: ${calledBy.join(", ")}`);

      parts.push("");
    } else {
      if (includeChildren) parts.push(`${pad}// -- ${title} --`);
    }

    if (Array.isArray(n.children)) {
      for (const c of n.children) walk(c, indent + 1);
    }
  }

  for (const root of nodes) walk(root, 0);
  return parts.join("\n");
}
  


function prettyPrintNode(astNode) {
  if (!astNode) return null;
  try {
    // compact: false gives multi-line formatting
    // retainLines: false lets generator format nicely
    const { code } = generate(astNode, { compact: false, retainLines: false });
    return code;
  } catch {
    return null;
  }
}


function memberPropName(me) {
  if (!me || me.type !== "MemberExpression") return null;
  if (!me.computed && me.property?.type === "Identifier") return me.property.name;
  if (me.computed && me.property?.type === "StringLiteral") return me.property.value;
  return null;
}

function calleeRootName(expr) {
  // window.addEventListener -> "window"
  // document.body.addEventListener -> "document.body"
  if (!expr) return "(unknown)";

  if (expr.type === "Identifier") return expr.name;

  if (expr.type === "ThisExpression") return "this";

  if (expr.type === "MemberExpression") {
    const left = calleeRootName(expr.object);
    const prop = memberPropName(expr);
    if (left && prop) return `${left}.${prop}`;
    return left ?? "(unknown)";
  }

  return "(unknown)";
}

function getEventListenerInfoFromFunctionPath(fnPath) {
  // Returns { eventType, target, method } if fnPath is the listener arg of addEventListener/removeEventListener; else null.
  const callPath = fnPath.parentPath?.isCallExpression()
    ? fnPath.parentPath
    : (fnPath.parentPath?.parentPath?.isCallExpression() ? fnPath.parentPath.parentPath : null);

  if (!callPath) return null;

  const callNode = callPath.node;
  const callee = callNode.callee;

  // must be *.addEventListener(...) or *.removeEventListener(...)
  if (callee?.type !== "MemberExpression") return null;

  const method = memberPropName(callee);
  if (method !== "addEventListener" && method !== "removeEventListener") return null;

  // fnPath node must be exactly the 2nd argument (index 1)
  const args = callNode.arguments || [];
  const listenerArg = args[1];
  if (!listenerArg || listenerArg !== fnPath.node) return null;

  // event type is arg[0] if StringLiteral
  const eventArg = args[0];
  const eventType =
    eventArg?.type === "StringLiteral" ? eventArg.value : "<dynamic>";

  const target = calleeRootName(callee.object);

  return { eventType, target, method };
}

function isEventListenerCallback(fnPath) {
  return getEventListenerInfoFromFunctionPath(fnPath) != null;
}

function inferListenerName(fnPath) {
  const info = getEventListenerInfoFromFunctionPath(fnPath);
  if (!info) return "(listener)";
  // Example: listener:addEventListener:click@window
  return `listener:${info.method}:${info.eventType}@${info.target}`;
}

function nodeIdFromLoc(prefix, node, fallbackCounter) {
  const loc = node.loc;
  if (!loc) return `${prefix}:${fallbackCounter}`;
  return `${prefix}:${loc.start.line}:${loc.start.column}-${loc.end.line}:${loc.end.column}`;
}

function inferClassName(path) {
  const node = path.node;

  if (node.id?.name) return node.id.name;

  const p = path.parent;

  if (p?.type === "VariableDeclarator" && p.id?.type === "Identifier") {
    return p.id.name;
  }

  if (p?.type === "AssignmentExpression") {
    const lhs = p.left;
    if (lhs?.type === "Identifier") return lhs.name;
    if (lhs?.type === "MemberExpression" && !lhs.computed && lhs.property?.type === "Identifier") {
      return lhs.property.name;
    }
  }

  if (p?.type === "ExportDefaultDeclaration") {
    return "(default)";
  }

  return "(anonymous class)";
}

function inferFunctionName(path) {
  const node = path.node;

  if (path.isClassMethod()) {
    const k = path.node.key;
    if (k?.type === "Identifier") return k.name;
    if (k?.type === "StringLiteral") return k.value;
    if (k?.type === "NumericLiteral") return String(k.value);
    return "(method)";
  }

  if (node.id?.name) return node.id.name;

  const p = path.parent;

  if (p?.type === "VariableDeclarator" && p.id?.type === "Identifier") {
    return p.id.name;
  }

  if (p?.type === "AssignmentExpression") {
    const lhs = p.left;
    if (lhs?.type === "MemberExpression") {
      if (!lhs.computed && lhs.property?.type === "Identifier") return lhs.property.name;
      if (lhs.computed && lhs.property?.type === "StringLiteral") return lhs.property.value;
      if (lhs.computed && lhs.property?.type === "NumericLiteral") return String(lhs.property.value);
    }
    if (lhs?.type === "Identifier") return lhs.name;
  }

  if (
    p?.type === "ObjectProperty" &&
    (p.key?.type === "Identifier" || p.key?.type === "StringLiteral" || p.key?.type === "NumericLiteral")
  ) {
    if (p.key.type === "Identifier") return p.key.name;
    return String(p.key.value);
  }

  return "(anonymous)";
}

function paramToString(p) {
  switch (p.type) {
    case "Identifier":
      return p.name;
    case "AssignmentPattern":
      return `${paramToString(p.left)} = …`;
    case "ObjectPattern":
      return `{ ${p.properties
        .map((prop) => prop.key?.name ?? (prop.key?.value != null ? String(prop.key.value) : "…"))
        .join(", ")} }`;
    case "ArrayPattern":
      return `[${p.elements.map((e) => (e ? paramToString(e) : "")).join(", ")}]`;
    case "RestElement":
      return `...${paramToString(p.argument)}`;
    default:
      return `<${p.type}>`;
  }
}

function isInlineCallback(path) {
  const p = path.parent;
  if (p?.type === "CallExpression") return true;
  if (path.parentPath?.parent?.type === "CallExpression") return true;
  return false;
}

function sortTree(list) {
  list.sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
  for (const n of list) sortTree(n.children);
}

// ---------- projection ----------
function projectTree(nodes, opts) {
  const {
    includeFieldsStructural, // Set<string>
    includeChildren,
    includeChildCountWhenOmittingChildren,
    callRefMode,
    idToNode,
    includedIds,
    fullDetailIds,
  } = opts;

  function refFor(id) {
    const n = idToNode.get(id);
    if (!n) return callRefMode === "id" ? id : "(unknown)";
    if (callRefMode === "id") return id;
    if (callRefMode === "name") return n.name ?? "(anonymous)";
    return { id, name: n.name ?? "(anonymous)" };
  }

  function filterIds(list) {
    return (list ?? []).filter((id) => includedIds.has(id));
  }

  function projectNode(n) {
    const isFull = fullDetailIds.has(n.id);

    // FULL-DETAIL: emit code, not metadata
    if (isFull) {
      const src = prettyPrintNode(n.astNode) ?? trimCommonIndent(n.src) ?? null;
    
      const out = {
        id: n.id,
        name: n.name,
        type: n.type,
        startLine: n.startLine,
        endLine: n.endLine,
        params: n.params ?? "",
    
        src, // EMBEDDED HERE
    
        calls: filterIds(n.calls).map(refFor),
        calledBy: filterIds(n.calledBy).map(refFor),
      };
    
      if (includeChildren) {
        out.children = (n.children ?? []).map(projectNode);
      } else if (includeChildCountWhenOmittingChildren) {
        out.childCount = (n.children ?? []).length;
      }
    
      return out;
    }
    

    // STRUCTURAL-ONLY: minimal metadata (configurable by includeFieldsStructural)
    const out = {};
    if (includeFieldsStructural.has("id")) out.id = n.id;
    if (includeFieldsStructural.has("name")) out.name = n.name;
    if (includeFieldsStructural.has("type")) out.type = n.type;
    if (includeFieldsStructural.has("startLine")) out.startLine = n.startLine;
    if (includeFieldsStructural.has("endLine")) out.endLine = n.endLine;

    if (includeChildren) {
      out.children = (n.children ?? []).map(projectNode);
    } else if (includeChildCountWhenOmittingChildren) {
      out.childCount = (n.children ?? []).length;
    }

    return out;
  }

  return nodes.map(projectNode);
}

function parseIntOrDefault(s, def) {                                                   // NEW
  const n = Number.parseInt(String(s ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function resolveSeedIds(seedTokens, nodesById) {                                       // NEW
  const byNameExact = new Map();
  for (const [id, n] of nodesById.entries()) {
    const name = n?.name;
    if (!name) continue;
    let set = byNameExact.get(name);
    if (!set) byNameExact.set(name, (set = new Set()));
    set.add(id);
  }

  const out = new Set();

  for (const raw of seedTokens) {
    const tok = String(raw ?? "").trim();
    if (!tok) continue;

    // 1) Exact id
    if (nodesById.has(tok)) {
      out.add(tok);
      continue;
    }

    // 2) Exact name
    const exact = byNameExact.get(tok);
    if (exact && exact.size) {
      for (const id of exact) out.add(id);
      continue;
    }

    // 3) Fallback: substring match (best-effort)
    for (const [id, n] of nodesById.entries()) {
      const name = String(n?.name ?? "");
      if (name && name.toLowerCase().includes(tok.toLowerCase())) out.add(id);
    }
  }

  return out;
}

function bidirNeighbors(id, callsById, calledById) {                                  // NEW
  const out = new Set();
  for (const x of (callsById.get(id) ?? [])) out.add(x);
  for (const x of (calledById.get(id) ?? [])) out.add(x);
  return out;
}

function bfsRadius(seedIds, radius, callsById, calledById) {                           // NEW
  const dist = new Map();
  const q = [];

  for (const s of seedIds) {
    dist.set(s, 0);
    q.push(s);
  }

  while (q.length) {
    const cur = q.shift();
    const d = dist.get(cur) ?? 0;
    if (d >= radius) continue;

    for (const nb of bidirNeighbors(cur, callsById, calledById)) {
      if (!dist.has(nb)) {
        dist.set(nb, d + 1);
        q.push(nb);
      }
    }
  }

  return new Set(dist.keys());
}

function addAncestors(ids, parentById) {                                               // NEW
  const out = new Set(ids);
  for (const id of ids) {
    let p = parentById.get(id);
    while (p) {
      if (out.has(p)) break;
      out.add(p);
      p = parentById.get(p);
    }
  }
  return out;
}

function filterTreeByIncludedIds(nodes, includedIds) {                                 // NEW
  function rec(n) {
    if (!includedIds.has(n.id)) return null;
    const kids = [];
    for (const c of (n.children ?? [])) {
      const got = rec(c);
      if (got) kids.push(got);
    }
    return { ...n, children: kids };
  }

  const out = [];
  for (const n of nodes) {
    const got = rec(n);
    if (got) out.push(got);
  }
  return out;
}


function parseCsvList(s) {
  return String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizeYesNo(s, defaultVal = true) {
  const v = String(s ?? "").trim().toLowerCase();
  if (!v) return defaultVal;
  if (["y", "yes", "true", "1"].includes(v)) return true;
  if (["n", "no", "false", "0"].includes(v)) return false;
  return defaultVal;
}

function normalizeEnum(s, allowed, defaultVal) {
  const v = String(s ?? "").trim().toLowerCase();
  if (!v) return defaultVal;
  if (allowed.includes(v)) return v;
  return defaultVal;
}

// Extract a "callee name key" from a CallExpression's callee.
// Best-effort: Identifier => "foo", MemberExpression => property name "foo".
// Returns null if dynamic/unsupported.
function calleeKeyFromCallExpression(callNode) {
  const callee = callNode.callee;

  // foo()
  if (callee?.type === "Identifier") return callee.name;

  // obj.foo() or obj["foo"]()
  if (callee?.type === "MemberExpression") {
    if (!callee.computed && callee.property?.type === "Identifier") return callee.property.name;
    if (callee.computed && callee.property?.type === "StringLiteral") return callee.property.value;
    return null;
  }

  // (fn)() or other dynamic cases
  return null;
}

// Find the "owner" node id for a call: nearest function if present, else nearest class, else null(root).
function findEnclosingOwnerId(path, classIdByNode, fallbackCounter) {
  const fnPath = path.findParent((p) => p.isFunction());
  if (fnPath) return nodeIdFromLoc("fn", fnPath.node, fallbackCounter);

  const clsPath = path.findParent((p) => p.isClassDeclaration() || p.isClassExpression());
  if (clsPath) return classIdByNode.get(clsPath.node) ?? null;

  return null;
}

// ---------- read input ----------
const filename = process.argv[2];
if (!filename) {
  console.error("Usage: node extract-functions.js <file.js>");
  process.exit(1);
}

const code = fs.readFileSync(filename, "utf8");

// NEW: build line start offsets for fast loc->substring slicing
function buildLineStartOffsets(text) { // NEW
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

// NEW: slice exact source from loc (Babel loc is 1-based line, 0-based column)
function sliceSourceByLoc(text, lineStarts, loc) { // NEW
  if (!loc) return null;

  const sLine = loc.start?.line;
  const sCol = loc.start?.column;
  const eLine = loc.end?.line;
  const eCol = loc.end?.column;

  if (
    !Number.isFinite(sLine) || !Number.isFinite(sCol) ||
    !Number.isFinite(eLine) || !Number.isFinite(eCol)
  ) return null;

  const sLineIdx = sLine - 1;
  const eLineIdx = eLine - 1;

  if (sLineIdx < 0 || eLineIdx < 0 || sLineIdx >= lineStarts.length || eLineIdx >= lineStarts.length) {
    return null;
  }

  const startIdx = lineStarts[sLineIdx] + sCol;
  const endIdx = lineStarts[eLineIdx] + eCol;

  if (startIdx < 0 || endIdx < startIdx || endIdx > text.length) return null;

  return text.slice(startIdx, endIdx);
}

const lineStarts = buildLineStartOffsets(code); // NEW


// ---------- parse ----------
const ast = parse(code, {
  sourceType: "unambiguous",
  plugins: ["jsx", "typescript", "classProperties", "topLevelAwait"],
  errorRecovery: true,
});

// ---------- containers ----------
const nodesById = new Map();         // id -> node (our output nodes)
const parentById = new Map();        // id -> parentId|null
const classIdByNode = new WeakMap(); // classNode -> classId

// call graph
const nameKeyToIds = new Map();      // string key -> Set<id>
const callsById = new Map();         // callerId -> Set<calleeId>
const calledById = new Map();        // calleeId -> Set<callerId>

let fallbackCounter = 0;

function registerNameKey(key, id) {
  if (!key) return;
  let s = nameKeyToIds.get(key);
  if (!s) {
    s = new Set();
    nameKeyToIds.set(key, s);
  }
  s.add(id);
}

function addEdge(callerId, calleeId) {
  if (!callerId || !calleeId) return;

  let s1 = callsById.get(callerId);
  if (!s1) {
    s1 = new Set();
    callsById.set(callerId, s1);
  }
  s1.add(calleeId);

  let s2 = calledById.get(calleeId);
  if (!s2) {
    s2 = new Set();
    calledById.set(calleeId, s2);
  }
  s2.add(callerId);
}

// ---------- PASS 1: collect classes ----------
traverse(ast, {
  ClassDeclaration(path) {
    fallbackCounter += 1;
    const node = path.node;
    const id = nodeIdFromLoc("class", node, fallbackCounter);
    const name = inferClassName(path);

    classIdByNode.set(node, id);

    nodesById.set(id, {
      id,
      name,
      type: node.type,
      params: "",
      startLine: node.loc?.start?.line ?? null,
      endLine: node.loc?.end?.line ?? null,
      astNode: node, // NEW
      src: sliceSourceByLoc(code, lineStarts, node.loc) ?? null, // NEW
      children: [],
      calls: [],
      calledBy: [],
    });


    // Basic key: class name (helps if something calls ClassName(...))
    registerNameKey(name, id);

    const parentFnPath = path.findParent((p) => p.isFunction());
    const parentId = parentFnPath
      ? nodeIdFromLoc("fn", parentFnPath.node, fallbackCounter)
      : null;

    parentById.set(id, parentId);
  },

  ClassExpression(path) {
    fallbackCounter += 1;
    const node = path.node;
    const id = nodeIdFromLoc("class", node, fallbackCounter);
    const name = inferClassName(path);

    classIdByNode.set(node, id);

    nodesById.set(id, {
      id,
      name,
      type: node.type,
      params: "",
      startLine: node.loc?.start?.line ?? null,
      endLine: node.loc?.end?.line ?? null,
      src: sliceSourceByLoc(code, lineStarts, node.loc) ?? null,
      astNode: node, // NEW
      children: [],
      calls: [],
      calledBy: [],
    });

    registerNameKey(name, id);

    const parentFnPath = path.findParent((p) => p.isFunction());
    const parentId = parentFnPath
      ? nodeIdFromLoc("fn", parentFnPath.node, fallbackCounter)
      : null;

    parentById.set(id, parentId);
  },
});

// ---------- PASS 2: collect functions ----------
traverse(ast, {
  Function(path) {
    const isInline =
      (path.isArrowFunctionExpression() || path.isFunctionExpression()) &&
      isInlineCallback(path);

    const keepBecauseListener = isEventListenerCallback(path);

    if (isInline && !keepBecauseListener) {
      return;
    }

    fallbackCounter += 1;
    const node = path.node;

    const id = nodeIdFromLoc("fn", node, fallbackCounter);
    const name = isEventListenerCallback(path)
      ? inferListenerName(path)
      : inferFunctionName(path);

    let parentId = null;

    if (path.isClassMethod()) {
      const classPath = path.findParent((p) => p.isClassDeclaration() || p.isClassExpression());
      if (classPath) parentId = classIdByNode.get(classPath.node) ?? null;
    }

    if (!parentId) {
      const parentFnPath = path.findParent((p) => p.isFunction());
      parentId = parentFnPath ? nodeIdFromLoc("fn", parentFnPath.node, fallbackCounter) : null;
    }

    if (!parentId) {
      const classPath = path.findParent((p) => p.isClassDeclaration() || p.isClassExpression());
      if (classPath) parentId = classIdByNode.get(classPath.node) ?? null;
    }

    nodesById.set(id, {
      id,
      name,
      type: node.type,
      params: node.params.map(paramToString).join(", "),
      startLine: node.loc?.start?.line ?? null,
      endLine: node.loc?.end?.line ?? null,
      astNode: node, // NEW
      src: sliceSourceByLoc(code, lineStarts, node.loc) ?? null, // NEW
      children: [],
      calls: [],
      calledBy: [],
    });


    parentById.set(id, parentId);

    // Register keys for call resolution:
    // - function name itself
    // - for methods, also register method name (already 'name') to catch obj.method()
    registerNameKey(name, id);
  },
});

// ---------- PASS 3: collect call edges ----------
traverse(ast, {
  CallExpression(path) {
    const callNode = path.node;
    const key = calleeKeyFromCallExpression(callNode);
    if (!key) return;

    // Who is making the call?
    const callerId = findEnclosingOwnerId(path, classIdByNode, fallbackCounter);

    // Who is being called? (best-effort by name/property key)
    const targetIds = nameKeyToIds.get(key);
    if (!targetIds || targetIds.size === 0) return;

    for (const calleeId of targetIds) {
      addEdge(callerId, calleeId);
    }
  },
});

// ---------- materialize calls/calledBy into nodes ----------
for (const [id, node] of nodesById.entries()) {
  node.calls = Array.from(callsById.get(id) ?? []);
  node.calledBy = Array.from(calledById.get(id) ?? []);
}

// ---------- assemble tree ----------
const roots = [];

for (const [id, node] of nodesById.entries()) {
  const parentId = parentById.get(id);
  if (parentId && nodesById.has(parentId)) {
    nodesById.get(parentId).children.push(node);
  } else {
    roots.push(node);
  }
}

sortTree(roots);

// ---------- prompt for output selection ----------
const FIELDS = ["id", "name", "type", "params", "startLine", "endLine", "calls", "calledBy"];

const rl = readline.createInterface({ input, output });

try {
  output.write("\nFields available:\n");
  output.write(`  ${FIELDS.join(", ")}\n\n`);

  // --- NEW: seeds + dual radii ---
  const seedAns = await rl.question(
    "Seed function(s) (comma-separated; can be id or name; substring allowed as fallback)\n> "
  ); // NEW
  const seedTokens = parseCsvList(seedAns);                                            // NEW
  const seedIds = resolveSeedIds(seedTokens, nodesById);                               // NEW

  if (seedIds.size === 0) {                                                           // NEW
    console.error("No seed functions matched. Try an exact name/id.");
    process.exit(2);
  }

  const fullRadAns = await rl.question("Full-detail radius (bidirectional, >=0) [default: 1]\n> ");     // NEW
  const ctxRadAns = await rl.question("Structural-context radius (bidirectional, >= full) [default: 2]\n> "); // NEW
  const fullRadius = parseIntOrDefault(fullRadAns, 1);                                 // NEW
  const contextRadiusRaw = parseIntOrDefault(ctxRadAns, 2);                            // NEW
  const contextRadius = Math.max(contextRadiusRaw, fullRadius);                        // NEW

  // Compute included ids
  const fullIds0 = bfsRadius(seedIds, fullRadius, callsById, calledById);              // NEW
  const contextIds0 = bfsRadius(seedIds, contextRadius, callsById, calledById);        // NEW

  const includedIds = addAncestors(new Set([...contextIds0, ...fullIds0]), parentById);
  const fullDetailIds = new Set(fullIds0);
  
  // Filter the root tree to only included ids
  const filteredRoots = filterTreeByIncludedIds(roots, includedIds);                   // NEW

  // Structural-only nodes: forced minimal fields (ignores user choices)               // NEW
  const chosenFieldsStructural = new Set(["id", "name", "type", "startLine", "endLine"]); // NEW

  const includeChildrenAns = await rl.question("Include children (keep tree structure)? [Y/n]\n> ");
  const includeChildren = normalizeYesNo(includeChildrenAns, true);

  let includeChildCountWhenOmittingChildren = false;
  if (!includeChildren) {
    const ccAns = await rl.question("If children are omitted, include childCount? [Y/n]\n> ");
    includeChildCountWhenOmittingChildren = normalizeYesNo(ccAns, true);
  }

  // Only ask call ref formatting if calls/calledBy might be printed (full-detail nodes only)
  let callRefMode = "name";
  const modeAns = await rl.question('For calls/calledBy, show "id", "name", or "both"? [default: name]\n> ');
  callRefMode = normalizeEnum(modeAns, ["id", "name", "both"], "name");


  const prettyAns = await rl.question("Pretty-print JSON (indentation)? [Y/n]\n> ");
  const pretty = normalizeYesNo(prettyAns, true);

  const projected = projectTree(filteredRoots, {
    includeFieldsStructural: chosenFieldsStructural,
    includeChildren,
    includeChildCountWhenOmittingChildren,
    callRefMode,
    idToNode: nodesById,
    includedIds,
    fullDetailIds,
  });


  const clipAns = await rl.question("Copy ENTIRE output tree to clipboard? [y/N]\n> ");
  const doClip = normalizeYesNo(clipAns, false);
  
  if (doClip) {
    const jsText = `export default ${toJsLiteral(projected, 0)};\n`;
    await clipboardy.write(jsText);
    console.error(`Copied ${jsText.length} chars to clipboard.`);
  } else {
    console.log(pretty ? JSON.stringify(projected, null, 2) : JSON.stringify(projected));
  }  

  


  if (!doClip) {
    console.log(pretty ? JSON.stringify(projected, null, 2) : JSON.stringify(projected));
  }
  } finally {
  rl.close();
}
