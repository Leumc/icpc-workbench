/**
 * 笔记库（/notes）的数据整理：GET /api/notes/library 回的是「一条条笔记」，
 * 页面要的是「记过笔记的题目」——按题目归档，一道题一组，组内是它的全部笔记与复习笔记。
 * 专题 / 模拟赛等没有题目的任务笔记按任务归组。
 */
import type { NoteProblemRef, ProblemNote } from './problemNotes'

export interface LibraryReviewNote {
  reviewItemId: number
  note: string
  stage: number
  addedAt: string
  lastReviewedAt: string | null
  nextDueOn: string
  problem: NoteProblemRef
}

export interface LibraryResponse {
  notes: ProblemNote[]
  reviewNotes: LibraryReviewNote[]
  labels: Array<{ label: string; count: number }>
  truncated: boolean
}

export interface NoteGroup {
  /** p<题目 id> 或 t<任务 id> */
  key: string
  problem: NoteProblemRef | null
  task: { id: number; title: string; planTitle: string | null; taskDate: string | null } | null
  notes: ProblemNote[]
  reviewNote: LibraryReviewNote | null
  /** 组内笔记用过的标注（去重，按出现顺序） */
  labels: string[]
  /** 组内最近一次活动（笔记更新 / 复习） */
  updatedAt: string
}

export type GroupSort = 'updated' | 'count' | 'key'

export const groupKeyOfProblem = (id: number): string => `p${id}`
export const groupKeyOfTask = (id: number): string => `t${id}`

const later = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b)

export function groupLibrary(resp: Pick<LibraryResponse, 'notes' | 'reviewNotes'>): NoteGroup[] {
  const groups = new Map<string, NoteGroup>()
  for (const n of resp.notes) {
    const problem = n.problem ?? null
    const key = problem ? groupKeyOfProblem(problem.id) : n.taskId !== null ? groupKeyOfTask(n.taskId) : `n${n.id}`
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        problem,
        task: problem || n.taskId === null ? null : { id: n.taskId, title: n.taskTitle ?? '训练任务', planTitle: n.planTitle, taskDate: n.taskDate },
        notes: [],
        reviewNote: null,
        labels: [],
        updatedAt: n.updatedAt,
      }
      groups.set(key, g)
    }
    g.notes.push(n)
    for (const l of n.labels) if (!g.labels.includes(l)) g.labels.push(l)
    g.updatedAt = later(g.updatedAt, n.updatedAt)
  }
  for (const r of resp.reviewNotes) {
    const key = groupKeyOfProblem(r.problem.id)
    const activity = r.lastReviewedAt ?? r.addedAt
    const g = groups.get(key)
    if (g) {
      g.reviewNote = r
      g.updatedAt = later(g.updatedAt, activity)
    } else {
      groups.set(key, { key, problem: r.problem, task: null, notes: [], reviewNote: r, labels: [], updatedAt: activity })
    }
  }
  return sortGroups([...groups.values()], 'updated')
}

const groupCount = (g: NoteGroup): number => g.notes.length + (g.reviewNote ? 1 : 0)

export function sortGroups(groups: NoteGroup[], sort: GroupSort): NoteGroup[] {
  const byUpdated = (a: NoteGroup, b: NoteGroup): number => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  const label = (g: NoteGroup): string => (g.problem ? `${g.problem.platform}:${g.problem.problemKey}` : `~${g.task?.title ?? ''}`)
  const sorted = [...groups]
  if (sort === 'count') sorted.sort((a, b) => groupCount(b) - groupCount(a) || byUpdated(a, b))
  else if (sort === 'key') sorted.sort((a, b) => label(a).localeCompare(label(b), 'zh-CN', { numeric: true }) || byUpdated(a, b))
  else sorted.sort(byUpdated)
  return sorted
}

/** 深链 ?problem= / ?task= / ?note= → 要选中的组 key（note 需要在已加载的组里找） */
export function groupKeyFromParams(params: URLSearchParams, groups: readonly NoteGroup[]): string | null {
  const id = (name: string): number | null => {
    const n = Number(params.get(name))
    return Number.isSafeInteger(n) && n > 0 ? n : null
  }
  const problem = id('problem')
  if (problem !== null) return groupKeyOfProblem(problem)
  const task = id('task')
  if (task !== null) return groupKeyOfTask(task)
  const note = id('note')
  if (note !== null) return groups.find((g) => g.notes.some((n) => n.id === note))?.key ?? null
  return null
}

export const noteGroupCount = groupCount
