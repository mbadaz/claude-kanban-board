// The tools the model calls to read and change the task file. Pure, like
// roadmap.ts: each takes the file's text and answers what to tell the model
// and, for a change, the file's new text. register.tsx reads and writes.

import type { Board, Stage, Status, Task } from '../types'
import { addStage, addTask, GONE, LABELS, parseRoadmap, removeStage, removeTask, setStatus } from './roadmap'

export type Outcome = {
  /** What the model reads: the result, or the error when `isError`. */
  answer: string
  /** The file's new text, for a change. */
  text?: string
  isError?: true
  /** A line for the board's notice row, for a change. */
  notice?: string
}

export type ToolName =
  | 'list_tasks'
  | 'add_task'
  | 'set_task_status'
  | 'remove_task'
  | 'add_stage'
  | 'remove_stage'

type Input = Readonly<Record<string, unknown>>

const STATUSES: Status[] = ['todo', 'doing', 'done']
const BOX: Record<Status, string> = { todo: '[ ]', doing: '[/]', done: '[x]' }

const statusSchema = {
  type: 'string',
  enum: STATUSES,
  description: 'todo, doing or done',
}

/** The tools as `$.tool.register` takes them, their descriptions naming the file. */
export function toolSpecs(fileName: string): {
  name: ToolName
  description: string
  inputSchema: Record<string, unknown>
}[] {
  return [
    {
      name: 'list_tasks',
      description:
        `List the stages and cards of this project's kanban task file (${fileName}): each card's ` +
        'id, status ([ ] to do, [/] doing, [x] done), group and text. Call it before the other ' +
        'kanban tools, which take these ids and stage titles. A card\'s id changes when its text does.',
      inputSchema: {
        type: 'object',
        properties: {
          stage: { type: 'string', description: 'Only this stage (its title, or the start of it)' },
        },
      },
    },
    {
      name: 'add_task',
      description:
        `Add a card to a stage of ${fileName}: below the card \`after\` names, else at the end of ` +
        'the stage. It is to do unless `status` says otherwise.',
      inputSchema: {
        type: 'object',
        properties: {
          stage: { type: 'string', description: 'The stage\'s title, or the start of it' },
          text: { type: 'string', description: 'The task; it becomes one line' },
          after: { type: 'string', description: 'Id of a card in that stage to add it below' },
          status: statusSchema,
        },
        required: ['stage', 'text'],
      },
    },
    {
      name: 'set_task_status',
      description: `Move a card of ${fileName} to todo, doing or done. Rewrites only its checkbox.`,
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The card\'s id, from list_tasks' },
          status: statusSchema,
        },
        required: ['id', 'status'],
      },
    },
    {
      name: 'remove_task',
      description:
        `Delete a card from ${fileName}, with the lines folded into it. For finished work use ` +
        'set_task_status with done instead; remove cards added by mistake or no longer wanted.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The card\'s id, from list_tasks' } },
        required: ['id'],
      },
    },
    {
      name: 'add_stage',
      description:
        `Add a stage (a ## section) to ${fileName} with its first cards, all to do: at the end of ` +
        'the file, or right after the stage `after` names. A stage needs at least one card.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The new stage\'s title' },
          tasks: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            description: 'Its first cards, in order',
          },
          after: { type: 'string', description: 'Title of the stage to put it after' },
        },
        required: ['title', 'tasks'],
      },
    },
    {
      name: 'remove_stage',
      description:
        `Delete a stage from ${fileName}: its ## heading, notes and cards. Refuses while it has ` +
        'unfinished cards, unless force is true.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The stage\'s title, or the start of it' },
          force: { type: 'boolean', description: 'Delete it even with unfinished cards' },
        },
        required: ['title'],
      },
    },
  ]
}

function fail(answer: string): Outcome {
  return { answer, isError: true }
}

function textOf(input: Input, key: string): string | undefined {
  const value = input[key]

  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function statusIn(input: Input): Status | undefined | 'bad' {
  const value = input.status
  if (value === undefined) return undefined

  return STATUSES.includes(value as Status) ? (value as Status) : 'bad'
}

function quoted(task: Task): string {
  return `${task.id} “${task.headline}”`
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`
}

function shortOf(title: string): string {
  return title.split(/\s+[—–-]\s+|:\s+/)[0] ?? title
}

/**
 * The stage a title names: exactly, then ignoring case, then the one stage
 * whose title starts with it ("Phase 1" for "Phase 1 — Groundwork").
 */
function stageNamed(board: Board, title: string): Stage | string {
  const wanted = title.trim().toLowerCase()
  const exact =
    board.stages.find(one => one.title === title.trim()) ??
    board.stages.find(one => one.title.toLowerCase() === wanted)
  if (exact !== undefined) return exact
  const starts = board.stages.filter(one => one.title.toLowerCase().startsWith(wanted))
  if (starts.length === 1) return starts[0]!
  const titles = board.stages.map(one => `“${one.title}”`).join(', ') || 'none yet'
  const why = starts.length > 1 ? `More than one stage starts with “${title}”` : `No stage titled “${title}”`

  return `${why}. Stages: ${titles}.`
}

function cardNamed(board: Board, id: string): { stage: Stage; task: Task } | undefined {
  for (const stage of board.stages) {
    const task = stage.tasks.find(one => one.id === id)
    if (task !== undefined) return { stage, task }
  }

  return undefined
}

function noCard(id: string, fileName: string): Outcome {
  return fail(
    `No card ${id} in ${fileName}: it was removed, or its text changed since it was listed. ` +
      'Call list_tasks for the current ids.',
  )
}

function listing(board: Board, only: Stage | null, fileName: string): string {
  const stages = only === null ? board.stages : [only]
  const cards = stages.reduce((n, stage) => n + stage.tasks.length, 0)
  const rows = [`${fileName}: ${plural(stages.length, 'stage')}, ${plural(cards, 'card')}.`]
  for (const stage of stages) {
    const done = stage.tasks.filter(task => task.status === 'done').length
    rows.push('', `## ${stage.title} · ${done} of ${stage.tasks.length} done`)
    let group: string | null = null
    for (const task of stage.tasks) {
      if (task.group !== null && task.group !== group) rows.push(`**${task.group}**`)
      group = task.group
      rows.push(`- ${BOX[task.status]} ${task.id}: ${task.text} (line ${task.line})`)
    }
  }

  return rows.join('\n')
}

/** Runs one tool over the file's text as it is now. */
export function runTool(name: ToolName, input: Input, text: string, fileName: string): Outcome {
  const board = parseRoadmap(text, fileName, 0)

  if (name === 'list_tasks') {
    if (board.stages.length === 0) {
      return { answer: `${fileName} has no stages yet: add one with add_stage.` }
    }
    const title = textOf(input, 'stage')
    if (title === undefined) return { answer: listing(board, null, fileName) }
    const stage = stageNamed(board, title)

    return typeof stage === 'string' ? fail(stage) : { answer: listing(board, stage, fileName) }
  }

  if (name === 'add_task') {
    const title = textOf(input, 'stage')
    const body = textOf(input, 'text')
    const status = statusIn(input)
    if (title === undefined || body === undefined) return fail('Give the stage and the task\'s text.')
    if (status === 'bad') return fail('status is todo, doing or done.')
    const stage = stageNamed(board, title)
    if (typeof stage === 'string') return fail(stage)
    const after = textOf(input, 'after') ?? null
    if (after !== null && !stage.tasks.some(task => task.id === after)) {
      return fail(`No card ${after} in “${stage.title}”. Call list_tasks for the current ids.`)
    }
    const edit = addTask(text, stage.title, after, body, status ?? 'todo')
    if ('error' in edit) return fail(edit.error)
    const made = cardNamed(parseRoadmap(edit.text, fileName, 0), edit.id)?.task
    const label = LABELS[status ?? 'todo']
    const where = made === undefined ? '' : `, line ${made.line}`

    return {
      answer: `Added ${edit.id} to “${stage.title}”${where}, as ${label}.`,
      text: edit.text,
      notice: `Claude added “${made?.headline ?? body}” to ${shortOf(stage.title)}.`,
    }
  }

  if (name === 'set_task_status') {
    const id = textOf(input, 'id')
    const status = statusIn(input)
    if (id === undefined || status === undefined) return fail('Give the card\'s id and a status.')
    if (status === 'bad') return fail('status is todo, doing or done.')
    const found = cardNamed(board, id)
    if (found === undefined) return noCard(id, fileName)
    if (found.task.status === status) {
      return { answer: `${quoted(found.task)} is already ${LABELS[status]}; nothing changed.` }
    }
    const edit = setStatus(text, id, status)
    if ('error' in edit) return edit.error === GONE ? noCard(id, fileName) : fail(edit.error)

    return {
      answer: `Moved ${quoted(found.task)} from ${LABELS[found.task.status]} to ${LABELS[status]}.`,
      text: edit.text,
      notice: `Claude moved “${found.task.headline}” to ${LABELS[status]}.`,
    }
  }

  if (name === 'remove_task') {
    const id = textOf(input, 'id')
    if (id === undefined) return fail('Give the card\'s id.')
    const found = cardNamed(board, id)
    if (found === undefined) return noCard(id, fileName)
    const edit = removeTask(text, id)
    if ('error' in edit) return edit.error === GONE ? noCard(id, fileName) : fail(edit.error)
    const isEmptied = !parseRoadmap(edit.text, fileName, 0).stages.some(
      one => one.title === found.stage.title,
    )
    const emptied = isEmptied
      ? ` It was the last card in “${found.stage.title}”, so that is no longer a stage; its heading and any notes are still in the file.`
      : ''

    return {
      answer: `Removed ${quoted(found.task)} from “${found.stage.title}” (it was at line ${found.task.line}).${emptied}`,
      text: edit.text,
      notice: `Claude removed “${found.task.headline}”.`,
    }
  }

  if (name === 'add_stage') {
    const title = textOf(input, 'title')
    const tasks = Array.isArray(input.tasks)
      ? input.tasks.filter((task): task is string => typeof task === 'string')
      : []
    if (title === undefined) return fail('Give the stage a title.')
    let after: string | null = null
    const afterTitle = textOf(input, 'after')
    if (afterTitle !== undefined) {
      const stage = stageNamed(board, afterTitle)
      if (typeof stage === 'string') return fail(stage)
      after = stage.title
    }
    const edit = addStage(text, title, tasks, after)
    if ('error' in edit) return fail(edit.error)
    const made = parseRoadmap(edit.text, fileName, 0).stages.find(one => one.title === edit.title)
    const cards = (made?.tasks ?? []).map(quoted).join(', ')

    return {
      answer: `Added stage “${edit.title}” with ${plural(edit.ids.length, 'card')}: ${cards}.`,
      text: edit.text,
      notice: `Claude added the stage “${edit.title}”.`,
    }
  }

  // remove_stage
  const title = textOf(input, 'title')
  if (title === undefined) return fail('Give the stage\'s title.')
  const stage = stageNamed(board, title)
  if (typeof stage === 'string') return fail(stage)
  const unfinished = stage.tasks.filter(task => task.status !== 'done')
  if (unfinished.length > 0 && input.force !== true) {
    const list = unfinished.map(task => `${quoted(task)} (${LABELS[task.status]})`).join('; ')

    return fail(
      `“${stage.title}” still has ${plural(unfinished.length, 'unfinished card')}: ${list}. ` +
        'Finish them, or call remove_stage again with force: true to delete them with the stage.',
    )
  }
  const edit = removeStage(text, stage.title)
  if ('error' in edit) return fail(edit.error)
  const done = edit.tasks.filter(task => task.status === 'done').length

  return {
    answer: `Removed stage “${stage.title}”: its heading, notes and ${plural(edit.tasks.length, 'card')} (${done} done).`,
    text: edit.text,
    notice: `Claude removed the stage “${stage.title}”.`,
  }
}
