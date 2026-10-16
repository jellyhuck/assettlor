#!/usr/bin/env node

// Entry point for `npx github:jellyhuck/assettlor` and global installs. The
// server runs from TypeScript source through tsx, as `npm start` does.
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

// Use the package's tsconfig rather than one found from the caller's cwd.
register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) });

const { runCli } = await import('../server/src/index.ts');

await runCli();
