import fs from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { diffLines } from 'diff';
import { simpleGit } from 'simple-git';
import { OpenAI } from 'openai';

dotenv.config();

async function main() {
  const [rootDir, filePath, ...rest] = process.argv.slice(2);
  const instruction = rest.join(' ').trim();
  if (!rootDir || !filePath || !instruction) {
    console.error('Usage: tsx tools/propose-edit.ts <repoRoot> <filePath> <instruction...>');
    process.exit(2);
  }

  const absFile = path.isAbsolute(filePath) ? filePath : path.join(rootDir, filePath);
  const before = await fs.readFile(absFile, 'utf8');

  let after = '';

  if (process.env.MOCK_LLM === '1') {
    after = before + `\n\n// [MOCK_AI_EDIT] ${instruction}\n`;
  } else {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set (or set MOCK_LLM=1)');
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

    const client = new OpenAI({ apiKey });

    const system = [
      'You are an AI code editor. Return ONLY the full updated file content.',
      'Follow existing style. Do not add unrelated changes.',
    ].join('\n');

    const user = [
      `Instruction: ${instruction}`,
      `File: ${path.basename(absFile)}`,
      '--- CURRENT CONTENT ---',
      before,
      '--- END ---',
    ].join('\n');

    const resp = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
    });

    after = resp.choices[0]?.message?.content ?? '';
  }

  const patches = diffLines(before, after);
  const changed = patches.some(p => p.added || p.removed);

  console.log('--- DIFF ---');
  for (const p of patches) {
    const prefix = p.added ? '+ ' : p.removed ? '- ' : '  ';
    for (const line of p.value.split('\n')) {
      if (!line) continue;
      console.log(prefix + line);
    }
  }

  if (!changed) {
    console.log('No changes.');
    return;
  }

  if (process.env.APPLY !== '1') {
    console.log('\nSet APPLY=1 to write + commit.');
    return;
  }

  await fs.writeFile(absFile, after, 'utf8');
  const git = simpleGit({ baseDir: rootDir });
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    await git.init();
  }
  await git.add(path.relative(rootDir, absFile));
  await git.commit(`[AI] ${instruction.slice(0, 72)}`);
  console.log('Applied + committed.');
}

main().catch((e) => {
  console.error(String(e?.stack ?? e));
  process.exit(1);
});
