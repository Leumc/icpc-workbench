import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { listenForTest } from './test-listen.ts';
import { createDb, type Db } from '../src/db/index.ts';
import { notesRoutes } from '../src/routes/notes.ts';
import { problemsRoutes } from '../src/routes/problems.ts';
import { parseProblemUrl } from '../src/problems/peek.ts';

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

async function withServer(fn: (db: Db, call: Call) => Promise<void>): Promise<void> {
  const db = createDb(':memory:');
  const app = express();
  app.use(express.json());
  app.use('/api/notes', notesRoutes(db));
  app.use('/api/problems', problemsRoutes(db));
  const srv = await listenForTest(app);
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const call: Call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(db, call);
  } finally {
    srv.close();
    db.close();
  }
}

const insertProblem = (db: Db, platform: string, key: string, title: string, extra: { url?: string; difficulty?: number; tags?: string[] } = {}): number =>
  Number(
    db
      .prepare('INSERT INTO problems (platform, problem_key, title, url, difficulty, tags) VALUES (?, ?, ?, ?, ?, ?)')
      .run(platform, key, title, extra.url ?? null, extra.difficulty ?? null, JSON.stringify(extra.tags ?? [])).lastInsertRowid,
  );

const insertNote = (db: Db, problemId: number | null, content: string, labels: string[] = [], taskId: number | null = null): number =>
  Number(
    db
      .prepare('INSERT INTO problem_notes (user_id, problem_id, task_id, labels, content) VALUES (1, ?, ?, ?, ?)')
      .run(problemId, taskId, JSON.stringify(labels), content).lastInsertRowid,
  );

const q = (url: string): string => `/api/problems/peek?url=${encodeURIComponent(url)}`;

test('parseProblemUrl：识别各平台题目链接，非题目页返回 null', () => {
  assert.deepEqual(parseProblemUrl('https://codeforces.com/contest/1919/problem/c'), { platform: 'codeforces', problemKey: '1919C' });
  assert.deepEqual(parseProblemUrl('https://codeforces.com/problemset/problem/1000/A'), { platform: 'codeforces', problemKey: '1000A' });
  assert.deepEqual(parseProblemUrl('https://www.luogu.com.cn/problem/P1001?contestId=1'), { platform: 'luogu', problemKey: 'P1001' });
  assert.deepEqual(parseProblemUrl('https://atcoder.jp/contests/abc300/tasks/abc300_a'), { platform: 'atcoder', problemKey: 'abc300_a' });
  assert.deepEqual(parseProblemUrl('https://atcoder.jp/tasks/abc300_b'), { platform: 'atcoder', problemKey: 'abc300_b' });
  assert.deepEqual(parseProblemUrl('https://dashoj.com/p/A1'), { platform: 'dashoj', problemKey: 'A1' });
  assert.deepEqual(parseProblemUrl('https://vjudge.net/problem/CodeForces-1234A'), { platform: 'codeforces', problemKey: '1234A' });
  assert.equal(parseProblemUrl('https://codeforces.com/blog/entry/1234'), null);
  assert.equal(parseProblemUrl('https://github.com/x/y'), null);
  assert.equal(parseProblemUrl('javascript:alert(1)'), null);
  assert.equal(parseProblemUrl('not a url'), null);
});

test('题目速览：按链接定位题目，并按原题身份汇总镜像题的笔记 / 卡点 / 提交 / 复习', async () => {
  await withServer(async (db, call) => {
    const cf = insertProblem(db, 'codeforces', '1000A', 'Codehorses T-shirts', {
      url: 'https://codeforces.com/contest/1000/problem/A', difficulty: 1200, tags: ['greedy', 'implementation'],
    });
    const lg = insertProblem(db, 'luogu', 'CF1000A', 'Codehorses T-shirts（洛谷）');
    const other = insertProblem(db, 'codeforces', '1000B', 'Light It Up');
    insertNote(db, lg, '在洛谷镜像上写的笔记', ['思路']);
    insertNote(db, cf, '原题上的笔记', ['踩坑']);
    insertNote(db, other, '别的题的笔记');
    db.prepare("INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id) VALUES (1, 'codeforces', 'me', ?, 'WA', '2026-05-01T10:00:00Z', 'e1')").run(cf);
    db.prepare("INSERT INTO submissions (user_id, platform, account, problem_id, verdict, submitted_at, external_id) VALUES (1, 'luogu', 'me', ?, 'AC', '2026-05-02T10:00:00Z', 'e2')").run(lg);
    db.prepare("INSERT INTO submission_intents (user_id, problem_id, code, outcome) VALUES (1, ?, NULL, 'wrong_approach')").run(lg);
    const itemId = Number(db.prepare("INSERT INTO review_items (user_id, problem_id, stage, note, next_due_on) VALUES (1, ?, 2, '复习要点', '2099-01-01')").run(cf).lastInsertRowid);
    db.prepare("INSERT INTO review_events (user_id, review_item_id, problem_id, reviewed_at, feedback, stage_before, stage_after, due_on, interval_days) VALUES (1, ?, ?, '2026-06-01T00:00:00Z', 'hard', 3, 2, '2026-06-01', 14)").run(itemId, cf);
    const listId = Number(db.prepare("INSERT INTO problem_lists (user_id, title) VALUES (1, '贪心专题')").run().lastInsertRowid);
    db.prepare("INSERT INTO problem_list_items (list_id, platform, problem_key, category) VALUES (?, 'luogu', 'CF1000A', '贪心')").run(listId);

    const { status, body } = await call('GET', q('https://codeforces.com/contest/1000/problem/A'));
    assert.equal(status, 200);
    assert.equal(body.found, true);
    assert.equal(body.problem.id, cf);
    assert.equal(body.problem.difficulty, 1200);
    assert.deepEqual(body.problem.tags.sort(), ['greedy', 'implementation'].sort());
    assert.deepEqual(body.mirrors.map((m: any) => m.id), [lg]);
    assert.deepEqual(body.notes.map((n: any) => n.content).sort(), ['原题上的笔记', '在洛谷镜像上写的笔记'].sort());
    assert.equal(body.notes.find((n: any) => n.problemId === lg).problem.platform, 'luogu');
    assert.equal(body.status, 'ac');
    assert.equal(body.stats.attempts, 2);
    assert.equal(body.stats.acCount, 1);
    assert.equal(body.stats.firstAcAt, '2026-05-02T10:00:00Z');
    assert.deepEqual(body.verdicts, { WA: 1, AC: 1 });
    assert.equal(body.submissions.length, 2);
    assert.equal(body.intents.length, 1);
    assert.equal(body.intents[0].outcome, 'wrong_approach');
    assert.equal(body.review.item.id, itemId);
    assert.equal(body.review.item.note, '复习要点');
    assert.equal(body.review.reviewCount, 1);
    assert.equal(body.review.lapseCount, 1);
    assert.deepEqual(body.lists.map((l: any) => [l.listTitle, l.category]), [['贪心专题', '贪心']]);

    // 从洛谷镜像链接点进来，汇总的是同一份数据，主题目是洛谷那一行
    const fromLuogu = await call('GET', q('https://www.luogu.com.cn/problem/CF1000A'));
    assert.equal(fromLuogu.body.problem.id, lg);
    assert.equal(fromLuogu.body.notes.length, 2);

    // 按 id 查询与按链接一致
    const byId = await call('GET', `/api/problems/peek?id=${cf}`);
    assert.equal(byId.body.notes.length, 2);
  });
});

test('题目速览：题库里没有的题仍按链接匹配训练任务（含任务上的笔记）与题单', async () => {
  await withServer(async (db, call) => {
    const planId = Number(db.prepare("INSERT INTO plans (user_id, title, start_date, end_date) VALUES (1, 'AI 计划', '2026-01-01', '2026-01-07')").run().lastInsertRowid);
    const url = 'https://www.luogu.com.cn/problem/P9999';
    const taskId = Number(
      db.prepare("INSERT INTO plan_tasks (plan_id, task_date, title, kind, url, note) VALUES (?, '2026-01-02', 'P9999 某题', 'practice', ?, 'AI 提示：先想单调性')").run(planId, `${url}/`).lastInsertRowid,
    );
    db.prepare("INSERT INTO plan_tasks (plan_id, task_date, title, kind, url) VALUES (?, '2026-01-03', '别的题', 'practice', 'https://www.luogu.com.cn/problem/P1')").run(planId);
    insertNote(db, null, '任务笔记', [], taskId);
    const listId = Number(db.prepare("INSERT INTO problem_lists (user_id, title) VALUES (1, '待整理')").run().lastInsertRowid);
    db.prepare("INSERT INTO problem_list_items (list_id, platform, problem_key, category) VALUES (?, 'luogu', 'P9999', '未分类')").run(listId);

    const { body } = await call('GET', q(url));
    assert.equal(body.found, false);
    assert.equal(body.problem, null);
    assert.deepEqual(body.target, { platform: 'luogu', problemKey: 'P9999' });
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].note, 'AI 提示：先想单调性');
    assert.equal(body.tasks[0].checkedAt, null);
    assert.deepEqual(body.notes.map((n: any) => n.content), ['任务笔记']);
    assert.equal(body.lists.length, 1);
    assert.equal(body.status, 'none');
  });
});

test('题目速览：参数校验', async () => {
  await withServer(async (_db, call) => {
    assert.equal((await call('GET', '/api/problems/peek')).status, 400);
    assert.equal((await call('GET', '/api/problems/peek?id=abc')).status, 400);
    const missing = await call('GET', '/api/problems/peek?id=999');
    assert.equal(missing.status, 200);
    assert.equal(missing.body.found, false);
  });
});

test('笔记库：汇总题目笔记与复习笔记，支持关键词 / 平台 / 标注 / 来源过滤', async () => {
  await withServer(async (db, call) => {
    const a = insertProblem(db, 'codeforces', '1A', 'Theatre Square');
    const b = insertProblem(db, 'luogu', 'P1001', 'A+B Problem');
    insertNote(db, a, '向上取整 (n+a-1)/a', ['思路']);
    insertNote(db, b, '注意 100% 不要溢出', ['踩坑', '易错']);
    db.prepare("INSERT INTO review_items (user_id, problem_id, note, next_due_on) VALUES (1, ?, '复习：long long', '2099-01-01')").run(a);
    db.prepare("INSERT INTO review_items (user_id, problem_id, note, next_due_on) VALUES (1, ?, '   ', '2099-01-01')").run(b);

    const all = (await call('GET', '/api/notes/library')).body;
    assert.equal(all.notes.length, 2);
    assert.equal(all.reviewNotes.length, 1, '空白复习笔记不进笔记库');
    assert.equal(all.reviewNotes[0].problem.problemKey, '1A');
    assert.equal(all.notes[0].problem.title !== undefined, true);
    assert.deepEqual(all.labels.map((l: any) => l.label).sort(), ['思路', '易错', '踩坑'].sort());
    assert.equal(all.truncated, false);

    const byKey = (await call('GET', '/api/notes/library?q=P1001')).body;
    assert.deepEqual(byKey.notes.map((n: any) => n.problem.problemKey), ['P1001']);
    assert.equal(byKey.reviewNotes.length, 0);

    // % 按字面量匹配
    const literal = (await call('GET', `/api/notes/library?q=${encodeURIComponent('100%')}`)).body;
    assert.equal(literal.notes.length, 1);
    const wildcard = (await call('GET', `/api/notes/library?q=${encodeURIComponent('%')}`)).body;
    assert.equal(wildcard.notes.length, 1);

    const byLabel = (await call('GET', `/api/notes/library?label=${encodeURIComponent('思路')}`)).body;
    assert.deepEqual(byLabel.notes.map((n: any) => n.problemId), [a]);
    assert.equal(byLabel.reviewNotes.length, 0, '按标注过滤时复习笔记（无标注）不返回');

    const byPlatform = (await call('GET', '/api/notes/library?platform=codeforces')).body;
    assert.equal(byPlatform.notes.length, 1);
    assert.equal(byPlatform.reviewNotes.length, 1);

    const reviewOnly = (await call('GET', '/api/notes/library?source=review')).body;
    assert.equal(reviewOnly.notes.length, 0);
    assert.equal(reviewOnly.reviewNotes.length, 1);

    assert.equal((await call('GET', '/api/notes/library?platform=nope')).status, 400);
    assert.equal((await call('GET', '/api/notes/library?source=nope')).status, 400);
  });
});

test('GET /api/notes?problemId=&mirrors=1 连同镜像题笔记一起返回', async () => {
  await withServer(async (db, call) => {
    const cf = insertProblem(db, 'codeforces', '1000A', 'X');
    const lg = insertProblem(db, 'luogu', 'CF1000A', 'X');
    insertNote(db, cf, 'cf');
    insertNote(db, lg, 'lg');
    assert.equal((await call('GET', `/api/notes?problemId=${cf}`)).body.items.length, 1);
    assert.equal((await call('GET', `/api/notes?problemId=${cf}&mirrors=1`)).body.items.length, 2);
  });
});
