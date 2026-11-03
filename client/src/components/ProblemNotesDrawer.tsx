import { Button, Drawer } from 'antd'
import { useNavigate } from 'react-router-dom'
import ProblemNotesPanel from './ProblemNotesPanel'

export interface NotesProblem {
  id: number
  title: string
  problem_key: string
}

/** 题目管理的「题目笔记」：一题多条、可标注；训练计划打卡写的笔记也汇总在这里。 */
export default function ProblemNotesDrawer({ problem, onClose, onChanged }: {
  problem: NotesProblem | null
  onClose: () => void
  /** 新增或删除后调用（刷新行上的笔记条数） */
  onChanged: () => void
}) {
  const nav = useNavigate()
  return (
    <Drawer
      title={problem ? `题目笔记 · ${problem.problem_key} ${problem.title}` : '题目笔记'}
      open={problem !== null}
      onClose={onClose}
      width={640}
      extra={
        problem && (
          <Button size="small" onClick={() => nav(`/notes?problem=${problem.id}`)}>在笔记库中查看</Button>
        )
      }
    >
      {problem && <ProblemNotesPanel key={problem.id} target={{ problemId: problem.id }} onChanged={onChanged} />}
    </Drawer>
  )
}
