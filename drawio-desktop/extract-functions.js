import fs from "fs";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

// ---------- read input ----------
const filename = process.argv[2];
if (!filename) {
  console.error("Usage: node extract-functions.js <file.js>");
  process.exit(1);
}

const code = fs.readFileSync(filename, "utf8");

// ---------- parse ----------
const ast = parse(code, {
  sourceType: "module",
  plugins: [
    "jsx",
    "typescript",
    "classProperties",
    "topLevelAwait"
  ]
});

// ---------- extract ----------
const functions = [];

traverse(ast, {
  Function(path) {
    const node = path.node;

    const name =
      node.id?.name ||
      path.parent?.id?.name ||
      path.parent?.key?.name ||
      "(anonymous)";

    functions.push({
      name,
      type: node.type,
      params: node.params.map(p => p.type),
      startLine: node.loc.start.line,
      endLine: node.loc.end.line,
      depth: path.getAncestry().length
    });
  }
});

// ---------- output ----------
console.log(JSON.stringify(functions, null, 2));
