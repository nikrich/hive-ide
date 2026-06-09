import { useEffect, useState } from 'react'

import type { HiveLoopStatus, HiveQuestion } from '../../../types/hive'

export interface HiveLoopState {
  status: HiveLoopStatus
  /** Latest question text per story id (push event + initial list). */
  questions: Record<string, string>
}

/** Subscribe to loop status + worker questions; expose start/stop/answer. */
export function useHiveLoop(): HiveLoopState & {
  start: () => Promise<void>
  stop: () => Promise<void>
  answer: (storyId: string, answer: string) => Promise<void>
} {
  const [status, setStatus] = useState<HiveLoopStatus>({ running: false, currentStory: null })
  const [questions, setQuestions] = useState<Record<string, string>>({})

  useEffect(() => {
    const loop = window.hive?.loop
    const q = window.hive?.questions
    if (!loop || !q) return
    void loop.status().then(setStatus).catch(() => undefined)
    void q.list().then((list) => {
      setQuestions(Object.fromEntries(list.map((x: HiveQuestion) => [x.storyId, x.question])))
    }).catch(() => undefined)
    const offStatus = loop.onStatus(setStatus)
    const offQ = q.onQuestion((x) => setQuestions((prev) => ({ ...prev, [x.storyId]: x.question })))
    return () => { offStatus(); offQ() }
  }, [])

  return {
    status,
    questions,
    start: async () => { await window.hive?.loop?.start() },
    stop: async () => { await window.hive?.loop?.stop() },
    answer: async (storyId, answer) => {
      await window.hive?.story?.answer(storyId, answer)
      setQuestions((prev) => { const next = { ...prev }; delete next[storyId]; return next })
    },
  }
}
