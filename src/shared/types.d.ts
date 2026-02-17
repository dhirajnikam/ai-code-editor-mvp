declare global {
  interface Window {
    api: {
      openFolder(): Promise<string | null>;
      listFiles(rootDir: string): Promise<string[]>;
      indexProject(rootDir: string): Promise<{ ok: boolean; filesIndexed: number }>; 
      readFile(filePath: string): Promise<string>;
      writeFile(filePath: string, content: string): Promise<boolean>;
      gitInitIfNeeded(rootDir: string): Promise<boolean>;
      gitCommitAll(rootDir: string, message: string): Promise<any>;
      aiProposeEdit(args: { rootDir: string; filePath: string; instruction: string; }): Promise<{ before: string; after: string; patches: Array<{added:boolean;removed:boolean;value:string}> }>;

      brainHealth(brainUrl: string): Promise<any>;
      brainRetrieve(brainUrl: string, body: any): Promise<any>;
      brainGraph(brainUrl: string): Promise<any>;

      localSearch(rootDir: string, query: string, limit?: number): Promise<Array<{ file: string; line: number; text: string }>>;
    }
  }
}
export {};
