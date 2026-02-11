import fs from 'node:fs/promises';
import path from 'node:path';

export type ImportGraph = {
  version: 1;
  rootDir: string;
  generatedAt: string;
  files: Record<string, { imports: string[] }>; // relPath -> relPaths
};

const JS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function isCodeFile(p: string) {
  return JS_EXT.has(path.extname(p));
}

function extractImports(source: string): string[] {
  // Very lightweight (MVP). Handles:
  //   import x from '...'
  //   import '...'
  //   const x = require('...')
  const out: string[] = [];
  const re = /(?:import\s+(?:[^'";]+\s+from\s+)?|require\()\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    out.push(m[1]);
  }
  return out;
}

async function exists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveImport(fromAbs: string, spec: string): Promise<string | null> {
  // Only resolve relative imports for now.
  if (!spec.startsWith('.')) return null;
  const fromDir = path.dirname(fromAbs);
  const base = path.resolve(fromDir, spec);

  const candidates = [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.js',
    base + '.jsx',
    base + '.mjs',
    base + '.cjs',
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
  ];

  for (const c of candidates) {
    if (await exists(c)) return c;
  }
  return null;
}

export async function buildImportGraph(rootDir: string, absFiles: string[]): Promise<ImportGraph> {
  const files: ImportGraph['files'] = {};

  const absSet = new Set(absFiles.map(f => path.resolve(f)));

  for (const abs of absFiles) {
    const r = path.relative(rootDir, abs);
    if (!isCodeFile(abs)) continue;
    let src = '';
    try {
      src = await fs.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    const specs = extractImports(src);
    const resolved: string[] = [];
    for (const spec of specs) {
      const tgt = await resolveImport(abs, spec);
      if (!tgt) continue;
      const tgtAbs = path.resolve(tgt);
      if (!absSet.has(tgtAbs)) continue;
      resolved.push(path.relative(rootDir, tgtAbs));
    }
    files[r] = { imports: Array.from(new Set(resolved)).sort() };
  }

  return {
    version: 1,
    rootDir,
    generatedAt: new Date().toISOString(),
    files,
  };
}

export function relatedFiles(graph: ImportGraph, relPath: string, hops = 2, limit = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const q: Array<{ p: string; d: number }> = [{ p: relPath, d: 0 }];

  // build reverse edges once
  const rev: Record<string, string[]> = {};
  for (const [f, meta] of Object.entries(graph.files)) {
    for (const imp of meta.imports) {
      (rev[imp] ||= []).push(f);
    }
  }

  while (q.length) {
    const { p, d } = q.shift()!;
    if (d > hops) continue;
    const nbrs = [
      ...(graph.files[p]?.imports ?? []),
      ...(rev[p] ?? []),
    ];
    for (const n of nbrs) {
      if (n === relPath) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
      if (out.length >= limit) return out;
      q.push({ p: n, d: d + 1 });
    }
  }
  return out;
}
