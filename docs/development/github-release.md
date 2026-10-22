# GitHub, changelog, and release workflow

Read the relevant sections before GitHub comments/issues/review resolution, creating or editing a PR, maintainer merges, changelog changes or review, or releases. For user-facing changes, read the Changelog section before preparing the change. These rules supplement [AGENTS.md](../../AGENTS.md).

Unless a Markdown link says otherwise, code paths below are relative to the repository root.

Commit, push, and release steps below describe the corresponding authorized workflow; they do not independently authorize those actions. NEVER commit unless asked.

## GitHub

Follow the [authorization and GitHub rules](../../AGENTS.md#authorization-and-github) for comments, issues, and review resolution.

### Pull requests

When authorized to create or edit a contributor-submitted PR, follow the checklist below. RoboOMP-managed PRs follow their dedicated workflow and enforced body format in `python/robomp/src/prompts/system_append.md` instead.

- MUST read [CONTRIBUTING.md](../../CONTRIBUTING.md) and the [PR template](../../.github/PULL_REQUEST_TEMPLATE.md) first. Preserve the template sections and checklist, including when shortening an existing description.
- MUST obtain at least one sentence written by the contributor in their own words explaining what changed and why, as required by `CONTRIBUTING.md`. If it is missing, ask the contributor; NEVER generate a substitute. Preserve that sentence during edits.
- For user-facing changes, MUST follow the [Changelog](#changelog) attribution rules. Internal issue fixes keep their issue links. For external contributions, add the PR link and contributor credit after GitHub assigns the number, then push the entry as part of the authorized PR workflow before marking the changelog checklist item complete. If that push is not authorized or has not succeeded, leave the item unchecked.
- MUST read back the published PR description after creating or editing it. Check only verified checklist items; explain skipped or inapplicable checks in `Testing`.

## Maintainer merge commits

Use this format: `Merge PR #<number>: <conventional PR subject> (@<author>)` — e.g. `Merge PR #6386: feat(catalog): add native Meta Model API provider (@eggpeat)`.

## Changelog

Location: `packages/*/CHANGELOG.md` (per package).

**Format** — sections under `## [Unreleased]`:

- `### Breaking Changes` (first if present)
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

**Rules:**

- New entries always go under `## [Unreleased]`.
- Entries are one line, brief, and user-facing: lead with what the user will see or can now do. Root-cause narration and implementation detail belong in the commit/PR, not the changelog.
- Never modify already-released sections (e.g., `## [0.12.2]`) — they are immutable.
- Don't flag changelog section order or formatting in reviews or PRs — `bun run release` runs `fix-changelogs` which normalizes everything automatically.

**Attribution:**

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/can1357/oh-my-pi/issues/123))`.
- External contributions: `Added feature X ([#456](https://github.com/can1357/oh-my-pi/pull/456) by [@username](https://github.com/username))`.

## Releasing

1. Ensure all changes since last release are in each affected package's `[Unreleased]` section.
2. Run `bun run release`.

The script handles version bump, CHANGELOG finalization, commit, tag, publish, and adding new `[Unreleased]` sections.
