import type { Db } from '../db/index.ts';
import { readNoteBlocks } from './problemNotes.ts';
import { IDENTITY_COLUMN_SQL } from '../problems/identity.ts';

/**
 * 题目笔记的读取口径（/api/notes、笔记库、题目速览共用）。
 *
 * 笔记归属的题目取 COALESCE(n.problem_id, t.problem_id)：任务写笔记时可能还没关联到题目，
 * 之后才被计划修改关联上。联表 problems 带出题目元信息，笔记库与速览不必再逐条回查。
 */
export interface NoteRow {
  id: number;
  problem_id: number | null;
  task_id: number | null;
  labels: string;
  content: string;
  blocks: string | null;
  created_at: string;
  updated_at: string;
  task_title: string | null;
  task_date: string | null;
  plan_id: number | null;
  plan_title: string | null;
  p_platform: string | null;
  p_key: string | null;
  p_title: string | null;
  p_url: string | null;
  p_difficulty: number | null;
}

export const NOTE_SELECT = `
  SELECT n.id, COALESCE(n.problem_id, t.problem_id) AS problem_id, n.task_id, n.labels, n.content, n.blocks,
         n.created_at, n.updated_at, t.title AS task_title, t.task_date, t.plan_id, pl.title AS plan_title,
         np.platform AS p_platform, np.problem_key AS p_key, np.title AS p_title, np.url AS p_url,
         np.difficulty AS p_difficulty
    FROM problem_notes n
    LEFT JOIN plan_tasks t ON t.id = n.task_id
    LEFT JOIN plans pl ON pl.id = t.plan_id
    LEFT JOIN problems np ON np.id = COALESCE(n.problem_id, t.problem_id)
`;

/** datetime('now') 产出无时区的 UTC 文本，转成 ISO 后前端才能按本地时区显示 */
export const utcToIso = (s: string): string =>
  s.includes('T') || /[zZ]$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;

export function parseLabels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((l): l is string => typeof l === 'string');
  } catch {
    /* 标注损坏不该让正文也读不出来 */
  }
  return [];
}

export function toApiNote(r: NoteRow) {
  return {
    id: r.id,
    problemId: r.problem_id,
    taskId: r.task_id,
    labels: parseLabels(r.labels),
    content: r.content,
    blocks: readNoteBlocks(r.blocks, r.content),
    createdAt: utcToIso(r.created_at),
    updatedAt: utcToIso(r.updated_at),
    taskTitle: r.task_title,
    taskDate: r.task_date,
    planId: r.plan_id,
    planTitle: r.plan_title,
    problem:
      r.problem_id !== null && r.p_platform !== null
        ? {
            id: r.problem_id,
            platform: r.p_platform,
            problemKey: r.p_key ?? '',
            title: r.p_title ?? '',
            url: r.p_url,
            difficulty: r.p_difficulty,
          }
        : null,
  };
}

export type ApiNote = ReturnType<typeof toApiNote>;

/** 与 id 同一原题身份的全部题目行（洛谷 CF/AT 镜像 ↔ 原题）；题目不存在时返回空数组 */
export function mirrorProblemIds(db: Db, problemId: number): number[] {
  const rows = db
    .prepare(
      `SELECT p.id FROM problems p
        WHERE ${IDENTITY_COLUMN_SQL} = (SELECT q.identity FROM problems q WHERE q.id = ?)
        ORDER BY p.id`,
    )
    .all(problemId) as Array<{ id: number }>;
  return rows.map((r) => r.id);
}

/** 若干题目（含经任务间接关联的）的全部笔记，新的在前 */
export function notesForProblems(db: Db, userId: number, problemIds: readonly number[], extraTaskIds: readonly number[] = []): ApiNote[] {
  if (problemIds.length === 0 && extraTaskIds.length === 0) return [];
  const conds: string[] = [];
  const params: number[] = [userId];
  if (problemIds.length > 0) {
    conds.push(`COALESCE(n.problem_id, t.problem_id) IN (${problemIds.map(() => '?').join(', ')})`);
    params.push(...problemIds);
  }
  if (extraTaskIds.length > 0) {
    conds.push(`n.task_id IN (${extraTaskIds.map(() => '?').join(', ')})`);
    params.push(...extraTaskIds);
  }
  const rows = db
    .prepare(`${NOTE_SELECT} WHERE n.user_id = ? AND (${conds.join(' OR ')}) ORDER BY n.id DESC`)
    .all(...params) as unknown as NoteRow[];
  return rows.map(toApiNote);
}
