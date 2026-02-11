import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { OpenAI } from 'openai';
import dotenv from 'dotenv';
import { diffLines } from 'diff';
import { buildImportGraph, relatedFiles } from './indexer/importGraph';

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

ipcMain.handle('project:listFiles', async (_evt, rootDir: string) => {
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
