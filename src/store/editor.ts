import { defineStore } from 'pinia'
import type { Cue, CueStatus, EditorDocument, Locale, PendingItem, Snapshot, TargetEntry, TranslationDraft } from '../types'
import { loadDocument, saveDocument } from '../utils/db'
import { makeId } from '../utils/id'
import { matchTranslations, parseSrtEntries, parseScript, parseSrt, toSrt } from '../utils/subtitle'
import { translate, type MessageKey } from '../i18n'

const DOCUMENT_ID = 'subtitle-dubbing-document'
let saveTimer: ReturnType<typeof setTimeout> | undefined
let channel: BroadcastChannel | undefined

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const plainDocument = (document: EditorDocument): EditorDocument => clone(document)

interface DraftState {
  cues: Cue[]
  drafts: TranslationDraft[]
  looseEntries: TargetEntry[]
  pendingItems: PendingItem[]
  activeDraftId: string | null
}

type HistoryEntry = { label: string; selection: string | null } & DraftState

/** 可识别的译稿语言预设 */
export const DRAFT_PRESETS: { language: string; labels: Record<Locale, string> }[] = [
  { language: 'en-US', labels: { 'zh-CN': '英文版', 'en-US': 'English version', 'ja-JP': '英語版' } },
  { language: 'ja-JP', labels: { 'zh-CN': '日文版', 'en-US': 'Japanese version', 'ja-JP': '日本語版' } },
  { language: 'zh-CN', labels: { 'zh-CN': '中文版', 'en-US': 'Chinese version', 'ja-JP': '中国語版' } },
]

/** 根据文件名猜测译稿语言 */
export const guessDraftLanguage = (filename: string): string => {
  const name = filename.toLowerCase()
  if (/ja|jp|jpn|日/.test(name)) return 'ja-JP'
  if (/zh|cn|chs|中/.test(name)) return 'zh-CN'
  return 'en-US'
}

const LEGACY_DRAFT_ID = 'draft-legacy'

const demoTargets: Record<string, { en: string; ja: string }> = {
  'cue-demo-01': {
    en: 'Open source is not an isolated technology, but an ongoing way of collaboration.',
    ja: 'オープンソースは孤立した技術ではなく、継続的な協働のあり方です。',
  },
  'cue-demo-02': {
    en: 'Today Dr. Lin joins us to discuss the choices community maintainers face every day.',
    ja: '今日は林博士に、コミュニティのメンテナーが日々向き合う選択について伺います。',
  },
  'cue-demo-03': {
    en: 'Behind every pull request lies context that first needs to be understood.',
    ja: 'すべてのプルリクエストの背後には、まず理解されるべき背景があります。',
  },
  'cue-demo-04': {
    en: 'Please start with the code review that left the deepest impression on you.',
    ja: 'まず、一番印象に残っているコードレビューを教えてください。',
  },
  'cue-demo-05': {
    en: 'The change was tiny, yet it let new users complete installation smoothly for the first time.',
    ja: '修正は小さなものでしたが、新しいユーザーが初めてスムーズにインストールできるようになりました。',
  },
  'cue-demo-06': {
    en: 'So we split the installation guide and added verification steps for every platform.',
    ja: 'そこでインストール手順を分割し、各プラットフォームに検証ステップを補いました。',
  },
}

const createDefaultDocument = (): EditorDocument => {
  const drafts: TranslationDraft[] = [
    { id: 'draft-en', language: 'en-US', label: '英文版', importedAt: Date.now() },
    { id: 'draft-ja', language: 'ja-JP', label: '日文版', importedAt: Date.now() },
  ]
  const makeCue = (
    id: string, start: number, end: number, source: string, actorId: string,
    speed: number, termIds: string[], status: Cue['status'], locked: boolean,
  ): Cue => ({
    id, start, end, source, actorId, speed, termIds, status, locked,
    targets: {
      'draft-en': demoTargets[id].en,
      'draft-ja': demoTargets[id].ja,
    },
    targetStatus: { 'draft-en': 'matched', 'draft-ja': 'matched' },
  })
  return {
    id: DOCUMENT_ID,
    title: '纪录片《开源之路》中文配音',
    language: 'zh-CN',
    revision: 0,
    updatedAt: Date.now(),
    lastWriter: '',
    actors: [
      { id: 'actor-narrator', name: '旁白 / Narrator', color: '#2f6fed', localeHint: 'zh-CN' },
      { id: 'actor-lin', name: '林博士 / Dr. Lin', color: '#cf5a39', localeHint: 'zh-CN' },
      { id: 'actor-chen', name: '陈工 / Engineer Chen', color: '#14866d', localeHint: 'zh-CN' },
      { id: 'actor-host', name: '主持人 / Host', color: '#7d53b8', localeHint: 'zh-CN' },
    ],
    terms: [
      { id: 'term-01', source: 'open source', target: '开源', note: '产品语境' },
      { id: 'term-02', source: 'maintainer', target: '维护者', note: '不使用“管理者”' },
      { id: 'term-03', source: 'pull request', target: '拉取请求', note: '首次出现保留英文缩写 PR' },
      { id: 'term-04', source: 'community', target: '社区', note: '泛指开发者社区' },
    ],
    drafts,
    looseEntries: [],
    pendingItems: [],
    activeDraftId: 'draft-en',
    cues: [
      makeCue('cue-demo-01', 0, 4.2, '开源并不是一项孤立的技术，而是一种持续协作的方式。', 'actor-narrator', 1.02, ['term-01'], 'reviewed', true),
      makeCue('cue-demo-02', 4.3, 8.6, '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', 'actor-host', 1, ['term-04', 'term-02'], 'reviewed', false),
      makeCue('cue-demo-03', 8.8, 13.5, '每个拉取请求背后，都有一段需要被理解的上下文。', 'actor-lin', 0.96, ['term-03'], 'reviewed', false),
      makeCue('cue-demo-04', 13.7, 18.8, '请您先介绍一次印象最深的代码评审。', 'actor-host', 1.03, [], 'draft', false),
      makeCue('cue-demo-05', 19, 25.1, '那次修改很小，却让新用户第一次能够顺利完成安装。', 'actor-lin', 0.98, [], 'issue', false),
      makeCue('cue-demo-06', 25.4, 31.2, '所以我们决定把安装说明拆开，并为每个平台补上验证步骤。', 'actor-chen', 1.05, [], 'draft', false),
    ],
    snapshots: [],
  }
}

/** 旧版本数据迁移：单一 target 升级为按语言保存 */
const migrate = (document: EditorDocument): EditorDocument => {
  const doc = document as EditorDocument & { cues: Array<Cue & { target?: string }> }
  let changed = false
  if (!doc.drafts) {
    doc.drafts = [{ id: LEGACY_DRAFT_ID, language: doc.language, label: '原文语言稿', importedAt: doc.updatedAt ?? Date.now() }]
    changed = true
  }
  if (!doc.looseEntries) { doc.looseEntries = []; changed = true }
  if (!doc.pendingItems) { doc.pendingItems = []; changed = true }
  if (doc.activeDraftId === undefined) { doc.activeDraftId = doc.drafts[0]?.id ?? null; changed = true }
  for (const cue of doc.cues) {
    if (!cue.targets) {
      cue.targets = {}
      cue.targetStatus = {}
      if (cue.target) {
        cue.targets[LEGACY_DRAFT_ID] = cue.target
        cue.targetStatus[LEGACY_DRAFT_ID] = 'matched'
      }
      delete (cue as { target?: string }).target
      changed = true
    }
  }
  if (Array.isArray(doc.snapshots)) {
    for (const snapshot of doc.snapshots as Array<Snapshot & { pendingItems?: PendingItem[] }>) {
      if (!snapshot.drafts) snapshot.drafts = doc.drafts
      if (!snapshot.looseEntries) snapshot.looseEntries = []
      if (!snapshot.pendingItems) snapshot.pendingItems = []
      if (snapshot.activeDraftId === undefined) snapshot.activeDraftId = doc.activeDraftId
      for (const cue of snapshot.cues as Array<Cue & { target?: string }>) {
        if (!cue.targets) {
          cue.targets = {}
          cue.targetStatus = {}
          if (cue.target) {
            cue.targets[LEGACY_DRAFT_ID] = cue.target
            cue.targetStatus[LEGACY_DRAFT_ID] = 'matched'
          }
          delete cue.target
        }
      }
    }
  }
  return changed ? plainDocument(doc) : document
}

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict'

export interface ExportIssues {
  emptyCueIds: string[]
  pendingIds: string[]
}

export const useEditorStore = defineStore('subtitle-editor', {
  state: () => ({
    document: createDefaultDocument(),
    selectedCueId: 'cue-demo-03' as string | null,
    actorFilter: 'all',
    timelineZoom: 1,
    saveState: 'saved' as SaveState,
    saving: false,
    initialized: false,
    conflict: false,
    online: navigator.onLine,
    tabId: makeId('tab'),
    lastSeenRevision: 0,
    mutationSerial: 0,
    past: [] as HistoryEntry[],
    future: [] as HistoryEntry[],
  }),
  getters: {
    t: (state) => (key: MessageKey, values?: Record<string, string | number>) => translate(state.document.language, key, values),
    selectedCue(state): Cue | undefined {
      return state.document.cues.find((cue) => cue.id === state.selectedCueId)
    },
    activeDraft(state): TranslationDraft | undefined {
      return state.document.drafts.find((draft) => draft.id === state.document.activeDraftId)
    },
    visibleCues(state): Cue[] {
      return state.actorFilter === 'all'
        ? state.document.cues
        : state.document.cues.filter((cue) => cue.actorId === state.actorFilter)
    },
    totalDuration(state): number {
      return Math.max(10, ...state.document.cues.map((cue) => cue.end)) * 1.04
    },
  },
  actions: {
    draftState(): DraftState {
      return {
        cues: clone(this.document.cues),
        drafts: clone(this.document.drafts),
        looseEntries: clone(this.document.looseEntries),
        pendingItems: clone(this.document.pendingItems),
        activeDraftId: this.document.activeDraftId,
      }
    },
    restoreDraftState(state: DraftState) {
      this.document.cues = clone(state.cues)
      this.document.drafts = clone(state.drafts)
      this.document.looseEntries = clone(state.looseEntries)
      this.document.pendingItems = clone(state.pendingItems)
      this.document.activeDraftId = state.activeDraftId
    },
    async initialize() {
      if (this.initialized) return
      this.online = navigator.onLine
      const stored = await loadDocument(DOCUMENT_ID)
      if (stored) {
        this.document = migrate(stored)
        this.lastSeenRevision = stored.revision
        if (this.document !== stored) {
          // 迁移产生结构变化时落盘一次
          const saved = await saveDocument(plainDocument(this.document), this.lastSeenRevision)
          this.document = saved
          this.lastSeenRevision = saved.revision
        }
      } else {
        const saved = await saveDocument(plainDocument(this.document))
        this.document = saved
        this.lastSeenRevision = saved.revision
      }
      this.initialized = true
      if ('BroadcastChannel' in window) {
        channel = new BroadcastChannel('sologsb-1001-document')
        channel.onmessage = async (event) => {
          const message = event.data as { type: string; tabId: string; revision: number; documentId: string }
          if (message.type !== 'document-updated' || message.tabId === this.tabId || message.documentId !== DOCUMENT_ID) return
          if (message.revision <= this.lastSeenRevision) return
          if (this.saveState === 'dirty' || this.saveState === 'saving' || this.conflict) {
            this.conflict = true
            this.saveState = 'conflict'
            return
          }
          const latestStored = await loadDocument(DOCUMENT_ID)
          if (latestStored) {
            const latest = migrate(latestStored)
            if (latest.revision > this.lastSeenRevision) {
              this.document = latest
              this.lastSeenRevision = latest.revision
              this.saveState = 'saved'
            }
          }
        }
      }
    },
    setOnline(value: boolean) {
      this.online = value
    },
    selectCue(id: string | null) {
      this.selectedCueId = id
    },
    setLocale(locale: Locale) {
      this.document.language = locale
      this.markChanged('language', true)
    },
    setActiveDraft(draftId: string | null) {
      if (draftId !== null && !this.document.drafts.some((draft) => draft.id === draftId)) return
      const before = this.draftState()
      this.document.activeDraftId = draftId
      this.past.push({ label: 'switch-draft', selection: this.selectedCueId, ...before })
      if (this.past.length > 60) this.past.shift()
      this.future = []
      this.markChanged('switch-draft')
    },
    draftLabel(draft: TranslationDraft): string {
      const preset = DRAFT_PRESETS.find((item) => item.language === draft.language)
      return draft.label || preset?.labels[this.document.language] || draft.language
    },
    targetText(cue: Cue): string {
      const id = this.document.activeDraftId
      return (id && cue.targets[id]) || ''
    },
    targetStatusOf(cue: Cue): Cue['targetStatus'][string] | undefined {
      const id = this.document.activeDraftId
      return id ? cue.targetStatus[id] : undefined
    },
    pendingForDraft(draftId: string): PendingItem[] {
      return this.document.pendingItems.filter((item) => item.draftId === draftId)
    },
    pendingCount(draftId: string): number {
      return this.document.pendingItems.filter((item) => item.draftId === draftId).length
    },
    commit(label: string, mutate: (state: DraftState) => void, nextSelection?: string | null) {
      const before = this.draftState()
      const working = this.draftState()
      mutate(working)
      this.past.push({ label, selection: this.selectedCueId, ...before })
      if (this.past.length > 60) this.past.shift()
      this.future = []
      this.restoreDraftState(working)
      if (nextSelection !== undefined) this.selectedCueId = nextSelection
      this.markChanged(label)
    },
    markChanged(label: string, persist = true) {
      this.document.updatedAt = Date.now()
      if (persist) {
        this.saveState = 'dirty'
        this.mutationSerial += 1
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(() => void this.persist(label), 500)
      }
    },
    async persist(label = 'autosave') {
      if (!this.initialized || this.conflict || this.saveState === 'saving') return
      const serial = this.mutationSerial
      this.saveState = 'saving'
      this.saving = true
      try {
        const next = await saveDocument({ ...plainDocument(this.document), lastWriter: this.tabId }, this.lastSeenRevision)
        this.document.revision = next.revision
        this.document.updatedAt = next.updatedAt
        this.lastSeenRevision = next.revision
        if (serial === this.mutationSerial) {
          this.saveState = 'saved'
        } else {
          this.saveState = 'dirty'
        }
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: DOCUMENT_ID })
      } catch (error) {
        if (error instanceof Error && error.message === 'REVISION_CONFLICT') {
          this.conflict = true
          this.saveState = 'conflict'
        } else {
          this.saveState = 'dirty'
          console.error(label, error)
        }
      } finally {
        this.saving = false
        if (this.saveState === 'dirty') {
          if (saveTimer) clearTimeout(saveTimer)
          saveTimer = setTimeout(() => void this.persist(label), 700)
        }
      }
    },
    async keepMine() {
      try {
        this.saving = true
        const latest = await loadDocument(DOCUMENT_ID)
        const expected = latest?.revision ?? this.lastSeenRevision
        const next = await saveDocument({ ...plainDocument(this.document), lastWriter: this.tabId }, expected)
        this.document.revision = next.revision
        this.lastSeenRevision = next.revision
        this.conflict = false
        this.saveState = 'saved'
        channel?.postMessage({ type: 'document-updated', tabId: this.tabId, revision: next.revision, documentId: DOCUMENT_ID })
      } finally {
        this.saving = false
      }
    },
    async loadLatest() {
      const latest = await loadDocument(DOCUMENT_ID)
      if (!latest) return
      this.document = migrate(latest)
      this.lastSeenRevision = latest.revision
      this.conflict = false
      this.saveState = 'saved'
      this.selectedCueId = latest.cues[0]?.id ?? null
      this.past = []
      this.future = []
    },
    undo() {
      const entry = this.past.pop()
      if (!entry) return
      this.future.push({ label: entry.label, selection: this.selectedCueId, ...this.draftState() })
      const { label: _label, selection, ...state } = entry
      void _label
      this.restoreDraftState(state)
      this.selectedCueId = selection
      this.markChanged(`undo:${entry.label}`)
    },
    redo() {
      const entry = this.future.pop()
      if (!entry) return
      this.past.push({ label: entry.label, selection: this.selectedCueId, ...this.draftState() })
      const { label: _label, selection, ...state } = entry
      void _label
      this.restoreDraftState(state)
      this.selectedCueId = selection
      this.markChanged(`redo:${entry.label}`)
    },
    updateCue(id: string, patch: Partial<Cue>, historyLabel = 'update-cue') {
      this.commit(historyLabel, (state) => {
        const cue = state.cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        const timeChanged = (patch.start !== undefined && patch.start !== cue.start) || (patch.end !== undefined && patch.end !== cue.end)
        Object.assign(cue, patch)
        // 时间码改动后，该台词在所有语言稿中回到待确认
        if (timeChanged) this.invalidateCueTimes(state, id)
      })
    },
    /** 时间码改动：受影响语言的匹配回到待确认，保留原译文由校对员重新指定 */
    invalidateCueTimes(state: DraftState, cueId: string) {
      const cue = state.cues.find((item) => item.id === cueId)
      if (!cue) return
      for (const draft of state.drafts) {
        const status = cue.targetStatus[draft.id]
        const hasText = Boolean(cue.targets[draft.id])
        if (status === 'matched' || hasText) {
          cue.targetStatus[draft.id] = 'pending'
          if (!state.pendingItems.some((item) => item.draftId === draft.id && item.cueId === cueId)) {
            state.pendingItems.push({
              id: makeId('pending'),
              draftId: draft.id,
              cueId,
              reason: 'time-changed',
            })
          }
        }
      }
    },
    markStatus(id: string, status: CueStatus) {
      this.updateCue(id, { status }, `status:${status}`)
    },
    toggleLock(id: string) {
      this.updateCue(id, { locked: !this.document.cues.find((cue) => cue.id === id)?.locked }, 'toggle-lock')
    },
    splitCue(id: string) {
      const source = this.document.cues.find((cue) => cue.id === id)
      if (!source || source.locked) return
      const middle = Number((source.start + (source.end - source.start) * 0.5).toFixed(2))
      const sourceMid = Math.max(1, Math.round(source.source.length / 2))
      const secondId = makeId('cue')
      this.commit('split', (state) => {
        const index = state.cues.findIndex((cue) => cue.id === id)
        const cue = state.cues[index]
        const second: Cue = {
          ...clone(cue),
          id: secondId,
          start: middle,
          source: cue.source.slice(sourceMid).trim(),
          targets: {},
          targetStatus: {},
          status: 'draft',
          locked: false,
        }
        cue.end = middle
        cue.source = cue.source.slice(0, sourceMid).trim()
        for (const draft of state.drafts) {
          const text = cue.targets[draft.id] ?? ''
          const targetMid = Math.max(1, Math.round(text.length / 2))
          if (text) {
            second.targets[draft.id] = text.slice(targetMid).trim()
            cue.targets[draft.id] = text.slice(0, targetMid).trim()
          }
          // 拆分改变了两条台词的时间码与边界，两个语言稿都回到待确认
          cue.targetStatus[draft.id] = 'pending'
          second.targetStatus[draft.id] = 'pending'
          state.pendingItems.push({ id: makeId('pending'), draftId: draft.id, cueId: cue.id, reason: 'time-changed' })
          state.pendingItems.push({ id: makeId('pending'), draftId: draft.id, cueId: secondId, reason: 'time-changed' })
        }
        state.cues.splice(index + 1, 0, second)
      }, secondId)
    },
    mergeNext(id: string) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const current = this.document.cues[index]
      const next = this.document.cues[index + 1]
      if (!current || !next || current.locked || next.locked) return
      const removedId = next.id
      this.commit('merge', (state) => {
        const itemIndex = state.cues.findIndex((cue) => cue.id === id)
        const item = state.cues[itemIndex]
        const following = state.cues[itemIndex + 1]
        item.end = following.end
        item.source = `${item.source} ${following.source}`.trim()
        item.termIds = [...new Set([...item.termIds, ...following.termIds])]
        for (const draft of state.drafts) {
          const left = item.targets[draft.id] ?? ''
          const right = following.targets[draft.id] ?? ''
          item.targets[draft.id] = `${left} ${right}`.trim()
          // 合并改变时间码：回到待确认
          item.targetStatus[draft.id] = 'pending'
          if (!state.pendingItems.some((pending) => pending.draftId === draft.id && pending.cueId === id)) {
            state.pendingItems.push({ id: makeId('pending'), draftId: draft.id, cueId: id, reason: 'time-changed' })
          }
        }
        // 清理指向被删台词的待确认项与游离条目挂接信息
        state.pendingItems = state.pendingItems.filter((pending) => {
          if (pending.cueId === removedId) {
            pending.cueId = undefined
            pending.reason = pending.reason === 'missing' ? 'offset' : pending.reason
          }
          return true
        })
        state.cues.splice(itemIndex + 1, 1)
      }, id)
    },
    moveCue(id: string, direction: -1 | 1) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= this.document.cues.length) return
      this.commit('move', (state) => {
        const [item] = state.cues.splice(index, 1)
        state.cues.splice(target, 0, item)
      }, id)
    },
    deleteCue(id: string) {
      const cue = this.document.cues.find((item) => item.id === id)
      if (!cue || cue.locked) return
      this.commit('delete', (state) => {
        const index = state.cues.findIndex((item) => item.id === id)
        if (index >= 0) state.cues.splice(index, 1)
        // 指向该台词的缺句/时码待确认项转为游离条目，由校对员改派
        state.pendingItems.forEach((pending) => {
          if (pending.cueId === id) {
            pending.cueId = undefined
            if (pending.reason === 'missing') pending.reason = 'offset'
          }
        })
      }, state0(this.document.cues, id))
    },
    createSnapshot(name: string) {
      const snapshot: Snapshot = {
        id: makeId('snapshot'),
        name: name.trim() || `v${this.document.snapshots.length + 1}`,
        createdAt: Date.now(),
        ...this.draftState(),
      }
      this.document.snapshots.unshift(snapshot)
      this.markChanged('snapshot', true)
    },
    restoreSnapshot(id: string) {
      const snapshot = this.document.snapshots.find((item) => item.id === id)
      if (!snapshot) return
      this.past.push({ label: 'restore-snapshot', selection: this.selectedCueId, ...this.draftState() })
      this.future = []
      this.restoreDraftState({
        cues: clone(snapshot.cues),
        drafts: clone(snapshot.drafts),
        looseEntries: clone(snapshot.looseEntries ?? []),
        pendingItems: clone(snapshot.pendingItems ?? []),
        activeDraftId: snapshot.activeDraftId ?? null,
      })
      this.selectedCueId = this.document.cues[0]?.id ?? null
      this.markChanged('restore-snapshot')
    },
    /** 导入底稿（首个 SRT / 剧本）：替换台词原文，保留已建语言稿 */
    importText(text: string, filename: string) {
      const lower = filename.toLowerCase()
      const cues = lower.endsWith('.srt') ? parseSrt(text) : parseScript(text, this.document.actors)
      if (!cues.length) throw new Error('EMPTY_IMPORT')
      this.commit('import', (state) => {
        // 重新导入底稿后，原匹配全部失效，各语言稿整体回到待确认
        for (const cue of cues) {
          for (const draft of state.drafts) {
            cue.targets[draft.id] = ''
            cue.targetStatus[draft.id] = 'empty'
          }
        }
        state.cues.splice(0, state.cues.length, ...cues)
        state.looseEntries = []
        state.pendingItems = []
        for (const draft of state.drafts) {
          for (const cue of cues) {
            state.pendingItems.push({ id: makeId('pending'), draftId: draft.id, cueId: cue.id, reason: 'missing' })
          }
        }
      }, cues[0].id)
      return cues.length
    },
    /**
     * 导入某一语言的译稿 SRT：按起止时间和顺序与底稿匹配。
     * 一一对应自动归入；一对多 / 缺句 / 时码偏移列入待确认。
     */
    importDraftSrt(text: string, draftLanguage: string, label: string) {
      const entries = parseSrtEntries(text)
      if (!entries.length) throw new Error('EMPTY_IMPORT')
      const draftId = this.document.drafts.find((draft) => draft.language === draftLanguage)?.id ?? makeId('draft')
      let matchedCount = 0
      let pendingCount = 0
      this.commit('import-draft', (state) => {
        let draft = state.drafts.find((item) => item.id === draftId)
        if (!draft) {
          draft = { id: draftId, language: draftLanguage, label: label || draftLanguage, importedAt: Date.now() }
          state.drafts.push(draft)
        } else {
          draft.importedAt = Date.now()
          if (label) draft.label = label
        }
        // 清空该语言旧数据
        state.looseEntries = state.looseEntries.filter((entry) => entry.draftId !== draftId)
        state.pendingItems = state.pendingItems.filter((item) => item.draftId !== draftId)
        for (const cue of state.cues) {
          delete cue.targets[draftId]
          cue.targetStatus[draftId] = 'empty'
        }
        const result = matchTranslations(clone(entries), state.cues, draftId)
        for (const cue of state.cues) cue.targetStatus[draftId] = 'empty'
        for (const [cueId, value] of result.matched) {
          const cue = state.cues.find((item) => item.id === cueId)
          if (cue) {
            cue.targets[draftId] = value
            cue.targetStatus[draftId] = 'matched'
          }
        }
        state.looseEntries.push(...result.looseEntries)
        state.pendingItems.push(...result.pending)
        state.activeDraftId = draftId
        matchedCount = result.matched.size
        pendingCount = result.pending.length
      }, this.document.cues[0]?.id ?? null)
      return { count: entries.length, matched: matchedCount, pending: pendingCount, draftId }
    },
    /** 校对员把游离译文条目指定给某条台词 */
    assignPending(itemId: string, cueId: string) {
      this.commit('assign-pending', (state) => {
        const item = state.pendingItems.find((pending) => pending.id === itemId)
        if (!item) return
        const entry = item.entryId ? state.looseEntries.find((loose) => loose.id === item.entryId) : undefined
        const cue = state.cues.find((target) => target.id === cueId)
        if (!cue) return
        if (entry) {
          cue.targets[item.draftId] = entry.text
          state.looseEntries = state.looseEntries.filter((loose) => loose.id !== entry.id)
        }
        cue.targetStatus[item.draftId] = 'matched'
        // 同一台词同语言若还有缺句待确认，视为已由本次指派解决
        state.pendingItems = state.pendingItems.filter((pending) => {
          if (pending.id === item.id) return false
          if (pending.draftId === item.draftId && pending.cueId === cueId && (pending.reason === 'missing' || pending.reason === 'time-changed')) return false
          return true
        })
      })
    },
    /** 确认时码改动后的原译文仍属于该台词 */
    confirmPending(itemId: string) {
      this.commit('confirm-pending', (state) => {
        const item = state.pendingItems.find((pending) => pending.id === itemId)
        if (!item || !item.cueId) return
        const cue = state.cues.find((target) => target.id === item.cueId)
        if (!cue) return
        cue.targetStatus[item.draftId] = cue.targets[item.draftId] ? 'matched' : 'empty'
        state.pendingItems = state.pendingItems.filter((pending) => pending.id !== itemId)
      })
    },
    /** 缺句：确认该台词在这一语言稿中无译文 */
    markEmpty(itemId: string) {
      this.commit('mark-empty', (state) => {
        const item = state.pendingItems.find((pending) => pending.id === itemId)
        if (!item || !item.cueId) return
        const cue = state.cues.find((target) => target.id === item.cueId)
        if (!cue) return
        cue.targets[item.draftId] = ''
        cue.targetStatus[item.draftId] = 'empty'
        state.pendingItems = state.pendingItems.filter((pending) => pending.id !== itemId)
      })
    },
    /** 缺句：从游离译文中挑一条补到该台词 */
    attachLooseEntry(itemId: string, entryId: string) {
      this.commit('attach-entry', (state) => {
        const item = state.pendingItems.find((pending) => pending.id === itemId)
        const entry = state.looseEntries.find((loose) => loose.id === entryId && loose.draftId === item?.draftId)
        if (!item || !item.cueId || !entry) return
        const cue = state.cues.find((target) => target.id === item.cueId)
        if (!cue) return
        cue.targets[item.draftId] = entry.text
        cue.targetStatus[item.draftId] = 'matched'
        state.looseEntries = state.looseEntries.filter((loose) => loose.id !== entry.id)
        state.pendingItems = state.pendingItems.filter((pending) => pending.id !== item.id && pending.entryId !== entry.id)
      })
    },
    /** 放弃游离译文条目 */
    discardPending(itemId: string) {
      this.commit('discard-pending', (state) => {
        const item = state.pendingItems.find((pending) => pending.id === itemId)
        if (!item) return
        if (item.entryId) state.looseEntries = state.looseEntries.filter((entry) => entry.id !== item.entryId)
        state.pendingItems = state.pendingItems.filter((pending) => pending.id !== itemId)
      })
    },
    updateTarget(id: string, text: string) {
      const draftId = this.document.activeDraftId
      if (!draftId) return
      this.commit('target-text', (state) => {
        const cue = state.cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        cue.targets[draftId] = text
        if (text && cue.targetStatus[draftId] !== 'matched') {
          // 手动录入译文：解决缺句/时码待确认
          state.pendingItems = state.pendingItems.filter(
            (item) => !(item.draftId === draftId && item.cueId === id && (item.reason === 'missing' || item.reason === 'time-changed')),
          )
          if (!state.pendingItems.some((item) => item.draftId === draftId && item.cueId === id)) {
            cue.targetStatus[draftId] = 'matched'
          }
        }
        if (!text && cue.targetStatus[draftId] === 'matched') cue.targetStatus[draftId] = 'empty'
      })
    },
    /** 导出前检查：空译文与未处理待确认项 */
    exportIssues(draftId: string | null): ExportIssues {
      const pendingIds = this.document.pendingItems.filter((item) => !draftId || item.draftId === draftId).map((item) => item.id)
      if (!draftId) return { emptyCueIds: [], pendingIds }
      const emptyCueIds = this.document.cues
        .filter((cue) => !cue.targets[draftId])
        .map((cue) => cue.id)
      return { emptyCueIds, pendingIds }
    },
    exportSrt(draftId: string | null) {
      const blob = new Blob([toSrt(this.document.cues, draftId)], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      const draft = this.document.drafts.find((item) => item.id === draftId)
      const suffix = draft ? `-${draft.language}` : ''
      anchor.download = `${this.document.title || 'subtitle'}${suffix}.srt`
      anchor.click()
      URL.revokeObjectURL(url)
    },
  },
})

const state0 = (cues: Cue[], removedId: string) =>
  cues[Math.max(0, cues.findIndex((item) => item.id === removedId) - 1)]?.id ?? null
