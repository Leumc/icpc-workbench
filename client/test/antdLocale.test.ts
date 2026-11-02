import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { readFlag } from '../src/persistence.ts'

test('antd 语言包走 es 路径：CommonJS 入口默认导入取不到文案，整站会静默退回英文', () => {
  const source = fs.readFileSync(new URL('../src/themeContext.tsx', import.meta.url), 'utf8')
  assert.match(source, /from 'antd\/es\/locale\/zh_CN'/)
  assert.doesNotMatch(source, /from 'antd\/locale\//)
})

test('readFlag：没存过时用默认值，存过就听用户的', () => {
  const store = new Map<string, string>()
  const original = globalThis.localStorage
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) },
  })
  try {
    assert.equal(readFlag('x'), false)
    assert.equal(readFlag('x', true), true)
    store.set('x', '0')
    assert.equal(readFlag('x', true), false, '用户展开过（存 0）不能被默认值覆盖')
    store.set('x', '1')
    assert.equal(readFlag('x'), true)
  } finally {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original })
  }
})
