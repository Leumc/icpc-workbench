import type { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  extra?: ReactNode
  /** 真实父子关系（如从详情返回列表）才传；所属分组侧栏已经高亮，不再重复显示 */
  breadcrumb?: string[]
}

/** 可复用页面标题：大标题 + 灰色描述 + 右侧操作区 */
export default function PageHeader({ title, description, extra, breadcrumb }: PageHeaderProps) {
  const crumbs = breadcrumb ?? []

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        flexWrap: 'wrap',
        gap: 12,
        marginBottom: crumbs.length > 0 ? 12 : 16,
      }}
    >
      <div style={{ minWidth: 0 }}>
        {crumbs.length > 0 && (
          <nav className="page-breadcrumb" aria-label="当前位置">
            {crumbs.map((c, i) => (
              <span key={`${c}-${i}`} className="page-breadcrumb-item">
                {i > 0 && <span className="page-breadcrumb-sep">/</span>}
                {c}
              </span>
            ))}
          </nav>
        )}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-description">{description}</p>}
      </div>
      {extra && (
        // minWidth: 0 让操作区可以收缩到内容宽度以下。flex 项默认 min-width:auto（= min-content），
        // 内含 nowrap 的 Space 时 min-content 就是整排按钮的总宽，窄窗口下会把整页撑出横向滚动条。
        <div className="page-header-extra">
          {extra}
        </div>
      )}
    </div>
  )
}
