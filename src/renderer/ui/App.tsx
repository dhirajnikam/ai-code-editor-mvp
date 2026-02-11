import React, { useMemo, useState } from 'react';
import { DiffView } from './DiffView';

export function App() {
  const [rootDir, setRootDir] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [proposed, setProposed] = useState<null | { before: string; after: string; patches: any[] }>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rel = useMemo(() => {
    if (!rootDir) return (p: string) => p;
    return (p: string) => (p.startsWith(rootDir) ? p.slice(rootDir.length + 1) : p);
  }, [rootDir]);

  async function openProject() {
    setError(null);
    const dir = await window.api.openFolder();
    if (!dir) return;
    setBusy('Opening project...');
    setRootDir(dir);
    await window.api.gitInitIfNeeded(dir);
    const list = await window.api.listFiles(dir);
    setFiles(list);
    setActiveFile(list.find(f => f.endsWith('.ts') || f.endsWith('.tsx') || f.endsWith('.js') || f.endsWith('.jsx')) ?? list[0] ?? null);
    setBusy('Indexing project (imports graph)...');
    try {
      await window.api.indexProject(dir);
    } catch {
      // indexing is best-effort
    }
    setBusy(null);
  }

  async function proposeEdit() {
    if (!rootDir || !activeFile || !instruction.trim()) return;
    setError(null);
    setBusy('Calling OpenAI...');
    try {
      const out = await window.api.aiProposeEdit({ rootDir, filePath: activeFile, instruction });
      setProposed(out);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function applyEdit() {
    if (!rootDir || !activeFile || !proposed) return;
    setError(null);
    setBusy('Writing file + committing...');
    try {
      await window.api.writeFile(activeFile, proposed.after);
      await window.api.gitCommitAll(rootDir, `[AI] ${instruction.slice(0, 72)}`);
      setProposed(null);
      setInstruction('');
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ width: 320, borderRight: '1px solid #ddd', padding: 10, overflow: 'auto' }}>
        <button onClick={openProject}>Open Folder</button>
        <div style={{ marginTop: 10, fontSize: 12, color: '#555' }}>
          {rootDir ? `Project: ${rootDir}` : 'No project open'}
        </div>

        <hr />
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Files</div>
        {files.slice(0, 500).map(f => (
          <div
            key={f}
            onClick={() => setActiveFile(f)}
            style={{
              cursor: 'pointer',
              padding: '4px 6px',
              borderRadius: 6,
              background: f === activeFile ? '#eef' : 'transparent',
              fontSize: 12,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={f}
          >
            {rel(f)}
          </div>
        ))}
      </div>

      <div style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={instruction}
            onChange={e => setInstruction(e.target.value)}
            placeholder="Tell AI what to change in the selected file..."
            style={{ flex: 1, padding: 10, border: '1px solid #ccc', borderRadius: 8 }}
          />
          <button disabled={!rootDir || !activeFile || !instruction.trim() || !!busy} onClick={proposeEdit}>
            Propose
          </button>
        </div>

        {busy && (
          <div style={{ padding: 10, background: '#fff7d6', border: '1px solid #f1d27a', borderRadius: 8 }}>{busy}</div>
        )}
        {error && (
          <div style={{ padding: 10, background: '#ffe8ea', border: '1px solid #ffb3ba', borderRadius: 8, whiteSpace: 'pre-wrap' }}>
            {error}
          </div>
        )}

        <div style={{ fontSize: 12, color: '#444' }}>
          Active file: <b>{activeFile ? rel(activeFile) : '(none)'}</b>
        </div>

        {proposed ? (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setProposed(null)}>Discard</button>
              <button onClick={applyEdit}>Apply + Commit</button>
            </div>
            <DiffView patches={proposed.patches} />
          </>
        ) : (
          <div style={{ flex: 1, border: '1px dashed #ccc', borderRadius: 8, padding: 12, color: '#666' }}>
            Propose an edit to see a diff here.
          </div>
        )}
      </div>
    </div>
  );
}
