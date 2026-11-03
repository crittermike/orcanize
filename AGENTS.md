# AGENTS.md

Guidance for agents working on this app.

## App overview

- This is a Vite + React 18 + TypeScript + Tailwind v4 frontend with a Node 24 Express + `ws` backend.
- The app is a realtime allocation planner: people, projects, two-week iterations, assignment chips, week notes, and quarter-level capacity planning (engineering-month estimates vs. computed capacity).
- The server stores each plan as one JSON blob in SQLite (`plans.state`) and broadcasts full-state updates over WebSockets to everyone watching the same slug.
- Production is a single Docker container: the server serves `/api`, `/ws`, and the built frontend from `dist/`.

## Common commands

- Install dependencies: `npm install`
- Local dev: `npm run dev` (Vite on :5173, server on :8787; Vite proxies `/api` and `/ws`)
- Typecheck + production build: `npm run build`
- Production server: `npm start`
- Deploy: automatic on every push to `main` after CI passes (`deploy` job in `.github/workflows/ci.yml`, uses the `FLY_API_TOKEN` repo secret). Manual: `~/.fly/bin/flyctl deploy` (Fly.io app is `allocation-planner`; `fly deploy` works if `flyctl` is on PATH)

Run `npm run build` before claiming code changes are complete — it both typechecks (`tsc -b`) and bundles. Run `npm test` for unit and server tests (`node --test test/*.test.ts`; `test/server.test.ts` starts the real server on a temp `DATA_DIR` with no GitHub token). Run `npm run test:e2e` for the Playwright smoke test (needs `npm run build` first and `npx playwright install chromium` once). There is no lint script. GitHub Actions (`.github/workflows/ci.yml`) runs the build, `npm test`, and the smoke test on every push to `main` and on every PR, then deploys `main` to Fly only if all pass.

## Important files

### Frontend
- `src/main.tsx`, `src/App.tsx`, `src/router.ts`: bootstrap, slug-based routing (`/` → Home, `/<slug>` → Plan, `/<slug>/p/<projectId>` → Plan with that project's editor open). Router is a tiny `pushState`/`popstate` hook plus a custom `app-navigate` event, with `searchParam`/`replaceSearchParam` helpers. While a project editor is open, `PlanView` keeps the address bar at its link with `history.replaceState` (no new history entries).
- `src/Home.tsx`: landing page — list of recent plans (from `/api/plans`), recently visited slugs (via `localStorage`), and the "new plan" form.
- `src/visited.ts`: `localStorage`-backed record of slugs this browser has opened (for the Home page recents list).
- `src/Plan.tsx`: main planner UI (~3.8k lines). Owns chart rendering in both orientations (`Chart` = people-as-rows, `ChartTransposed` = weeks-as-rows), drag/drop assignment behavior, projects table with DRI column and drag-to-reorder, the projects flyout (which embeds the capacity bars), per-week notes modal, and most local UI preferences (`localStorage`).
- `src/Capacity.tsx`: capacity-planning surface — `CapacityBars` (Estimate + Actual stacked bars), `QuarterModal` (engineers / weeks / first-responder weeks / buffer rows), `PrioritizationTable` (top-level orchestrator, "show what fits" mode), `DescopedDrawer`, and `exportPlanMarkdown`.
- `src/capacityShared.tsx`: single source of truth for capacity math. Exports `deriveCapacity(state)` which returns `CapacityInfo` (capacityEM, demandEM, gap, plannedByProject, frWeeksInPlan, etc.), plus the `WEEKS_PER_EM = 4` constant and the sentinel-id helpers. All capacity consumers (bars, projects table, markdown export) must read from `deriveCapacity` to avoid formula drift.
- `src/ProjectModal.tsx`: project edit modal, `ColorPopover`, and `EmPicker` (chip-style EM picker plus "weeks × engineers" auto-convert). Exports `EM_CHIPS` (must stay in sync with what `Capacity.tsx` displays). Has a Milestones section (name, ship date, assignment-weeks, remove; GitHub epic milestones found by `ScopePanel` are synced automatically via `syncGitHubMilestones`). Widens to two columns with `ScopePanel` when the project URL is a GitHub issue the server can read (`scopeSourceFor`).
- `src/scope.ts`: scope tracking for projects whose URL is a GitHub issue — URL parsing, snapshot types, `trackingFromHistory` (rebuilds snapshots from GitHub's history of sub-issues added/removed and issues closed/reopened), the counting rules (leaf sub-issues only; not planned/duplicate is removal, not completion), change detection, creep (new issues after work starts; splits and moves between milestones don't count), pace blending from finished milestones, and forecasts (`analyzeScope`, `projectFinish`, `maxCreepForTarget`). Epics get one view per milestone and no combined forecast. All scope numbers must come from here.
- `src/ScopePanel.tsx`: the project modal's scope view (milestone table for epics, verdict, burn-up chart, creep slider forecast with break-even against the release date, changes, remaining). Loads GitHub data through `src/scopeApi.ts`; a GitHub milestone's target is the ship date of this project's milestone with the same issue URL, else the release date of the plan project linked to that issue. Reports the epic's milestones (`onMilestonesFound`) so the modal can import them. Display names come from `milestoneNames` in `scope.ts`, which drops shared leading words without splitting bracketed tags (`[3232 M1] Title` → `M1: Title`).
- `src/scopeApi.ts`: `/api/config` (whether the server has a GitHub token, and its repo allowlist) and the scope endpoints, sent with the plan's unlock token.
- `src/scopeDemo.ts`: one fictional epic (`acme-demo/invoice-exports` #700, milestones #701–#706) with a scenario switcher, for UI work without a token. Dev builds only (`import.meta.env.DEV`); tree-shaken out of production. Never mix demo data with real GitHub observations.
- `src/usePlan.ts`: HTTP/WS plan loading, optimistic local updates, debounced syncing (`SEND_DEBOUNCE_MS = 120`), reconnect behavior, visit tracking, password unlock/change, and the `migrateState` shim that upgrades older saved plans on read.
- `src/milestones.ts`: pure helpers for project milestones — slot uniqueness (`sameSlot`), retargeting and removing milestones without orphaning assignments, migration sanitizers, URL-deduped import, and `releasesByWeek` (project and milestone ship dates per chart week, calendar-day arithmetic).
- `src/useModalFocus.ts`: focus trap and focus return for modals (`role="dialog"`, `aria-modal`). Use it for new modals.
- `src/types.ts`: shared plan data shapes (`PlanState`, `Project`, `Quarter`, `Buffer`, etc.).
- `src/styles.css`: small custom CSS layered on top of Tailwind v4.

### Backend / infra
- `server/index.js`: SQLite schema + migrations (password columns are idempotent `ALTER TABLE`s), REST API, static frontend serving, WebSocket room management (one room per slug), and the initial plan state used when a new plan is created. Loads `.env` from the repo root when present.
- `server/scope.js`: GitHub connector for scope tracking. Reads an issue's sub-issue tree and each issue's history over GraphQL with `GITHUB_TOKEN` (a milestone's small parent epic is fetched too, for moves and finished milestones' pace), caches the last complete result per issue in the `scope_cache` table, and refreshes in the background after 15 minutes. Partial or failed fetches never replace cached data.
- `Dockerfile`, `fly.toml`: Fly.io deployment and production container setup. `min_machines_running = 1` keeps WS reconnects snappy.
- `.github/workflows/ci.yml`: typecheck, build, unit/server tests, and Playwright smoke test (`e2e/`, Chromium only) on push to `main` and on PRs; deploys `main` to Fly after they pass.

## State and sync notes

- The persisted `PlanState` shape (see `src/types.ts`): `title`, `people`, `projects`, `iterations`, `assignments`, optional `weekNotes`, optional `quarter`.
- Capacity-planning project fields are all optional and additive: `estimateEM` (engineering-months), `priority`, `descoped`, `driId`, `url`, `notes`. Older saved plans without them keep working.
- `Project.releaseDate` is an optional communicated ship date (`YYYY-MM-DD`), independent of assignments. Group active projects into Monday-Sunday release weeks using calendar-day arithmetic, not elapsed milliseconds, so DST cannot shift a release into the wrong week.
- `Project.milestones` is an optional ordered list of `Milestone` (`{ id, name, releaseDate?, url? }`; `url` is the GitHub milestone sub-issue when imported from scope tracking). `Assignment.milestoneId` optionally points at a milestone of the assignment's `projectId`. Assignments are unique per person, week, project, and milestone ("no milestone" is its own slot); use `sameSlot`. Milestone assignments still count toward their project — capacity keys on `projectId` and must not count milestones separately. Removing a milestone keeps its assignments as plain project work. `migrateState` drops malformed milestones and any `milestoneId` that no longer matches its project.
- Project and milestone ship dates appear as plain text under each week's date in the week header, like calendar events (`WeekReleases` in `src/Plan.tsx`); weeks with more than three fold the rest into "+N more". Late or at-risk forecasts color the text (late also shows "→ finish"). Descoped projects are excluded. Build the per-week grouping with `releasesByWeek` in `src/milestones.ts`.
- Scope milestone breakdowns and GitHub milestone import use only direct sub-issues with `issueType === 'Batch'`, including empty batches. Keep other sub-issues in the outside-milestones count; do not infer milestone status from titles or nested sub-issues.
- `Quarter` carries the planning inputs: `engineers`, `weeksInQuarter`, `firstResponderWeeks`, `weeksPerEM`, and a list of `Buffer` rows (`{ id, label, pct, note? }`). `weeksPerEM` is always forced to the canonical `WEEKS_PER_EM = 4` when read, so any stale override is ignored.
- Pure UI preferences belong in `localStorage`, not in `PlanState`, unless they're explicitly meant to sync across users. Existing examples live in `src/Plan.tsx`.
- `setState` from `usePlan` updates locally first, then sends the whole state over WS after a short debounce. Sends wait for the server's `hello` so it can't overwrite an earlier edit. WebSocket updates are last-write-wins at the full-state level — avoid making unrelated state rewrites in UI handlers, and never read-modify-write off stale local state.
- Plan state migrations belong in `migrateState` in `src/usePlan.ts` (run on every load). When you change `PlanState`, add a migration there for older saved plans.
- Assignment week IDs are derived from iteration IDs as `` `${iterationId}:0` `` and `` `${iterationId}:1` `` — changing an iteration's start date must not change its ID (assignments would be orphaned).
- Capacity math: never recompute capacity / demand / gap / planned-per-project inline. Call `deriveCapacity(state)` from `src/capacityShared.tsx`.

## Sentinel project IDs

Some `Assignment.projectId` values are reserved sentinels. They represent non-project work, must **not** appear in `state.projects`, and are excluded from planned-EM totals via `isSentinel()` in `capacityShared.tsx`:

- `__pto__` — vacation / time off
- `__fr__` — first-responder duty (capacity already deducts `quarter.firstResponderWeeks`; the modal surfaces any mismatch between plan and config)
- `__unavailable__` — person not on the team that week

When adding new non-project assignment types, add a new sentinel ID and update `isSentinel`.

## UI conventions

- Styling is Tailwind v4 utility classes, mostly inline in JSX.
- Keep edits surgical in `src/Plan.tsx` and `src/Capacity.tsx`; both are large.
- When adding chart behavior, check both orientations (`Chart` and `ChartTransposed` in `src/Plan.tsx`).
- Project color chips should use `inkFor(project.color)` for readable foreground text. The `PALETTE_BG` array in `Capacity.tsx` and the `COLORS` array in `ProjectModal.tsx` must stay in sync.
- The capacity bars and the "show what fits" toggle live inside the projects flyout — no separate capacity tab.

## Password protection

- Plans can optionally have a password. Server columns: `password_hash`, `password_version` (idempotent migrations on startup).
- Unlock tokens are HMAC-signed with a per-install secret persisted to `${DATA_DIR}/.token-secret` (or `PLAN_TOKEN_SECRET` env var). Tokens are stored client-side in `localStorage` under `plan-token:<slug>`.
- All password-related flows (`submitPassword`, `changePassword`, `passwordRequired`) are in `src/usePlan.ts`.
- Without a password set, plans remain fully open — anyone with the URL can view and edit.

## GitHub scope tracking

- Enabled only when the server has `GITHUB_TOKEN` (a fine-grained, read-only Issues token). `GITHUB_SCOPE_REPOS` optionally limits which repos it reads. Never put the token in browser code or a committed file; locally it lives in the gitignored `.env`.
- `/api/plans/:slug/scope?url=…` (and `POST …/scope/refresh`) only serve issues that a project in that plan links to, and use the plan's password check, so the server's token can't be used to read arbitrary issues.
- The server only fetches and caches GitHub's history (`ScopeHistory`). All counting and forecasting runs in the browser through `src/scope.ts`, so demo data and real data share one code path.
- Scope is measured in points: each issue's `Points` field from any GitHub project board it's on (read by `server/scope.js` in a separate query), defaulting to `DEFAULT_POINTS = 3` via `pointsOf` in `src/scope.ts`. If the token can't read projects, scope still loads and every issue counts as 3, with a warning. Fine-grained tokens need org Projects read access.
- A milestone's status pill and headline use `targetStatus` from `src/scope.ts`: a forecast that misses its ship date shows Late or At risk instead of a good pace status.
- The projects list marks a project "Done" when its linked issue is closed as completed (`issueCompleted` in `src/scope.ts`, `useDoneProjects` in `src/releaseForecasts.ts`), using the same cached scope responses as release forecasts.
- Count completions from each issue's close reason. GitHub's `subIssuesSummary.completed` counts "not planned" closures as completed.
- `ScopePanel` reports `loading` / `content` / `none` to the project modal. The modal widens only for `content`, or right away while loading if the link names a milestone or this browser saw scope for the issue before (`scope-seen-v1` in `localStorage`); otherwise it shows "Loading scope…" in its header. Selecting a milestone writes `?milestone=<issue number>` to the URL.

## Data and deployment cautions

- SQLite data lives in `./data/gantt.db` locally and `/data/gantt.db` on Fly.io. Override with `DATA_DIR=…`.
- Fly.io uses a persistent volume mounted at `/data`; do not remove or rename the mount, or rotate `PLAN_TOKEN_SECRET`, without a migration plan (rotating the secret invalidates all outstanding unlock tokens).
- Do not commit local database files from `data/`.
- The app has no global login/auth. Per-plan password protection is opt-in; otherwise anyone with a plan URL can view and edit.
