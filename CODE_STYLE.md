# Code Style & Engineering Conventions

Guidelines for authoring code in Assettlor. Agents and developers must adhere to these conventions when contributing changes.

---

## 1. TypeScript & Module System

- **Target & Runtime**: NodeNext module resolution with ES2022+ target.
- **ESM Relative Imports**: All relative imports in `server/`, `shared/`, and `scripts/` **must** include the explicit `.js` extension:
  ```ts
  // Correct
  import { getDatabase } from '../db/database.js';
  import { Asset } from '../../shared/types.js';

  // Incorrect (will fail at runtime under Node ESM)
  import { getDatabase } from '../db/database';
  ```
- **Path Aliases**:
  - `@shared/*` maps to `shared/*` in root and client.
  - `@/*` maps to `client/src/*` in client.
- **Strict Typing**:
  - Maintain `strict: true`. Avoid `any`; use typed domain interfaces from `shared/types.ts`.
  - Type DB query outputs with explicit interfaces (e.g. `as { count: number }`).

---

## 2. Backend Patterns (Fastify & SQLite)

- **Layered Architecture**:
  - **Routes (`server/src/routes/`)**: Responsible only for HTTP parameter parsing, validation, and invoking services. Keep routes thin.
  - **Services (`server/src/services/`)**: Encapsulate all business logic (scanning, stacking, image manipulation, audio extraction, copying).
  - **Database (`server/src/db/database.ts`)**: Centralizes SQLite connection, schema migrations, and queries. Do not create ad-hoc database connections in routes.
- **SQLite & Transactions**:
  - Always use prepared statements (`db.prepare(...)`) to guard against injection and maximize throughput.
  - Wrap multi-statement inserts or updates in `db.transaction(...)`.
  - WAL mode (`PRAGMA journal_mode = WAL;`) is mandatory for high-concurrency local reading.
- **File & Stream Handling**:
  - Stream large files via `fs.createReadStream` supporting HTTP 206 Partial Content range requests (see `routes/assets.ts`).
  - Virtual zip entries must be extracted directly to memory buffers via AdmZip; never write temporary files to disk during inspection or streaming.

---

## 3. Frontend Patterns (React 19, Vite & Tailwind)

- **Components**: Functional components in `client/src/components/`. Use descriptive PascalCase names.
- **Styling**: Tailwind CSS v4 utility classes.
  - Use `clsx` and `tailwind-merge` when combining dynamic class names.
  - Adhere to the dark slate aesthetic (`#141420`, `#1a1a2e`, `#252538`).
- **Hooks & State**:
  - Adhere strictly to React 19 hook guidelines.
  - Avoid calling `setState` synchronously within `useEffect` if the state can be derived during rendering.
  - Ensure all hook dependencies are correctly declared in dependency arrays.
- **Linting**:
  - Oxlint is the project linter: run `npm --prefix client run lint`.
  - Changes must introduce zero errors and avoid adding new lint warnings.

---

## 4. Error Handling & Logging

- **Server Errors**: Return structured JSON error objects `{ error: string, details?: unknown }` with proper HTTP status codes (`400`, `404`, `500`).
- **Silent Failures**: Avoid empty `catch {}` blocks. If an error is safely ignorable (e.g., thumbnail extraction on unsupported formats), log a debug/warn trace or document why it is ignored.

---

## 5. Testing Conventions (Vitest)

- Test files reside in `tests/` named `<module>.test.ts`.
- Use test fixtures and helpers in `tests/helpers.ts` (`createTempDir`, `cleanupTempDir`, `createTestZipArchive`, `TINY_PNG_BUFFER`).
- Always clean up temporary directories and close database instances in test teardowns (`afterEach` or `afterAll`).

---

## 6. Pre-Commit Verification Checklist

Before finalizing any changes, verify:
1. `npm test` passes completely (10+ test suites, 95+ tests).
2. `npm run build` succeeds (client bundle compiles without TypeScript errors).
3. `npm --prefix client run lint` reports 0 errors.
4. `npm run test:pipeline` passes if modifying scanner, stacker, or copier logic.
