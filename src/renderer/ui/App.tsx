import React, { useMemo, useState } from 'react';
import { DiffView } from './DiffView';

type Tab = 'code' | 'chat';

export function App() {
  const [tab, setTab] = useState<Tab>('code');

  const [brainUrl, setBrainUrl] = useState<string>(() => {
    return localStorage.getItem('aice.brainUrl') || 'http://127.0.0.1:8099';
  });
  const [brainHealth, setBrainHealth] = useState<any>(null);

  const [rootDir, setRootDir] = useState<string | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [proposed, setProposed] = useState<null | { before: string; after: string; patches: any[] }>(null);
  const [proposedMulti, setProposedMulti] = useState<null | { files: Array<{ filePath: string; before: string; after: string; patches: any[] }>; plan: any }>(null);
  const [activeProposedFile, setActiveProposedFile] = useState<string | null>(null);
  const [trace, setTrace] = useState<any>(null);

  const [chatInput, setChatInput] = useState('');
  const [chat, setChat] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);

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

  async function refreshBrainHealth(nextUrl?: string) {
    const url = (nextUrl ?? brainUrl).trim();
    if (!url) return;
    setError(null);
    setBusy('Checking brain server...');
    try {
      const h = await window.api.brainHealth(url);
      setBrainHealth(h);
    } catch (e: any) {
      setBrainHealth(null);
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function proposeEdit() {
    if (!rootDir || !activeFile || !instruction.trim()) return;
    setError(null);
    setProposed(null);
    setProposedMulti(null);
    setActiveProposedFile(null);

    setBusy('Retrieving brain trace...');
    let contextPack: string | undefined = undefined;
    try {
      // Ask the brain for retrieval trace; we also pass context_pack into multi-file proposing.
      try {
        const currentRel = rootDir ? rel(activeFile) : activeFile;
        const r = await window.api.brainRetrieve(brainUrl, { query: instruction, current_file: currentRel, mode: 'balanced', priority: 'quality' });
        setTrace(r);
        contextPack = r?.context_pack;
      } catch {
        setTrace(null);
      }

      setBusy('Calling OpenAI (multi-file)...');
      const out = await window.api.aiProposeEditsMulti({ rootDir, entryFilePath: activeFile, instruction, contextPack, fileLimit: 8 });
      setProposedMulti(out);
      setActiveProposedFile(out.files[0]?.filePath ?? null);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  async function applyEdit() {
    if (!rootDir || !instruction.trim()) return;

    // multi-file apply
    if (proposedMulti?.files?.length) {
      setError(null);
      setBusy('Creating branch...');
      try {
        const slug = instruction.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
        const branch = `ai/${Date.now()}-${slug || 'multi'}`;
        await window.api.gitCreateBranch(rootDir, branch);

        setBusy('Writing files...');
        for (const f of proposedMulti.files) {
          await window.api.writeFile(f.filePath, f.after);
        }

        setBusy('Committing...');
        await window.api.gitCommitAll(rootDir, `[AI][multi] ${instruction.slice(0, 72)} (files: ${proposedMulti.files.length})`);

        setProposedMulti(null);
        setActiveProposedFile(null);
        setInstruction('');
        return;
      } catch (e: any) {
        setError(String(e?.message ?? e));
      } finally {
        setBusy(null);
      }
    }

    // single-file fallback
    if (!activeFile || !proposed) return;
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

  async function sendChat() {
    const q = chatInput.trim();
    if (!q) return;
    setError(null);
    setBusy('Retrieving...');
    setChat(c => [...c, { role: 'user', text: q }]);
    setChatInput('');
    try {
      const out = await window.api.brainRetrieve(brainUrl, { query: q, current_file: activeFile && rootDir ? rel(activeFile) : undefined, mode: 'balanced', priority: 'quality' });
      setTrace(out);
      const answer = out?.answer || out?.raw_answer || '(no answer field returned)';
      setChat(c => [...c, { role: 'assistant', text: String(answer) }]);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  }

  function TopBar() {
    return (
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 10, borderBottom: '1px solid #ddd' }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => setTab('code')} disabled={tab === 'code'}>Code</button>
          <button onClick={() => setTab('chat')} disabled={tab === 'chat'}>Chat</button>
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: '#555' }}>Brain:</span>
          <input
            value={brainUrl}
            onChange={e => {
              const v = e.target.value;
              setBrainUrl(v);
              localStorage.setItem('aice.brainUrl', v);
            }}
            style={{ width: 260, padding: 6, border: '1px solid #ccc', borderRadius: 8, fontSize: 12 }}
            placeholder="http://<server>:8099"
          />
          <button onClick={() => refreshBrainHealth()} disabled={!!busy}>Test</button>
          <span style={{ fontSize: 12, color: brainHealth?.ok ? '#0a0' : '#a00' }}>
            {brainHealth?.ok ? 'OK' : '—'}
          </span>
        </div>
      </div>
    );
  }

  function LeftRail() {
    return (
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
    );
  }

  function TracePanel() {
    if (!trace) {
      return (
        <div style={{ flex: 1, border: '1px dashed #ccc', borderRadius: 8, padding: 12, color: '#666' }}>
          No trace yet.
        </div>
      );
    }

    const intent = trace?.trace?.intent;
    const traversal = trace?.trace?.traversal;
    const selection = trace?.trace?.selection;

    return (
      <div style={{ flex: 1, border: '1px solid #ddd', borderRadius: 8, padding: 10, overflow: 'auto' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Decision / Trace</div>

        <div style={{ fontSize: 12, color: '#333' }}>
          <div><b>Model:</b> {trace.model} · <b>Mode:</b> {trace.mode} · <b>Priority:</b> {trace.priority} · <b>Budget:</b> {trace.token_budget}</div>
        </div>

        <hr />

        <div style={{ fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Intent</div>
          <pre style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(intent ?? {}, null, 2)}</pre>
        </div>

        <hr />

        <div style={{ fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Traversal</div>
          <pre style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(traversal ?? {}, null, 2)}</pre>
        </div>

        <hr />

        <div style={{ fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Selection</div>
          <pre style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>{JSON.stringify(selection ?? [], null, 2)}</pre>
        </div>

        <hr />

        <div style={{ fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>Context Pack</div>
          <details>
            <summary style={{ cursor: 'pointer' }}>Show</summary>
            <pre style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>{trace.context_pack ?? ''}</pre>
          </details>
        </div>
      </div>
    );
  }

  function CodeTab() {
    return (
      <>
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

        <div style={{ fontSize: 12, color: '#444' }}>
          Active file: <b>{activeFile ? rel(activeFile) : '(none)'}</b>
        </div>

        <div style={{ display: 'flex', gap: 12, minHeight: 0, flex: 1 }}>
          <div style={{ flex: 2, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {proposedMulti?.files?.length ? (
              <>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button onClick={() => { setProposedMulti(null); setActiveProposedFile(null); }}>Discard</button>
                  <button onClick={applyEdit}>Apply + Commit</button>
                  <span style={{ fontSize: 12, color: '#555' }}>Files: {proposedMulti.files.length}</span>
                </div>

                <div style={{ display: 'flex', gap: 10, minHeight: 0, flex: 1 }}>
                  <div style={{ width: 240, border: '1px solid #ddd', borderRadius: 8, overflow: 'auto' }}>
                    {proposedMulti.files.map(f => (
                      <div
                        key={f.filePath}
                        onClick={() => setActiveProposedFile(f.filePath)}
                        style={{
                          cursor: 'pointer',
                          padding: '6px 8px',
                          borderBottom: '1px solid #eee',
                          background: f.filePath === activeProposedFile ? '#eef' : 'transparent',
                          fontSize: 12,
                        }}
                        title={f.filePath}
                      >
                        {rootDir ? rel(f.filePath) : f.filePath}
                      </div>
                    ))}
                  </div>

                  <div style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
                    {(() => {
                      const cur = proposedMulti.files.find(x => x.filePath === activeProposedFile) ?? proposedMulti.files[0];
                      return cur ? <DiffView patches={cur.patches} /> : null;
                    })()}
                  </div>
                </div>
              </>
            ) : proposed ? (
              <>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setProposed(null)}>Discard</button>
                  <button onClick={applyEdit}>Apply + Commit</button>
                </div>
                <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                  <DiffView patches={proposed.patches} />
                </div>
              </>
            ) : (
              <div style={{ flex: 1, border: '1px dashed #ccc', borderRadius: 8, padding: 12, color: '#666' }}>
                Propose an edit to see a diff here.
              </div>
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <TracePanel />
          </div>
        </div>
      </>
    );
  }

  function ChatTab() {
    return (
      <>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            placeholder="Ask the brain..."
            style={{ flex: 1, padding: 10, border: '1px solid #ccc', borderRadius: 8 }}
            onKeyDown={e => {
              if (e.key === 'Enter') sendChat();
            }}
          />
          <button disabled={!chatInput.trim() || !!busy} onClick={sendChat}>Send</button>
        </div>

        <div style={{ display: 'flex', gap: 12, minHeight: 0, flex: 1 }}>
          <div style={{ flex: 2, minWidth: 0, border: '1px solid #ddd', borderRadius: 8, padding: 10, overflow: 'auto' }}>
            {chat.length === 0 ? (
              <div style={{ color: '#666' }}>No messages yet.</div>
            ) : (
              chat.map((m, i) => (
                <div key={i} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 12, color: '#555' }}>{m.role}</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
                </div>
              ))
            )}
          </div>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <TracePanel />
          </div>
        </div>
      </>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      <TopBar />
      {busy && (
        <div style={{ padding: 10, background: '#fff7d6', borderBottom: '1px solid #f1d27a' }}>{busy}</div>
      )}
      {error && (
        <div style={{ padding: 10, background: '#ffe8ea', borderBottom: '1px solid #ffb3ba', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <LeftRail />
        <div style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0 }}>
          {tab === 'code' ? <CodeTab /> : <ChatTab />}
        </div>
      </div>
    </div>
  );
}
