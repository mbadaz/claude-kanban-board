# roadmap-kanban

A Claude Code mod (a function-hooks plugin) that draws a kanban board in a pane
over a markdown task file: `TASKS.md` in the session's working directory unless
the `file` option names another. The README covers use and the file format; this
file covers working on the mod.

## Layout

| Path | What it is |
|---|---|
| `.claude-plugin/plugin.json` | Name, version, the `file` option (`userConfig`, default `TASKS.md`), the types contract |
| `.claude-plugin/marketplace.json` | Makes this repository its own marketplace (`source: "./"`), so it installs with one line |
| `hooks/hooks.json` | Names the one hooks module, `register.tsx` |
| `hooks/register.tsx` | Everything that touches `$`: `/kanban`, the 1.5 s poll, the pane, moves and adds, registering and serving the tools |
| `hooks/roadmap.ts` | Pure parsing and editing, no `$`, so the tests can drive it directly |
| `hooks/tools.ts` | The model's tools: their specs, and `runTool`, pure over the file's text |
| `types/index.d.ts` | The `$.state` contract (`PluginState['roadmap-kanban']`) and the tools' inputs (`McpToolInputs`) |
| `tests/kanban.test.tsx` | Parser, editor and pane tests |
| `tsconfig.json` | Extends `.claude-plugin/types/tsconfig.json`, which the engine writes |

## Rules, and why

- **The file is the only store.** The board keeps nothing the file doesn't say,
  so edits made in an editor, by git or by Claude show up at the next poll and
  can never be overwritten by stale board state.
- **An edit changes only the lines it must, and keeps each line's own ending.**
  A move rewrites one checkbox; an add inserts one line with its anchor's
  ending. People review these files in git diffs: a move that rewrote line
  endings across the file was a real bug (fixed in 0.2.1).
- **A card's id is a hash of its stage title and its cleaned text, never its
  mark.** So a card keeps its id across moves, and a card whose text changed
  elsewhere gets a new one: `setStatus` then finds no match and refuses (`GONE`)
  instead of ticking the wrong line. Identical cards in a stage get `-1`, `-2`…
- **Stage titles are unique.** Sections that share a `## ` title merge into one
  stage, because the board selects stages, and `addTask` finds where to insert,
  by title alone.
- **A card is its checkbox line plus what markdown folds into it**: indented
  lines, and unindented ("lazy") lines that start no block of their own (`BLOCK`
  in `roadmap.ts`). One deliberate difference from GitHub: a bold-only line
  straight after a card stays a group label, because the format documents "a
  line in bold alone is a group".
- **When `Board`'s fields change, change its shape tag** (`'board-1'` in
  `register.tsx`). `$.state` outlives a reload; the tag makes new code decline a
  value stored by old code instead of misreading it.
- **Moving a card never moves its line between sections.** The status lives in
  the checkbox, not in the line's position.
- **The tools share the board's parser and editor**, and each reads the file
  fresh, so they inherit every rule above, stale-id refusal included. Their
  answers name ids and stage titles the way `list_tasks` prints them, because
  the model's next call takes them back.
- **The tools exist only where the task file does.** They're registered at
  session start, or when `/kanban` finds a file made later, so other projects
  never see them. There is no unregistering: a file deleted mid-session leaves
  them answering "No TASKS.md at …".
- **Tools are answered in `tool.run`, never `tool.call`.** `tool.run` fires only
  after the session's permission check allowed the call; an answer at
  `tool.call` would skip that check, letting the model write the file unasked.
- **`remove_stage` refuses while a stage has unfinished cards** unless `force`
  is true, and `add_stage` needs at least one card (an empty `## ` section
  can't be told apart from prose like "Beyond v1.0", so it wouldn't be a stage).

## Checking a change

```
claude plugin validate .
claude plugin test .
npx -y -p typescript@5.6.3 tsc -p .
```

`tsc` needs `.claude-plugin/types/`, which Claude Code writes when it loads the
mod as a development mod or with `claude --plugin-dir .`. Git ignores that
folder, so a fresh clone can't type-check until Claude Code has loaded it once.

For a change to parsing or editing, also run the parser over real task files and
check that moving every card and back leaves each file byte-for-byte unchanged.

Test-kit behaviour worth knowing:

- A test hook that **throws** is skipped (the call then reports "no
  implementation"). To make a `$` call such as `$.fs.write` fail, return
  `{ deny: reason }` from the hook.
- Options go in as `test(name, { options: { file: '…' } }, body)`.
- `mock.clock(on)` holds every timer; `clock.advance(ms)` fires the poll and the
  notice timeout.
- A test that wants the tools registered answers `tool.register`; then
  `$.tool.call({ tool: 'mcp__roadmap-kanban__…', ...args })` runs a call through
  the engine to the mod's `tool.run` hook.

Loader and type rules the tools ran into:

- Each hook passed to `on` must be written as a function at the call site
  (`($, e) => serve($, 'list_tasks', e)`), with the tool name as a string
  literal in the matcher. A hook returned by a helper makes the module fail to
  load.
- The engine's types accept only tool names they know, so the tools and their
  inputs are declared in `types/index.d.ts` under `McpToolInputs`. Keep that in
  step with `toolSpecs` in `tools.ts`.

## Releasing

- Installed copies pick up a pushed change only when `version` in
  `plugin.json` is bumped; a push without a bump never reaches them. That is
  Claude Code's plugin installer, not this mod's code: it caches each install
  under the plugin's computed version (the manifest's `version` first) and keeps
  the cached copy while that version matches. So bump it in the same commit as
  any change meant to reach people who installed the mod. Leaving `version` out
  would make every push an update instead (the commit SHA becomes the version).
- Auto-update is off by default for third-party marketplaces like this one: even
  after a bump, people get the change by running
  `claude plugin update roadmap-kanban@roadmap-kanban` and restarting, unless
  they turned auto-update on under Marketplaces in `/plugin`.
- Before a push, scan the folder for keys (the plugin-authoring skill's
  `scan_secrets` tool) and keep text from the project the mod is used in out of
  tests, comments and the README. The tests use neutral sample cards for that
  reason; the repository is public.
- Commit and push only when asked.

## This copy (local, not true of a clone)

This folder is both the installed mod (it loads in every session as
`roadmap-kanban@skills-dir`, user scope) and the working copy of the public
repository `mbadaz/claude-kanban-board` (branch `main`; the plugin and its
marketplace are still named `roadmap-kanban`). Changes here take effect in
the next session, not this one. Don't also install the mod from its marketplace
on this machine: two copies would load, and what that does is untested.
