# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool — questions about its behavior refer to code in `packages/coding-agent/`, not your current session.

### Package Structure

| Package                 | Description                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `packages/ai`           | Multi-provider LLM client with streaming support                                        |
| `packages/catalog`      | Model catalog: bundled models.json, provider descriptors, model identity/classification |
| `packages/agent`        | Agent runtime with tool calling and state management                                    |
| `packages/coding-agent` | Main CLI application (primary focus)                                                    |
| `packages/tui`          | Terminal UI library with differential rendering                                         |
| `packages/natives`      | Bindings for native text/image/grep operations                                          |
| `packages/stats`        | Local observability dashboard (`omp stats`)                                             |
| `packages/omptype`      | ArkType-compatible schema validation with a lazy JIT runtime                            |
| `packages/utils`        | Shared utilities (logger, streams, temp files)                                          |
| `crates/pi-natives`     | Rust crate for performance-critical text/grep ops                                       |

**Catalog import convention**: code in this repo imports catalog _values_ (bundled models, model-thinking helpers, identity, descriptors, model manager/cache) from `@oh-my-pi/pi-catalog/<module>` — never via `@oh-my-pi/pi-ai`. The pi-ai barrel re-exports only the model/effort _types_ its own signatures use (`Model`, `Api`, `ThinkingConfig`, `Effort`, …); type-only imports of those from `@oh-my-pi/pi-ai` are fine.

## Read Before Working in These Areas

Read the linked guide or section **before changing or reviewing the matching area**. These are mandatory extensions of this file, loaded only when relevant; follow every matching row when work crosses areas. Links are relative to this file. Do not load every guide for unrelated tasks.

| Trigger | Required guide or section |
| --- | --- |
| File I/O, subprocesses, streams, Node module imports, or Bun API choices | [Bun and shared runtime APIs](docs/development/bun.md) |
| Adding, modifying, or reviewing tests, test doubles, or test infrastructure | [Test contracts and isolation](docs/development/testing.md) |
| Worker creation, CLI worker dispatch/entrypoints, or worker bundle/binary packaging | [Worker entrypoints and smoke validation](docs/development/workers.md) |
| Model/provider policy, identity-based branches, discovery, descriptors, or catalog generation in any package | [Model policy and generated catalogs](docs/development/catalog.md) |
| Tool rendering, error/diff display, streamed arguments/previews, or transcript rebuilding | [Tool renderer development rules](docs/tui-runtime-internals.md#tool-renderer-development-rules), including streaming previews when applicable |
| Rust build profiles, toolchain/build configuration, debugging symbols, or Rust test runner changes | [Rust build profiles and test runner](docs/natives-build-release-debugging.md#rust-build-profiles) |
| GitHub comments/issues/review resolution, PR creation/editing, or maintainer merges | [GitHub workflow](docs/development/github-release.md#github) and the relevant PR/merge sections |
| User-facing changes, changelog edits/reviews, or releases | [Changelog](docs/development/github-release.md#changelog); for releases, also [Releasing](docs/development/github-release.md#releasing) |

## Authorization and GitHub

- NEVER commit unless asked. Requirements to include generated files in a commit, push changelog entries, or run a release describe the corresponding authorized workflow; they do not independently authorize those actions.
- Before posting a GitHub comment or creating an issue, MUST show the target and proposed text and obtain user confirmation. An explicit instruction to post supplied text to a specified target already counts as confirmation.
- A request to address or fix PR feedback permits drafting replies, not posting them without confirmation. A request only to get or check comments is read-only.
- When authorized to resolve review feedback, MUST verify the fix, obtain approval for a factual reply citing the change and verification, and post it in the existing thread before resolving. NEVER resolve if the reply is unapproved or posting fails.
- Permission to work on a PR does not authorize unrelated comments or issue creation.

## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** — no `await import()`, no `import("pkg").Type` in type positions, no dynamic type imports. Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`. In pure `index.ts` barrels, use star re-exports even for single-specifier cases. If stars create ambiguity, remove the redundant export path; do not keep duplicates.
- **Class privacy**: use ES `#private` fields; leave externally accessible members bare. **No `private`/`protected`/`public` keyword on fields or methods**, except on **constructor parameter properties** where TypeScript requires it (e.g. `constructor(private readonly session: ToolSession)`).
- **Promises**: use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- **Prompts**: never build prompts in code (no inline strings, template literals, or concatenation). Prompts live in static `.md` files; use Handlebars for dynamic content. Import them via `import content from "./prompt.md" with { type: "text" }` — not `readFile`.
- **Judge questions**: one JSON file per feature (`src/prompts/judge/<feature>.json`) maps question ids to `{ instructions, criteria? }`. Load it with `judgeQuestions(file)` from `@oh-my-pi/pi-ai`; fill Handlebars instructions with `renderQuestion(question, context)`. `criteria` sets the kind: a list of levels → score, omitted or `true`/`false` keys only → yes/no, any other labels → choice (`{}` when the caller supplies the labels). Choice labels and answer types come from the JSON keys.

## Central Utilities

Before writing a helper, check whether one already exists — `packages/coding-agent/src/utils/`, `@oh-my-pi/pi-utils`, `@oh-my-pi/pi-tui`, and the domain modules next to your callsite. This applies to **everything**: VCS wrappers, formatting/truncation/path-display helpers, image handling, clipboard, streams, temp files, caching. The central versions carry hardening a fresh copy always loses (timeouts, output caps, non-interactive env, lock avoidance, caching, TUI sanitization).

- Search for the operation before implementing it. Two implementations of the same thing is a bug even when both work.
- Examples of the pattern: `@oh-my-pi/pi-natives/vcs` and `src/utils/active-repo-context.ts` are the only sanctioned way for project code to run git/jj (`import * as vcs from "@oh-my-pi/pi-natives/vcs"` — never hand-spawn via `$`/`Bun.spawn`); rendering goes through the helpers in TUI Sanitization below (`replaceTabs`, `truncateToWidth`, `shortenPath`, `PREVIEW_LIMITS`) rather than ad-hoc string math.
- Missing capability? Extend the central helper (new option, new sub-function on the namespace) and call it — don't fork its logic locally.

## Runtime APIs

Use Bun APIs where they provide a cleaner alternative; fall back to `node:*` only for what Bun does not cover. Never spawn shell commands for operations with proper APIs. Follow the [Bun guide](docs/development/bun.md) for API choices, process/stream handling, namespace imports, file I/O, and synchronous-interface exceptions.

Inside the omp CLI host, workers MUST re-enter the CLI entrypoint. Outside that host, retain the direct-module fallback. Follow the [worker guide](docs/development/workers.md) for dispatch, packaging, and smoke validation.

## Model Policy and Generated Files

- Model/provider policy belongs in `packages/catalog/src/compat/rules/`, not TypeScript model-name matching or per-model policy tables. Identity branches in TS may only consume structured `classifyModel()` facts; prefer a KDL axis when it can express the policy. See the [catalog guide](docs/development/catalog.md) for ownership, correction axes, and overlap handling.
- NEVER hand-edit `packages/catalog/src/models.json` or `packages/catalog/src/compat/rules.json`. Change their sources and run `bun run gen:models` and/or `bun run gen:compat` as applicable; include generated outputs with source changes. If a commit is authorized, commit them together.
- Test the rule/descriptor/mapper, not bundled JSON, for catalog regressions.

## Logging and CLI Output

Code that may run while the TUI, RPC, SDK, workers, or background runtimes are active MUST NOT use `console.log`/`error`/`warn`; use `logger` from `@oh-my-pi/pi-utils` or an explicit output sink. Standalone CLI commands that exit without entering the TUI MAY use `console.*` or process streams for intentional user-facing output. This exception is semantic, not filename-based; shared code must use `logger` or an explicit output sink. Keep structured stdout clean.

Logs rotate under `~/.omp/logs/omp.YYYY-MM-DD.log`; `bun test` processes log to per-user `omp-test-logs-<uid>/` under the OS temp directory.

## TUI Sanitization

All tool-rendered text must use the central helpers: `replaceTabs()` for tabs, `truncateToWidth()` / `ui.truncate()` with `TRUNCATE_LENGTHS`, `shortenPath()` for home paths, and `PREVIEW_LIMITS` for previews. No ad-hoc string math or limits. Apply this to success, error, diff, and streaming paths. Read the [renderer rules](docs/tui-runtime-internals.md#tool-renderer-development-rules) before changing these paths; streamed previews must preserve both live and rebuilt transcript behavior.

## Testing and Commands

- Test observable contracts and name the consumer-visible failure mode. Regression tests must exercise the original failure path. Do not add tests for tiny low-risk changes unless they protect a real contract or a regression-prone edge case.
- Follow the [testing guide](docs/development/testing.md) for assertion boundaries and exceptions. Never use `mock.module()`, leak global mutations across tests, or assert implementation-source text. Generated output files may be tested as behavior.
- Prefer focused package-local verification for the changed area. For the repository check, use `bun check`, never `tsc`/`npx tsc`; the root check runs both TS and Rust checks. Focused tests do not replace a required full check.
- For Rust tests, use `bun run test:rs`, never direct `cargo test`. It runs nextest and then doctests; see the [test runner explanation](docs/natives-build-release-debugging.md#rust-test-runner).
