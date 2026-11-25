// Pure task-file parsing and editing: no `$`, so the tests can drive it.
//
// A stage is a `## ` section; sections that share a title are one stage. A card
// is a `- [ ]` (to do), `- [/]` (doing) or `- [x]` (done) line plus the lines
// markdown folds into it: indented ones, and unindented ("lazy") ones that start
// no block of their own. Every edit changes only the lines it must and keeps each
// line's own ending, so the rest of the file stays byte for byte, even in a file
// that mixes LF and CRLF.

import type { Board, Stage, Status, Task } from '../types'

const STAGE = /^##\s+(.+?)\s*#*\s*$/
const TITLE = /^#\s/
const SUBHEAD = /^###+\s+(.+?)\s*#*\s*$/
const GROUP = /^\*\*([^*]+?)\*\*:?\s*$/
const TASK = /^(\s*)[-*+] \[([ xX/])\] (.*)$/
const FENCE = /^\s*(```|~~~)/
const MARK = /\[([ xX/])\]/
// A line that opens a block (heading, quote, HTML, table row, list item,
// thematic break) ends a card's paragraph instead of continuing it lazily.
const BLOCK = /^\s*(?:#{1,6}(?:\s|$)|>|<|\||[-*+](?:\s|$)|\d{1,9}[.)](?:\s|$)|([-*_])(?:\s*\1){2,}\s*$)/

export const MARKS: Record<Status, string> = { todo: ' ', doing: '/', done: 'x' }
export const LABELS: Record<Status, string> = {
  todo: 'To do',
  doing: 'Doing',
  done: 'Done',
}

function statusOf(mark: string): Status {
  if (mark === ' ') return 'todo'
  if (mark === '/') return 'doing'

  return 'done'
}

function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0

  return (h >>> 0).toString(36)
}

function clean(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function headlineOf(body: string): string {
  const bold = /^\*\*(.+?)\*\*/.exec(body)
  if (bold) return clean(bold[1]!).replace(/[.:]$/, '')
  const text = clean(body)
  const sentence = /^(.+?[.!?])\s+(?=[A-Z(§])/.exec(text)

  return (sentence ? sentence[1]! : text).replace(/\.$/, '')
}

function indentOf(line: string): number {
  return /^\s*/.exec(line)![0].length
}

/** The file's lines, and the ending after each: `''` after the last. */
function splitLines(text: string): { lines: string[]; ends: string[] } {
  const lines: string[] = []
  const ends: string[] = []
  const eol = /\r?\n/g
  let at = 0
  for (let m = eol.exec(text); m !== null; m = eol.exec(text)) {
    lines.push(text.slice(at, m.index))
    ends.push(m[0])
    at = m.index + m[0].length
  }
  lines.push(text.slice(at))
  ends.push('')

  return { lines, ends }
}

function joinLines(lines: string[], ends: string[]): string {
  return lines.map((line, i) => line + ends[i]).join('')
}

type Located = Task & { stage: string; first: number; last: number; indent: string }

/** A `## ` section's lines: its heading at `start`, up to (not including) `end`. */
type Section = { title: string; start: number; end: number }

/**
 * Every task in file order, with where it sits; stages with no tasks are
 * absent. A title seen before reopens that stage, so titles stay unique: the
 * board finds a stage, and `addTask` its place, by title alone. `sections` is
 * every `## ` section, with or without tasks; one ends at the next `## ` or
 * `# ` heading.
 */
function locate(text: string): {
  stages: { title: string; tasks: Located[] }[]
  sections: Section[]
} {
  const { lines } = splitLines(text)
  const stages: { title: string; tasks: Located[] }[] = []
  const sections: Section[] = []
  const seen = new Map<string, number>()
  let stage: { title: string; tasks: Located[] } | null = null
  let section: Section | null = null
  let group: string | null = null
  let inFence = false
  let open: { first: number; indent: number; mark: string; body: string[] } | null = null

  const endSection = (at: number) => {
    if (section !== null) section.end = at
    section = null
  }

  const stageNamed = (title: string) => {
    const known = stages.find(one => one.title === title)
    if (known !== undefined) return known
    const made = { title, tasks: [] as Located[] }
    stages.push(made)

    return made
  }

  const close = (last: number) => {
    if (open === null) return
    const body = open.body.join(' ')
    if (stage === null) stage = stageNamed('Tasks')
    const base = hash(`${stage.title}\n${clean(body)}`)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    stage.tasks.push({
      id: n === 0 ? `t${base}` : `t${base}-${n}`,
      group,
      status: statusOf(open.mark),
      headline: headlineOf(body),
      text: clean(body),
      line: open.first + 1,
      stage: stage.title,
      first: open.first,
      last,
      indent: ' '.repeat(open.indent),
    })
    open = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (FENCE.test(line)) {
      close(i - 1)
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const task = TASK.exec(line)
    if (open !== null && task === null && line.trim() !== '') {
      // A blank line has already closed the card, so this line follows the
      // card's own lines directly. A group label stays a label, as the format
      // says, even where markdown would fold it in.
      const isLazy = !BLOCK.test(line) && !GROUP.test(line)
      if (indentOf(line) > open.indent || isLazy) {
        open.body.push(line.trim())
        continue
      }
    }
    close(i - 1)
    const heading = STAGE.exec(line)
    if (heading) {
      endSection(i)
      const title = clean(heading[1]!)
      section = { title, start: i, end: lines.length }
      sections.push(section)
      stage = stageNamed(title)
      group = null
      continue
    }
    if (TITLE.test(line)) {
      endSection(i)
      stage = null
      group = null
      continue
    }
    const sub = SUBHEAD.exec(line) ?? GROUP.exec(line)
    if (sub) {
      group = clean(sub[1]!)
      continue
    }
    if (task) open = { first: i, indent: task[1]!.length, mark: task[2]!, body: [task[3]!] }
  }
  close(lines.length - 1)

  return { stages: stages.filter(one => one.tasks.length > 0), sections }
}

function strip(task: Located): Task {
  const { id, group, status, headline, text, line } = task

  return { id, group, status, headline, text, line }
}

export function parseRoadmap(text: string, path: string, mtimeMs: number): Board {
  const stages: Stage[] = locate(text).stages.map(one => ({
    title: one.title,
    tasks: one.tasks.map(strip),
  }))

  return { path, mtimeMs, stages, error: null }
}

export type Edit = { text: string; task: Task } | { error: string }

/** The answer when a card id no longer matches: the card went, or its text changed. */
export const GONE = 'That card is no longer in the file as shown; the board was reloaded.'

function noStage(title: string): string {
  return `No stage titled “${title}”.`
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Rewrites one task's checkbox; finds the task again by id in `text` as it is now. */
export function setStatus(text: string, id: string, status: Status): Edit {
  const task = locate(text)
    .stages.flatMap(one => one.tasks)
    .find(one => one.id === id)
  if (task === undefined) return { error: GONE }
  const { lines, ends } = splitLines(text)
  lines[task.first] = lines[task.first]!.replace(MARK, `[${MARKS[status]}]`)

  return { text: joinLines(lines, ends), task: { ...strip(task), status } }
}

/**
 * Inserts `- [ ] body` (or the mark `status` names) right below the card
 * `afterId` names, or below the stage's last card, at that card's indent and
 * with that line's ending. Answers the new card's id.
 */
export function addTask(
  text: string,
  stageTitle: string,
  afterId: string | null,
  body: string,
  status: Status = 'todo',
): { text: string; id: string } | { error: string } {
  const words = collapse(body)
  if (words === '') return { error: 'Type the task first.' }
  const stage = locate(text).stages.find(one => one.title === stageTitle)
  if (stage === undefined) return { error: noStage(stageTitle) }
  const anchor =
    stage.tasks.find(one => one.id === afterId) ?? stage.tasks[stage.tasks.length - 1]!
  const { lines, ends } = splitLines(text)
  const at = anchor.last
  const end = ends[at]!
  // The anchor ends the file with no final newline: it gains the line above's
  // ending, and the new last line keeps the file's lack of one.
  ends[at] = end || ends[at - 1] || '\n'
  lines.splice(at + 1, 0, `${anchor.indent}- [${MARKS[status]}] ${words}`)
  ends.splice(at + 1, 0, end)
  const next = joinLines(lines, ends)
  const added = locate(next)
    .stages.find(one => one.title === stageTitle)
    ?.tasks.find(one => one.first === anchor.last + 1)

  return { text: next, id: added?.id ?? '' }
}

/** Deletes one card: its checkbox line and every line folded into it. */
export function removeTask(text: string, id: string): Edit {
  const task = locate(text)
    .stages.flatMap(one => one.tasks)
    .find(one => one.id === id)
  if (task === undefined) return { error: GONE }
  const { lines, ends } = splitLines(text)
  const count = task.last - task.first + 1
  const lastEnd = ends[task.last]!
  lines.splice(task.first, count)
  ends.splice(task.first, count)
  // The card ended the file with no final newline: the new last line keeps that.
  if (lastEnd === '' && task.first > 0 && task.first === lines.length) ends[task.first - 1] = ''

  return { text: joinLines(lines, ends), task: strip(task) }
}

/**
 * Adds a `## title` section holding one to-do card per body: at the end of the
 * file, or right after the last section titled `afterTitle`. Refuses a title a
 * stage already has, since sections that share a title are one stage.
 */
export function addStage(
  text: string,
  title: string,
  bodies: readonly string[],
  afterTitle: string | null,
): { text: string; title: string; ids: string[] } | { error: string } {
  const name = collapse(title)
  if (name === '') return { error: 'Give the stage a title.' }
  const words = bodies.map(collapse).filter(body => body !== '')
  if (words.length === 0) return { error: 'A stage needs at least one card: give its first task.' }
  const found = locate(text)
  const parsed = clean(name)
  if (found.stages.some(one => one.title === parsed)) {
    return { error: `A stage titled “${parsed}” already exists; add cards to it instead.` }
  }
  const { lines, ends } = splitLines(text)
  const eol = ends.find(end => end !== '') ?? '\n'
  if (text === '') {
    lines.length = 0
    ends.length = 0
  }
  let at = lines.length
  if (afterTitle !== null) {
    const after = found.sections.filter(one => one.title === afterTitle)
    if (after.length === 0) return { error: noStage(afterTitle) }
    at = after[after.length - 1]!.end
  }
  // The file's final newline (an empty last element) stays at the very end.
  if (at === lines.length && lines.length > 1 && lines[at - 1] === '') at -= 1
  const isLast = at === lines.length || (at === lines.length - 1 && lines[at] === '')
  const block: string[] = []
  if (at > 0 && lines[at - 1]!.trim() !== '') block.push('')
  block.push(`## ${name}`, '', ...words.map(word => `- [ ] ${word}`))
  if (!isLast) block.push('')
  if (at === lines.length) {
    // Appending past a last line with no newline: it gains one, and the new
    // last line keeps the file's lack of one.
    if (at > 0) ends[at - 1] = eol
    lines.push(...block)
    ends.push(...block.map(() => eol))
    ends[ends.length - 1] = ''
  } else {
    lines.splice(at, 0, ...block)
    ends.splice(at, 0, ...block.map(() => eol))
  }
  const next = joinLines(lines, ends)
  const made = locate(next).stages.find(one => one.title === parsed)

  return { text: next, title: parsed, ids: made?.tasks.map(task => task.id) ?? [] }
}

/**
 * Deletes every section titled `title`: heading, notes and cards. A section
 * that ran to the end of the file takes the blank lines above it too, and the
 * file keeps whether it ended with a newline.
 */
export function removeStage(
  text: string,
  title: string,
): { text: string; tasks: Task[] } | { error: string } {
  const found = locate(text)
  const stage = found.stages.find(one => one.title === title)
  if (stage === undefined) return { error: noStage(title) }
  const ranges = found.sections.filter(one => one.title === title)
  if (ranges.length === 0) {
    return {
      error: `“${title}” is the cards above the file's first ## heading, not a section: remove them one by one.`,
    }
  }
  const { lines, ends } = splitLines(text)
  const hadFinalNewline = lines[lines.length - 1] === ''
  for (const range of [...ranges].reverse()) {
    const reachesEnd = range.end >= lines.length
    let start = range.start
    if (reachesEnd) while (start > 0 && lines[start - 1]!.trim() === '') start -= 1
    lines.splice(start, range.end - start)
    ends.splice(start, range.end - start)
    if (reachesEnd && !hadFinalNewline && lines.length > 0) ends[lines.length - 1] = ''
  }

  return { text: joinLines(lines, ends), tasks: stage.tasks.map(strip) }
}
