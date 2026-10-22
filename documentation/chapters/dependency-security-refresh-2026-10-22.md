---
part: Runtime
status: shipped
updated: 2026-10-22
---
# Dependency security refresh (2026-10-22)

All affected packages are dev dependencies (type check, lint tooling, bundler). The
plugin bundle `main.js` does not ship them.

## Audit
`npm audit`: before high 9, moderate 3 (12 total); after 0 vulnerabilities.

## What changed (`package.json` and `package-lock.json`)
| Package | From | To | Why |
|---|---|---|---|
| `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin` | 5.29.0 | 8.72.0 | drops the vulnerable braces/micromatch/fast-glob/globby chain and the typescript-eslint highs |
| `typescript` | 4.7.4 | 4.9.5 | typescript-eslint 8 needs 4.8.4 or newer |
| `esbuild` | 0.17.3 | 0.28.2 | dev-server request advisory (moderate) |
| `obsidian` types (lockfile, range `latest`) | 1.13.1 | 1.14.4 | pulls patched `moment` |
| `@codemirror/state`, `@codemirror/view` (lockfile) | 6.5.0, 6.38.6 | 6.7.6, 6.43.13 | transitive via `obsidian` |

## Validation
On the primary checkout through `testrun`: `npm ci`, `npx tsc -noEmit -skipLibCheck` (0 errors,
same as baseline) and `node esbuild.config.mjs production` (bundles). This repo has no test suite.
The bundle is not committed (`main.js` is untracked here), so the esbuild 0.28 output change
only appears on the next release build.

## Resolved tickets
| Ticket | Root cause | Commit |
|---|---|---|
| Dependency security refresh 2026-10-22 | stale pins (typescript-eslint 5.29, esbuild 0.17) | see git log (`build(deps): ...`) |
