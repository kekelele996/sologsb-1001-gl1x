import type { Cue, PendingItem, PendingReason, TargetEntry } from '../types'
import { makeId } from './id'

export const formatTime = (seconds: number, separator = ','): string => {
  const safe = Math.max(0, seconds)
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  const s = Math.floor(safe % 60)
  const ms = Math.round((safe - Math.floor(safe)) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`
}

export const parseTime = (value: string): number => {
  const normalized = value.trim().replace(',', '.')
  const parts = normalized.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return Number(normalized) || 0
}

/** 时码相等容差（秒），SRT 毫秒取整误差在此范围内视为一致 */
export const TIME_EPSILON = 0.02

export const timeEquals = (a: number, b: number) => Math.abs(a - b) <= TIME_EPSILON

/** 解析后的外部 SRT 条目（英/日版译文稿），此时尚未挂到底稿台词上 */
export interface SrtEntry {
  start: number
  end: number
  text: string
}

export const parseSrtEntries = (text: string): SrtEntry[] => {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/)
  const entries: SrtEntry[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean)
    const timeLineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeLineIndex < 0) continue
    const [from, to] = lines[timeLineIndex].split('-->').map((part) => part.trim().split(' ')[0])
    const content = lines.slice(timeLineIndex + 1).join('\n').trim()
    if (!content) continue
    entries.push({ start: parseTime(from), end: parseTime(to), text: content })
  }
  return entries
}

/** 导入底稿（首份 SRT）：条目即原文，各语言译文留空 */
export const parseSrt = (text: string, actorId = 'actor-narrator'): Cue[] =>
  parseSrtEntries(text).map((entry) => ({
    id: makeId('cue'),
    start: entry.start,
    end: entry.end,
    source: entry.text,
    targets: {},
    targetStatus: {},
    actorId,
    speed: 1,
    termIds: [],
    status: 'draft',
    locked: false,
  }))

export const parseScript = (text: string, actors: { id: string; name: string }[]): Cue[] => {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean)
  const result: Cue[] = []
  lines.forEach((line, index) => {
    const match = line.match(/^([^：:]{1,18})[：:]\s*(.+)$/)
    const actorName = match?.[1]?.trim()
    const content = match?.[2]?.trim() || line
    const actor = actors.find((item) => item.name === actorName) ?? actors[0]
    result.push({
      id: makeId('cue'),
      start: index * 4,
      end: index * 4 + 3.5,
      source: content,
      targets: {},
      targetStatus: {},
      actorId: actor?.id ?? 'actor-narrator',
      speed: 1,
      termIds: [],
      status: 'draft',
      locked: false,
    })
  })
  return result
}

export interface MatchResult {
  /** 自动一一对应的 cueId -> 译文文本 */
  matched: Map<string, string>
  /** 未能自动归入、交校对员处理的待确认项 */
  pending: PendingItem[]
  /** 尚未挂接的游离译文条目 */
  looseEntries: TargetEntry[]
}

/**
 * 按起止时间和顺序匹配译稿条目与底稿台词。
 * 只有“起止时间一致 + 双方互为唯一候选 + 顺序单调一致”的条目才自动归入；
 * 一对多、缺句、时码偏移（含顺序错位）全部列为待确认。
 */
export const matchTranslations = (entries: SrtEntry[], cues: Cue[], draftId: string): MatchResult => {
  const looseEntries: TargetEntry[] = entries.map((entry, index) => ({
    id: makeId('entry'),
    draftId,
    start: entry.start,
    end: entry.end,
    text: entry.text,
    order: index + 1,
  }))
  const pending: PendingItem[] = []
  const matched = new Map<string, string>()
  if (!looseEntries.length) return { matched, pending, looseEntries }

  const entryCandidates = looseEntries.map((entry) =>
    cues.map((cue) => cue.id).filter((id) => {
      const cue = cues.find((item) => item.id === id)!
      return timeEquals(cue.start, entry.start) && timeEquals(cue.end, entry.end)
    }),
  )
  const cueCandidates = (cueId: string) =>
    looseEntries
      .map((entry) => entry.id)
      .filter((id) => {
        const entry = looseEntries.find((item) => item.id === id)!
        const cue = cues.find((item) => item.id === cueId)!
        return timeEquals(cue.start, entry.start) && timeEquals(cue.end, entry.end)
      })

  // 时间一致且双方互为唯一候选，初步配成一对，随后再检查顺序
  const pairs: { cueId: string; entryId: string }[] = []
  looseEntries.forEach((entry, entryIndex) => {
    const candidates = entryCandidates[entryIndex]
    if (candidates.length !== 1) return
    const cueId = candidates[0]
    if (cueCandidates(cueId).length === 1) pairs.push({ cueId, entryId: entry.id })
  })

  // 顺序必须单调一致；与任意其他配对构成逆序的配对都降级为时码偏移待确认，
  // 例如相邻两句时码相同却互相交换时，两句都交给校对员处理
  const cueOrder = new Map(cues.map((cue, index) => [cue.id, index]))
  const entryOrder = new Map(looseEntries.map((entry, index) => [entry.id, index]))
  const ordered = pairs.map((pair) => ({ ...pair, ci: cueOrder.get(pair.cueId)!, ei: entryOrder.get(pair.entryId)! }))
  const inInversion = ordered.map((a, i) =>
    ordered.some((b, j) => i !== j && (a.ci - b.ci) * (a.ei - b.ei) < 0),
  )
  const auto = new Set<string>()
  ordered.forEach((pair, index) => {
    if (inInversion[index]) return
    const entry = looseEntries.find((item) => item.id === pair.entryId)!
    matched.set(pair.cueId, entry.text)
    auto.add(pair.cueId)
    auto.add(pair.entryId)
  })

  looseEntries
    .filter((entry) => !auto.has(entry.id))
    .forEach((entry) => {
      const candidates = entryCandidates[entry.order - 1]
      let reason: PendingReason
      let cueId: string | undefined
      if (candidates.length > 1) {
        reason = 'ambiguous' // 一对多
      } else if (candidates.length === 1) {
        reason = 'offset' // 时间一致但顺序错位
        cueId = candidates[0]
      } else {
        reason = 'offset' // 起止时间对不上
      }
      pending.push({
        id: makeId('pending'),
        draftId,
        cueId,
        entryId: entry.id,
        reason,
        detail: `${formatTime(entry.start)} --> ${formatTime(entry.end)}`,
      })
    })

  // 底稿有、译稿缺：缺句待确认
  const linkedCueIds = new Set<string>()
  for (const [cueId] of matched) linkedCueIds.add(cueId)
  for (const item of pending) if (item.cueId) linkedCueIds.add(item.cueId)
  cues
    .filter((cue) => !linkedCueIds.has(cue.id))
    .forEach((cue) => {
      pending.push({
        id: makeId('pending'),
        draftId,
        cueId: cue.id,
        reason: 'missing',
        detail: `${formatTime(cue.start)} --> ${formatTime(cue.end)}`,
      })
    })

  return { matched, pending, looseEntries }
}

/** 导出某一语言稿：取该语言译文，无译文时回退原文 */
export const toSrt = (cues: Cue[], draftId: string | null): string =>
  [...cues]
    .sort((a, b) => a.start - b.start)
    .map((cue, index) => {
      const text = (draftId && cue.targets[draftId]) || cue.source
      return `${index + 1}\n${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${text}`
    })
    .join('\n\n') + '\n'
