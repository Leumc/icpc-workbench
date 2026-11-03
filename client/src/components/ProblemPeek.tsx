/**
 * 题目速览（一级弹窗）+ 关联数据详情（二级弹窗）。
 *
 * 一级弹窗只放「能帮你决定要不要现在点开这道题」的信息：题号 / 标题 / 难度 / 知识点 /
 * 做题状态，以及工作台里每类关联数据的一行摘要；摘要行点开是二级弹窗，里面是完整内容
 * （笔记全文可编辑、全部卡点、全部复习日志、提交记录、训练任务含 AI 提示、所在题单），
 * 每个二级弹窗都带跳到对应功能页的按钮。
 *
 * 由全局链接拦截触发（见 problemPeek.ts / externalLinks.ts），在 App 里挂一份即可。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Alert, App as AntdApp, Button, Card, Empty, Modal, Space, Table, Tag, Tooltip } from 'antd'
import {
  BookOutlined,
  CheckCircleOutlined,
  CopyOutlined,
  ExportOutlined,
  FileTextOutlined,
  HistoryOutlined,
  OrderedListOutlined,
  PlusOutlined,
  RightOutlined,
  ScheduleOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import Markdown from './Markdown'
import NoteBlocksView from './NoteBlocksView'
import PlatformTag from './PlatformTag'
import ProblemNotesPanel from './ProblemNotesPanel'
import InlineError from './InlineError'
import PageSkeleton from './PageSkeleton'
import { get, post } from '../api'
import { difficultyColor, KIND_COLOR, KIND_LABEL, platformName, tagColor, type TaskKind } from '../ui'
import { intentLabel } from '../intentOptions'
import { FEEDBACK_META, reviewTimingText } from '../reviewDue'
import {
  closeProblemPeek,
  noteSnippet,
  peekApiPath,
  useProblemPeekRequest,
  type PeekRequest,
  type ProblemPeekData,
} from '../problemPeek'
import type { PlatformId } from '../../../shared/src/index.ts'

type DetailKind = 'notes' | 'intents' | 'review' | 'submissions' | 'tasks' | 'lists'

const STATUS_META: Record<ProblemPeekData['status'], { label: string; color: string }> = {
  ac: { label: '已通过', color: 'success' },
  tried: { label: '尝试未过', color: 'warning' },
  none: { label: '未提交', color: 'default' },
}

const BAND_LABEL: Record<string, string> = { consolidation: '巩固档', core: '核心档', challenge: '挑战档' }

const VERDICT_COLOR: Record<string, string> = { AC: 'success', WA: 'error', TLE: 'warning', MLE: 'warning', RE: 'volcano', CE: 'default', SKIPPED: 'default' }

const CONTEXT_LABEL: Record<string, string> = { contest: '赛时', virtual: '虚拟赛', practice: '练习' }

/** 一级在其它弹窗 / 抽屉之上（比赛分析弹窗里点题目链接也要盖住它），二级再高一层 */
const PEEK_Z = 1200
const DETAIL_Z = 1210

const fmt = (iso: string | null | undefined, pattern = 'YYYY-MM-DD HH:mm'): string => (iso ? dayjs(iso).format(pattern) : '—')

const kindLabel = (k: string): string => KIND_LABEL[k as TaskKind] ?? k
const kindColor = (k: string): string | undefined => KIND_COLOR[k as TaskKind]
const pName = (p: string): string => platformName(p as PlatformId)

export default function ProblemPeekHost() {
  const req = useProblemPeekRequest()
  const nav = useNavigate()
  const { message } = AntdApp.useApp()
  const [data, setData] = useState<ProblemPeekData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<DetailKind | null>(null)
  const [adding, setAdding] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  /** 二级弹窗里改了笔记等数据，关闭速览前要刷新一级摘要 */
  const reqRef = useRef<PeekRequest | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    reqRef.current = req
  }, [req])

  const load = useCallback((r: PeekRequest, keepData = false) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    if (!keepData) setData(null)
    setError(null)
    get<ProblemPeekData>(peekApiPath(r), { signal: ctrl.signal })
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d)
      })
      .catch((e: Error) => {
        if (!ctrl.signal.aborted) setError(e.message)
      })
  }, [])

  useEffect(() => {
    setDetail(null)
    if (req) load(req)
    else {
      abortRef.current?.abort()
      setData(null)
      setError(null)
    }
  }, [req, load])

  // 换题（二级弹窗里点了另一道题的链接）时原先聚焦的摘要行被卸载，焦点掉回 body，
  // Esc 就关不掉速览了：内容就绪后把焦点收回卡片内
  useEffect(() => {
    if (!data || detail !== null) return
    const active = document.activeElement
    if (!active || active === document.body) bodyRef.current?.focus({ preventScroll: true })
  }, [data, detail])

  const reload = useCallback(() => {
    if (reqRef.current) load(reqRef.current, true)
  }, [load])

  const close = (): void => {
    setDetail(null)
    closeProblemPeek()
  }

  const goTo = (path: string): void => {
    close()
    nav(path)
  }

  const problem = data?.problem ?? null
  const url = data?.problem?.url ?? data?.url ?? req?.url ?? null
  const key = problem?.problemKey ?? data?.target?.problemKey ?? null
  const platform = problem?.platform ?? data?.target?.platform ?? null
  const title = problem?.title ?? req?.titleHint ?? key ?? '题目'

  const addToReview = async (): Promise<void> => {
    if (!data) return
    setAdding(true)
    try {
      const r = problem
        ? await post<{ alreadyInQueue: boolean; nextDueOn: string }>('/api/reviews', { platform: problem.platform, problemKey: problem.problemKey })
        : await post<{ alreadyInQueue: boolean; nextDueOn: string }>('/api/reviews/from-url', { url, title: req?.titleHint ?? '' })
      message.success(r.alreadyInQueue ? `已在复习库，下次到期 ${r.nextDueOn}` : `已加入复习库，首次复习 ${r.nextDueOn}`)
      reload()
    } catch (e) {
      message.error((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  const copyLink = async (): Promise<void> => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      message.success('链接已复制')
    } catch {
      message.error('复制失败，请手动复制')
    }
  }

  const problemsPath = key ? `/problems?q=${encodeURIComponent(key)}` : '/problems'

  return (
    <>
      <Modal
        open={req !== null}
        onCancel={close}
        zIndex={PEEK_Z}
        width={620}
        className="problem-peek"
        title={<span className="problem-peek-kicker">题目速览</span>}
        destroyOnHidden
        footer={
          <div className="problem-peek-footer">
            <span className="muted-note problem-peek-hint">Ctrl / ⌘ + 点击题目链接可跳过速览直接打开</span>
            <Space wrap>
              {url && <Button icon={<CopyOutlined />} onClick={() => void copyLink()}>复制链接</Button>}
              {url ? (
                <Button type="primary" icon={<ExportOutlined />} href={url} target="_blank" rel="noreferrer" data-peek="off" onClick={close}>
                  打开题目
                </Button>
              ) : (
                <Button onClick={close}>关闭</Button>
              )}
            </Space>
          </div>
        }
      >
        {error ? (
          <InlineError message={error} hint="速览数据没能取回来；仍可直接打开题目。" onRetry={() => req && load(req)} />
        ) : !data ? (
          <PageSkeleton stats={false} table rows={4} />
        ) : (
          <div className="problem-peek-body" ref={bodyRef} tabIndex={-1}>
            <div className="problem-peek-head">
              {platform && <PlatformTag id={platform as PlatformId} />}
              {key && <span className="mono problem-peek-key">{key}</span>}
              {problem?.difficulty != null ? (
                <Tooltip title={problem.difficultySource === 'manual' ? '手动标定的难度' : undefined}>
                  <span className="rating-pill mono" style={{ color: difficultyColor(problem.difficulty) }}>
                    {problem.difficulty}
                    {problem.difficultyLabel && problem.difficultyLabel !== String(problem.difficulty) && ` · ${problem.difficultyLabel}`}
                  </span>
                </Tooltip>
              ) : (
                <span className="muted-note">难度未知</span>
              )}
              <Tag color={STATUS_META[data.status].color} style={{ marginInlineEnd: 0 }}>{STATUS_META[data.status].label}</Tag>
            </div>
            <h3 className="problem-peek-title">{title}</h3>
            {problem && problem.tags.length > 0 && (
              <div className="problem-peek-tags">
                {problem.tags.map((t) => <Tag key={t} color={tagColor(t)} style={{ marginInlineEnd: 0 }}>{t}</Tag>)}
              </div>
            )}
            {data.mirrors.length > 0 && (
              <div className="muted-note problem-peek-mirrors">
                同一原题：
                {data.mirrors.map((m, i) => (
                  <span key={m.id}>
                    {i > 0 && '、'}
                    {pName(m.platform)} {m.problemKey}
                  </span>
                ))}
                （下面的记录已合并）
              </div>
            )}
            {!data.found && (
              <Alert
                type="info"
                showIcon
                className="problem-peek-alert"
                message="工作台题库里还没有这道题"
                description="可能还没同步提交或导入题库；下面仍按链接汇总了相关的训练任务与题单。加入复习库会顺带把题目登记进来。"
              />
            )}
            {data.recommendation && (
              <div className="muted-note">今日训练在 {data.recommendation.recommendedOn} 推荐过（{BAND_LABEL[data.recommendation.band] ?? data.recommendation.band}）</div>
            )}

            <div className="problem-peek-rows" role="list">
              <PeekRow
                icon={<FileTextOutlined />}
                label="笔记"
                count={data.notes.length + (data.review?.item?.note ? 1 : 0)}
                summary={notesSummary(data)}
                onOpen={() => setDetail('notes')}
                disabled={!data.found && data.notes.length === 0}
                disabledHint="题库里没有这道题，暂时无法挂笔记"
              />
              <PeekRow
                icon={<WarningOutlined />}
                label="卡点"
                count={data.intents.length}
                summary={intentsSummary(data)}
                onOpen={() => setDetail('intents')}
              />
              <PeekRow
                icon={<BookOutlined />}
                label="复习"
                count={data.review?.reviewCount ?? 0}
                summary={reviewSummary(data)}
                onOpen={() => setDetail('review')}
                action={
                  !data.review?.item && url ? (
                    <Button size="small" icon={<PlusOutlined />} loading={adding} onClick={(e) => { e.stopPropagation(); void addToReview() }}>
                      加入复习
                    </Button>
                  ) : undefined
                }
              />
              <PeekRow
                icon={<HistoryOutlined />}
                label="提交"
                count={data.stats.attempts}
                summary={submissionsSummary(data)}
                onOpen={() => setDetail('submissions')}
              />
              <PeekRow
                icon={<ScheduleOutlined />}
                label="训练任务"
                count={data.tasks.length}
                summary={tasksSummary(data)}
                onOpen={() => setDetail('tasks')}
              />
              <PeekRow
                icon={<OrderedListOutlined />}
                label="题单"
                count={data.lists.length}
                summary={data.lists.length === 0 ? '不在任何题单里' : [...new Set(data.lists.map((l) => `${l.listTitle} · ${l.category}`))].join('；')}
                onOpen={() => setDetail('lists')}
              />
            </div>
          </div>
        )}
      </Modal>

      {data && (
        <Modal
          open={detail !== null}
          onCancel={() => setDetail(null)}
          zIndex={DETAIL_Z}
          width={detail === 'notes' ? 860 : 760}
          className="problem-peek-detail"
          title={detail ? `${DETAIL_TITLE[detail]} · ${key ?? ''} ${title}` : ''}
          destroyOnHidden
          styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }}
          footer={
            detail && (
              <Space wrap>
                {DETAIL_LINKS[detail](problem?.id ?? null, problemsPath, data).map((l) => (
                  <Button key={l.path} type={l.primary ? 'primary' : 'default'} icon={<RightOutlined />} iconPosition="end" onClick={() => goTo(l.path)}>
                    {l.label}
                  </Button>
                ))}
                <Button onClick={() => setDetail(null)}>返回速览</Button>
              </Space>
            )
          }
        >
          {detail === 'notes' && <NotesDetail data={data} onChanged={reload} />}
          {detail === 'intents' && <IntentsDetail data={data} />}
          {detail === 'review' && <ReviewDetail data={data} adding={adding} canAdd={url !== null} onAdd={() => void addToReview()} />}
          {detail === 'submissions' && <SubmissionsDetail data={data} />}
          {detail === 'tasks' && <TasksDetail data={data} />}
          {detail === 'lists' && <ListsDetail data={data} />}
        </Modal>
      )}
    </>
  )
}

const DETAIL_TITLE: Record<DetailKind, string> = {
  notes: '笔记',
  intents: '卡点记录',
  review: '复习记录',
  submissions: '提交记录',
  tasks: '训练任务',
  lists: '所在题单',
}

type DetailLink = { label: string; path: string; primary?: boolean }

/** 二级弹窗底部「去对应功能页」的按钮 */
const DETAIL_LINKS: Record<DetailKind, (problemId: number | null, problemsPath: string, data: ProblemPeekData) => DetailLink[]> = {
  notes: (id, _p, data) => {
    if (id !== null) return [{ label: '在笔记库中打开', path: `/notes?problem=${id}`, primary: true }]
    const taskId = data.notes.find((n) => n.taskId !== null)?.taskId
    return [{ label: '打开笔记库', path: taskId ? `/notes?task=${taskId}` : '/notes', primary: true }]
  },
  intents: (_id, p) => [{ label: '去题目管理', path: p, primary: true }],
  review: () => [{ label: '去复习库', path: '/reviews', primary: true }],
  submissions: (_id, p) => [{ label: '去题目管理', path: p, primary: true }],
  tasks: () => [
    { label: '去训练计划', path: '/plans', primary: true },
    { label: '去日历打卡', path: '/calendar' },
  ],
  lists: () => [{ label: '去题单整理', path: '/lists', primary: true }],
}

function PeekRow({ icon, label, count, summary, onOpen, action, disabled, disabledHint }: {
  icon: ReactNode
  label: string
  count: number
  summary: ReactNode
  onOpen: () => void
  action?: ReactNode
  disabled?: boolean
  disabledHint?: string
}) {
  return (
    <div role="listitem" className={`problem-peek-row${count === 0 ? ' is-empty' : ''}`}>
      <button
        type="button"
        className="problem-peek-row-main"
        onClick={onOpen}
        disabled={disabled}
        title={disabled ? disabledHint : `查看${label}详情`}
      >
        <span className="problem-peek-row-icon" aria-hidden="true">{icon}</span>
        <span className="problem-peek-row-label">
          {label}
          {count > 0 && <span className="problem-peek-row-count">{count}</span>}
        </span>
        <span className="problem-peek-row-summary">{disabled ? disabledHint : summary}</span>
        {!disabled && <RightOutlined className="problem-peek-row-chevron" aria-hidden="true" />}
      </button>
      {action && <span className="problem-peek-row-action">{action}</span>}
    </div>
  )
}

/* ---------------- 一级摘要文案 ---------------- */

function notesSummary(d: ProblemPeekData): string {
  const reviewNote = d.review?.item?.note?.trim()
  if (d.notes.length === 0) return reviewNote ? `复习笔记：${noteSnippet(reviewNote)}` : '还没有笔记'
  const latest = d.notes.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b))
  const labels = [...new Set(d.notes.flatMap((n) => n.labels))]
  const parts = [`最近 ${fmt(latest.updatedAt, 'MM-DD')}`]
  if (labels.length > 0) parts.push(labels.slice(0, 4).join(' / '))
  const snippet = noteSnippet(latest.content, 40)
  if (snippet) parts.push(snippet)
  return parts.join(' · ')
}

function intentsSummary(d: ProblemPeekData): string {
  if (d.intents.length === 0) return '没有记过卡点'
  const latest = d.intents[0]
  const outcomes = [...new Set(d.intents.map((i) => intentLabel(i.outcome)))]
  return `最近：${intentLabel(latest.outcome)}${latest.codeName ? `（${latest.codeName}）` : ''} · ${fmt(latest.createdAt, 'MM-DD')}${outcomes.length > 1 ? ` · 共 ${outcomes.join(' / ')}` : ''}`
}

function reviewSummary(d: ProblemPeekData): string {
  const r = d.review
  if (!r || !r.item) return r && r.reviewCount > 0 ? `已移出复习队列 · 曾复习 ${r.reviewCount} 次` : '未加入复习'
  const due = r.item.overdueDays > 0 ? `逾期 ${r.item.overdueDays} 天` : r.item.daysUntilDue === 0 ? '今天到期' : `${r.item.daysUntilDue} 天后到期`
  return `第 ${r.item.stage + 1} 档 · ${due}（${r.item.nextDueOn}）· 已复习 ${r.reviewCount} 次${r.lapseCount > 0 ? `，${r.lapseCount} 次困难` : ''}`
}

function submissionsSummary(d: ProblemPeekData): string {
  if (d.stats.attempts === 0) return '工作台里没有这道题的提交'
  const parts = [`${d.stats.acCount} 次 AC`]
  if (d.stats.firstAcAt) parts.push(`首次 AC ${fmt(d.stats.firstAcAt, 'YYYY-MM-DD')}`)
  else if (d.stats.lastSubmittedAt) parts.push(`最近提交 ${fmt(d.stats.lastSubmittedAt, 'YYYY-MM-DD')}`)
  return parts.join(' · ')
}

function tasksSummary(d: ProblemPeekData): string {
  if (d.tasks.length === 0) return '没有出现在训练计划里'
  const checked = d.tasks.filter((t) => t.checkedAt).length
  const first = d.tasks[0]
  // AI 写的任务备注常自带「提示：」前缀，去掉后统一加一次
  const hintText = first.note ? noteSnippet(first.note, 40).replace(/^(AI\s*)?(提示|备注)\s*[:：]\s*/i, '') : ''
  const hint = hintText ? ` · 提示：${hintText}` : ''
  return `${first.planTitle} · ${first.taskDate}${d.tasks.length > 1 ? ` 等 ${d.tasks.length} 个任务` : ''} · 已打卡 ${checked}${hint}`
}

/* ---------------- 二级详情 ---------------- */

function NotesDetail({ data, onChanged }: { data: ProblemPeekData; onChanged: () => void }) {
  const reviewNote = data.review?.item?.note?.trim()
  return (
    <div className="peek-detail-stack">
      {data.problem ? (
        <ProblemNotesPanel target={{ problemId: data.problem.id, mirrors: true }} onChanged={onChanged} />
      ) : data.notes.length === 0 ? (
        <Empty description="还没有笔记" />
      ) : (
        // 题库里没有这道题：笔记只挂在训练任务上，这里只读展示，编辑去笔记库
        data.notes.map((n) => (
          <Card key={n.id} size="small" title={`${n.planTitle ?? ''} · ${n.taskDate ?? ''} · ${n.taskTitle ?? ''}`}>
            <NoteBlocksView blocks={n.blocks} />
          </Card>
        ))
      )}
      {reviewNote && (
        <Card size="small" title="复习笔记（复习库）">
          <Markdown text={reviewNote} />
        </Card>
      )}
    </div>
  )
}

function IntentsDetail({ data }: { data: ProblemPeekData }) {
  if (data.intents.length === 0) {
    return <Empty description="没有记过卡点。在题目管理的「卡在哪」里可以记录这道题卡在了哪儿。" />
  }
  return (
    <Table
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={data.intents}
      columns={[
        { title: '时间', dataIndex: 'createdAt', width: 150, render: (v: string) => fmt(v) },
        { title: '卡点', dataIndex: 'outcome', width: 120, render: (v: string) => <Tag color="orange">{intentLabel(v)}</Tag> },
        { title: '知识点', dataIndex: 'codeName', render: (v: string | null, r) => v ?? (r.code ? r.code : <span className="muted-note">非知识点问题</span>) },
        {
          title: '记在',
          key: 'src',
          width: 150,
          render: (_: unknown, r) => <span className="muted-note">{pName(r.platform)} {r.problemKey}</span>,
        },
      ]}
    />
  )
}

function ReviewDetail({ data, adding, canAdd, onAdd }: { data: ProblemPeekData; adding: boolean; canAdd: boolean; onAdd: () => void }) {
  const r = data.review
  return (
    <div className="peek-detail-stack">
      {r?.item ? (
        <div className="peek-kv-grid">
          <span>当前档位</span><b>第 {r.item.stage + 1} 档（间隔 {r.item.intervalDays} 天）</b>
          <span>下次到期</span>
          <b>
            {r.item.nextDueOn}
            {r.item.overdueDays > 0 ? `（逾期 ${r.item.overdueDays} 天）` : r.item.daysUntilDue === 0 ? '（今天）' : `（${r.item.daysUntilDue} 天后）`}
          </b>
          <span>加入时间</span><b>{fmt(r.item.addedAt, 'YYYY-MM-DD')}</b>
          <span>上次复习</span><b>{r.item.lastReviewedAt ? fmt(r.item.lastReviewedAt) : '还没复习过'}</b>
          <span>累计</span><b>复习 {r.reviewCount} 次{r.lapseCount > 0 ? `，其中 ${r.lapseCount} 次判为困难` : ''}</b>
        </div>
      ) : (
        <Alert
          type="info"
          showIcon
          message={r && r.reviewCount > 0 ? `这道题已移出复习队列（曾复习 ${r.reviewCount} 次）` : '这道题还没加入复习库'}
          action={canAdd ? <Button size="small" type="primary" loading={adding} onClick={onAdd}>加入复习</Button> : undefined}
        />
      )}
      {r?.item?.note?.trim() && (
        <Card size="small" title="复习笔记">
          <Markdown text={r.item.note} />
        </Card>
      )}
      {r && r.events.length > 0 ? (
        <Table
          size="small"
          rowKey="id"
          pagination={r.events.length > 10 ? { pageSize: 10, size: 'small' } : false}
          dataSource={r.events}
          columns={[
            { title: '复习时间', dataIndex: 'reviewedAt', width: 150, render: (v: string) => fmt(v) },
            {
              title: '反馈',
              dataIndex: 'feedback',
              width: 80,
              render: (v: string) => (
                <Tag color={v === 'hard' ? 'red' : v === 'easy' ? 'green' : 'blue'}>{FEEDBACK_META.find((f) => f.key === v)?.label ?? v}</Tag>
              ),
            },
            { title: '档位', key: 'stage', width: 90, render: (_: unknown, e) => `${e.stageBefore + 1} → ${e.stageAfter + 1}` },
            { title: '按期', key: 'timing', width: 100, render: (_: unknown, e) => reviewTimingText(e.reviewedAt, e.dueOn) },
            { title: '新间隔', dataIndex: 'intervalDays', render: (v: number, e) => `${v} 天${e.factor !== 1 ? `（×${e.factor.toFixed(2)}）` : ''}` },
          ]}
        />
      ) : (
        <div className="muted-note">还没有复习日志。</div>
      )}
    </div>
  )
}

function SubmissionsDetail({ data }: { data: ProblemPeekData }) {
  if (data.stats.attempts === 0) {
    return <Empty description="工作台里没有这道题的提交记录（同步平台账号后会自动出现）。" />
  }
  return (
    <div className="peek-detail-stack">
      <div className="peek-kv-grid">
        <span>提交 / AC</span><b>{data.stats.attempts} 次 / {data.stats.acCount} 次</b>
        <span>首次提交</span><b>{fmt(data.stats.firstSubmittedAt)}</b>
        <span>首次 AC</span><b>{data.stats.firstAcAt ? fmt(data.stats.firstAcAt) : '还没 AC'}</b>
        <span>最近提交</span><b>{fmt(data.stats.lastSubmittedAt)}</b>
      </div>
      <Space size={4} wrap>
        {Object.entries(data.verdicts).map(([v, n]) => (
          <Tag key={v} color={VERDICT_COLOR[v] ?? 'default'}>{v} × {n}</Tag>
        ))}
      </Space>
      <Table
        size="small"
        rowKey="id"
        pagination={data.submissions.length > 10 ? { pageSize: 10, size: 'small' } : false}
        dataSource={data.submissions}
        columns={[
          { title: '时间', dataIndex: 'submittedAt', width: 150, render: (v: string) => fmt(v) },
          { title: '结果', dataIndex: 'verdict', width: 80, render: (v: string) => <Tag color={VERDICT_COLOR[v] ?? 'default'}>{v}</Tag> },
          { title: '语言', dataIndex: 'language', render: (v: string | null) => v ?? '—' },
          { title: '语境', dataIndex: 'context', width: 80, render: (v: string | null) => (v ? CONTEXT_LABEL[v] ?? v : '—') },
          { title: '平台 / 账号', key: 'acc', render: (_: unknown, s) => <span className="muted-note">{pName(s.platform)} {s.problemKey}{s.account ? ` · ${s.account}` : ''}</span> },
        ]}
      />
      {data.stats.attempts > data.submissions.length && (
        <div className="muted-note">只列出最近 {data.submissions.length} 次提交。</div>
      )}
    </div>
  )
}

function TasksDetail({ data }: { data: ProblemPeekData }) {
  if (data.tasks.length === 0) return <Empty description="这道题没有出现在任何训练计划里。" />
  return (
    <div className="peek-detail-stack">
      {data.tasks.map((t) => (
        <Card
          key={t.id}
          size="small"
          title={
            <Space size={6} wrap>
              <Tag color={kindColor(t.kind)} style={{ marginInlineEnd: 0 }}>{kindLabel(t.kind)}</Tag>
              <span>{t.title}</span>
            </Space>
          }
          extra={t.checkedAt ? <Tag icon={<CheckCircleOutlined />} color="success">已打卡 {fmt(t.checkedAt, 'MM-DD HH:mm')}</Tag> : <Tag>未打卡</Tag>}
        >
          <div className="muted-note">{t.planTitle} · {t.taskDate}</div>
          {t.note?.trim() ? (
            <div className="peek-task-note">
              <div className="peek-task-note-label">任务提示 / 备注</div>
              <Markdown text={t.note} />
            </div>
          ) : (
            <div className="muted-note">这个任务没有提示或备注。</div>
          )}
        </Card>
      ))}
    </div>
  )
}

function ListsDetail({ data }: { data: ProblemPeekData }) {
  if (data.lists.length === 0) return <Empty description="这道题不在任何题单里。" />
  return (
    <Table
      size="small"
      rowKey="itemId"
      pagination={false}
      dataSource={data.lists}
      columns={[
        { title: '题单', dataIndex: 'listTitle' },
        { title: '分类', dataIndex: 'category', render: (v: string) => <Tag>{v}</Tag> },
        { title: '条目', key: 'item', render: (_: unknown, l) => <span className="muted-note">{pName(l.platform)} {l.problemKey}</span> },
      ]}
    />
  )
}
