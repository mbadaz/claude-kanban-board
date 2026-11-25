import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { addStage, addTask, parseRoadmap, removeStage, removeTask, setStatus } from '../hooks/roadmap'
import { runTool } from '../hooks/tools'

const SAMPLE = [
  '# Plan',
  '',
  '## Phase 1 — Groundwork',
  '',
  '**Done**',
  '',
  '- [x] Set up the repository: folders, `README.md`.',
  '',
  '**Remaining**',
  '',
  '- [ ] **Check the API notes against v2.** They still describe',
  '      the v1 endpoints.',
  '- [/] Choose the app name.',
  '',
  '**Exit test:** something.',
  '',
  '## Phase 2 — First release',
  '',
  '**App**',
  '',
  '- [ ] Search results with tests (§3.1). More words here.',
  '',
  '| table | row |',
  '',
  '## Beyond v1.0',
  '',
  '- Not a checkbox, so not a card.',
  '',
].join('\n')

test('parses stages, statuses, groups and headlines', async () => {
  const board = parseRoadmap(SAMPLE, '/p/ROADMAP.md', 1)
  expect(board.stages.map(stage => stage.title)).toEqual([
    'Phase 1 — Groundwork',
    'Phase 2 — First release',
  ])
  const [scaffold, verify, decide] = board.stages[0]!.tasks
  expect(scaffold).toMatchObject({ status: 'done', group: 'Done', line: 7 })
  expect(verify).toMatchObject({
    status: 'todo',
    group: 'Remaining',
    headline: 'Check the API notes against v2',
    text: 'Check the API notes against v2. They still describe the v1 endpoints.',
    line: 11,
  })
  expect(decide).toMatchObject({ status: 'doing', headline: 'Choose the app name' })
  expect(board.stages[1]!.tasks[0]!.headline).toBe('Search results with tests (§3.1)')
})

test('a move rewrites one checkbox and keeps the card id', async () => {
  const before = parseRoadmap(SAMPLE, '', 0).stages[0]!.tasks[1]!
  const edit = setStatus(SAMPLE, before.id, 'done')
  if ('error' in edit) throw new Error(edit.error)
  const changed = SAMPLE.split('\n').filter((line, i) => line !== edit.text.split('\n')[i])
  expect(changed).toEqual(['- [ ] **Check the API notes against v2.** They still describe'])
  expect(edit.text.split('\n')[10]).toBe(
    '- [x] **Check the API notes against v2.** They still describe',
  )
  const after = parseRoadmap(edit.text, '', 0).stages[0]!.tasks[1]!
  expect(after.id).toBe(before.id)
  expect(after.status).toBe('done')
})

test('a card added below a multi-line card lands after its last line', async () => {
  const anchor = parseRoadmap(SAMPLE, '', 0).stages[0]!.tasks[1]!
  const edit = addTask(SAMPLE, 'Phase 1 — Groundwork', anchor.id, '  Write the  tests ')
  if ('error' in edit) throw new Error(edit.error)
  expect(edit.text.split('\n').slice(10, 14)).toEqual([
    '- [ ] **Check the API notes against v2.** They still describe',
    '      the v1 endpoints.',
    '- [ ] Write the tests',
    '- [/] Choose the app name.',
  ])
  expect(addTask(SAMPLE, 'Phase 1 — Groundwork', null, '   ')).toEqual({
    error: 'Type the task first.',
  })
})

test('CRLF files stay CRLF after an edit', async () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n')
  const id = parseRoadmap(crlf, '', 0).stages[1]!.tasks[0]!.id
  const edit = setStatus(crlf, id, 'doing')
  if ('error' in edit) throw new Error(edit.error)
  expect(edit.text).toBe(crlf.replace('- [ ] Search', '- [/] Search'))
})

test('an edit keeps every line ending as it was, in a file that mixes them', async () => {
  const mixed = '## S\r\n- [ ] a\n- [ ] b\r\n- [ ] c'
  const [a, b] = parseRoadmap(mixed, '', 0).stages[0]!.tasks
  const moved = setStatus(mixed, b!.id, 'done')
  if ('error' in moved) throw new Error(moved.error)
  expect(moved.text).toBe('## S\r\n- [ ] a\n- [x] b\r\n- [ ] c')

  const between = addTask(mixed, 'S', a!.id, 'new')
  if ('error' in between) throw new Error(between.error)
  expect(between.text).toBe('## S\r\n- [ ] a\n- [ ] new\n- [ ] b\r\n- [ ] c')

  // c ends the file with no final newline; the new last card keeps it that way.
  const last = addTask(mixed, 'S', null, 'last')
  if ('error' in last) throw new Error(last.error)
  expect(last.text).toBe('## S\r\n- [ ] a\n- [ ] b\r\n- [ ] c\r\n- [ ] last')
  expect(parseRoadmap(last.text, '', 0).stages[0]!.tasks[3]).toMatchObject({
    id: last.id,
    headline: 'last',
  })
})

test('an unindented line that markdown folds into a card is part of it; a new block is not', async () => {
  const lazy = [
    '## S',
    '- [ ] **First** card',
    'wraps here without an indent.',
    '- [ ] before a bullet',
    '- a plain bullet',
    '- [ ] before a group',
    '**Group**',
    '- [ ] grouped',
    '- [ ] before a quote',
    '> quoted',
    '- [ ] before a heading',
    '### Sub',
    '- [ ] last',
  ].join('\n')
  const tasks = parseRoadmap(lazy, '', 0).stages[0]!.tasks
  expect(tasks.map(task => task.text)).toEqual([
    'First card wraps here without an indent.',
    'before a bullet',
    'before a group',
    'grouped',
    'before a quote',
    'before a heading',
    'last',
  ])
  expect(tasks[0]!.headline).toBe('First')
  expect(tasks[3]!.group).toBe('Group')
  expect(tasks[6]!.group).toBe('Sub')

  const below = addTask(lazy, 'S', tasks[0]!.id, 'new')
  if ('error' in below) throw new Error(below.error)
  expect(below.text.split('\n').slice(1, 4)).toEqual([
    '- [ ] **First** card',
    'wraps here without an indent.',
    '- [ ] new',
  ])
})

test('sections that share a title are one stage, and an added card lands in the right one', async () => {
  const twice = [
    '## Notes',
    '- [ ] first',
    '',
    '## Other',
    '- [ ] other',
    '',
    '## Notes',
    '- [ ] second',
    '',
  ].join('\n')
  const board = parseRoadmap(twice, '', 0)
  expect(board.stages.map(stage => stage.title)).toEqual(['Notes', 'Other'])
  const [first, second] = board.stages[0]!.tasks
  expect([first!.headline, second!.headline]).toEqual(['first', 'second'])

  const atEnd = addTask(twice, 'Notes', null, 'third')
  if ('error' in atEnd) throw new Error(atEnd.error)
  expect(atEnd.text.split('\n').slice(6, 9)).toEqual(['## Notes', '- [ ] second', '- [ ] third'])
  const below = addTask(twice, 'Notes', first!.id, 'between')
  if ('error' in below) throw new Error(below.error)
  expect(below.text.split('\n').slice(0, 3)).toEqual(['## Notes', '- [ ] first', '- [ ] between'])

  // Loose tasks above and below a `#` title share the fallback stage.
  const loose = ['- [ ] loose', '# Title', '- [ ] after the title', '## S', '- [ ] in S'].join('\n')
  expect(parseRoadmap(loose, '', 0).stages.map(stage => [stage.title, stage.tasks.length])).toEqual([
    ['Tasks', 2],
    ['S', 1],
  ])
})

test('the pane moves a card and writes the task file, on every surface', async ($, on) => {
  let file = SAMPLE
  let mtimeMs = 1
  const writes: string[] = []
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'kanban' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/p' }))
  on('fs.stat', () => ({
    value: { kind: 'file', size: file.length, mtimeMs, isLink: false },
  }))
  on('fs.read', () => ({ value: file }))
  on('fs.write', (_, e) => {
    file = e.text
    mtimeMs += 1
    writes.push(e.text)

    return { value: undefined }
  })

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const verify = parseRoadmap(SAMPLE, '', 0).stages[0]!.tasks[1]!

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'roadmap-kanban',
      surface,
      component: 'Pane',
      requestId: 'roadmap-kanban',
      props: {
        title: 'Roadmap',
        isFocused: true,
        bodyColumns: 90,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 40 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: 'Phase 1 — Groundwork' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^TO DO/ }))?.text).toBe('TO DO · 1')
    // The "Done" / "Remaining" sub-headings repeat the columns: not drawn.
    expect(await ui.find({ type: 'Text', text: 'Remaining' })).toBeUndefined()

    await ui.press({ key: verify.id })
    expect(await ui.find({ key: 'move-done' })).toBeDefined()
    await ui.press({ key: 'move-done' })
    expect((await ui.find({ type: 'Text', text: /^DONE/ }))?.text).toBe('DONE · 2')

    await ui.press({ key: 'move-todo' })
    expect((await ui.find({ type: 'Text', text: /^TO DO/ }))?.text).toBe('TO DO · 1')
    await ui.press({ key: 'deselect' })
    await ui.unmount()
  }
  expect(writes).toHaveLength(4)
  expect(file).toBe(SAMPLE)
})

test('the pane adds a card and opens other stages', async ($, on) => {
  let file = SAMPLE
  let mtimeMs = 1
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'kanban' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.stat', () => ({
    value: { kind: 'file', size: file.length, mtimeMs, isLink: false },
  }))
  on('fs.read', () => ({ value: file }))
  on('fs.write', (_, e) => {
    file = e.text
    mtimeMs += 1

    return { value: undefined }
  })

  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'roadmap-kanban',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'roadmap-kanban',
    props: {
      title: 'Roadmap',
      isFocused: true,
      bodyColumns: 40,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })

  await ui.press({ key: 'stage-1' })
  expect(await ui.find({ type: 'Text', text: 'Phase 2 — First release' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'App' })).toBeDefined()

  await ui.input({ key: 'add-0', text: 'Tests for empty results' })
  expect(file).toContain('- [ ] Search results with tests (§3.1). More words here.\n- [ ] Tests for empty results\n')
  expect(await ui.find({ type: 'Text', text: /Tests for empty results/ })).toBeDefined()
  expect(await ui.find({ key: 'add-1' })).toBeDefined()
  await ui.unmount()
})

test('a missing task file says so instead of drawing a board', async ($, on) => {
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'kanban' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })

  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'roadmap-kanban',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'roadmap-kanban',
    props: {
      title: 'Roadmap',
      isFocused: false,
      bodyColumns: 40,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  expect((await ui.find({ type: 'Text', text: /^No / }))?.text).toBe(
    'No TASKS.md at /elsewhere/TASKS.md.',
  )
  await ui.unmount()
})

const optionCase = async (...[$, on]: Parameters<TestBody>) => {
  const read: string[] = []
  const opened: (string | undefined)[] = []
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'kanban' } }))
  on('ui.open', (_, e) => {
    opened.push(e.title)

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }))
  on('fs.read', (_, e) => {
    read.push(e.path)

    return { value: SAMPLE }
  })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  return { read, opened }
}

test('by default the board reads TASKS.md', async ($, on) => {
  const { read, opened } = await optionCase($, on)
  expect(read).toEqual(['/p/TASKS.md'])
  expect(opened).toEqual(['Tasks'])
})

test('the file option points the board at another file', { options: { file: 'ROADMAP.md' } }, async ($, on) => {
  const { read, opened } = await optionCase($, on)
  expect(read).toEqual(['/p/ROADMAP.md'])
  expect(opened).toEqual(['Roadmap'])
})

test(
  'an absolute file option is read as it is, and names the board',
  { options: { file: '/notes/PLAN.markdown' } },
  async ($, on) => {
    const { read, opened } = await optionCase($, on)
    expect(read).toEqual(['/notes/PLAN.markdown'])
    expect(opened).toEqual(['Plan'])
  },
)

/** SAMPLE as /p/TASKS.md in memory, edited by the board or by `save` (another editor). */
const world = async (...[$, on]: Parameters<TestBody>) => {
  const clock = mock.clock(on)
  const tools: string[] = []
  on('tool.register', (_, e) => {
    tools.push(e.name)

    return { value: { tool: `mcp__roadmap-kanban__${e.name}` } }
  })
  const file = {
    text: SAMPLE,
    mtimeMs: 1,
    reads: 0,
    writes: [] as string[],
    failWrite: null as string | null,
    save(text: string) {
      file.text = text
      file.mtimeMs += 1
    },
  }
  on('command.register', () => ({ value: { command: 'kanban' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/p' }))
  on('fs.stat', () => ({
    value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false },
  }))
  on('fs.read', () => {
    file.reads += 1

    return { value: file.text }
  })
  on('fs.write', (_, e) => {
    if (file.failWrite !== null) return { deny: file.failWrite }
    file.writes.push(e.text)
    file.save(e.text)

    return { value: undefined }
  })
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true })

  return { clock, file, tools }
}

const pane = ($: Parameters<TestBody>[0], placement: 'dock' | 'widget' = 'dock', bodyColumns = 90) =>
  $.ui.mount({
    plugin: 'roadmap-kanban',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'roadmap-kanban',
    props: {
      title: 'Tasks',
      isFocused: true,
      bodyColumns,
      placement,
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  })

const VERIFY = parseRoadmap(SAMPLE, '', 0).stages[0]!.tasks[1]!

test('a card changed elsewhere is not moved: the board reloads and says why', async ($, on) => {
  const { file } = await world($, on)
  const ui = await pane($)
  await ui.press({ key: VERIFY.id })
  // Another editor rewords the card before the move lands.
  const reworded = SAMPLE.replace('They still describe', 'They describe')
  file.save(reworded)
  await ui.press({ key: 'move-done' })

  expect(file.writes).toEqual([])
  expect(file.text).toBe(reworded)
  expect(await ui.find({ type: 'Text', text: /no longer in the file/ })).toBeDefined()
  // The reworded card is a different card, so nothing stays selected.
  expect(await ui.find({ key: 'move-done' })).toBeUndefined()
  await ui.unmount()
})

test('a write that fails leaves the file and the board as they were', async ($, on) => {
  const { file } = await world($, on)
  file.failWrite = 'EACCES: permission denied'
  const ui = await pane($)
  await ui.press({ key: VERIFY.id })
  await ui.press({ key: 'move-done' })

  expect(file.text).toBe(SAMPLE)
  expect((await ui.find({ type: 'Text', text: /^Could not update/ }))?.text).toMatch(
    /^Could not update TASKS\.md: .*EACCES/,
  )
  expect((await ui.find({ type: 'Text', text: /^TO DO/ }))?.text).toBe('TO DO · 1')
  await ui.unmount()
})

test('an edit made elsewhere shows at the next poll; an unchanged file is not reread', async ($, on) => {
  const { clock, file } = await world($, on)
  const ui = await pane($)
  const reads = file.reads
  await clock.advance(3000)
  expect(file.reads).toBe(reads)

  file.save(SAMPLE.replace('- [/] Choose', '- [ ] Polled card.\n- [/] Choose'))
  await clock.advance(1500)
  expect(file.reads).toBe(reads + 1)
  expect((await ui.find({ type: 'Text', text: /^TO DO/ }))?.text).toBe('TO DO · 2')
  expect(await ui.find({ type: 'Text', text: /Polled card/ })).toBeDefined()
  await ui.unmount()
})

test('the widget shows the stage in view and its counts, not the board', async ($, on) => {
  await world($, on)
  const ui = await pane($, 'widget', 40)
  expect(await ui.find({ type: 'Text', text: 'Phase 1 — Groundwork' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /to do ·/ }))?.text).toBe('1 to do · 1 doing · 1 done')
  expect(await ui.find({ key: 'add-0' })).toBeUndefined()
  await ui.unmount()
})

// ── The model's tools ───────────────────────────────────────────────────────

const ids = (text: string) => parseRoadmap(text, '', 0).stages.map(stage => stage.tasks.map(t => t.id))
const run = (name: Parameters<typeof runTool>[0], input: Record<string, unknown>, text = SAMPLE) =>
  runTool(name, input, text, 'TASKS.md')

test('list_tasks shows every card with its id, status, group and line; a stage by the start of its title', async () => {
  const all = run('list_tasks', {})
  expect(all.isError).toBeUndefined()
  expect(all.text).toBeUndefined()
  expect(all.answer).toContain('TASKS.md: 2 stages, 4 cards.')
  expect(all.answer).toContain('## Phase 1 — Groundwork · 1 of 3 done')
  expect(all.answer).toContain(
    `**Remaining**\n- [ ] ${VERIFY.id}: Check the API notes against v2. They still describe the v1 endpoints. (line 11)`,
  )

  const one = run('list_tasks', { stage: 'phase 2' })
  expect(one.answer).toContain('## Phase 2 — First release · 0 of 1 done')
  expect(one.answer).not.toContain('Phase 1')
  expect(run('list_tasks', { stage: 'Phase' })).toMatchObject({ isError: true })
  expect(run('list_tasks', { stage: 'Phase' }).answer).toMatch(/^More than one stage starts with “Phase”/)
  expect(run('list_tasks', { stage: 'Later' }).answer).toBe(
    'No stage titled “Later”. Stages: “Phase 1 — Groundwork”, “Phase 2 — First release”.',
  )
})

test('add_task adds below a card, in the status asked for, and refuses what it cannot place', async () => {
  const added = run('add_task', { stage: 'Phase 1', text: 'Draft  the changelog', after: VERIFY.id, status: 'doing' })
  expect(added.isError).toBeUndefined()
  expect(added.text!.split('\n').slice(10, 14)).toEqual([
    '- [ ] **Check the API notes against v2.** They still describe',
    '      the v1 endpoints.',
    '- [/] Draft the changelog',
    '- [/] Choose the app name.',
  ])
  const made = parseRoadmap(added.text!, '', 0).stages[0]!.tasks[2]!
  expect(added.answer).toBe(`Added ${made.id} to “Phase 1 — Groundwork”, line 13, as Doing.`)
  expect(added.notice).toBe('Claude added “Draft the changelog” to Phase 1.')

  expect(run('add_task', { stage: 'Phase 1', text: 'x', after: 'tnope' }).answer).toBe(
    'No card tnope in “Phase 1 — Groundwork”. Call list_tasks for the current ids.',
  )
  expect(run('add_task', { stage: 'Phase 1' })).toMatchObject({ isError: true })
  expect(run('add_task', { stage: 'Phase 1', text: 'x', status: 'blocked' }).answer).toBe(
    'status is todo, doing or done.',
  )
})

test('set_task_status moves one card, says when nothing changed, and refuses a stale id', async () => {
  const moved = run('set_task_status', { id: VERIFY.id, status: 'done' })
  expect(moved.answer).toBe(`Moved ${VERIFY.id} “Check the API notes against v2” from To do to Done.`)
  expect(moved.text).toBe(SAMPLE.replace('- [ ] **Check', '- [x] **Check'))

  const same = run('set_task_status', { id: VERIFY.id, status: 'todo' })
  expect(same.text).toBeUndefined()
  expect(same.answer).toMatch(/is already To do; nothing changed\.$/)

  const stale = run('set_task_status', { id: VERIFY.id, status: 'done' }, SAMPLE.replace('still describe', 'describe'))
  expect(stale).toMatchObject({ isError: true })
  expect(stale.answer).toMatch(/^No card t\S+ in TASKS\.md: it was removed, or its text changed since it was listed\./)
})

test('remove_task deletes a card with its folded lines, and says when a stage is left empty', async () => {
  const removed = run('remove_task', { id: VERIFY.id })
  expect(removed.text).toBe(
    SAMPLE.replace(
      '- [ ] **Check the API notes against v2.** They still describe\n      the v1 endpoints.\n',
      '',
    ),
  )
  expect(removed.answer).toBe(
    `Removed ${VERIFY.id} “Check the API notes against v2” from “Phase 1 — Groundwork” (it was at line 11).`,
  )

  const last = parseRoadmap(SAMPLE, '', 0).stages[1]!.tasks[0]!
  const emptied = run('remove_task', { id: last.id })
  expect(emptied.answer).toMatch(/It was the last card in “Phase 2 — First release”, so that is no longer a stage;/)
  expect(parseRoadmap(emptied.text!, '', 0).stages.map(stage => stage.title)).toEqual(['Phase 1 — Groundwork'])
  // The card that ends a file with no final newline leaves it with none.
  expect(removeTask('## S\n- [ ] a\n- [ ] b', ids('## S\n- [ ] a\n- [ ] b')[0]![1]!)).toMatchObject({ text: '## S\n- [ ] a' })
})

test('add_stage adds a section with its first cards, at the end or after a stage', async () => {
  const atEnd = run('add_stage', { title: 'Phase 3 — Launch', tasks: ['Write the  announcement', 'Ship it'] })
  expect(atEnd.text).toBe(`${SAMPLE}\n## Phase 3 — Launch\n\n- [ ] Write the announcement\n- [ ] Ship it\n`)
  expect(atEnd.answer).toMatch(/^Added stage “Phase 3 — Launch” with 2 cards: t\S+ “Write the announcement”, t\S+ “Ship it”\.$/)

  const after = run('add_stage', { title: 'Phase 1.5 — Polish', tasks: ['Tidy the UI'], after: 'Phase 1' })
  expect(after.text!.split('\n').slice(14, 22)).toEqual([
    '**Exit test:** something.',
    '',
    '## Phase 1.5 — Polish',
    '',
    '- [ ] Tidy the UI',
    '',
    '## Phase 2 — First release',
    '',
  ])
  expect(parseRoadmap(after.text!, '', 0).stages.map(stage => stage.title)).toEqual([
    'Phase 1 — Groundwork',
    'Phase 1.5 — Polish',
    'Phase 2 — First release',
  ])

  expect(run('add_stage', { title: 'Phase 1 — Groundwork', tasks: ['x'] }).answer).toBe(
    'A stage titled “Phase 1 — Groundwork” already exists; add cards to it instead.',
  )
  expect(run('add_stage', { title: 'Empty', tasks: [] }).answer).toBe(
    'A stage needs at least one card: give its first task.',
  )
  // Into an empty file, and onto a last line with no newline.
  expect(addStage('', 'S', ['a'], null)).toMatchObject({ text: '## S\n\n- [ ] a' })
  expect(addStage('# Plan', 'S', ['a'], null)).toMatchObject({ text: '# Plan\n\n## S\n\n- [ ] a' })
})

test('remove_stage refuses while cards are unfinished, and with force deletes the whole section', async () => {
  const refused = run('remove_stage', { title: 'Phase 1' })
  expect(refused).toMatchObject({ isError: true })
  expect(refused.text).toBeUndefined()
  expect(refused.answer).toBe(
    `“Phase 1 — Groundwork” still has 2 unfinished cards: ${VERIFY.id} “Check the API notes against v2” (To do); ` +
      `${ids(SAMPLE)[0]![2]} “Choose the app name” (Doing). Finish them, or call remove_stage again with force: true ` +
      'to delete them with the stage.',
  )

  const forced = run('remove_stage', { title: 'Phase 1', force: true })
  expect(forced.answer).toBe('Removed stage “Phase 1 — Groundwork”: its heading, notes and 3 cards (1 done).')
  expect(forced.text!.split('\n').slice(0, 4)).toEqual(['# Plan', '', '## Phase 2 — First release', ''])

  // A finished stage at the end of the file goes with the blank lines above
  // it, and the file keeps whether it ended with a newline.
  expect(removeStage('A\n\n## S\n- [x] done\n', 'S')).toMatchObject({ text: 'A\n' })
  expect(removeStage('A\n\n## S\n- [x] done', 'S')).toMatchObject({ text: 'A' })
  expect(run('remove_stage', { title: 'S' }, 'A\n\n## S\n- [x] done\n')).toMatchObject({ text: 'A\n' })
  expect(removeStage('- [x] loose\n', 'Tasks')).toMatchObject({
    error: '“Tasks” is the cards above the file\'s first ## heading, not a section: remove them one by one.',
  })
})

test('the tools are registered only where the task file exists', async ($, on) => {
  const { tools } = await world($, on)
  expect(tools).toEqual(['list_tasks', 'add_task', 'set_task_status', 'remove_task', 'add_stage', 'remove_stage'])
})

test('no task file, no tools', async ($, on) => {
  const tools: string[] = []
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'kanban' } }))
  on('tool.register', (_, e) => {
    tools.push(e.name)

    return { value: { tool: `mcp__roadmap-kanban__${e.name}` } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })
  await $.session.start({ cwd: '/elsewhere', surface: 'terminal', isInteractive: false })
  expect(tools).toEqual([])
})

test('a tool call writes the file and shows on the board at once; a refused one writes nothing', async ($, on) => {
  const { file } = await world($, on)
  const ui = await pane($)
  expect((await ui.find({ type: 'Text', text: /^DONE/ }))?.text).toBe('DONE · 1')

  const moved = await $.tool.call({ tool: 'mcp__roadmap-kanban__set_task_status', id: VERIFY.id, status: 'done' })
  expect(moved).toMatchObject({ result: `Moved ${VERIFY.id} “Check the API notes against v2” from To do to Done.` })
  expect(file.text).toBe(SAMPLE.replace('- [ ] **Check', '- [x] **Check'))
  expect((await ui.find({ type: 'Text', text: /^DONE/ }))?.text).toBe('DONE · 2')
  expect(await ui.find({ type: 'Text', text: 'Claude moved “Check the API notes against v2” to Done.' })).toBeDefined()

  const refused = await $.tool.call({ tool: 'mcp__roadmap-kanban__remove_stage', title: 'Phase 2' })
  expect(JSON.stringify(refused)).toContain('still has 1 unfinished card')
  expect(file.writes).toHaveLength(1)
  await ui.unmount()
})
