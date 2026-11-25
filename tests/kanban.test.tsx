import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { addTask, parseRoadmap, setStatus } from '../hooks/roadmap'

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

  return { clock, file }
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
