export type CueStatus = 'draft' | 'reviewed' | 'issue'
export type Locale = 'zh-CN' | 'en-US' | 'ja-JP'
export type TranslationState = 'confirmed' | 'pending'

export interface CueTranslation {
  text: string
  state: TranslationState
}

export interface Cue {
  id: string
  start: number
  end: number
  source: string
  /** 按语言保存的译文，键为语言代码（如 zh / en / ja） */
  translations: Record<string, CueTranslation>
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

export type PendingReason = 'ambiguous' | 'shifted' | 'unmatched' | 'missing'

export interface PendingItem {
  id: string
  language: string
  reason: PendingReason
  /** 导入行在文件中的序号（从 1 开始），missing 类型为 null */
  importedIndex: number | null
  importedStart: number | null
  importedEnd: number | null
  importedText: string | null
  /** 涉及的台词：missing 类型为缺译文的台词，其余为建议归属 */
  cueId: string | null
  candidateCueIds: string[]
  resolved: boolean
  createdAt: number
}

export interface Snapshot {
  id: string
  name: string
  createdAt: number
  cues: Cue[]
  pendingItems: PendingItem[]
}

export interface EditorDocument {
  id: string
  title: string
  language: Locale
  /** 本项目跟踪的译文语言代码列表 */
  targetLanguages: string[]
  cues: Cue[]
  pendingItems: PendingItem[]
  actors: Actor[]
  terms: Term[]
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

export interface HistoryEntry {
  label: string
  cues: Cue[]
  pendingItems: PendingItem[]
  selectedCueId: string | null
}

export interface ImportedEntry {
  index: number
  start: number
  end: number
  text: string
}
