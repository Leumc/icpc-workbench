import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupKeyFromParams, groupLibrary, sortGroups, type LibraryReviewNote } from '../src/noteLibrary'
import type { ProblemNote } from '../src/problemNotes'

const problem = (id: number, key: string) => ({ id, platform: 'codeforces', problemKey: key, title: `T${key}`, url: null, difficulty: null })

const note = (id: number, p: ReturnType<typeof problem> | null, updatedAt: string, labels: string[] = [], taskId: number | null = null): ProblemNote => ({
  id,
  problemId: p?.id ?? null,
  taskId,
  labels,
  content: `n${id}`,
  blocks: [{ type: 'markdown', text: `n${id}` }],
  createdAt: updatedAt,
  updatedAt,
  taskTitle: taskId ? '专题：线段树' : null,
  taskDate: taskId ? '2026-01-01' : null,
  planTitle: taskId ? '计划' : null,
  problem: p,
})

const review = (p: ReturnType<typeof problem>, at: string): LibraryReviewNote => ({
  reviewItemId: p.id * 10,
  note: 'r',
  stage: 0,
  addedAt: at,
  lastReviewedAt: null,
  nextDueOn: '2099-01-01',
  problem: p,
})

test('groupLibrary：同题笔记归一组，复习笔记并入同题，无题目的任务笔记按任务归组', () => {
  const a = problem(1, '1A')
  const b = problem(2, '2B')
  const c = problem(3, '3C')
  const groups = groupLibrary({
    notes: [
      note(10, a, '2026-11-02T00:00:00Z', ['思路']),
      note(11, a, '2026-11-01T00:00:00Z', ['思路', '踩坑']),
      note(12, b, '2026-10-01T00:00:00Z'),
      note(13, null, '2026-09-01T00:00:00Z', [], 99),
    ],
    reviewNotes: [review(b, '2026-11-03T00:00:00Z'), review(c, '2026-01-01T00:00:00Z')],
  })
  assert.deepEqual(groups.map((g) => g.key), ['p2', 'p1', 't99', 'p3'])
  const ga = groups.find((g) => g.key === 'p1')!
  assert.equal(ga.notes.length, 2)
  assert.deepEqual(ga.labels, ['思路', '踩坑'])
  assert.equal(ga.updatedAt, '2026-11-02T00:00:00Z')
  const gb = groups.find((g) => g.key === 'p2')!
  assert.equal(gb.reviewNote?.reviewItemId, 20)
  assert.equal(gb.updatedAt, '2026-11-03T00:00:00Z', '复习活动更新组的最近时间')
  const gt = groups.find((g) => g.key === 't99')!
  assert.equal(gt.problem, null)
  assert.equal(gt.task?.title, '专题：线段树')
  assert.equal(groups.find((g) => g.key === 'p3')!.notes.length, 0)
})

test('sortGroups：笔记最多 / 按题号（自然序）', () => {
  const groups = groupLibrary({
    notes: [
      note(1, problem(1, '10A'), '2026-01-03T00:00:00Z'),
      note(2, problem(2, '9A'), '2026-01-02T00:00:00Z'),
      note(3, problem(2, '9A'), '2026-01-01T00:00:00Z'),
    ],
    reviewNotes: [],
  })
  assert.deepEqual(sortGroups(groups, 'count').map((g) => g.key), ['p2', 'p1'])
  assert.deepEqual(sortGroups(groups, 'key').map((g) => g.key), ['p2', 'p1'])
  assert.deepEqual(sortGroups(groups, 'updated').map((g) => g.key), ['p1', 'p2'])
})

test('groupKeyFromParams：problem / task / note 深链', () => {
  const groups = groupLibrary({ notes: [note(5, problem(4, '4D'), '2026-01-01T00:00:00Z')], reviewNotes: [] })
  assert.equal(groupKeyFromParams(new URLSearchParams('problem=4'), groups), 'p4')
  assert.equal(groupKeyFromParams(new URLSearchParams('problem=77'), groups), 'p77', '不在结果里的题也能深链')
  assert.equal(groupKeyFromParams(new URLSearchParams('task=8'), groups), 't8')
  assert.equal(groupKeyFromParams(new URLSearchParams('note=5'), groups), 'p4')
  assert.equal(groupKeyFromParams(new URLSearchParams('note=6'), groups), null)
  assert.equal(groupKeyFromParams(new URLSearchParams('problem=abc'), groups), null)
  assert.equal(groupKeyFromParams(new URLSearchParams(''), groups), null)
})
