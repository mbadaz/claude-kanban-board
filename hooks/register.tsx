// A kanban board over a markdown task file: TASKS.md at the session's working
// directory unless the `file` option names another.
//
// Each `## ` section with checkbox tasks is a stage tab; each task is a card in
// To do (`- [ ]`), Doing (`- [/]`) or Done (`- [x]`). Moving a card rewrites
// that one checkbox; adding one inserts a `- [ ]` line below the selected card.
// The file is the only store: edits made anywhere else show within POLL_MS.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Stage, Status, Task } from '../types'
import { addTask, LABELS, parseRoadmap, setStatus } from './roadmap'

const PANE = 'roadmap-kanban'
const DEFAULT_FILE = 'TASKS.md'
const POLL_MS = 1500
const NOTICE_MS = 6000
const COLUMNS: Status[] = ['todo', 'doing', 'done']
const HOTKEYS: Record<Status, string> = { todo: '1', doing: '2', done: '3' }
const TONES: Record<Status, 'warning' | 'suggestion' | 'success'> = {
  todo: 'warning',
  doing: 'suggestion',
  done: 'success',
}
// A sub-heading that only names a status (a "Done" or "Remaining" list)
// repeats the column it is in, so it is not drawn as a group label.
const STATUS_GROUPS = /^(to ?do|remaining|doing|in progress|done|completed?)$/i

const EMPTY: Board = { path: '', mtimeMs: 0, stages: [], error: null }

// Change the tag when Board's fields change: it declines what an earlier
// version stored, which outlives a reload.
const board = atom({ plugin: 'roadmap-kanban', key: 'board' } as const, EMPTY, {
  shape: 'board-1',
})
const stageInView = atom({ plugin: 'roadmap-kanban', key: 'stage' } as const, null)
const selected = atom({ plugin: 'roadmap-kanban', key: 'selected' } as const, null)
const notice = atom({ plugin: 'roadmap-kanban', key: 'notice' } as const, null)
const added = atom({ plugin: 'roadmap-kanban', key: 'added' } as const, 0)

// Set from the `file` option by `register`, which runs again at every reload,
// a change of the option included.
let file = DEFAULT_FILE
let fileName = DEFAULT_FILE

function pathIn(cwd: string): string {
  if (file.startsWith('/')) return file

  return `${cwd.replace(/[\\/]+$/, '')}/${file}`
}

/** "TASKS.md" → "Tasks": the pane's title. */
function titleOf(): string {
  const base = fileName.replace(/\.(md|markdown)$/i, '')

  return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase()
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function fit(text: string, width: number): string {
  const room = Math.max(4, width)

  return text.length <= room ? text : `${text.slice(0, room - 1)}…`
}

/** "Phase 1 — Groundwork" → "Phase 1". */
function shortOf(title: string): string {
  return title.split(/\s+[—–-]\s+|:\s+/)[0] ?? title
}

function countOf(stage: Stage, status: Status): number {
  return stage.tasks.filter(task => task.status === status).length
}

/** Reads the file again when its mtime moved, or always when `force`. */
async function load($: EngineInterface, path: string, force: boolean): Promise<void> {
  const stat = await $.fs.stat(path).catch(() => undefined)
  const held = await read($, board)
  if (stat === undefined || stat.kind !== 'file') {
    const error = `No ${fileName} at ${path}.`
    if (held.error !== error) await update($, board, () => ({ ...EMPTY, path, error }))

    return
  }
  const isCurrent = held.path === path && held.mtimeMs === stat.mtimeMs && held.error === null
  if (isCurrent && !force) return
  const fresh = parseRoadmap(await $.fs.read(path), path, stat.mtimeMs)
  await update($, board, () => fresh)
}

async function say($: EngineInterface, text: string, isError: boolean): Promise<void> {
  await update($, notice, () => ({ text, isError }))
  $.clock.after(NOTICE_MS, () => {
    void update($, notice, held => (held?.text === text ? null : held))
  })
}

async function move($: EngineInterface, id: string, status: Status): Promise<void> {
  const { path } = await read($, board)
  try {
    const edit = setStatus(await $.fs.read(path), id, status)
    if ('error' in edit) {
      await load($, path, true)
      await say($, edit.error, true)

      return
    }
    await $.fs.write(path, edit.text)
    await load($, path, true)
    await say($, `Moved “${fit(edit.task.headline, 60)}” to ${LABELS[status]}.`, false)
  } catch (err) {
    await say($, `Could not update ${fileName}: ${messageOf(err)}`, true)
  }
}

async function add(
  $: EngineInterface,
  stageTitle: string,
  afterId: string | null,
  body: string,
): Promise<void> {
  const { path } = await read($, board)
  try {
    const edit = addTask(await $.fs.read(path), stageTitle, afterId, body)
    if ('error' in edit) {
      await load($, path, true)
      await say($, edit.error, true)

      return
    }
    await $.fs.write(path, edit.text)
    await load($, path, true)
    await update($, added, n => n + 1)
    if (edit.id !== '') await update($, selected, () => edit.id)
    await say($, `Added a card to ${shortOf(stageTitle)}.`, false)
  } catch (err) {
    await say($, `Could not update ${fileName}: ${messageOf(err)}`, true)
  }
}

async function reload($: EngineInterface): Promise<void> {
  const path = pathIn(await $.session.cwd())
  await load($, path, true)
  const { error } = await read($, board)
  await say($, error ?? `Reloaded ${fileName}.`, error !== null)
}

let poll: { cancel: () => void } | undefined

export const register: Register = (on, options) => {
  const option = typeof options.file === 'string' ? options.file.trim() : ''
  file = option === '' ? DEFAULT_FILE : option
  fileName = file.split(/[\\/]/).pop() || file

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'kanban',
      description: `Open the kanban board for ${fileName}`,
    })
    if (e.isInteractive) {
      const path = pathIn(e.cwd)
      await load($, path, true).catch(() => undefined)
      poll?.cancel()
      poll = $.clock.every(POLL_MS, () => {
        void load($, path, false).catch(() => undefined)
      })
      if ((await read($, board)).error === null) void $.ui.open({ id: PANE, title: titleOf() })
    }

    return next(e)
  })

  on('command.run', { command: 'kanban' }, async $ => {
    await load($, pathIn(await $.session.cwd()), true).catch(() => undefined)
    const opened = await $.ui.open({ id: PANE, title: titleOf(), focus: true })

    return {
      text: opened.isPlaced ? `${titleOf()} board opened.` : `${titleOf()} board waits: ${opened.reason}`,
      isTextDisplayOnly: true,
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input, Progress } = $.ui.resolve(e)
    const held = await read($, board)
    const wanted = await read($, stageInView)
    const pick = await read($, selected)
    const note = await read($, notice)
    const addCount = await read($, added)
    const cols = Math.max(24, e.props.bodyColumns)

    const noticeRow =
      note === null ? null : <Text color={note.isError ? 'error' : 'success'}>{note.text}</Text>

    if (held.path === '') return <Text dimColor>Reading {fileName}…</Text>
    if (held.error !== null || held.stages.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="warning">
            {held.error ?? `${fileName} has no checkbox tasks (- [ ]) under a ## heading yet.`}
          </Text>
          <Button key="reload" onPress={() => reload($)}>
            Reload
          </Button>
          {noticeRow}
        </Box>
      )
    }

    const stage =
      held.stages.find(one => one.title === wanted) ??
      held.stages.find(one => one.tasks.some(task => task.status !== 'done')) ??
      held.stages[0]!
    const done = countOf(stage, 'done')
    const total = stage.tasks.length

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column">
          <Text weight="bold">{fit(stage.title, cols)}</Text>
          <Text dimColor>
            {countOf(stage, 'todo')} to do · {countOf(stage, 'doing')} doing · {done} done
          </Text>
        </Box>
      )
    }

    const isWide = cols >= 66
    const width = isWide ? Math.floor((cols - 4) / 3) : cols
    const chosen = stage.tasks.find(task => task.id === pick)

    const card = (task: Task) => {
      const isChosen = task.id === pick

      return (
        <Button
          key={task.id}
          plain
          onPress={() => update($, selected, held => (held === task.id ? null : task.id))}
        >
          <Text
            weight={isChosen ? 'bold' : undefined}
            color={isChosen ? 'suggestion' : undefined}
            dimColor={task.status === 'done' && !isChosen}
          >
            {fit(`${isChosen ? '▸' : '•'} ${task.headline}`, width)}
          </Text>
        </Button>
      )
    }

    const column = (status: Status) => {
      const tasks = stage.tasks.filter(task => task.status === status)
      const rows = []
      let group: string | null = null
      for (const task of tasks) {
        const isLabelled = task.group !== null && !STATUS_GROUPS.test(task.group)
        if (isLabelled && task.group !== group) {
          rows.push(
            <Text dimColor italic>
              {fit(task.group!, width)}
            </Text>,
          )
        }
        group = task.group
        rows.push(card(task))
      }

      return (
        <Box flexDirection="column" width={isWide ? width : undefined}>
          <Text weight="bold" color={TONES[status]}>
            {`${LABELS[status].toUpperCase()} · ${tasks.length}`}
          </Text>
          {rows.length === 0 ? <Text dimColor>—</Text> : rows}
        </Box>
      )
    }

    const detail = (task: Task) => {
      const rest = task.text.startsWith(task.headline)
        ? task.text.slice(task.headline.length).replace(/^[.:]?\s*/, '')
        : task.text
      const where = [LABELS[task.status], task.group, `${fileName}:${task.line}`]

      return (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text weight="bold">{task.headline}</Text>
          {rest !== '' && <Text>{rest}</Text>}
          <Text dimColor>{where.filter(part => part !== null).join(' · ')}</Text>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {COLUMNS.filter(status => status !== task.status).map(status => (
              <Button
                key={`move-${status}`}
                plain
                hotkey={HOTKEYS[status]}
                onPress={() => move($, task.id, status)}
              >
                {`Move to ${LABELS[status]}`}
              </Button>
            ))}
            <Button key="deselect" plain dimColor onPress={() => update($, selected, () => null)}>
              Close
            </Button>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {held.stages.map((one, i) => (
            <Button
              key={`stage-${i}`}
              variant={one === stage ? 'primary' : undefined}
              onPress={async () => {
                await update($, stageInView, () => one.title)
                await update($, selected, () => null)
              }}
            >
              {`${shortOf(one.title)} ${countOf(one, 'done')}/${one.tasks.length}`}
            </Button>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text weight="bold">{stage.title}</Text>
          <Progress
            label={`${done} of ${total} done`}
            value={done}
            max={total}
            valueText={`${done}/${total}`}
          />
        </Box>
        <Box flexDirection={isWide ? 'row' : 'column'} columnGap={2} rowGap={1}>
          {COLUMNS.map(column)}
        </Box>
        {chosen !== undefined && detail(chosen)}
        <Input
          key={`add-${addCount}`}
          label="+ "
          placeholder={
            chosen !== undefined
              ? 'New card, below the selected one'
              : `New card in ${shortOf(stage.title)}`
          }
          submitLabel="add"
          onSubmit={value => add($, stage.title, chosen?.id ?? null, value)}
        />
        <Box flexDirection="column">
          {noticeRow}
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor>{`Live from ${fileName} ·`}</Text>
            <Button key="reload" plain dimColor hotkey="r" onPress={() => reload($)}>
              Reload
            </Button>
          </Box>
        </Box>
      </Box>
    )
  })
}
