import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { App as AntdApp, Alert, Button, Card, Input, Modal, Segmented, Select, Space, Tag } from 'antd'
import { ArrowLeftOutlined, EditOutlined, EyeOutlined, SearchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import PageHeader from '../components/PageHeader'
import PageSkeleton from '../components/PageSkeleton'
import EmptyState from '../components/EmptyState'
import InlineError from '../components/InlineError'
import PlatformTag from '../components/PlatformTag'
import Markdown from '../components/Markdown'
import NoteEditor from '../components/NoteEditor'
import ProblemNotesPanel from '../components/ProblemNotesPanel'
import { get, patch } from '../api'
import { difficultyColor } from '../ui'
import { useDebounced } from '../useDebounced'
import { BP, useMediaQuery } from '../useMediaQuery'
import { relativeTimeText } from '../syncStatus'
import { noteSnippet, openProblemPeek, type ProblemPeekData } from '../problemPeek'
import {
  groupKeyFromParams,
  groupLibrary,
  noteGroupCount,
  sortGroups,
  type GroupSort,
  type LibraryResponse,
  type NoteGroup,
} from '../noteLibrary'
import { PLATFORMS, type PlatformId } from '../../../shared/src/index.ts'

type Source = 'all' | 'problem' | 'review'

const SORT_OPTIONS: Array<{ value: GroupSort; label: string }> = [
  { value: 'updated', label: '最近更新' },
  { value: 'count', label: '笔记最多' },
  { value: 'key', label: '按题号' },
]

/** 笔记库：所有写过笔记的题目按题归档，可搜正文、按标注 / 平台 / 来源筛选，右侧直接看全文与编辑。 */
export default function Notes() {
  const { message } = AntdApp.useApp()
  const [params, setParams] = useSearchParams()
  const narrow = useMediaQuery(BP.mdDown)

  const [qInput, setQInput] = useState(() => params.get('q') ?? '')
  const q = useDebounced(qInput.trim(), 300)
  const [platform, setPlatform] = useState<PlatformId | 'all'>('all')
  const [label, setLabel] = useState<string | null>(() => params.get('label'))
  const [source, setSource] = useState<Source>('all')
  const [sort, setSort] = useState<GroupSort>('updated')

  const [resp, setResp] = useState<LibraryResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(() => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setLoadError(null)
    const qs = new URLSearchParams()
    if (q) qs.set('q', q)
    if (platform !== 'all') qs.set('platform', platform)
    if (label) qs.set('label', label)
    if (source !== 'all') qs.set('source', source)
    get<LibraryResponse>(`/api/notes/library?${qs.toString()}`, { signal: ctrl.signal })
      .then((r) => {
        if (!ctrl.signal.aborted) setResp(r)
      })
      .catch((e: Error) => {
        if (!ctrl.signal.aborted) setLoadError(e.message)
      })
  }, [q, platform, label, source])

  useEffect(() => {
    load()
    return () => abortRef.current?.abort()
  }, [load])

  const groups = useMemo(() => (resp ? sortGroups(groupLibrary(resp), sort) : []), [resp, sort])
  const selectedKey = groupKeyFromParams(params, groups)
  const selected = groups.find((g) => g.key === selectedKey) ?? null
  const highlightNoteId = Number(params.get('note')) || null

  const select = (g: NoteGroup | null): void => {
    const next = new URLSearchParams()
    if (g?.problem) next.set('problem', String(g.problem.id))
    else if (g?.task) next.set('task', String(g.task.id))
    setParams(next, { replace: true })
  }

  const noteTotal = groups.reduce((s, g) => s + g.notes.length, 0)
  const reviewTotal = groups.filter((g) => g.reviewNote).length
  const hasFilters = qInput.trim() !== '' || platform !== 'all' || label !== null || source !== 'all'
  const clearFilters = (): void => {
    setQInput('')
    setPlatform('all')
    setLabel(null)
    setSource('all')
  }

  const labelOptions = (resp?.labels ?? []).map((l) => ({ value: l.label, label: `${l.label}（${l.count}）` }))
  if (label && !labelOptions.some((o) => o.value === label)) labelOptions.unshift({ value: label, label })

  const showList = !narrow || selectedKey === null
  const showDetail = !narrow || selectedKey !== null

  return (
    <div>
      <PageHeader title="笔记库" description="写过笔记的题目都归档在这里：按题目汇总题目笔记、打卡笔记与复习笔记，可搜正文、按标注筛选" />

      <div className="notes-lib-toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="搜题号、题名、笔记正文、任务"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          className="notes-lib-search"
          aria-label="搜索笔记"
        />
        <Select
          value={platform}
          onChange={setPlatform}
          style={{ minWidth: 120 }}
          aria-label="平台"
          options={[{ value: 'all', label: '全部平台' }, ...PLATFORMS.map((p) => ({ value: p.id, label: p.name }))]}
        />
        <Select
          allowClear
          value={label}
          onChange={(v) => setLabel(v ?? null)}
          placeholder="按标注"
          style={{ minWidth: 130 }}
          aria-label="标注"
          options={labelOptions}
        />
        <Segmented<Source>
          value={source}
          onChange={setSource}
          options={[
            { value: 'all', label: '全部' },
            { value: 'problem', label: '题目笔记' },
            { value: 'review', label: '复习笔记' },
          ]}
        />
        <Select value={sort} onChange={setSort} options={SORT_OPTIONS} style={{ minWidth: 110 }} aria-label="排序" />
        {hasFilters && <Button type="link" onClick={clearFilters}>清除筛选</Button>}
      </div>

      {resp && (
        <div className="muted-note notes-lib-stats" role="status">
          {groups.length} 道题 · {noteTotal} 条题目笔记 · {reviewTotal} 条复习笔记
          {resp.truncated && '（结果过多，只显示最近的一部分，请收窄筛选条件）'}
        </div>
      )}

      {loadError ? (
        <InlineError message={loadError} hint="笔记库没能加载；重试即可，笔记不会丢失。" onRetry={load} />
      ) : !resp ? (
        <PageSkeleton stats={false} table rows={6} />
      ) : (
        <div className={`notes-lib${narrow ? ' is-narrow' : ''}`}>
          {showList && (
            <div className="notes-lib-list" role="list" aria-label="记过笔记的题目">
              {groups.length === 0 ? (
                <Card size="small">
                  <EmptyState
                    title={hasFilters ? '没有符合条件的笔记' : '还没有写过笔记'}
                    description={
                      hasFilters
                        ? '换个关键词或清除筛选试试。'
                        : '在题目管理的「笔记」、训练计划打卡、复习库或任意题目速览里都可以写笔记，写过的都会汇总到这里。'
                    }
                    action={hasFilters ? { label: '清除筛选', type: 'default', onClick: clearFilters } : undefined}
                  />
                </Card>
              ) : (
                groups.map((g) => (
                  <GroupItem key={g.key} group={g} active={g.key === selectedKey} onSelect={() => select(g)} />
                ))
              )}
            </div>
          )}
          {showDetail && (
            <div className="notes-lib-detail">
              {narrow && (
                <Button type="link" icon={<ArrowLeftOutlined />} onClick={() => select(null)} style={{ paddingInline: 0 }}>
                  返回列表
                </Button>
              )}
              {selectedKey === null ? (
                <Card size="small">
                  <EmptyState title="选一道题查看笔记" description="左侧列出了所有记过笔记的题目；点开后在这里看全文、编辑或再写一条。" />
                </Card>
              ) : (
                <GroupDetail
                  key={selectedKey}
                  groupKey={selectedKey}
                  group={selected}
                  highlightNoteId={highlightNoteId}
                  onChanged={load}
                  onReviewNoteSaved={() => {
                    message.success('复习笔记已保存')
                    load()
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function GroupItem({ group: g, active, onSelect }: { group: NoteGroup; active: boolean; onSelect: () => void }) {
  const latest = g.notes[0]
  const snippet = latest ? noteSnippet(latest.content, 70) : g.reviewNote ? noteSnippet(g.reviewNote.note, 70) : ''
  return (
    <button type="button" role="listitem" className={`notes-lib-item${active ? ' is-active' : ''}`} onClick={onSelect} aria-current={active || undefined}>
      <div className="notes-lib-item-head">
        {g.problem ? <PlatformTag id={g.problem.platform as PlatformId} /> : <Tag style={{ marginInlineEnd: 0 }}>训练任务</Tag>}
        {g.problem?.difficulty != null && (
          <span className="rating-pill mono" style={{ color: difficultyColor(g.problem.difficulty) }}>{g.problem.difficulty}</span>
        )}
        <span className="notes-lib-item-time">{relativeTimeText(g.updatedAt)}</span>
      </div>
      <div className="notes-lib-item-title">
        {g.problem ? (
          <>
            <span className="mono">{g.problem.problemKey}</span> {g.problem.title}
          </>
        ) : (
          g.task?.title
        )}
      </div>
      {snippet && <div className="notes-lib-item-snippet">{snippet}</div>}
      <div className="notes-lib-item-meta">
        {g.notes.length > 0 && <span>{g.notes.length} 条笔记</span>}
        {g.reviewNote && <span>复习笔记</span>}
        {g.labels.slice(0, 4).map((l) => <Tag key={l} color="blue" style={{ marginInlineEnd: 0 }}>{l}</Tag>)}
        {noteGroupCount(g) === 0 && <span>无笔记</span>}
      </div>
    </button>
  )
}

function GroupDetail({ groupKey, group, highlightNoteId, onChanged, onReviewNoteSaved }: {
  groupKey: string
  group: NoteGroup | null
  highlightNoteId: number | null
  onChanged: () => void
  onReviewNoteSaved: () => void
}) {
  const { message } = AntdApp.useApp()
  const isProblem = groupKey.startsWith('p')
  const id = Number(groupKey.slice(1))
  // 深链到当前筛选结果之外（或还没写过笔记）的题目：单独取一次题目信息
  const [fallback, setFallback] = useState<ProblemPeekData | null>(null)
  useEffect(() => {
    if (!isProblem || group?.problem) return
    let alive = true
    get<ProblemPeekData>(`/api/problems/peek?id=${id}`)
      .then((d) => alive && setFallback(d))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [isProblem, id, group])

  const problem = group?.problem ?? (fallback?.problem ? { ...fallback.problem } : null)
  const reviewNote = group?.reviewNote ?? null
  const [editingReview, setEditingReview] = useState<string | null>(null)
  const [savingReview, setSavingReview] = useState(false)

  const saveReviewNote = async (): Promise<void> => {
    if (!reviewNote || editingReview === null) return
    setSavingReview(true)
    try {
      await patch(`/api/reviews/${reviewNote.reviewItemId}`, { note: editingReview })
      setEditingReview(null)
      onReviewNoteSaved()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setSavingReview(false)
    }
  }

  return (
    <div className="notes-lib-detail-inner">
      <Card size="small" className="notes-lib-detail-head">
        {isProblem ? (
          problem ? (
            <>
              <div className="today-problem-head">
                <PlatformTag id={problem.platform as PlatformId} />
                {problem.difficulty != null && (
                  <span className="rating-pill mono" style={{ color: difficultyColor(problem.difficulty) }}>{problem.difficulty}</span>
                )}
              </div>
              <div className="notes-lib-detail-title">
                {/* 题目链接同样走全局速览拦截：点开先看到这道题的全部关联数据 */}
                {problem.url ? (
                  <a href={problem.url} data-problem-id={problem.id} target="_blank" rel="noreferrer">
                    [{problem.problemKey}] {problem.title} ↗
                  </a>
                ) : (
                  <span>[{problem.problemKey}] {problem.title}</span>
                )}
              </div>
              <Space wrap size={6}>
                <Button size="small" icon={<EyeOutlined />} onClick={() => openProblemPeek({ problemId: problem.id, url: problem.url ?? undefined })}>
                  题目速览
                </Button>
              </Space>
            </>
          ) : (
            <span className="muted-note">题目 #{id}</span>
          )
        ) : (
          <>
            <div className="notes-lib-detail-title">{group?.task?.title ?? `训练任务 #${id}`}</div>
            {group?.task && <div className="muted-note">{group.task.planTitle} · {group.task.taskDate}（这个任务没有关联题目，笔记挂在任务上）</div>}
          </>
        )}
      </Card>

      {reviewNote && (
        <Card
          size="small"
          title="复习笔记"
          extra={
            <Space size={4}>
              <span className="muted-note">下次复习 {reviewNote.nextDueOn}{reviewNote.lastReviewedAt ? ` · 上次 ${dayjs(reviewNote.lastReviewedAt).format('MM-DD')}` : ''}</span>
              <Button type="text" size="small" icon={<EditOutlined />} aria-label="编辑复习笔记" onClick={() => setEditingReview(reviewNote.note)} />
            </Space>
          }
        >
          <Markdown text={reviewNote.note} />
        </Card>
      )}

      {group && group.notes.length === 0 && reviewNote && (
        <Alert type="info" showIcon message="这道题只有复习笔记；也可以在下面写题目笔记（可分条、可加标注、可插代码与图片）。" />
      )}

      <ProblemNotesPanel
        target={isProblem ? { problemId: id } : { taskId: id }}
        highlightNoteId={highlightNoteId}
        onChanged={onChanged}
      />

      <Modal
        title="编辑复习笔记"
        open={editingReview !== null}
        onCancel={() => setEditingReview(null)}
        onOk={() => void saveReviewNote()}
        okText="保存"
        cancelText="取消"
        confirmLoading={savingReview}
        width={880}
        maskClosable={false}
        keyboard={false}
        destroyOnHidden
      >
        {editingReview !== null && (
          <NoteEditor value={editingReview} onChange={setEditingReview} height={420} maxLength={20000} />
        )}
      </Modal>
    </div>
  )
}
