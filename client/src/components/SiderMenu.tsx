/**
 * 可拖拽排序的侧边栏导航。替换 antd Menu，保留分组结构，组内拖拽重排。
 *
 * 两条并行的排序路径（UI 优化方案 §6.2）：
 * 1. mouse 事件拖拽（默认路径，兼容 WebView2/WKWebView；HTML5 DnD 在 WebView2 中不工作）；
 * 2. **键盘路径**：每个组内条目在鼠标 hover 或自身获得焦点时显现「上移/下移」按钮
 *    （opacity:0 不会移除 Tab 焦点，所以 Tab 到按钮时 :focus-within 会让它显形）。
 *    这条路径不改动拖拽代码，纯增量。
 *
 * 3. **触屏路径**：手机 / 平板上箭头不常驻（opacity:0 的按钮在触屏上照样能点中，
 *    贴在每一项右侧，点导航时极易误触），改为**长按**某一项进入排序态，
 *    这一项才露出放大的上移 / 下移按钮；点这一项或点别处结束排序。
 *
 * 几条路径落盘后都给 3 秒「撤销」提示，误操作可回退。
 * 顺序持久化在 localStorage（见 menuConfig.tsx），折叠态保留分组分隔线。
 */
import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, KeyboardEvent, TouchEvent as ReactTouchEvent } from 'react'
import { useMediaQuery } from '../useMediaQuery'
import { App as AntdApp, Button, Tooltip } from 'antd'
import { IconArrowDown, IconArrowUp, IconUndo } from './icons'
import {
  MENU_GROUPS,
  MENU_FIXED_BOTTOM,
  MENU_FIXED_TOP,
  menuIcon,
  menuLabel,
  moveInGroup,
  reorderInGroup,
  resetMenuOrder,
  setMenuOrder,
  useMenuOrder,
  type MenuOrder,
} from '../menuConfig'

/** 触屏判定：没有悬停能力或主指针是手指 */
const TOUCH_QUERY = '(hover: none), (pointer: coarse)'
/** 长按触发时长与允许的手指抖动（超过视为滑动） */
const LONG_PRESS_MS = 500
const LONG_PRESS_MOVE_TOLERANCE = 10

interface SiderMenuProps {
  selected: string
  collapsed: boolean
  onNavigate: (key: string) => void
}

interface DragTarget {
  /** 拖拽落点的菜单项 key */
  key: string
  /** 插入位置：before = 落点项上方，after = 落点项下方 */
  pos: 'before' | 'after'
}

export default function SiderMenu({ selected, collapsed, onNavigate }: SiderMenuProps) {
  const { message } = AntdApp.useApp()
  const order = useMenuOrder()
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState<DragTarget | null>(null)
  /** 拖拽源 key（ref 即时读写，不依赖 state 异步更新） */
  const dragKeyRef = useRef<string | null>(null)
  /** 记录拖拽源所属组，落点只允许在同一组内 */
  const dragGroupRef = useRef<string | null>(null)
  /** 拖拽开始前的顺序快照：撤销提示要用它回滚 */
  const orderBeforeRef = useRef<MenuOrder | null>(null)
  /** 撤销提示的 key：连续排序时先销毁上一条，避免提示堆叠刷屏 */
  const msgKeyRef = useRef(0)

  // ---------- 触屏：长按进入排序 ----------
  /** 触屏设备（没有悬停）：箭头不常驻，长按才出现 */
  const touch = useMediaQuery(TOUCH_QUERY)
  /** 正在排序的项（长按选中）；null = 不在排序态 */
  const [reorderKey, setReorderKey] = useState<string | null>(null)
  const pressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  /** 在此时刻之前的 click 一律吞掉：长按松手、结束排序的那一下都不能顺带导航 */
  const suppressClickUntilRef = useRef(0)

  const cancelPress = () => {
    if (pressRef.current) clearTimeout(pressRef.current.timer)
    pressRef.current = null
  }

  const handleTouchStart = (e: ReactTouchEvent<HTMLButtonElement>, key: string) => {
    if (e.touches.length !== 1) return cancelPress()
    cancelPress()
    const t = e.touches[0]
    pressRef.current = {
      x: t.clientX,
      y: t.clientY,
      timer: setTimeout(() => {
        pressRef.current = null
        suppressClickUntilRef.current = Date.now() + 800
        setReorderKey(key)
        navigator.vibrate?.(12)
      }, LONG_PRESS_MS),
    }
  }

  const handleTouchMove = (e: ReactTouchEvent<HTMLButtonElement>) => {
    const p = pressRef.current
    if (!p) return
    const t = e.touches[0]
    // 手指在滑动（滚动导航）就不是长按
    if (Math.hypot(t.clientX - p.x, t.clientY - p.y) > LONG_PRESS_MOVE_TOLERANCE) cancelPress()
  }

  // 排序态下点到这一行之外：结束排序，并吞掉这一下可能触发的导航
  useEffect(() => {
    if (reorderKey === null) return
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('.sider-nav-row.is-reordering')) return
      suppressClickUntilRef.current = Date.now() + 600
      setReorderKey(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [reorderKey])

  // 离开触屏形态（如平板接上鼠标）时退出排序态
  useEffect(() => {
    if (!touch) setReorderKey(null)
  }, [touch])

  useEffect(() => cancelPress, [])

  const handleItemClick = (key: string) => {
    if (Date.now() < suppressClickUntilRef.current) return
    // 排序态下点正在排序的这一项 = 完成排序，不导航
    if (reorderKey !== null) {
      setReorderKey(null)
      return
    }
    onNavigate(key)
  }

  const clearDrag = () => {
    dragKeyRef.current = null
    dragGroupRef.current = null
    setDragKey(null)
    setDragOver(null)
  }

  // 拖拽中松手在列表外时清除状态（mouse 事件方案，兼容 WebView2/WKWebView）
  useEffect(() => {
    if (dragKey === null) return
    document.addEventListener('mouseup', clearDrag)
    return () => document.removeEventListener('mouseup', clearDrag)
  }, [dragKey])

  /** 当前各组顺序的快照（撤销用）。取渲染期读到的 order，不重新读 localStorage */
  const snapshot = (): MenuOrder => {
    const out: MenuOrder = {}
    for (const g of MENU_GROUPS) out[g.key] = [...(order[g.key] ?? [])]
    return out
  }

  /**
   * 排序落盘后的「撤销」提示（§6.2 验收标准：3 秒内可撤销）。
   * before 是本次操作前的顺序；撤销时整份写回 —— 只有被操作的那组会变，
   * 但整份恢复更简单，也不会漏掉连续操作产生的中间态。
   */
  const showUndo = (before: MenuOrder | null) => {
    if (!before) return
    const key = `menu-order-${(msgKeyRef.current += 1)}`
    // 先销毁上一条：同一 tick 连续 open 会叠成一摞
    message.destroy()
    message.open({
      key,
      type: 'success',
      duration: 3,
      content: (
        <span>
          已调整导航顺序
          <Button
            type="link"
            size="small"
            icon={<IconUndo size={13} />}
            onClick={() => {
              message.destroy(key)
              setMenuOrder(before)
              message.info('已恢复排序前的顺序')
            }}
          >
            撤销
          </Button>
        </span>
      ),
    })
  }

  const handleMouseDown = (e: ReactMouseEvent<HTMLButtonElement>, key: string, groupKey: string) => {
    // 折叠状态不启动拖拽
    if (collapsed) return
    e.stopPropagation() // 阻止冒泡到 onClick（防止按下即导航）
    e.preventDefault() // 阻止默认行为避免选中文本
    dragKeyRef.current = key
    dragGroupRef.current = groupKey
    orderBeforeRef.current = snapshot()
    setDragKey(key)
  }

  const handleMouseEnter = (e: ReactMouseEvent<HTMLButtonElement>, key: string, groupKey: string) => {
    // 只在拖拽中且同组内处理
    if (dragKeyRef.current === null || dragGroupRef.current !== groupKey) return
    if (dragKeyRef.current === key) return
    const rect = e.currentTarget.getBoundingClientRect()
    const pos: 'before' | 'after' = e.clientY > rect.top + rect.height / 2 ? 'after' : 'before'
    // 避免拖到自身原位产生闪烁
    if (dragOver?.key === key && dragOver?.pos === pos) return
    setDragOver({ key, pos })
  }

  const handleMouseUp = (groupKey: string) => {
    if (dragKeyRef.current !== null && dragOver && dragGroupRef.current === groupKey) {
      reorderInGroup(groupKey, dragKeyRef.current, dragOver.key, dragOver.pos)
      showUndo(orderBeforeRef.current)
    }
    orderBeforeRef.current = null
    clearDrag()
  }

  /** 键盘排序：上移/下移一格 */
  const handleMove = (groupKey: string, key: string, delta: -1 | 1) => {
    const before = snapshot()
    if (moveInGroup(groupKey, key, delta)) showUndo(before)
  }

  const renderNavItem = (key: string, groupKey: string | null, index: number, groupLength: number) => {
    const isSelected = selected === key
    const isDragging = dragKey === key
    const dropTarget = dragOver?.key === key
    const canDrag = !collapsed && groupKey !== null
    const reordering = touch && reorderKey === key
    // 鼠标设备：箭头随悬停 / 焦点显形；触屏：只有长按选中的那一项才渲染箭头
    const showControls = canDrag && (!touch || reordering)

    const classNames = [
      'sider-nav-item',
      isSelected ? 'is-selected' : '',
      isDragging ? 'is-dragging' : '',
      dropTarget && dragOver?.pos === 'before' ? 'is-drag-over-before' : '',
      dropTarget && dragOver?.pos === 'after' ? 'is-drag-over-after' : '',
    ]
      .filter(Boolean)
      .join(' ')

    const label = menuLabel(key)
    const item = (
      <button
        type="button"
        role="menuitem"
        className={classNames}
        aria-current={isSelected ? 'page' : undefined}
        onClick={() => handleItemClick(key)}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => e.key === 'Enter' && onNavigate(key)}
        onTouchStart={touch && canDrag ? (e) => handleTouchStart(e, key) : undefined}
        onTouchMove={touch && canDrag ? handleTouchMove : undefined}
        onTouchEnd={touch && canDrag ? cancelPress : undefined}
        onTouchCancel={touch && canDrag ? cancelPress : undefined}
        // 长按在部分 WebView 上会弹系统菜单 / 选中文字，触屏排序时屏蔽
        onContextMenu={touch && canDrag ? (e) => e.preventDefault() : undefined}
        onMouseDown={canDrag ? (e) => handleMouseDown(e, key, groupKey) : undefined}
        onMouseEnter={canDrag ? (e) => handleMouseEnter(e, key, groupKey) : undefined}
        onMouseUp={canDrag ? () => handleMouseUp(groupKey) : undefined}
      >
        <span className="sider-nav-icon">{menuIcon(key)}</span>
        <span className="sider-nav-label">{label}</span>
      </button>
    )

    return (
      <div className={`sider-nav-row${canDrag ? ' reorder-host' : ''}${reordering ? ' is-reordering' : ''}`} key={key}>
        {collapsed ? (
          <Tooltip title={label} placement="right">
            {item}
          </Tooltip>
        ) : (
          item
        )}
        {showControls && (
          <span className="reorder-controls">
            <button
              type="button"
              className="reorder-btn"
              disabled={index === 0}
              title={`上移「${label}」`}
              aria-label={`上移「${label}」`}
              onClick={() => handleMove(groupKey, key, -1)}
            >
              <IconArrowUp size={13} />
            </button>
            <button
              type="button"
              className="reorder-btn"
              disabled={index === groupLength - 1}
              title={`下移「${label}」`}
              aria-label={`下移「${label}」`}
              onClick={() => handleMove(groupKey, key, 1)}
            >
              <IconArrowDown size={13} />
            </button>
          </span>
        )}
      </div>
    )
  }

  /** 当前顺序是否已偏离默认（决定「恢复默认排序」是否显示） */
  const customized = MENU_GROUPS.some(
    (g) => (order[g.key] ?? []).join('\u0000') !== g.items.join('\u0000'),
  )

  return (
    <nav
      className="sider-nav sider-menu"
      role="menu"
      aria-orientation="vertical"
      style={{ userSelect: dragKey !== null ? 'none' : undefined }}
    >
      {/* 固定项：数据概览、日历打卡（打卡是每日练习的收尾动作，固定在概览正下方） */}
      {MENU_FIXED_TOP.map((key) => renderNavItem(key, null, 0, 1))}

      {MENU_GROUPS.map((group) => {
        const items = order[group.key] ?? group.items
        return (
          <div key={group.key} className="sider-nav-group">
            <div className="sider-nav-group-title">
              <span>{group.label}</span>
            </div>
            {items.map((key, i) => renderNavItem(key, group.key, i, items.length))}
          </div>
        )
      })}

      {/* 固定项：底部（设置、关于） */}
      {MENU_FIXED_BOTTOM.map((key) => renderNavItem(key, null, 0, 1))}

      {/* 恢复默认排序：只在用户确实排过顺序时出现，避免常态占用视觉权重 */}
      {customized && !collapsed && (
        <div className="sider-nav-reset">
          <Button
            type="text"
            size="small"
            icon={<IconUndo size={13} />}
            onClick={() => {
              resetMenuOrder()
              message.success('已恢复默认导航排序')
            }}
          >
            恢复默认排序
          </Button>
        </div>
      )}
    </nav>
  )
}
