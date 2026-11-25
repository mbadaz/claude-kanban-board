/** A card's column, written in the task file as `- [ ]`, `- [/]` or `- [x]`. */
export type Status = 'todo' | 'doing' | 'done'

export type Task = {
  /** Stable across moves: hashed from the stage and the task's text, not its mark. */
  id: string
  /** The nearest `**Bold**` or `###` sub-heading above it in its stage, if any. */
  group: string | null
  status: Status
  /** The bold lead, else the first sentence: what the card shows. */
  headline: string
  /** The whole task, continuation lines joined, markdown emphasis removed. */
  text: string
  /** 1-based line of the `- [ ]` in the file. */
  line: number
}

/** A `## ` title in the task file whose sections hold at least one checkbox task. */
export type Stage = { title: string; tasks: Task[] }

export type Board = {
  path: string
  mtimeMs: number
  stages: Stage[]
  error: string | null
}

export type Notice = { text: string; isError: boolean }

declare module 'claude-code' {
  interface PluginState {
    'roadmap-kanban': {
      board: Shaped<Board>
      /** The stage tab in view, by title; null picks the first unfinished one. */
      stage: string | null
      /** The selected card's id. */
      selected: string | null
      notice: Notice | null
      /** Bumped after each add, re-keying the input so it empties. */
      added: number
    }
  }

  /** The tools this mod registers (hooks/tools.ts), as the model calls them. */
  interface McpToolInputs {
    'mcp__roadmap-kanban__list_tasks': { stage?: string }
    'mcp__roadmap-kanban__add_task': {
      stage: string
      text: string
      after?: string
      status?: Status
    }
    'mcp__roadmap-kanban__set_task_status': { id: string; status: Status }
    'mcp__roadmap-kanban__remove_task': { id: string }
    'mcp__roadmap-kanban__add_stage': { title: string; tasks: string[]; after?: string }
    'mcp__roadmap-kanban__remove_stage': { title: string; force?: boolean }
  }
}
