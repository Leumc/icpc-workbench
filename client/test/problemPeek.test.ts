import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanTitleHint, isProblemUrl, noteSnippet, peekApiPath, peekRequestFromClick } from '../src/problemPeek'

test('isProblemUrl：各平台题目页命中', () => {
  for (const url of [
    'https://codeforces.com/contest/1919/problem/C',
    'https://codeforces.com/problemset/problem/1000/A',
    'https://codeforces.com/gym/104821/problem/A',
    'https://atcoder.jp/contests/abc300/tasks/abc300_a',
    'https://atcoder.jp/tasks/abc300_a',
    'https://www.luogu.com.cn/problem/P1001',
    'https://www.luogu.com.cn/problem/CF1000A',
    'https://www.nowcoder.com/practice/0123456789abcdef0123456789abcdef',
    'https://ac.nowcoder.com/acm/problem/12345',
    'https://ac.nowcoder.com/acm/contest/12345/A',
    'https://bs.daimayuan.top/p/12',
    'https://www.jisuanke.com/problem/T1001',
    'https://leetcode.cn/problems/two-sum/',
    'https://leetcode.cn/problems/two-sum/description/',
    'https://qoj.ac/contest/3588/problem/17753',
    'https://qoj.ac/problem/9242',
    'https://vjudge.net/problem/CodeForces-1234A',
    'https://vjudge.net/problem/%E6%B4%9B%E8%B0%B7-P1001',
    'https://dashoj.com/p/A1',
  ]) {
    assert.equal(isProblemUrl(url), true, url)
  }
})

test('isProblemUrl：比赛页 / 博客 / 题单 / 其它站点不命中', () => {
  for (const url of [
    'https://codeforces.com/contest/1919',
    'https://codeforces.com/blog/entry/1',
    'https://atcoder.jp/contests/abc300',
    'https://www.luogu.com.cn/problem/list',
    'https://www.luogu.com.cn/training/100',
    'https://leetcode.cn/problemset/',
    'https://github.com/foo/bar',
    'javascript:alert(1)',
    'mailto:a@b.c',
    '/problems?q=1A',
  ]) {
    assert.equal(isProblemUrl(url), false, url)
  }
})

/** 最小化的 DOM 替身：只实现 closest / getAttribute / textContent */
function anchor(attrs: Record<string, string>, text = ''): Element {
  const el = {
    getAttribute: (k: string) => attrs[k] ?? null,
    textContent: text,
    closest: (sel: string) => (sel.includes('a[') ? el : null),
  }
  return el as unknown as Element
}

const click = (target: Element, extra: Partial<MouseEvent> = {}) => ({
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  target,
  ...extra,
}) as Parameters<typeof peekRequestFromClick>[0]

const ORIGIN = 'http://127.0.0.1:5173/today'

test('peekRequestFromClick：题目链接被拦截并带上标题兜底', () => {
  const req = peekRequestFromClick(click(anchor({ href: 'https://www.luogu.com.cn/problem/P1001' }, '[P1001] A+B Problem ↗')), ORIGIN)
  assert.deepEqual(req, { url: 'https://www.luogu.com.cn/problem/P1001', titleHint: 'A+B Problem' })
})

test('peekRequestFromClick：修饰键 / 非左键 / data-peek=off / 非题目链接 / 站内链接都放行', () => {
  const a = anchor({ href: 'https://codeforces.com/contest/1/problem/A' })
  assert.equal(peekRequestFromClick(click(a, { ctrlKey: true }), ORIGIN), null)
  assert.equal(peekRequestFromClick(click(a, { metaKey: true }), ORIGIN), null)
  assert.equal(peekRequestFromClick(click(a, { shiftKey: true }), ORIGIN), null)
  assert.equal(peekRequestFromClick(click(a, { button: 1 }), ORIGIN), null)
  assert.equal(peekRequestFromClick(click(a, { defaultPrevented: true }), ORIGIN), null)
  assert.equal(peekRequestFromClick(click(anchor({ href: 'https://codeforces.com/contest/1/problem/A', 'data-peek': 'off' })), ORIGIN), null)
  assert.equal(peekRequestFromClick(click(anchor({ href: 'https://codeforces.com/contest/1' })), ORIGIN), null)
  assert.equal(peekRequestFromClick(click(anchor({ href: '/notes?problem=1' })), ORIGIN), null)
  const noAnchor = { closest: () => null } as unknown as Element
  assert.equal(peekRequestFromClick(click(noAnchor), ORIGIN), null)
})

test('peekRequestFromClick：data-problem-id 即使链接认不出也拦截', () => {
  const req = peekRequestFromClick(click(anchor({ href: 'https://example.com/custom-oj/42', 'data-problem-id': '7' }, 'Custom')), ORIGIN)
  assert.deepEqual(req, { url: 'https://example.com/custom-oj/42', problemId: 7, titleHint: 'Custom' })
})

test('peekApiPath：id 与链接都带上', () => {
  assert.equal(peekApiPath({ problemId: 3, url: 'https://a.b/c?d=1' }), '/api/problems/peek?id=3&url=https%3A%2F%2Fa.b%2Fc%3Fd%3D1')
  assert.equal(peekApiPath({ url: 'https://x.y/z' }), '/api/problems/peek?url=https%3A%2F%2Fx.y%2Fz')
})

test('cleanTitleHint / noteSnippet', () => {
  assert.equal(cleanTitleHint('  [1919C]  Grouping Increases ↗ '), 'Grouping Increases')
  assert.equal(cleanTitleHint('↗'), undefined)
  assert.equal(noteSnippet('# 思路\n\n**二分**答案\n\n```cpp\nint x;\n```'), '思路 二分 答案 [代码]')
  assert.equal(noteSnippet('a'.repeat(100), 10), `${'a'.repeat(10)}…`)
})
