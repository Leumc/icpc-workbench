import type { PlatformId } from '../../../shared/src/index.ts';
import { PLATFORMS } from '../../../shared/src/index.ts';
import { nativeDifficultyLabel } from '../../../shared/src/difficulty.ts';
import type { Db } from '../db/index.ts';
import { safeTags } from '../analysis/stats.ts';
import { knowledgeTagsSql } from '../knowledge/store.ts';
import { nameOfCode } from '../knowledge/taxonomy.ts';
import { notesForProblems, utcToIso, type ApiNote } from '../notes/noteQuery.ts';
import { intervalDaysForStage } from '../reviews/schedule.ts';
import { IDENTITY_COLUMN_SQL, problemIdentity } from './identity.ts';
import { parseProblemListText } from './parseProblemList.ts';

/**
 * 题目速览（点击任意题目链接弹出的卡片）：把「这道题在工作台里的全部关联数据」一次取齐。
 *
 * 口径：按**原题身份**聚合（洛谷 CF1000A ↔ Codeforces 1000A 是同一道题），
 * 否则在 CF 链接上看不到挂在洛谷镜像上的笔记 / 卡点 / 复习记录。
 * 题库里没有这道题时仍按链接（与解析出的平台题号）匹配训练任务与题单——
 * AI 生成的计划任务、导入的题单条目都可能只有链接、还没对应题目行。
 */

/** 二级弹窗展示的提交条数上限（更早的提交在题目管理里看） */
export const PEEK_SUBMISSION_LIMIT = 100;
/** 复习日志条数上限 */
export const PEEK_REVIEW_EVENT_LIMIT = 100;

export interface PeekQuery {
  problemId?: number;
  url?: string;
  platform?: string;
  problemKey?: string;
}

interface ParsedTarget {
  platform: PlatformId;
  problemKey: string;
}

/** 补充 parseProblemList 未覆盖、但本应用自己会生成的题目链接形态 */
const EXTRA_URL_PATTERNS: Array<{ re: RegExp; platform: PlatformId; key: (m: RegExpMatchArray) => string }> = [
  // vjudgeIdentity 生成的 AtCoder 简写链接：atcoder.jp/tasks/abc300_a
  { re: /atcoder\.jp\/tasks\/([a-z0-9_-]+)/i, platform: 'atcoder', key: (m) => m[1].toLowerCase() },
  // DashOJ 题库：dashoj.com/p/{key}；VJudge 映射链接：oj.dashoj.com/problem/{key}
  { re: /dashoj\.com\/(?:p|problem)\/([A-Za-z0-9_-]+)/i, platform: 'dashoj', key: (m) => m[1] },
];

/** 从题目链接解析平台与题号；不是可识别的题目页返回 null（只做字符串解析，不发请求） */
export function parseProblemUrl(raw: string): ParsedTarget | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    /* 非法编码按原样解析 */
  }
  const text = `${url.origin}${pathname}`;
  const hit = parseProblemListText(text)[0];
  // parseProblemListText 是题单解析器：行内找不到 URL 时会退到「裸题号」识别，
  // 这里只认 URL 规则命中的结果（hit.url 存在），避免把任意网址的路径段误当题号
  if (hit?.url) return { platform: hit.platform, problemKey: hit.problemKey };
  for (const p of EXTRA_URL_PATTERNS) {
    const m = text.match(p.re);
    if (m) return { platform: p.platform, problemKey: p.key(m) };
  }
  return null;
}

/** 链接比较用的规范形：去掉 hash、末尾斜杠，host 小写 */
function normalizeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return null;
  }
}

interface ProblemRow {
  id: number;
  platform: PlatformId;
  problem_key: string;
  title: string;
  difficulty: number | null;
  native_difficulty: string | null;
  difficulty_scale: string | null;
  difficulty_source: string | null;
  url: string | null;
  tags: string;
}

const PROBLEM_COLUMNS = (db: Db) => `p.id, p.platform, p.problem_key, p.title, p.difficulty, p.native_difficulty,
  p.difficulty_scale, p.difficulty_source, p.url, ${knowledgeTagsSql(db)}`;

function toPeekProblem(r: ProblemRow) {
  return {
    id: r.id,
    platform: r.platform,
    problemKey: r.problem_key,
    title: r.title,
    url: r.url,
    difficulty: r.difficulty,
    difficultyLabel: r.native_difficulty === null ? null : nativeDifficultyLabel(r.platform, r.native_difficulty),
    difficultySource: r.difficulty_source,
    tags: safeTags(r.tags),
  };
}

export type PeekProblem = ReturnType<typeof toPeekProblem>;

const placeholders = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** 找到要展示的主题目行；找不到返回 null（parsed 仍可能有值：题库里还没有这道题） */
function resolvePrimary(db: Db, q: PeekQuery): { primary: ProblemRow | null; parsed: ParsedTarget | null } {
  const select = `SELECT ${PROBLEM_COLUMNS(db)} FROM problems p`;
  if (q.problemId !== undefined) {
    const row = db.prepare(`${select} WHERE p.id = ?`).get(q.problemId) as ProblemRow | undefined;
    return { primary: row ?? null, parsed: row ? { platform: row.platform, problemKey: row.problem_key } : null };
  }
  let parsed: ParsedTarget | null = null;
  if (q.platform && q.problemKey && PLATFORMS.some((p) => p.id === q.platform)) {
    parsed = { platform: q.platform as PlatformId, problemKey: q.problemKey.trim() };
  } else if (q.url) {
    parsed = parseProblemUrl(q.url);
  }
  if (parsed) {
    const exact = db
      .prepare(`${select} WHERE p.platform = ? AND p.problem_key = ?`)
      .get(parsed.platform, parsed.problemKey) as ProblemRow | undefined;
    if (exact) return { primary: exact, parsed };
    // 题号大小写/镜像写法不同：按原题身份找（生成列走索引）
    const byIdentity = db
      .prepare(`${select} WHERE ${IDENTITY_COLUMN_SQL} = ? ORDER BY (p.platform = ?) DESC, p.id LIMIT 1`)
      .get(problemIdentity(parsed), parsed.platform) as ProblemRow | undefined;
    if (byIdentity) return { primary: byIdentity, parsed };
  }
  if (q.url) {
    // 解析不出题号（或题库里没有该题号）时按题目行上存的链接精确匹配：比赛内题目链接等
    // 形态 parseProblemList 不认识，但同步时原样存进了 problems.url
    const norm = normalizeUrl(q.url);
    if (norm) {
      const candidates = [norm, `${norm}/`];
      const row = db
        .prepare(`${select} WHERE p.url IN (?, ?) ORDER BY p.id LIMIT 1`)
        .get(...candidates) as ProblemRow | undefined;
      if (row) return { primary: row, parsed: parsed ?? { platform: row.platform, problemKey: row.problem_key } };
    }
  }
  return { primary: null, parsed };
}

export function problemPeek(db: Db, userId: number, q: PeekQuery, today: string) {
  const { primary, parsed } = resolvePrimary(db, q);

  // 同一原题身份的全部题目行（主行排第一）
  let mirrors: ProblemRow[] = [];
  if (primary) {
    mirrors = db
      .prepare(
        `SELECT ${PROBLEM_COLUMNS(db)} FROM problems p
          WHERE ${IDENTITY_COLUMN_SQL} = (SELECT q.identity FROM problems q WHERE q.id = ?)
          ORDER BY (p.id = ?) DESC, p.id`,
      )
      .all(primary.id, primary.id) as unknown as ProblemRow[];
    if (mirrors.length === 0) mirrors = [primary];
  }
  const ids = mirrors.map((m) => m.id);
  const idIn = placeholders(ids.length);

  // 用于匹配「只有链接」的任务：点击的链接 + 各题目行存的链接（规范化后比较）
  const urlSet = new Set<string>();
  for (const u of [q.url, ...mirrors.map((m) => m.url)]) {
    const n = u ? normalizeUrl(u) : null;
    if (n) urlSet.add(n);
  }

  // ---------- 训练计划任务 ----------
  const taskRows = (
    db
      .prepare(
        `SELECT t.id, t.plan_id, pl.title AS plan_title, t.task_date, t.title, t.kind, t.note, t.url, t.problem_id,
                c.completed_at
           FROM plan_tasks t
           JOIN plans pl ON pl.id = t.plan_id AND pl.user_id = ?
           LEFT JOIN checkins c ON c.task_id = t.id
          WHERE ${ids.length > 0 ? `t.problem_id IN (${idIn}) OR ` : ''}(t.problem_id IS NULL AND t.url IS NOT NULL)
          ORDER BY t.task_date DESC, t.id DESC`,
      )
      .all(userId, ...ids) as Array<{
      id: number; plan_id: number; plan_title: string; task_date: string; title: string; kind: string;
      note: string | null; url: string | null; problem_id: number | null; completed_at: string | null;
    }>
  ).filter((t) => t.problem_id !== null || (t.url !== null && urlSet.has(normalizeUrl(t.url) ?? '')));
  const tasks = taskRows.map((t) => ({
    id: t.id,
    planId: t.plan_id,
    planTitle: t.plan_title,
    taskDate: t.task_date,
    title: t.title,
    kind: t.kind,
    note: t.note,
    checkedAt: t.completed_at ? utcToIso(t.completed_at) : null,
  }));

  // ---------- 笔记（含只挂在上面那些任务上的笔记） ----------
  const notes: ApiNote[] = notesForProblems(db, userId, ids, taskRows.filter((t) => t.problem_id === null).map((t) => t.id));

  // ---------- 提交 ----------
  let submissions: Array<{
    id: number; platform: string; account: string; verdict: string; language: string | null;
    submittedAt: string; context: string | null; problemKey: string;
  }> = [];
  const verdicts: Record<string, number> = {};
  let stats = { attempts: 0, acCount: 0, firstSubmittedAt: null as string | null, firstAcAt: null as string | null, lastSubmittedAt: null as string | null, lastAcAt: null as string | null };
  if (ids.length > 0) {
    const agg = db
      .prepare(
        `SELECT COUNT(*) AS attempts,
                COALESCE(SUM(CASE WHEN verdict = 'AC' THEN 1 ELSE 0 END), 0) AS acCount,
                MIN(submitted_at) AS firstSubmittedAt,
                MIN(CASE WHEN verdict = 'AC' THEN submitted_at END) AS firstAcAt,
                MAX(submitted_at) AS lastSubmittedAt,
                MAX(CASE WHEN verdict = 'AC' THEN submitted_at END) AS lastAcAt
           FROM submissions WHERE user_id = ? AND problem_id IN (${idIn})`,
      )
      .get(userId, ...ids) as typeof stats;
    stats = agg;
    for (const v of db
      .prepare(`SELECT verdict, COUNT(*) AS n FROM submissions WHERE user_id = ? AND problem_id IN (${idIn}) GROUP BY verdict ORDER BY n DESC`)
      .all(userId, ...ids) as Array<{ verdict: string; n: number }>) {
      verdicts[v.verdict] = v.n;
    }
    submissions = db
      .prepare(
        `SELECT s.id, s.platform, s.account, s.verdict, s.language, s.submitted_at AS submittedAt, s.context,
                p.problem_key AS problemKey
           FROM submissions s JOIN problems p ON p.id = s.problem_id
          WHERE s.user_id = ? AND s.problem_id IN (${idIn})
          ORDER BY s.submitted_at DESC, s.id DESC LIMIT ?`,
      )
      .all(userId, ...ids, PEEK_SUBMISSION_LIMIT) as typeof submissions;
  }

  // ---------- 卡点 ----------
  const intents =
    ids.length === 0
      ? []
      : (
          db
            .prepare(
              `SELECT i.id, i.code, i.outcome, i.created_at, p.platform, p.problem_key
                 FROM submission_intents i JOIN problems p ON p.id = i.problem_id
                WHERE i.user_id = ? AND i.problem_id IN (${idIn})
                ORDER BY i.created_at DESC, i.id DESC`,
            )
            .all(userId, ...ids) as Array<{ id: number; code: string | null; outcome: string; created_at: string; platform: string; problem_key: string }>
        ).map((i) => ({
          id: i.id,
          code: i.code,
          codeName: i.code ? nameOfCode(i.code) : null,
          outcome: i.outcome,
          createdAt: utcToIso(i.created_at),
          platform: i.platform,
          problemKey: i.problem_key,
        }));

  // ---------- 复习 ----------
  let review = null;
  if (ids.length > 0) {
    const item = db
      .prepare(
        `SELECT ri.id, ri.stage, ri.note, ri.added_at, ri.last_reviewed_at, ri.next_due_on, p.platform, p.problem_key
           FROM review_items ri JOIN problems p ON p.id = ri.problem_id
          WHERE ri.user_id = ? AND ri.problem_id IN (${idIn})
          ORDER BY ri.next_due_on LIMIT 1`,
      )
      .get(userId, ...ids) as
      | { id: number; stage: number; note: string | null; added_at: string; last_reviewed_at: string | null; next_due_on: string; platform: string; problem_key: string }
      | undefined;
    const events = (
      db
        .prepare(
          `SELECT re.id, re.reviewed_at, re.feedback, re.stage_before, re.stage_after, re.due_on, re.interval_days, re.factor
             FROM review_events re
            WHERE re.user_id = ? AND re.problem_id IN (${idIn})
            ORDER BY julianday(re.reviewed_at) DESC, re.id DESC LIMIT ?`,
        )
        .all(userId, ...ids, PEEK_REVIEW_EVENT_LIMIT) as Array<{
        id: number; reviewed_at: string; feedback: string; stage_before: number; stage_after: number;
        due_on: string; interval_days: number; factor: number;
      }>
    ).map((e) => ({
      id: e.id,
      reviewedAt: e.reviewed_at,
      feedback: e.feedback,
      stageBefore: e.stage_before,
      stageAfter: e.stage_after,
      dueOn: e.due_on,
      intervalDays: e.interval_days,
      factor: e.factor,
    }));
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN feedback = 'hard' THEN 1 ELSE 0 END), 0) AS lapses
           FROM review_events WHERE user_id = ? AND problem_id IN (${idIn})`,
      )
      .get(userId, ...ids) as { total: number; lapses: number };
    if (item || events.length > 0) {
      review = {
        item: item
          ? {
              id: item.id,
              stage: item.stage,
              intervalDays: intervalDaysForStage(item.stage),
              note: item.note,
              addedAt: utcToIso(item.added_at),
              lastReviewedAt: item.last_reviewed_at,
              nextDueOn: item.next_due_on,
              overdueDays: item.next_due_on < today ? daysBetween(item.next_due_on, today) : 0,
              daysUntilDue: item.next_due_on >= today ? daysBetween(today, item.next_due_on) : 0,
            }
          : null,
        reviewCount: counts.total,
        lapseCount: counts.lapses,
        events,
      };
    }
  }

  // ---------- 题单 ----------
  const pairs: Array<[string, string]> = mirrors.map((m) => [m.platform, m.problem_key]);
  if (parsed && !pairs.some(([p, k]) => p === parsed.platform && k === parsed.problemKey)) {
    pairs.push([parsed.platform, parsed.problemKey]);
  }
  const lists =
    pairs.length === 0
      ? []
      : (
          db
            .prepare(
              `SELECT l.id AS listId, l.title AS listTitle, i.id AS itemId, i.category, i.platform, i.problem_key AS problemKey
                 FROM problem_list_items i JOIN problem_lists l ON l.id = i.list_id
                WHERE l.user_id = ? AND (${pairs.map(() => '(i.platform = ? AND i.problem_key = ?)').join(' OR ')})
                ORDER BY l.position, l.id`,
            )
            .all(userId, ...pairs.flat()) as Array<{ listId: number; listTitle: string; itemId: number; category: string; platform: string; problemKey: string }>
        );

  // ---------- 今日训练推荐 ----------
  const recommendation =
    ids.length === 0
      ? null
      : ((db
          .prepare(
            `SELECT recommended_on AS recommendedOn, band FROM today_recommendations
              WHERE user_id = ? AND problem_id IN (${idIn}) ORDER BY recommended_on DESC LIMIT 1`,
          )
          .get(userId, ...ids) as { recommendedOn: string; band: string } | undefined) ?? null);

  const status: 'ac' | 'tried' | 'none' = stats.acCount > 0 ? 'ac' : stats.attempts > 0 ? 'tried' : 'none';
  return {
    found: primary !== null,
    target: parsed,
    url: primary?.url ?? q.url ?? null,
    problem: primary ? toPeekProblem(primary) : null,
    mirrors: mirrors.slice(1).map(toPeekProblem),
    status,
    stats,
    verdicts,
    submissions,
    notes,
    intents,
    review,
    tasks,
    lists,
    recommendation,
  };
}

export type ProblemPeekResult = ReturnType<typeof problemPeek>;

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((b - a) / 86_400_000) : 0;
}
