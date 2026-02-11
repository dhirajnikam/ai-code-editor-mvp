export type ImportGraph = {
  version: 1;
  rootDir: string;
  generatedAt: string;
  files: Record<string, { imports: string[] }>;
};
