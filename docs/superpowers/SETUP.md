# Superpowers setup for this project

[Superpowers](https://github.com/obra/superpowers) is a set of development-workflow *skills* for coding agents (brainstorm → spec → plan → TDD → review → verify).

## Current recommended installation (checked 2026-10-04)

The repository README's **Claude Code** section recommends Anthropic's official plugin marketplace:

```text
/plugin install superpowers@claude-plugins-official
```

(Alternative: `/plugin marketplace add obra/superpowers-marketplace`, then `/plugin install superpowers@superpowers-marketplace`.)

## What was installed here

```bash
claude plugin install superpowers@claude-plugins-official --scope project
```

- Plugin `superpowers@claude-plugins-official` **v6.4.1**, **project scope**. This wrote `.claude/settings.json`:

  ```json
  { "enabledPlugins": { "superpowers@claude-plugins-official": true } }
  ```

  Project scope means it's enabled only for this repository and is shareable through `.claude/settings.json`. Your user-level setup stays untouched. (It was already installed for another project of yours, `py-ml`, at project scope. That install was left alone.)
- Nothing was copied into the repo. The plugin delivers its skills (plus a session-start hook that tells the agent to use them) on its own, so copying skill files in would only duplicate it.
- No extra marketplaces, agents, MCP servers or other plugins were added.

**Note:** plugin skills load when a Claude Code session *starts*. In the session that built this demo, the plugin was installed mid-session, so the agent read the relevant `SKILL.md` files straight from the plugin cache (`~/.claude/plugins/cache/claude-plugins-official/superpowers/6.4.1/skills/`) and followed them by hand. New sessions in this folder get them automatically.

## Why not "install only some skills"?

Superpowers ships as **one plugin**, and Claude Code enables or disables plugins as a whole. Copying individual skills into `.claude/skills/` would mean doing manually what the plugin already does, and the copies would stop getting updates. Skills are loaded on demand (only their one-line descriptions sit in context until one is triggered), so the unused ones cost almost nothing. The table below says which ones this project uses.

| Skill | Used? | How it was used here |
|---|---|---|
| `brainstorming` | ✅ | Classified the work as *architectural* → wrote the spec `docs/superpowers/specs/2026-10-04-flash-sale-demo-design.md` (problem analysis, approaches, data model, failure modes). |
| `writing-plans` | ✅ | `docs/superpowers/plans/2026-10-04-flash-sale-demo.md`: file map, interfaces, task list, Review Focus. |
| `test-driven-development` | ✅ | Unit tests, Lua-script tests and integration tests were written before the code they cover and seen failing first. The idempotency guard was also mutation-tested (removing it fails 3 tests). |
| `systematic-debugging` | ✅ | Root-caused two surprises instead of guessing: NestJS 12 being ESM-only (Jest can't load it on Node < 24.9, so we pinned NestJS 11), and p99 ≈ 2s spikes (macOS `kern.ipc.somaxconn = 128` dropping SYNs at 500 connections, so the default is now 100). |
| `subagent-driven-development` / `dispatching-parallel-agents` | ✅ (partly) | The teaching docs were written by two parallel subagents working from the spec and the real code. The code itself was written in the main session, because its parts are tightly coupled. |
| `requesting-code-review` | ✅ | A fresh reviewer subagent reviewed the whole tree at the end. |
| `verification-before-completion` | ✅ | Every claim in the final report comes from a command that was actually run (tests, load runs, Docker). |
| `receiving-code-review` | ✅ | Review findings were checked against the code before being accepted or rejected. |
| `executing-plans` | — | Alternative to subagent-driven execution; not needed. |
| `using-git-worktrees`, `finishing-a-development-branch` | — | Single local repo, no branches or PRs requested. |
| `writing-skills`, `diagnosing-superpowers` | — | For authoring skills or debugging Superpowers itself; unrelated. |

### Deviation, on purpose

The brainstorming skill normally **stops for human approval** of the spec and again of the plan. The project brief explicitly asked for a full end-to-end run ("Do not stop after scaffolding"), so both documents were written and self-reviewed, and implementation continued without waiting. Read them to see what was decided and why.

## Turning it off

```bash
claude plugin disable superpowers@claude-plugins-official --scope project
# or delete the entry from .claude/settings.json
```
