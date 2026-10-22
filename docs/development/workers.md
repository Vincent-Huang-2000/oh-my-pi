# Worker entrypoints and smoke validation

Read before changing worker creation, CLI worker dispatch, worker entrypoints, or their bundle/compiled-binary packaging. These rules supplement [AGENTS.md](../../AGENTS.md).

Unless a Markdown link says otherwise, code paths below are relative to the repository root.

Inside the omp CLI host, workers MUST re-enter the CLI entrypoint, not separate worker entry modules. Outside a CLI host, keep the direct-module fallback described below. `packages/coding-agent/src/cli.ts` declares itself as the worker host at startup (`declareWorkerHostEntry()` from `@oh-my-pi/pi-utils/env`) and dispatches hidden argv selectors (`__omp_worker_stats_sync`, `__omp_worker_tab`, `__omp_worker_js_eval`, `__omp_worker_tiny_inference`) before loading the command registry. Spawn sites use:

```ts
import { workerHostEntry } from "@oh-my-pi/pi-utils";
const hostEntry = workerHostEntry();
const worker = hostEntry
	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
```

When the process was started from the omp CLI — source `packages/coding-agent/src/cli.ts`, the coding-agent npm bundle's `dist/cli.js`, or compiled binary — `workerHostEntry()` is `Bun.main` and the worker re-enters the single entry module, so no per-worker `--compile` entrypoints or bundle entries exist. Outside a CLI host (`bun test`, SDK embedding, standalone `omp-stats`) it returns `null` and the direct-module fallback loads the worker source. New worker kinds MUST add their selector to the dispatch table in `packages/coding-agent/src/cli.ts` and keep the fallback branch.

History: `with { type: "file" }` only copied the entry as a raw asset (workers crashed silently in compiled binaries — issues #1011, #1027), and the later literal-path + extra-entrypoint pattern required keeping spawn literals and two build scripts in sync (issue #1150). The smoke probe below is the live validation of this contract.

Validate any new worker with the dedicated smoke probe: `omp --smoke-test` spawns the stats sync worker and the tiny-model subprocess, pings them, and exits — it's wired into `ci:test:smoke` and `scripts/install-tests/run-ci.sh` so binary, source-link, and tarball installs all exercise it. Add a sibling smoke if the new worker is on a different module graph.
