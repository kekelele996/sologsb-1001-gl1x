export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'

/** 某一语言稿与底稿台词的匹配状态 */
export type TargetLinkStatus = 'matched' | 'pending' | 'empty'

/** 待确认原因：一对多、缺句、时码偏移（含顺序不符）、时码被改动 */
export type PendingReason = 'ambiguous' | 'missing' | 'offset' | 'time-changed'

export interface Cue {
  id: string
  start: number
  end: number
  source: string
  /** 各语言译文，key 为语言代码；不再只有单一译文 */
  targets: Record<string, string>
  /** 各语言稿与底稿的匹配状态 */
  targetStatus: Record<string, TargetLinkStatus>
  actorId: string
  speed: number
  termIds: string[]
  status: CueStatus
  locked: boolean
}

export interface Actor {
  id: string
  name: string
  color: string
  localeHint: string
}

export interface Term {
  id: string
  source: string
  target: string
  note: string
}

/** 一种语言的译文稿（如英文版、日文版） */
export interface TranslationDraft {
  id: string
  /** BCP-47 语言代码，如 en-US / ja-JP */
  language: string
  label: string
  importedAt: number
}

/** 导入后无法一一对应、尚未挂到台词上的译文条目 */
export interface TargetEntry {
  id: string
  draftId: string
  start: number
  end: number
  text: string
  /** 导入时的序号（从 1 开始），用于按顺序匹配与展示 */
  order: number
}

/** 待确认项：缺句 / 一对多 / 时码偏移 / 时码改动 */
export interface PendingItem {
  id: string
  draftId: string
  /** 缺句 / 时码问题指向的底稿台词；一对多且无唯一候选时为空 */
  cueId?: string
  /** 待挂接的游离条目；缺句（底稿有、译稿无）时为空 */
  entryId?: string
  reason: PendingReason
  detail?: string
}

export interface Snapshot {
  id: string
  name: string
  createdAt: number
  cues: Cue[]
  drafts: TranslationDraft[]
  looseEntries: TargetEntry[]
  pendingItems: PendingItem[]
  activeDraftId: string | null
}

export interface EditorDocument {
  id: string
  title: string
  language: Locale
  cues: Cue[]
  actors: Actor[]
  terms: Term[]
  drafts: TranslationDraft[]
  looseEntries: TargetEntry[]
  pendingItems: PendingItem[]
  activeDraftId: string | null
  snapshots: Snapshot[]
  updatedAt: number
  revision: number
  lastWriter: string
}

export interface CueConflict {
  cueId: string
  type: 'actor' | 'tone' | 'address'
  message: string
}
