/**
 * 题目速览：点击**任何**题目链接（页面表格、AI 回复 / 笔记里的 Markdown 链接、模板例题……）
 * 都先弹出速览卡片，而不是直接跳到 OJ。
 *
 * 实现是全局拦截（见 externalLinks.ts 的 setupExternalLinks）：在 document 捕获阶段识别
 * 「指向题目页的 <a>」，阻止默认跳转并把请求放进这里的小 store，由 App 里挂载的
 * <ProblemPeekHost /> 订阅渲染。这样新加的页面、AI 生成的内容不需要逐处接入。
 *
 * 不拦截的情况：
 * - 带 data-peek="off" 的链接（速览卡片自己的「打开题目」按钮）；
 * - Ctrl / ⌘ / Shift / Alt + 点击与中键（用户明确要「直接在新标签打开」）；
 * - 不是题目页的链接（比赛页、博客、GitHub 等）。
 */
import { useSyncExternalStore } from 'react'

export interface PeekRequest {
  /** 被点击的题目链接 */
  url?: string
  /** 站内已知题目 id（data-problem-id），比链接解析更准 */
  problemId?: number
  /** 链接文字（题库里还没有这道题时用作标题兜底） */
  titleHint?: string
  /** 每次打开递增，同一链接连点两次也会重新拉取 */
  seq: number
}

let current: PeekRequest | null = null
let seq = 0
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const l of listeners) l()
}

export function openProblemPeek(req: Omit<PeekRequest, 'seq'>): void {
  seq += 1
  current = { ...req, seq }
  emit()
}

export function closeProblemPeek(): void {
  if (current === null) return
  current = null
  emit()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useProblemPeekRequest(): PeekRequest | null {
  return useSyncExternalStore(subscribe, () => current, () => null)
}

/**
 * 各平台「题目页」的链接形态（只看 host + path，不发请求）。
 * 宁可漏判也不误判：误判会让比赛页、讨论区链接也弹出一张「没找到题目」的卡片。
 * 服务端（server/src/problems/peek.ts）会再做一次精确解析，并按 problems.url 兜底匹配。
 */
const PROBLEM_URL_RULES: Array<{ host: RegExp; path: RegExp }> = [
  { host: /(^|\.)codeforces\.(com|ml)$/, path: /^\/(contest|gym)\/\d+\/problem\/[A-Za-z0-9]+\/?$|^\/problemset\/problem\/\d+\/[A-Za-z0-9]+\/?$/ },
  { host: /(^|\.)atcoder\.jp$/, path: /^\/contests\/[^/]+\/tasks\/[a-z0-9_-]+\/?$|^\/tasks\/[a-z0-9_-]+\/?$/i },
  { host: /(^|\.)luogu\.com\.cn$/, path: /^\/problem\/(?!list\b)[A-Za-z0-9_]+\/?$/ },
  { host: /(^|\.)nowcoder\.com$/, path: /^\/practice\/[a-f0-9]{32}|^\/acm\/problem\/\d+|^\/acm\/contest\/\d+\/[A-Za-z0-9]+\/?$/i },
  { host: /^bs\.daimayuan\.top$/, path: /^\/p\/\d+\/?$/ },
  { host: /^oj\.daimayuan\.top$/, path: /^\/(problem|course\/\d+)\/\d+\/?$/ },
  { host: /(^|\.)jisuanke\.com$/, path: /^\/(contest\/\d+\/)?problem\/[A-Za-z0-9_-]+\/?$/ },
  { host: /(^|\.)leetcode\.(cn|com)$/, path: /^\/problems\/[a-z0-9_-]+(\/(description)?)?\/?$/i },
  { host: /(^|\.)qoj\.ac$/, path: /^\/(contest\/\d+\/)?problem\/[A-Za-z0-9_]+\/?$/i },
  { host: /(^|\.)vjudge\.net$/, path: /^\/problem\/[^/]+-[^/]+\/?$/ },
  { host: /(^|\.)dashoj\.com$/, path: /^\/(p|problem)\/[A-Za-z0-9_-]+\/?$/ },
]

/** href 是否指向某个 OJ 的题目页（解析失败 / 非 http(s) 一律 false） */
export function isProblemUrl(href: string, base = 'http://localhost/'): boolean {
  let url: URL
  try {
    url = new URL(href, base)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  let path = url.pathname
  try {
    path = decodeURIComponent(path)
  } catch {
    /* 非法编码按原样匹配 */
  }
  return PROBLEM_URL_RULES.some((r) => r.host.test(host) && r.path.test(path))
}

/** 去掉链接文字里的装饰（↗ 箭头、[题号] 前缀），留作标题兜底 */
export function cleanTitleHint(text: string | null | undefined): string | undefined {
  const t = (text ?? '').replace(/↗\uFE0E?/g, '').replace(/^\s*\[[^\]]{1,40}\]\s*/, '').replace(/\s+/g, ' ').trim()
  return t.length > 0 && t.length <= 200 ? t : undefined
}

/**
 * 从一次点击里取出速览请求；不该拦截时返回 null。
 * 抽成纯函数便于测试（DOM 只用到 closest / getAttribute / textContent）。
 */
export function peekRequestFromClick(
  e: Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'defaultPrevented' | 'target'>,
  origin: string,
): Omit<PeekRequest, 'seq'> | null {
  if (e.button !== 0 || e.defaultPrevented) return null
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return null
  const target = e.target as Element | null
  const anchor = target?.closest?.('a[href], a[data-problem-id]') as HTMLAnchorElement | null
  if (!anchor) return null
  if (anchor.getAttribute('data-peek') === 'off') return null
  const href = anchor.getAttribute('href') ?? ''
  const idAttr = Number(anchor.getAttribute('data-problem-id'))
  const problemId = Number.isSafeInteger(idAttr) && idAttr > 0 ? idAttr : undefined
  let absolute: string | undefined
  if (href) {
    try {
      const u = new URL(href, origin)
      // 站内路由链接不是题目链接
      if (u.origin !== new URL(origin).origin) absolute = u.href
    } catch {
      /* 非法地址交给浏览器默认处理 */
    }
  }
  if (problemId === undefined && (absolute === undefined || !isProblemUrl(absolute))) return null
  return {
    ...(absolute ? { url: absolute } : {}),
    ...(problemId !== undefined ? { problemId } : {}),
    titleHint: cleanTitleHint(anchor.textContent),
  }
}

/* ---------------- GET /api/problems/peek 的响应 ---------------- */

export interface PeekProblem {
  id: number
  platform: string
  problemKey: string
  title: string
  url: string | null
  difficulty: number | null
  difficultyLabel: string | null
  difficultySource: string | null
  tags: string[]
}

export interface PeekSubmission {
  id: number
  platform: string
  account: string
  verdict: string
  language: string | null
  submittedAt: string
  context: string | null
  problemKey: string
}

export interface PeekIntent {
  id: number
  code: string | null
  codeName: string | null
  outcome: string
  createdAt: string
  platform: string
  problemKey: string
}

export interface PeekReviewEvent {
  id: number
  reviewedAt: string
  feedback: string
  stageBefore: number
  stageAfter: number
  dueOn: string
  intervalDays: number
  factor: number
}

export interface PeekReview {
  item: {
    id: number
    stage: number
    intervalDays: number
    note: string | null
    addedAt: string
    lastReviewedAt: string | null
    nextDueOn: string
    overdueDays: number
    daysUntilDue: number
  } | null
  reviewCount: number
  lapseCount: number
  events: PeekReviewEvent[]
}

export interface PeekTask {
  id: number
  planId: number
  planTitle: string
  taskDate: string
  title: string
  kind: string
  note: string | null
  checkedAt: string | null
}

export interface PeekListEntry {
  listId: number
  listTitle: string
  itemId: number
  category: string
  platform: string
  problemKey: string
}

export interface ProblemPeekData {
  found: boolean
  target: { platform: string; problemKey: string } | null
  url: string | null
  problem: PeekProblem | null
  mirrors: PeekProblem[]
  status: 'ac' | 'tried' | 'none'
  stats: {
    attempts: number
    acCount: number
    firstSubmittedAt: string | null
    firstAcAt: string | null
    lastSubmittedAt: string | null
    lastAcAt: string | null
  }
  verdicts: Record<string, number>
  submissions: PeekSubmission[]
  notes: import('./problemNotes').ProblemNote[]
  intents: PeekIntent[]
  review: PeekReview | null
  tasks: PeekTask[]
  lists: PeekListEntry[]
  recommendation: { recommendedOn: string; band: string } | null
}

/** 速览接口地址：站内已知 id 优先，链接一并带上（用于匹配只有链接的训练任务） */
export function peekApiPath(req: Pick<PeekRequest, 'url' | 'problemId'>): string {
  const qs = new URLSearchParams()
  if (req.problemId !== undefined) qs.set('id', String(req.problemId))
  if (req.url) qs.set('url', req.url)
  return `/api/problems/peek?${qs.toString()}`
}

/** 笔记第一段可读文字（去掉 Markdown 记号），给摘要行用 */
export function noteSnippet(content: string, max = 60): string {
  const text = content
    .replace(/```[\s\S]*?```/g, ' [代码] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' [图片] ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\$+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}
