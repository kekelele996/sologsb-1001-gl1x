import type { Cue, ImportedEntry, PendingItem } from '../types'
import { makeId } from './id'

/** 起止时间均在此误差内视为同一时码 */
const EXACT_TOLERANCE = 0.12
/** 超过精确误差但在此窗口内视为时码偏移 */
const SHIFT_WINDOW = 2

export interface MatchResult {
  /** 一一对应、可自动归入的配对 */
  assignments: { entry: ImportedEntry; cueId: string }[]
  /** 一对多、时码偏移或无匹配的导入行 */
  pending: PendingItem[]
  /** 本次被任意导入行命中的台词 id */
  matchedCueIds: Set<string>
}

const matchesExactly = (cue: Cue, entry: ImportedEntry) =>
  Math.abs(cue.start - entry.start) <= EXACT_TOLERANCE && Math.abs(cue.end - entry.end) <= EXACT_TOLERANCE

export const matchImport = (cues: Cue[], entries: ImportedEntry[], language: string): MatchResult => {
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end)
  const exactCandidates = entries.map((entry) => sorted.filter((cue) => matchesExactly(cue, entry)))

  // 每条台词被多少导入行唯一命中，用于排除多对一
  const claimCount = new Map<string, number>()
  for (const candidates of exactCandidates) {
    if (candidates.length === 1) claimCount.set(candidates[0].id, (claimCount.get(candidates[0].id) ?? 0) + 1)
  }

  const assigned = new Map<number, string>()
  const demoted = new Set<number>()
  entries.forEach((_, index) => {
    const candidates = exactCandidates[index]
    if (candidates.length === 1 && (claimCount.get(candidates[0].id) ?? 0) === 1) assigned.set(index, candidates[0].id)
    else demoted.add(index)
  })

  // 顺序校验：自动归入的台词位置必须随导入顺序严格递增，否则双方降级为待确认
  let lastPosition = -1
  entries.forEach((_, index) => {
    const cueId = assigned.get(index)
    if (cueId === undefined) return
    const position = sorted.findIndex((cue) => cue.id === cueId)
    if (position <= lastPosition) {
      assigned.delete(index)
      demoted.add(index)
    } else {
      lastPosition = position
    }
  })

  const now = Date.now()
  const pending: PendingItem[] = []
  entries.forEach((entry, index) => {
    if (!demoted.has(index)) return
    const candidates = exactCandidates[index]
    let reason: PendingItem['reason']
    let candidateIds: string[]
    if (candidates.length > 0) {
      reason = 'ambiguous'
      candidateIds = candidates.map((cue) => cue.id)
    } else {
      const nearby = sorted
        .filter((cue) => Math.abs(cue.start - entry.start) <= SHIFT_WINDOW || Math.abs(cue.end - entry.end) <= SHIFT_WINDOW)
        .sort((a, b) => Math.abs(a.start - entry.start) + Math.abs(a.end - entry.end) - (Math.abs(b.start - entry.start) + Math.abs(b.end - entry.end)))
      if (nearby.length) {
        reason = 'shifted'
        candidateIds = nearby.map((cue) => cue.id)
      } else {
        reason = 'unmatched'
        candidateIds = []
      }
    }
    pending.push({
      id: makeId('pending'),
      language,
      reason,
      importedIndex: entry.index,
      importedStart: entry.start,
      importedEnd: entry.end,
      importedText: entry.text,
      cueId: candidateIds[0] ?? null,
      candidateCueIds: candidateIds,
      resolved: false,
      createdAt: now,
    })
  })

  return {
    assignments: [...assigned.entries()].map(([index, cueId]) => ({ entry: entries[index], cueId })),
    pending,
    matchedCueIds: new Set(assigned.values()),
  }
}
