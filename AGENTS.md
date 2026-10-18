# Agent instructions

## Repository shape

- This is a pnpm workspace (`apps/*`, `packages/*`, `ee/apps/*`, `ee/packages/*`) plus a separate `evals/` pnpm workspace. The main product surfaces are `apps/app` (Vite UI), `apps/desktop` (Electron shell), `apps/server` (filesystem-backed server), and `ee/apps/den-*` (Den control plane).
- Use the root toolchain: Node 24, pnpm 11.4.0, and Bun 1.3.10+. Use `pnpm`, never npm or yarn; run `pnpm install --frozen-lockfile` from the root. `evals/` also needs `pnpm --dir evals install`.
- `packages/sdk` is generated from the Den API. After changing the API or SDK inputs, run `pnpm sdk:generate`, then `pnpm sdk:check`; do not hand-edit generated SDK output.
- Den DB schema changes require a migration: run `pnpm --filter @omnirush-ee/den-db db:generate` and commit the generated files under `ee/packages/den-db/drizzle`.

## Commands

- Desktop development: `pnpm dev` (or `pnpm dev:worktree` for an isolated profile). UI-only: `pnpm dev:ui`. Headless web: `pnpm world up dev-headless --detach`; stop it with `pnpm world down dev-headless` and inspect `tmp/dev-headless-web.json` for its manifest.
- Main checks: `pnpm typecheck`, `pnpm test:core`, and `pnpm --filter @mars/desktop typecheck:electron`. The full product suite is `pnpm test:extended` and is substantially more expensive.
- Focused checks use package scripts: `pnpm --filter @mars/app test:core`, `pnpm --filter mars-server test:core`, `pnpm --filter @mars/desktop test:core`, or `pnpm --filter @omnirush-ee/den-api test`. For one Bun test, run the package's script with the test path, e.g. `pnpm --filter @mars/app exec bun test tests/<file>.test.ts`.
- Journey proof lives in `evals/specs/**` or `scenarios/<name>/*.e2e.test.ts`; unit tests are not proof. Run a selected journey with `pnpm evals:e2e <slug>` or a PR spec with `pnpm evals:pr specs/<name>.test.ts`. Load the repository skills `write-a-spec`, `run-tests`, `diagnose-a-red-run` (only when red), and `publish-evidence` as applicable.
- `evals` is independently checked: `pnpm --dir evals run lint:layers`, `pnpm evals:typecheck`, and `pnpm --dir evals test`. E2E placement is printed by the CLI; named runs can use `--local` or `--daytona`.
- Local Den development requires MySQL and Redis: `pnpm dev:den:mysql`, `pnpm dev:den:db-push`, then use the relevant `pnpm dev:den:api` / `pnpm dev:den:web` scripts. These scripts provide local development defaults; do not reuse them for production.

## Change constraints

- Keep diffs small and do not add a new test file when an existing journey covers the behavior; extend the existing journey instead. Runtime-observable changes need observable journey assertions and published evidence. Skips are not passes.
- TypeScript uses strict typing: do not introduce `any` or unnecessary type assertions. Follow existing React/Tailwind/shadcn patterns and reuse shared components.
- Never commit secrets, credentials, personal data, or customer/partner identities. Public branch names, commits, PRs, fixtures, and evidence must use internal ticket IDs or neutral names.
- Every commit must be DCO signed (`git commit -s`). Contributions under `ee/` additionally require the applicable CLA; see `CONTRIBUTING.md`.
- For previews, use `.opencode/skills/preview-my-work/SKILL.md`; do not improvise a shared running environment. Repo-local OpenCode configuration is `.opencode/opencode.json`.
