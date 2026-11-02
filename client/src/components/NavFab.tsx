import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { MenuOutlined } from '@ant-design/icons'

const STORAGE_KEY = 'icpc-nav-fab-position'
const SIZE = 48
const EDGE = 12
/** 默认高于页面底部：AI 助手的输入框和右下角进度卡都在最下面 */
const DEFAULT_POSITION: FabPosition = { side: 'left', bottom: 112 }
/** 移动超过这个距离才算拖动，手指轻微抖动仍是点击 */
const DRAG_THRESHOLD = 6

interface FabPosition {
  side: 'left' | 'right'
  bottom: number
}

function readPosition(): FabPosition {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as FabPosition | null
    if (parsed && (parsed.side === 'left' || parsed.side === 'right') && Number.isFinite(parsed.bottom)) return parsed
  } catch {
    /* 存储不可用或内容损坏：用默认位置 */
  }
  return DEFAULT_POSITION
}

/** 窄屏导航入口：点击展开侧边栏。可以拖开，避免挡住正在看的内容；松手后贴到最近的左右边缘。 */
export default function NavFab({ onOpen }: { onOpen: () => void }) {
  const [position, setPosition] = useState(readPosition)
  const [dragging, setDragging] = useState<{ x: number; y: number } | null>(null)
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  /** 刚拖动过：随后的 click 不算点击 */
  const dragged = useRef(false)

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    start.current = { x: e.clientX, y: e.clientY, moved: false }
    dragged.current = false
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const s = start.current
    if (!s) return
    if (!s.moved && Math.hypot(e.clientX - s.x, e.clientY - s.y) < DRAG_THRESHOLD) return
    s.moved = true
    dragged.current = true
    setDragging({ x: e.clientX, y: e.clientY })
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const s = start.current
    start.current = null
    setDragging(null)
    if (!s?.moved) return
    const next: FabPosition = {
      side: e.clientX < window.innerWidth / 2 ? 'left' : 'right',
      bottom: Math.round(Math.min(window.innerHeight - SIZE - EDGE, Math.max(EDGE, window.innerHeight - e.clientY - SIZE / 2))),
    }
    setPosition(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* 仅本次会话生效 */
    }
  }

  const placement = dragging
    ? { left: dragging.x - SIZE / 2, top: dragging.y - SIZE / 2 }
    : {
        [position.side]: EDGE,
        // 横竖屏切换后视口变矮时，不让球跑到屏幕外
        bottom: `min(${position.bottom}px, calc(100dvh - ${SIZE + EDGE}px))`,
      }

  return (
    <button
      type="button"
      className={`nav-fab${dragging ? ' is-dragging' : ''}`}
      style={placement}
      aria-label="打开导航菜单"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        start.current = null
        setDragging(null)
      }}
      // 必须在 click 里打开，不能在 pointerup 里：抬手时打开的话，球随即卸载，浏览器紧接着补发的
      // click 会落到抽屉的遮罩或菜单项上，抽屉马上又被关掉。键盘 Enter / 空格也会触发 click
      onClick={() => {
        if (!dragged.current) onOpen()
      }}
    >
      <MenuOutlined />
    </button>
  )
}
