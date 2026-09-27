import { defineStore } from 'pinia'
import type { Cue, CueTranslation, EditorDocument, HistoryEntry, Locale, PendingItem, Snapshot } from '../types'
import { loadDocument, saveDocument } from '../utils/db'
import { makeId } from '../utils/id'
import { parseScript, parseSrt, parseSrtEntries, toSrt } from '../utils/subtitle'
import { matchImport } from '../utils/match'
import { translate, type MessageKey } from '../i18n'

const DOCUMENT_ID = 'subtitle-dubbing-document'
let saveTimer: ReturnType<typeof setTimeout> | undefined
let channel: BroadcastChannel | undefined

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const cloneCues = (cues: Cue[]): Cue[] => clone(cues)
const clonePending = (items: PendingItem[]): PendingItem[] => clone(items)
const plainDocument = (document: EditorDocument): EditorDocument => clone(document)

/** 兼容旧版数据：单一 target 字段迁移为按语言保存的译文 */
const migrateCue = (cue: Cue & { target?: string }): void => {
  if (!cue.translations) cue.translations = {}
  if (typeof cue.target === 'string') {
    if (cue.target.trim() && !Object.keys(cue.translations).length) {
      cue.translations.zh = { text: cue.target, state: 'confirmed' }
    }
    delete cue.target
  }
}

const migrateDocument = (document: EditorDocument): EditorDocument => {
  document.targetLanguages ??= []
  document.pendingItems ??= []
  document.cues.forEach(migrateCue)
  document.snapshots?.forEach((snapshot) => {
    snapshot.pendingItems ??= []
    snapshot.cues.forEach(migrateCue)
  })
  if (!document.targetLanguages.length) {
    const languages = new Set<string>()
    document.cues.forEach((cue) => Object.keys(cue.translations).forEach((lang) => languages.add(lang)))
    document.targetLanguages = [...languages]
  }
  return document
}

const zh = (text: string): Record<string, CueTranslation> => ({ zh: { text, state: 'confirmed' } })

const createDefaultDocument = (): EditorDocument => ({
  id: DOCUMENT_ID,
  title: '纪录片《开源之路》中文配音',
  language: 'zh-CN',
  targetLanguages: ['zh'],
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
  cues: [
    { id: 'cue-demo-01', start: 0, end: 4.2, source: '开源并不是一项孤立的技术，而是一种持续协作的方式。', translations: zh('开源并不是一项孤立的技术，而是一种持续协作的方式。'), actorId: 'actor-narrator', speed: 1.02, termIds: ['term-01'], status: 'reviewed', locked: true },
    { id: 'cue-demo-02', start: 4.3, end: 8.6, source: '今天，我们邀请林博士谈谈社区维护者每天面对的选择。', translations: zh('今天，我们邀请林博士谈谈社区维护者每天面对的选择。'), actorId: 'actor-host', speed: 1, termIds: ['term-04', 'term-02'], status: 'reviewed', locked: false },
    { id: 'cue-demo-03', start: 8.8, end: 13.5, source: '每个拉取请求背后，都有一段需要被理解的上下文。', translations: zh('每个拉取请求背后，都有一段需要被理解的上下文。'), actorId: 'actor-lin', speed: 0.96, termIds: ['term-03'], status: 'reviewed', locked: false },
    { id: 'cue-demo-04', start: 13.7, end: 18.8, source: '请您先介绍一次印象最深的代码评审。', translations: zh('请您先介绍一次印象最深的代码评审。'), actorId: 'actor-host', speed: 1.03, termIds: [], status: 'draft', locked: false },
    { id: 'cue-demo-05', start: 19, end: 25.1, source: '那次修改很小，却让新用户第一次能够顺利完成安装。', translations: zh('那次修改很小，却让新用户第一次顺利完成安装。'), actorId: 'actor-lin', speed: 0.98, termIds: [], status: 'issue', locked: false },
    { id: 'cue-demo-06', start: 25.4, end: 31.2, source: '所以我们决定把安装说明拆开，并为每个平台补上验证步骤。', translations: zh('因此，我们拆分安装说明，并为每个平台补上验证步骤。'), actorId: 'actor-chen', speed: 1.05, termIds: [], status: 'draft', locked: false },
  ],
  pendingItems: [],
  snapshots: [],
})

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict'

export const useEditorStore = defineStore('subtitle-editor', {
  state: () => ({
    document: createDefaultDocument(),
    selectedCueId: 'cue-demo-03' as string | null,
    activeTargetLang: 'zh',
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
    visibleCues(state): Cue[] {
      return state.actorFilter === 'all'
        ? state.document.cues
        : state.document.cues.filter((cue) => cue.actorId === state.actorFilter)
    },
    totalDuration(state): number {
      return Math.max(10, ...state.document.cues.map((cue) => cue.end)) * 1.04
    },
    openPendingItems(state): PendingItem[] {
      return state.document.pendingItems
        .filter((item) => !item.resolved)
        .sort((a, b) => a.createdAt - b.createdAt || (a.importedIndex ?? 0) - (b.importedIndex ?? 0))
    },
    openPendingCount(): number {
      return this.openPendingItems.length
    },
    /** 导出前检查：指定语言的空译文、待确认译文和未处理的归属项 */
    exportIssues(state) {
      return (language: string) => {
        const empty: string[] = []
        const pending: string[] = []
        for (const cue of state.document.cues) {
          const translation = cue.translations[language]
          if (!translation || !translation.text.trim()) empty.push(cue.id)
          else if (translation.state === 'pending') pending.push(cue.id)
        }
        const openItems = state.document.pendingItems.filter((item) => item.language === language && !item.resolved)
        return { empty, pending, openItems }
      }
    },
  },
  actions: {
    async initialize() {
      if (this.initialized) return
      this.online = navigator.onLine
      const stored = await loadDocument(DOCUMENT_ID)
      if (stored) {
        this.document = migrateDocument(stored)
        this.lastSeenRevision = stored.revision
      } else {
        const saved = await saveDocument(plainDocument(this.document))
        this.document = saved
        this.lastSeenRevision = saved.revision
      }
      this.ensureActiveLanguage()
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
          const latest = await loadDocument(DOCUMENT_ID)
          if (latest && latest.revision > this.lastSeenRevision) {
            this.document = migrateDocument(latest)
            this.lastSeenRevision = latest.revision
            this.saveState = 'saved'
            this.ensureActiveLanguage()
          }
        }
      }
    },
    ensureActiveLanguage() {
      if (!this.document.targetLanguages.includes(this.activeTargetLang)) {
        this.activeTargetLang = this.document.targetLanguages[0] ?? 'zh'
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
    setActiveTargetLang(language: string) {
      this.activeTargetLang = language
    },
    commit(label: string, mutate: (cues: Cue[], pendingItems: PendingItem[]) => void, nextSelection?: string | null) {
      const beforeCues = cloneCues(this.document.cues)
      const beforePending = clonePending(this.document.pendingItems)
      const workingCues = cloneCues(this.document.cues)
      const workingPending = clonePending(this.document.pendingItems)
      mutate(workingCues, workingPending)
      this.past.push({ label, cues: beforeCues, pendingItems: beforePending, selectedCueId: this.selectedCueId })
      if (this.past.length > 60) this.past.shift()
      this.future = []
      this.document.cues = workingCues
      this.document.pendingItems = workingPending
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
      this.document = migrateDocument(latest)
      this.lastSeenRevision = latest.revision
      this.conflict = false
      this.saveState = 'saved'
      this.selectedCueId = latest.cues[0]?.id ?? null
      this.ensureActiveLanguage()
    },
    undo() {
      const entry = this.past.pop()
      if (!entry) return
      this.future.push({ label: entry.label, cues: cloneCues(this.document.cues), pendingItems: clonePending(this.document.pendingItems), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.document.pendingItems = clonePending(entry.pendingItems)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`undo:${entry.label}`)
    },
    redo() {
      const entry = this.future.pop()
      if (!entry) return
      this.past.push({ label: entry.label, cues: cloneCues(this.document.cues), pendingItems: clonePending(this.document.pendingItems), selectedCueId: this.selectedCueId })
      this.document.cues = cloneCues(entry.cues)
      this.document.pendingItems = clonePending(entry.pendingItems)
      this.selectedCueId = entry.selectedCueId
      this.markChanged(`redo:${entry.label}`)
    },
    updateCue(id: string, patch: Partial<Cue>, historyLabel = 'update-cue') {
      this.commit(historyLabel, (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        Object.assign(cue, patch)
        // 时间码改动后，该台词已有译文全部回到待确认
        if (patch.start !== undefined || patch.end !== undefined) {
          for (const translation of Object.values(cue.translations)) {
            if (translation.text.trim()) translation.state = 'pending'
          }
        }
      })
    },
    updateTranslation(id: string, language: string, text: string) {
      this.commit('translation', (cues) => {
        const cue = cues.find((item) => item.id === id)
        if (!cue || cue.locked) return
        cue.translations[language] = { text, state: 'confirmed' }
      })
    },
    markStatus(id: string, status: Cue['status']) {
      this.updateCue(id, { status }, `status:${status}`)
    },
    toggleLock(id: string) {
      this.updateCue(id, { locked: !this.document.cues.find((cue) => cue.id === id)?.locked }, 'toggle-lock')
    },
    splitCue(id: string) {
      const source = this.document.cues.find((cue) => cue.id === id)
      if (!source || source.locked) return
      const ratio = 0.5
      const middle = Number((source.start + (source.end - source.start) * ratio).toFixed(2))
      const sourceMid = Math.max(1, Math.round(source.source.length * ratio))
      const secondId = makeId('cue')
      this.commit('split', (cues) => {
        const index = cues.findIndex((cue) => cue.id === id)
        const cue = cues[index]
        const firstTranslations: Record<string, CueTranslation> = {}
        const secondTranslations: Record<string, CueTranslation> = {}
        for (const [language, translation] of Object.entries(cue.translations)) {
          if (!translation.text.trim()) continue
          const mid = Math.max(1, Math.round(translation.text.length * ratio))
          firstTranslations[language] = { text: translation.text.slice(0, mid).trim(), state: 'pending' }
          secondTranslations[language] = { text: translation.text.slice(mid).trim(), state: 'pending' }
        }
        const second: Cue = {
          ...cue,
          id: secondId,
          start: middle,
          source: cue.source.slice(sourceMid).trim(),
          translations: secondTranslations,
          status: 'draft',
          locked: false,
        }
        cue.end = middle
        cue.source = cue.source.slice(0, sourceMid).trim()
        cue.translations = firstTranslations
        cue.status = 'draft'
        cues.splice(index + 1, 0, second)
      }, secondId)
    },
    mergeNext(id: string) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const current = this.document.cues[index]
      const next = this.document.cues[index + 1]
      if (!current || !next || current.locked || next.locked) return
      this.commit('merge', (cues) => {
        const item = cues[index]
        const following = cues[index + 1]
        item.end = following.end
        item.source = `${item.source} ${following.source}`.trim()
        const languages = new Set([...Object.keys(item.translations), ...Object.keys(following.translations)])
        for (const language of languages) {
          const first = item.translations[language]?.text ?? ''
          const second = following.translations[language]?.text ?? ''
          if (!first.trim() && !second.trim()) continue
          item.translations[language] = { text: `${first} ${second}`.trim(), state: 'pending' }
        }
        item.termIds = [...new Set([...item.termIds, ...following.termIds])]
        item.status = 'draft'
        cues.splice(index + 1, 1)
      }, id)
    },
    moveCue(id: string, direction: -1 | 1) {
      const index = this.document.cues.findIndex((cue) => cue.id === id)
      const target = index + direction
      if (index < 0 || target < 0 || target >= this.document.cues.length) return
      this.commit('move', (cues) => {
        const [item] = cues.splice(index, 1)
        cues.splice(target, 0, item)
      }, id)
    },
    deleteCue(id: string) {
      const cue = this.document.cues.find((item) => item.id === id)
      if (!cue || cue.locked) return
      this.commit('delete', (cues, pendingItems) => {
        const index = cues.findIndex((item) => item.id === id)
        if (index >= 0) cues.splice(index, 1)
        for (let i = pendingItems.length - 1; i >= 0; i -= 1) {
          const item = pendingItems[i]
          if (item.reason === 'missing' && item.cueId === id) {
            pendingItems.splice(i, 1)
            continue
          }
          item.candidateCueIds = item.candidateCueIds.filter((cueId) => cueId !== id)
          if (item.cueId === id) item.cueId = item.candidateCueIds[0] ?? null
        }
      }, this.document.cues[Math.max(0, this.document.cues.findIndex((item) => item.id === id) - 1)]?.id ?? null)
    },
    createSnapshot(name: string) {
      const snapshot: Snapshot = {
        id: makeId('snapshot'),
        name: name.trim() || `v${this.document.snapshots.length + 1}`,
        createdAt: Date.now(),
        cues: cloneCues(this.document.cues),
        pendingItems: clonePending(this.document.pendingItems),
      }
      this.document.snapshots.unshift(snapshot)
      this.markChanged('snapshot', true)
    },
    restoreSnapshot(id: string) {
      const snapshot = this.document.snapshots.find((item) => item.id === id)
      if (!snapshot) return
      this.past.push({ label: 'restore-snapshot', cues: cloneCues(this.document.cues), pendingItems: clonePending(this.document.pendingItems), selectedCueId: this.selectedCueId })
      this.future = []
      this.document.cues = cloneCues(snapshot.cues)
      this.document.pendingItems = clonePending(snapshot.pendingItems ?? [])
      this.selectedCueId = this.document.cues[0]?.id ?? null
      this.markChanged('restore-snapshot')
    },
    /** 底稿导入：替换全部台词与译文 */
    importText(text: string, filename: string) {
      const lower = filename.toLowerCase()
      const cues = lower.endsWith('.srt') ? parseSrt(text) : parseScript(text, this.document.actors)
      if (!cues.length) throw new Error('EMPTY_IMPORT')
      this.commit('import', (current, pendingItems) => {
        current.splice(0, current.length, ...cues)
        pendingItems.splice(0, pendingItems.length)
      }, cues[0].id)
      return cues.length
    },
    /** 译文导入：按起止时间和顺序匹配，一一对应自动归入，其余列为待确认 */
    importTranslation(text: string, language: string) {
      const entries = parseSrtEntries(text)
      if (!entries.length) throw new Error('EMPTY_IMPORT')
      const { assignments, pending, matchedCueIds } = matchImport(this.document.cues, entries, language)
      const now = Date.now()
      // 已被某个待确认导入行列为候选的台词不再重复生成缺句项
      const candidateIds = new Set(pending.flatMap((item) => item.candidateCueIds))
      const missing: PendingItem[] = this.document.cues
        .filter((cue) => !matchedCueIds.has(cue.id) && !candidateIds.has(cue.id) && !cue.translations[language]?.text.trim())
        .map((cue) => ({
          id: makeId('pending'),
          language,
          reason: 'missing' as const,
          importedIndex: null,
          importedStart: null,
          importedEnd: null,
          importedText: null,
          cueId: cue.id,
          candidateCueIds: [],
          resolved: false,
          createdAt: now,
        }))
      this.commit('import-translation', (cues, pendingItems) => {
        for (let i = pendingItems.length - 1; i >= 0; i -= 1) {
          if (pendingItems[i].language === language) pendingItems.splice(i, 1)
        }
        for (const { entry, cueId } of assignments) {
          const cue = cues.find((item) => item.id === cueId)
          if (cue) cue.translations[language] = { text: entry.text, state: 'confirmed' }
        }
        pendingItems.push(...pending, ...missing)
      })
      if (!this.document.targetLanguages.includes(language)) this.document.targetLanguages.push(language)
      this.activeTargetLang = language
      return { auto: assignments.length, pending: pending.length + missing.length }
    },
    /** 校对员把待确认的导入行归入指定台词 */
    resolvePendingAssign(pendingId: string, cueId: string) {
      const item = this.document.pendingItems.find((entry) => entry.id === pendingId)
      if (!item || item.resolved || item.importedText == null) return
      this.commit('pending-assign', (cues, pendingItems) => {
        const cue = cues.find((entry) => entry.id === cueId)
        if (!cue) return
        cue.translations[item.language] = { text: item.importedText as string, state: 'confirmed' }
        for (const entry of pendingItems) {
          if (entry.id === pendingId) entry.resolved = true
          else if (!entry.resolved && entry.reason === 'missing' && entry.language === item.language && entry.cueId === cueId) entry.resolved = true
        }
      })
    },
    /** 校对员把一条未归入的导入行指定给缺句台词 */
    resolveMissingWithImport(missingId: string, sourcePendingId: string) {
      const missing = this.document.pendingItems.find((entry) => entry.id === missingId)
      const source = this.document.pendingItems.find((entry) => entry.id === sourcePendingId)
      if (!missing || !source || missing.resolved || source.resolved || !missing.cueId || source.importedText == null) return
      this.commit('pending-assign', (cues, pendingItems) => {
        const cue = cues.find((entry) => entry.id === missing.cueId)
        if (!cue) return
        cue.translations[source.language] = { text: source.importedText as string, state: 'confirmed' }
        const missingItem = pendingItems.find((entry) => entry.id === missingId)
        const sourceItem = pendingItems.find((entry) => entry.id === sourcePendingId)
        if (missingItem) missingItem.resolved = true
        if (sourceItem) sourceItem.resolved = true
      })
    },
    /** 忽略待确认项：导入行丢弃，或缺句保持空白 */
    resolvePendingDismiss(pendingId: string) {
      this.commit('pending-dismiss', (_cues, pendingItems) => {
        const entry = pendingItems.find((item) => item.id === pendingId)
        if (entry) entry.resolved = true
      })
    },
    exportSrt(language: string) {
      const blob = new Blob([toSrt(this.document.cues, language)], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${this.document.title || 'subtitle'}.${language}.srt`
      anchor.click()
      URL.revokeObjectURL(url)
    },
  },
})
