import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { diffLines } from 'diff';
import { buildImportGraph, relatedFiles } from './indexer/importGraph';

type SearchHit = { file: string; line: number; text: string };

dotenv.config();

const isDev = !app.isPackaged;

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (isDev) {
    win.loadURL('http://localhost:5173');
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC ---

ipcMain.handle('project:openFolder', async () => {
  // Some Electron type packages disagree on the return type; keep it simple.
  const res: any = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  if (res?.canceled || !res?.filePaths?.length) return null;
  return res.filePaths[0] as string;
});

async function listProjectFiles(rootDir: string): Promise<string[]> {
  async function walk(dir: string, out: string[]) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, out);
      else out.push(p);
    }
  }
  const out: string[] = [];
  await walk(rootDir, out);
  return out;
}

ipcMain.handle('project:listFiles', async (_evt, rootDir: string) => {
  return listProjectFiles(rootDir);
});

ipcMain.handle('project:search', async (_evt, rootDir: string, query: string, limit: number = 50) => {
  const q = (query || '').trim();
  if (!q) return [];

  const files = await listProjectFiles(rootDir);
  const hits: SearchHit[] = [];

  for (const f of files) {
    if (hits.length >= limit) break;
    // skip very large files
    try {
      const st = await fs.stat(f);
      if (st.size > 512_000) continue;
    } catch {
      continue;
    }

    let text = '';
    try {
      text = await fs.readFile(f, 'utf8');
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= limit) break;
      if (lines[i].toLowerCase().includes(q.toLowerCase())) {
        hits.push({ file: f, line: i + 1, text: lines[i].slice(0, 400) });
      }
    }
  }

  return hits;
});

ipcMain.handle('project:index', async (_evt, rootDir: string) => {
  // Build a lightweight import graph to improve context selection.
  async function walk(dir: string, out: string[]) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.aice') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, out);
      else out.push(p);
    }
  }
  const list: string[] = [];
  await walk(rootDir, list);

  const graph = await buildImportGraph(rootDir, list);
  const outDir = path.join(rootDir, '.aice');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'index.json'), JSON.stringify(graph, null, 2), 'utf8');
  return { ok: true, filesIndexed: Object.keys(graph.files).length };
});

ipcMain.handle('file:read', async (_evt, filePath: string) => {
  return fs.readFile(filePath, 'utf8');
});

ipcMain.handle('file:write', async (_evt, filePath: string, content: string) => {
  await fs.writeFile(filePath, content, 'utf8');
  return true;
});

ipcMain.handle('git:initIfNeeded', async (_evt, rootDir: string) => {
  const git = simpleGit({ baseDir: rootDir });
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    await git.init();
    await git.add('.');
    await git.commit('Initial commit');
  }
  return true;
});

ipcMain.handle('git:commitAll', async (_evt, rootDir: string, message: string) => {
  const git = simpleGit({ baseDir: rootDir });
  await git.add('.');
  const status = await git.status();
  if (status.files.length === 0) return { committed: false };
  const out = await git.commit(message);
  return { committed: true, out };
});

ipcMain.handle('git:createBranch', async (_evt, rootDir: string, name: string) => {
  const git = simpleGit({ baseDir: rootDir });
  const branch = name.replace(/[^a-zA-Z0-9/_-]/g, '-').slice(0, 80);
  await git.checkoutLocalBranch(branch);
  return { ok: true, branch };
});

async function brainFetch(brainUrl: string, pathName: string, opts: { method?: string; body?: any } = {}) {
  const url = new URL(pathName, brainUrl).toString();
  const method = opts.method || 'GET';
  const headers: any = {};
  let body: any = undefined;
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { method, headers, body });
  const text = await res.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`Brain request failed ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

ipcMain.handle('brain:health', async (_evt, brainUrl: string) => {
  return brainFetch(brainUrl, '/health');
});

ipcMain.handle('brain:retrieve', async (_evt, brainUrl: string, body: any) => {
  return brainFetch(brainUrl, '/retrieve', { method: 'POST', body });
});

ipcMain.handle('brain:graph', async (_evt, brainUrl: string) => {
  return brainFetch(brainUrl, '/graph');
});

ipcMain.handle('ai:proposeEditsMulti', async (_evt, args: { rootDir: string; entryFilePath: string; instruction: string; contextPack?: string; fileLimit?: number }) => {
  const { rootDir, entryFilePath, instruction } = args;
  const fileLimit = Math.max(1, Math.min(Number(args.fileLimit ?? 6), 12));
  const entryRel = path.relative(rootDir, entryFilePath);

  // candidate set: entry + related files from lightweight import index
  let candidates: string[] = [entryRel];
  try {
    const idxRaw = await fs.readFile(path.join(rootDir, '.aice', 'index.json'), 'utf8');
    const idx = JSON.parse(idxRaw);
    const rels: string[] = relatedFiles(idx, entryRel, 2, 20);
    candidates = Array.from(new Set([entryRel, ...rels])).slice(0, 30);
  } catch {
    // no index
  }

  // Load contents (cap per file)
  const fileBlobs: Array<{ path: string; content: string }> = [];
  for (const relPath of candidates) {
    const abs = path.join(rootDir, relPath);
    try {
      const c = await fs.readFile(abs, 'utf8');
      fileBlobs.push({ path: relPath, content: c.slice(0, 12000) });
    } catch {
      // ignore
    }
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set. Create a .env file (see .env.example).');
  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  // 1) Plan which files to edit
  const planSystem = [
    'You are a senior software engineer planning a multi-file edit.',
    'Return STRICT JSON: {"files": [{"path":"...","reason":"..."}], "notes":"..."}.',
    'Only include files from the provided candidate list.',
    'Prefer the smallest set of files required.',
  ].join('\n');

  const planUser = [
    `Instruction: ${instruction}`,
    `Entry file: ${entryRel}`,
    `Candidate files (${fileBlobs.length}):`,
    ...fileBlobs.map(f => `- ${f.path}`),
    args.contextPack ? `\nBRAIN CONTEXT_PACK:\n${args.contextPack}` : '',
  ].join('\n');

  const planResp = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: planSystem },
      { role: 'user', content: planUser },
    ],
    temperature: 0.1,
    response_format: { type: 'json_object' } as any,
  });

  let plan: any = {};
  try {
    plan = JSON.parse(planResp.choices[0]?.message?.content || '{}');
  } catch {
    plan = { files: [{ path: entryRel, reason: 'fallback' }], notes: 'planner returned non-json' };
  }

  const chosen: string[] = Array.isArray(plan.files)
    ? plan.files.map((x: any) => String(x.path || '')).filter(Boolean)
    : [entryRel];

  const finalList = Array.from(new Set([entryRel, ...chosen])).filter(p => candidates.includes(p)).slice(0, fileLimit);

  // 2) Produce updated contents per file
  const outFiles: Array<{ filePath: string; before: string; after: string; patches: any[] }> = [];

  const globalContext = [
    args.contextPack ? `BRAIN CONTEXT_PACK:\n${args.contextPack}` : '',
    'FILES (read-only, truncated):',
    ...fileBlobs.map(f => `FILE: ${f.path}\n---\n${f.content}\n---`),
  ].filter(Boolean).join('\n\n');

  for (const relPath of finalList) {
    const abs = path.join(rootDir, relPath);
    const before = await fs.readFile(abs, 'utf8');

    const sys = [
      'You are an AI code editor.',
      'You are editing ONE file at a time as part of a multi-file change.',
      'Return ONLY the full updated file content for the target file.',
      'Keep changes minimal and consistent with the rest of the project.',
    ].join('\n');

    const user = [
      `Instruction: ${instruction}`,
      `Target file: ${relPath}`,
      `Plan summary: ${JSON.stringify(plan).slice(0, 2000)}`,
      '--- CURRENT CONTENT ---',
      before,
      '--- END ---',
      globalContext ? `\n\n${globalContext}` : '',
    ].join('\n');

    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    });

    const after = resp.choices[0]?.message?.content ?? '';
    const patches = diffLines(before, after);

    outFiles.push({
      filePath: abs,
      before,
      after,
      patches: patches.map(p => ({ added: !!p.added, removed: !!p.removed, value: p.value })),
    });
  }

  return { files: outFiles, plan };
});

ipcMain.handle('ai:proposeEdit', async (_evt, args: { rootDir: string; filePath: string; instruction: string; }) => {
  const { rootDir, filePath, instruction } = args;
  const before = await fs.readFile(filePath, 'utf8');

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set. Create a .env file (see .env.example).');
  }

  // Load lightweight index if present to attach related-file context.
  let contextPack = '';
  try {
    const idxRaw = await fs.readFile(path.join(rootDir, '.aice', 'index.json'), 'utf8');
    const idx = JSON.parse(idxRaw);
    const rel = path.relative(rootDir, filePath);
    const rels: string[] = relatedFiles(idx, rel, 2, 10);
    const snippets: string[] = [];
    for (const r of rels) {
      const abs = path.join(rootDir, r);
      try {
        const s = await fs.readFile(abs, 'utf8');
        const capped = s.slice(0, 2000);
        snippets.push(`FILE: ${r}\n---\n${capped}\n---`);
      } catch {
        // ignore
      }
    }
    if (snippets.length) {
      contextPack = `\n\nRELATED FILE CONTEXT (read-only, may be truncated):\n${snippets.join('\n\n')}`;
    }
  } catch {
    // no index
  }

  const client = new OpenAI({ apiKey });
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const system = [
    'You are an AI code editor. Return ONLY the full updated file content.',
    'Follow existing style. Do not add unrelated changes.',
    'If you need to change other files, do NOT. Only return the updated content for the current file.',
  ].join('\n');

  const user = [
    `Instruction: ${instruction}`,
    `File: ${path.basename(filePath)}`,
    '--- CURRENT CONTENT ---',
    before,
    '--- END ---',
    contextPack,
  ].join('\n');

  const resp = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.2,
  });

  const after = resp.choices[0]?.message?.content ?? '';
  const patches = diffLines(before, after);

  return {
    before,
    after,
    patches: patches.map(p => ({ added: !!p.added, removed: !!p.removed, value: p.value })),
  };
});
