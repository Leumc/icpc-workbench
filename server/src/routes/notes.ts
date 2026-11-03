import { Router } from 'express';
import type { Db } from '../db/index.ts';
import { DEFAULT_USER_ID } from '../constants.ts';
import {
  insertTaskNote,
  NoteInputError,
  parseNoteBody,
  parseNoteInput,
  parseNoteLabels,
} from '../notes/problemNotes.ts';
import { mirrorProblemIds, NOTE_SELECT, notesForProblems, toApiNote, utcToIso, type NoteRow } from '../notes/noteQuery.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';

/** 笔记库单次最多返回的条数（题目笔记、复习笔记各自计） */
const LIBRARY_LIMIT = 1000;

interface ReviewNoteEntry {
  reviewItemId: number;
  note: string;
  stage: number;
  addedAt: string;
  lastReviewedAt: string | null;
  nextDueOn: string;
  problem: { id: number; platform: string; problemKey: string; title: string; url: string | null; difficulty: number | null };
}

const positiveId = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function notesRoutes(db: Db): Router {
  const r = Router();

  const readNote = (id: number): NoteRow | undefined =>
    db.prepare(`${NOTE_SELECT} WHERE n.id = ? AND n.user_id = ?`).get(id, DEFAULT_USER_ID) as NoteRow | undefined;

  // GET /api/notes?problemId= | ?taskId= → 笔记列表（新的在前）
  // 按题查询取 COALESCE：任务写笔记时可能还没关联到题目，之后才被计划修改关联上
  r.get('/', (req, res) => {
    const problemId = positiveId(req.query.problemId);
    const taskId = positiveId(req.query.taskId);
    if ((problemId === null) === (taskId === null)) {
      return res.status(400).json({ error: '需要且只能指定 problemId 或 taskId 之一' });
    }
    // mirrors=1：连同洛谷 CF/AT 镜像 ↔ 原题的笔记一起取（题目速览按原题身份汇总）
    if (problemId !== null && req.query.mirrors === '1') {
      const ids = mirrorProblemIds(db, problemId);
      return res.json({ items: notesForProblems(db, DEFAULT_USER_ID, ids.length > 0 ? ids : [problemId]) });
    }
    const where = problemId !== null ? 'COALESCE(n.problem_id, t.problem_id) = ?' : 'n.task_id = ?';
    const rows = db
      .prepare(`${NOTE_SELECT} WHERE n.user_id = ? AND ${where} ORDER BY n.id DESC`)
      .all(DEFAULT_USER_ID, problemId ?? taskId) as unknown as NoteRow[];
    res.json({ items: rows.map(toApiNote) });
  });

  /**
   * GET /api/notes/library?q=&platform=&label=&source=all|problem|review
   * 笔记库：全部题目笔记（含打卡笔记）+ 复习库里写过的复习笔记，按最近更新倒序。
   * - q：题号 / 题名 / 笔记正文 / 任务与计划标题，字面量匹配（% 与 _ 不当通配符）
   * - label：只看带该标注的题目笔记（复习笔记没有标注，指定 label 时不返回）
   * - labels：当前用户所有在用标注及条数（不受过滤影响，供筛选下拉）
   * 个人笔记量级有限，单次最多回 LIBRARY_LIMIT 条，超出时 truncated=true 提示收窄条件。
   */
  r.get('/library', (req, res) => {
    const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
    const q = str(req.query.q).slice(0, 200);
    const platform = str(req.query.platform);
    const label = str(req.query.label);
    const source = str(req.query.source) || 'all';
    if (platform && !PLATFORMS.some((p) => p.id === platform)) {
      return res.status(400).json({ error: `platform 非法: ${platform}` });
    }
    if (!['all', 'problem', 'review'].includes(source)) {
      return res.status(400).json({ error: 'source 需为 all / problem / review' });
    }
    const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

    let notes: ReturnType<typeof toApiNote>[] = [];
    let truncated = false;
    if (source !== 'review') {
      let where = 'n.user_id = ?';
      const params: Array<string | number> = [DEFAULT_USER_ID];
      if (like) {
        where += ` AND (n.content LIKE ? ESCAPE '\\' OR np.title LIKE ? ESCAPE '\\' OR np.problem_key LIKE ? ESCAPE '\\'
                    OR t.title LIKE ? ESCAPE '\\' OR pl.title LIKE ? ESCAPE '\\')`;
        params.push(like, like, like, like, like);
      }
      if (platform) {
        where += ' AND np.platform = ?';
        params.push(platform);
      }
      if (label) {
        where += ' AND json_valid(n.labels) AND EXISTS (SELECT 1 FROM json_each(n.labels) je WHERE je.value = ?)';
        params.push(label);
      }
      const rows = db
        .prepare(`${NOTE_SELECT} WHERE ${where} ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`)
        .all(...params, LIBRARY_LIMIT + 1) as unknown as NoteRow[];
      truncated = rows.length > LIBRARY_LIMIT;
      notes = rows.slice(0, LIBRARY_LIMIT).map(toApiNote);
    }

    let reviewNotes: ReviewNoteEntry[] = [];
    if (source !== 'problem' && !label) {
      let where = "ri.user_id = ? AND ri.note IS NOT NULL AND trim(ri.note) <> ''";
      const params: Array<string | number> = [DEFAULT_USER_ID];
      if (like) {
        where += ` AND (ri.note LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\' OR p.problem_key LIKE ? ESCAPE '\\')`;
        params.push(like, like, like);
      }
      if (platform) {
        where += ' AND p.platform = ?';
        params.push(platform);
      }
      const rows = db
        .prepare(
          `SELECT ri.id, ri.note, ri.stage, ri.added_at, ri.last_reviewed_at, ri.next_due_on,
                  p.id AS problem_id, p.platform, p.problem_key, p.title, p.url, p.difficulty
             FROM review_items ri JOIN problems p ON p.id = ri.problem_id
            WHERE ${where}
            ORDER BY COALESCE(ri.last_reviewed_at, ri.added_at) DESC, ri.id DESC LIMIT ?`,
        )
        .all(...params, LIBRARY_LIMIT + 1) as Array<{
        id: number; note: string; stage: number; added_at: string; last_reviewed_at: string | null; next_due_on: string;
        problem_id: number; platform: string; problem_key: string; title: string; url: string | null; difficulty: number | null;
      }>;
      truncated ||= rows.length > LIBRARY_LIMIT;
      reviewNotes = rows.slice(0, LIBRARY_LIMIT).map((r) => ({
        reviewItemId: r.id,
        note: r.note,
        stage: r.stage,
        addedAt: utcToIso(r.added_at),
        lastReviewedAt: r.last_reviewed_at,
        nextDueOn: r.next_due_on,
        problem: { id: r.problem_id, platform: r.platform, problemKey: r.problem_key, title: r.title, url: r.url, difficulty: r.difficulty },
      }));
    }

    const labels = db
      .prepare(
        `SELECT je.value AS label, COUNT(*) AS count
           FROM problem_notes n, json_each(n.labels) je
          WHERE n.user_id = ? AND json_valid(n.labels) AND je.type = 'text'
          GROUP BY je.value ORDER BY count DESC, je.value`,
      )
      .all(DEFAULT_USER_ID) as Array<{ label: string; count: number }>;
    res.json({ notes, reviewNotes, labels, truncated });
  });

  // POST /api/notes  body: { problemId | taskId, blocks | content, labels? } → 新增一条笔记（不改变打卡状态）
  r.post('/', (req, res) => {
    const body = (req.body ?? {}) as { problemId?: unknown; taskId?: unknown };
    const problemId = positiveId(body.problemId);
    const taskId = positiveId(body.taskId);
    if ((problemId === null) === (taskId === null)) {
      return res.status(400).json({ error: '需要且只能指定 problemId 或 taskId 之一' });
    }
    let id: number;
    if (taskId !== null) {
      if (!db.prepare('SELECT 1 AS hit FROM plan_tasks WHERE id = ?').get(taskId)) {
        return res.status(404).json({ error: '任务不存在' });
      }
      id = insertTaskNote(db, DEFAULT_USER_ID, taskId, parseNoteInput(req.body));
    } else {
      if (!db.prepare('SELECT 1 AS hit FROM problems WHERE id = ?').get(problemId)) {
        return res.status(404).json({ error: '题目不存在' });
      }
      const note = parseNoteInput(req.body);
      id = Number(
        db
          .prepare('INSERT INTO problem_notes (user_id, problem_id, labels, content, blocks) VALUES (?, ?, ?, ?, ?)')
          .run(DEFAULT_USER_ID, problemId, JSON.stringify(note.labels), note.content, JSON.stringify(note.blocks)).lastInsertRowid,
      );
    }
    res.json(toApiNote(readNote(id)!));
  });

  // PATCH /api/notes/:id  body: { blocks? | content?, labels? }
  r.patch('/:id', (req, res) => {
    const id = positiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id 非法' });
    const body = (req.body ?? {}) as { blocks?: unknown; content?: unknown; labels?: unknown };
    const hasBody = body.blocks !== undefined || body.content !== undefined;
    if (!hasBody && body.labels === undefined) {
      return res.status(400).json({ error: '没有可更新字段（blocks/content/labels）' });
    }
    const parsed = hasBody ? parseNoteBody(body) : null;
    const labels = body.labels === undefined ? null : JSON.stringify(parseNoteLabels(body.labels));
    const result = db
      .prepare(
        `UPDATE problem_notes
            SET content = COALESCE(?, content), blocks = COALESCE(?, blocks),
                labels = COALESCE(?, labels), updated_at = datetime('now')
          WHERE id = ? AND user_id = ?`,
      )
      .run(parsed?.content ?? null, parsed ? JSON.stringify(parsed.blocks) : null, labels, id, DEFAULT_USER_ID);
    if (Number(result.changes) === 0) return res.status(404).json({ error: '笔记不存在' });
    res.json(toApiNote(readNote(id)!));
  });

  // DELETE /api/notes/:id → 已打卡任务至少保留一条笔记（打卡不可取消，删光就成了无笔记的打卡）
  r.delete('/:id', (req, res) => {
    const id = positiveId(req.params.id);
    if (id === null) return res.status(400).json({ error: 'id 非法' });
    const note = db
      .prepare('SELECT task_id FROM problem_notes WHERE id = ? AND user_id = ?')
      .get(id, DEFAULT_USER_ID) as { task_id: number | null } | undefined;
    if (!note) return res.status(404).json({ error: '笔记不存在' });
    if (note.task_id !== null) {
      const { n } = db
        .prepare('SELECT COUNT(*) AS n FROM problem_notes WHERE task_id = ?')
        .get(note.task_id) as { n: number };
      const checked = db.prepare('SELECT 1 AS hit FROM checkins WHERE task_id = ?').get(note.task_id);
      if (checked && n <= 1) {
        return res.status(409).json({ error: '这是该打卡任务的最后一条笔记，不能删除；可以改写内容' });
      }
    }
    db.prepare('DELETE FROM problem_notes WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  r.use(((err, _req, res, next) => {
    if (err instanceof NoteInputError) return res.status(400).json({ error: err.message });
    next(err);
  }) as import('express').ErrorRequestHandler);

  return r;
}
