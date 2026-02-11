# AI Code Editor MVP

A minimal working prototype:

- Open a folder
- Pick a file
- Give an instruction
- Calls OpenAI (via your key)
- Shows a diff
- Applies changes + commits to Git

## Setup

```bash
npm install
cp .env.example .env
# put your OPENAI_API_KEY in .env
```

## Run (dev)

```bash
npm run dev
```

## Notes

- This is an MVP; no Neo4j yet.
- Keys are loaded from `.env` and are ignored by git.
