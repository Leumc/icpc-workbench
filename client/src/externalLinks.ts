/**
 * 外链打开策略：
 * - 浏览器环境：保持原生 <a target="_blank"> / window.open 行为
 * - 桌面壳（Tauri WebView）：target="_blank" 的新窗口请求被默认策略吞掉，
 *   需拦截后委托 opener 插件交系统浏览器打开
 * - 题目链接：两种环境都先弹题目速览（见 problemPeek.ts），由卡片上的按钮再真正打开
 */

import { openProblemPeek, peekRequestFromClick } from './problemPeek'

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>

interface TauriGlobal {
  core?: {
    invoke?: TauriInvoke
  }
}

function tauriInvoke(): TauriInvoke | null {
  const tauri = (window as { __TAURI__?: TauriGlobal }).__TAURI__
  return tauri?.core?.invoke ?? null
}

export function isTauriShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** 在系统浏览器打开外链（桌面壳走 opener 插件，浏览器回退 window.open） */
export async function openExternal(url: string): Promise<void> {
  const invoke = tauriInvoke()
  if (invoke && /^https?:/i.test(url)) {
    try {
      await invoke('plugin:opener|open_url', { url })
      return
    } catch {
      // 插件调用失败时回退，避免链接彻底失效
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * 全局接管链接点击（捕获阶段，早于 React 与各页面自己的处理）：
 * 1. 指向题目页的链接 → 先弹题目速览卡片（problemPeek.ts），浏览器与桌面壳都生效；
 * 2. 桌面壳内其余 http(s) 外链 → 统一走系统浏览器（含 Markdown 渲染的链接）。
 */
export function setupExternalLinks(): void {
  if (typeof document === 'undefined') return
  const shell = isTauriShell()
  document.addEventListener(
    'click',
    (e) => {
      const peek = peekRequestFromClick(e, window.location.href)
      if (peek) {
        e.preventDefault()
        openProblemPeek(peek)
        return
      }
      if (!shell) return
      if (e.button !== 0 || e.defaultPrevented) return
      const target = e.target as Element | null
      const anchor = target?.closest?.('a[href]')
      if (!anchor) return
      const href = anchor.getAttribute('href') ?? ''
      if (!/^https?:/i.test(href)) return
      // 站内路由链接不拦截（SPA 同源跳转由前端路由处理）
      if (new URL(href, window.location.href).origin === window.location.origin) return
      e.preventDefault()
      e.stopPropagation()
      void openExternal(href)
    },
    true,
  )
}
