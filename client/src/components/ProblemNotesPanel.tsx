import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Card, Modal, Popconfirm, Space, Tag } from 'antd'
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import EmptyState from './EmptyState'
import InlineError from './InlineError'
import NoteBlocksView from './NoteBlocksView'
import NoteForm from './NoteForm'
import PageSkeleton from './PageSkeleton'
import { del, get, patch, post } from '../api'
import { platformName } from '../ui'
import type { PlatformId } from '../../../shared/src/index.ts'
import { draftPayload, isBlankNote, isUploading, newDraft, toDraft, type NoteDraft, type ProblemNote } from '../problemNotes'

/** 笔记挂在哪：题目（mirrors=连同镜像题一起看）或无题目的训练任务 */
export type NotesTarget = { problemId: number; mirrors?: boolean } | { taskId: number }

const listPath = (t: NotesTarget): string =>
  'taskId' in t ? `/api/notes?taskId=${t.taskId}` : `/api/notes?problemId=${t.problemId}${t.mirrors ? '&mirrors=1' : ''}`

const createBody = (t: NotesTarget) => ('taskId' in t ? { taskId: t.taskId } : { problemId: t.problemId })

/**
 * 一道题（或一个任务）的全部笔记：查看、写新的、编辑、删除。
 * 题目管理的笔记抽屉、笔记库详情、题目速览的笔记弹窗共用这一个面板，三处行为一致。
 */
export default function ProblemNotesPanel({ target, onChanged, highlightNoteId, emptyDescription }: {
  target: NotesTarget
  /** 新增 / 编辑 / 删除后调用（刷新外部的条数、列表） */
  onChanged?: () => void
  /** 打开后滚动到并高亮这条笔记（笔记库深链 ?note=） */
  highlightNoteId?: number | null
  emptyDescription?: string
}) {
  const { message } = AntdApp.useApp()
  const [notes, setNotes] = useState<ProblemNote[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  /** null = 未打开编辑；id 为 null = 新写一条 */
  const [editing, setEditing] = useState<{ id: number | null; draft: NoteDraft } | null>(null)
  const [saving, setSaving] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const path = listPath(target)
  const load = useCallback(() => {
    setLoadError(null)
    get<{ items: ProblemNote[] }>(path)
      .then((r) => setNotes(r.items))
      .catch((e: Error) => setLoadError(e.message))
  }, [path])

  useEffect(() => {
    setNotes(null)
    setEditing(null)
    load()
  }, [load])

  // 深链定位：笔记渲染出来后再滚动（图片等异步内容会让位置变，scrollIntoView 取 nearest 即可）
  useEffect(() => {
    if (!notes || !highlightNoteId) return
    const el = rootRef.current?.querySelector(`[data-note-id="${highlightNoteId}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [notes, highlightNoteId])

  const startNew = (): void => setEditing({ id: null, draft: newDraft() })

  const save = async (): Promise<void> => {
    if (!editing) return
    // 未传完的框没有地址，此时保存会被当空框略去，文件就丢了
    if (isUploading(editing.draft)) {
      message.warning('文件还在上传，请稍候')
      return
    }
    if (isBlankNote(editing.draft)) {
      message.warning('笔记内容不能为空')
      return
    }
    setSaving(true)
    try {
      if (editing.id === null) {
        await post('/api/notes', { ...createBody(target), ...draftPayload(editing.draft) })
      } else {
        await patch(`/api/notes/${editing.id}`, draftPayload(editing.draft))
      }
      message.success('笔记已保存')
      setEditing(null)
      load()
      onChanged?.()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: number): Promise<void> => {
    try {
      await del(`/api/notes/${id}`)
      message.success('笔记已删除')
      load()
      onChanged?.()
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  const primaryId = 'problemId' in target ? target.problemId : null

  return (
    <div ref={rootRef} className="notes-panel">
      {loadError ? (
        <InlineError message={loadError} hint="笔记没能取回来；重试即可，已写的笔记不会丢失。" onRetry={load} />
      ) : notes === null ? (
        <PageSkeleton stats={false} table rows={4} />
      ) : notes.length === 0 ? (
        <EmptyState
          title="还没有笔记"
          description={emptyDescription ?? '记下思路、踩过的坑或待回看的点；一道题可以写多条，并用标注区分。'}
          action={{ label: '写笔记', type: 'primary', icon: <PlusOutlined />, onClick: startNew }}
        />
      ) : (
        <>
          <div className="notes-panel-toolbar">
            <span className="muted-note">共 {notes.length} 条笔记</span>
            <Button type="primary" size="small" icon={<PlusOutlined />} onClick={startNew}>写笔记</Button>
          </div>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {notes.map((n) => (
              <Card
                key={n.id}
                size="small"
                data-note-id={n.id}
                className={n.id === highlightNoteId ? 'note-card-highlight' : undefined}
                title={
                  <Space size={4} wrap>
                    {n.labels.map((l) => <Tag key={l} color="blue" style={{ marginInlineEnd: 0 }}>{l}</Tag>)}
                    <span style={{ color: 'var(--text-3)', fontSize: 12, fontWeight: 400 }}>
                      {dayjs(n.createdAt).format('YYYY-MM-DD HH:mm')}
                      {n.updatedAt !== n.createdAt && ` · 编辑于 ${dayjs(n.updatedAt).format('MM-DD HH:mm')}`}
                    </span>
                  </Space>
                }
                extra={
                  <Space size={0}>
                    <Button type="text" size="small" icon={<EditOutlined />} aria-label="编辑笔记" onClick={() => setEditing({ id: n.id, draft: toDraft(n) })} />
                    <Popconfirm title="删除这条笔记？" okText="删除" cancelText="取消" onConfirm={() => void remove(n.id)}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label="删除笔记" />
                    </Popconfirm>
                  </Space>
                }
              >
                {(n.taskTitle || (primaryId !== null && n.problem && n.problem.id !== primaryId)) && (
                  <div className="note-source-line">
                    {primaryId !== null && n.problem && n.problem.id !== primaryId && (
                      <span>记在镜像题 {platformName(n.problem.platform as PlatformId)} {n.problem.problemKey} 上</span>
                    )}
                    {n.taskTitle && <span>来自训练计划：{n.planTitle} · {n.taskDate} · {n.taskTitle}</span>}
                  </div>
                )}
                <NoteBlocksView blocks={n.blocks} />
              </Card>
            ))}
          </Space>
        </>
      )}
      <Modal
        title={editing?.id === null ? '写笔记' : '编辑笔记'}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        onOk={() => void save()}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        width={880}
        maskClosable={false}
        keyboard={false}
        destroyOnHidden
        styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
      >
        {editing && (
          <NoteForm
            key={editing.id ?? 'new'}
            value={editing.draft}
            onChange={(update) => setEditing((e) => (e ? { ...e, draft: update(e.draft) } : e))}
          />
        )}
      </Modal>
    </div>
  )
}
