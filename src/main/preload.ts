import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  openFolder: () => ipcRenderer.invoke('project:openFolder'),
  listFiles: (rootDir: string) => ipcRenderer.invoke('project:listFiles', rootDir),
  indexProject: (rootDir: string) => ipcRenderer.invoke('project:index', rootDir),
  readFile: (filePath: string) => ipcRenderer.invoke('file:read', filePath),
  writeFile: (filePath: string, content: string) => ipcRenderer.invoke('file:write', filePath, content),
  gitInitIfNeeded: (rootDir: string) => ipcRenderer.invoke('git:initIfNeeded', rootDir),
  gitCommitAll: (rootDir: string, message: string) => ipcRenderer.invoke('git:commitAll', rootDir, message),
  aiProposeEdit: (args: { rootDir: string; filePath: string; instruction: string; }) => ipcRenderer.invoke('ai:proposeEdit', args),
});
