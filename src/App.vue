<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Clock, Delete, DocumentCopy, Download, EditPen, Files, Lock, MagicStick, Monitor,
  RefreshLeft, RefreshRight, Search, Unlock, UploadFilled, Warning,
} from '@element-plus/icons-vue'
import { useEditorStore, DRAFT_PRESETS, guessDraftLanguage } from './store/editor'
import type { Cue, CueConflict, PendingItem, TargetEntry, TargetLinkStatus } from './types'
import type { MessageKey } from './i18n'
import { formatTime } from './utils/subtitle'

const store = useEditorStore()
const { document: project, selectedCue, selectedCueId, visibleCues, saveState, conflict, online, timelineZoom, actorFilter } = storeToRefs(store)
const fileInput = ref<HTMLInputElement>()
const snapshotDialog = ref(false)
const snapshotName = ref('')
const search = ref('')

// 译稿导入
const draftDialog = ref(false)
const draftFileInput = ref<HTMLInputElement>()
const draftLanguage = ref('en-US')
const draftFileName = ref('')
const draftText = ref('')

// 导出前检查
const exportDialog = ref(false)
const exportEmpty = ref<string[]>([])
const exportPending = ref<string[]>([])

// 待确认面板中各行临时选择的归属
const assignChoice = ref<Record<string, string>>({})
const attachChoice = ref<Record<string, string>>({})

const activeDraftId = computed(() => project.value.activeDraftId)
const activeDraftSelect = computed({
  get: () => project.value.activeDraftId ?? 'base',
  set: (value: string) => store.setActiveDraft(value === 'base' ? null : value),
})

const targetOf = (cue: Cue): string => store.targetText(cue)
const linkStatusOf = (cue: Cue): TargetLinkStatus | undefined => store.targetStatusOf(cue)

const filteredCues = computed(() => {
  const query = search.value.trim().toLowerCase()
  const list = visibleCues.value
  if (!query) return list
  return list.filter((cue) => `${cue.source} ${cue.targets[project.value.activeDraftId ?? ''] ?? ''}`.toLowerCase().includes(query))
})
const selectedTarget = computed(() => (selectedCue.value ? targetOf(selectedCue.value) : ''))
const selectedWarnings = computed(() => selectedCue.value ? cueWarnings(selectedCue.value) : [])
const selectedTermMismatches = computed(() => selectedCue.value ? termMismatches(selectedCue.value) : [])
const totalCharacters = computed(() =>
  project.value.cues.reduce((sum, cue) => sum + cue.source.length + (cue.targets[project.value.activeDraftId ?? '']?.length ?? 0), 0))
const saveLabel = computed(() => ({
  saved: store.t('saved'), dirty: store.t('dirty'), saving: store.t('saving'), conflict: store.t('conflict'),
}[saveState.value]))
const actorColor = (id: string) => project.value.actors.find((actor) => actor.id === id)?.color ?? '#6d7b91'
const actorName = (id: string) => project.value.actors.find((actor) => actor.id === id)?.name ?? '—'
const statusLabel = (status: Cue['status']) => store.t(status)
const statusType = (status: Cue['status']) => status === 'reviewed' ? 'success' : status === 'issue' ? 'danger' : 'info'

const linkTagType = (status?: TargetLinkStatus) => status === 'matched' ? 'success' : status === 'pending' ? 'warning' : 'info'
const linkTagLabel = (status?: TargetLinkStatus) =>
  status === 'matched' ? store.t('statusMatched') : status === 'pending' ? store.t('statusPending') : store.t('statusEmpty')

/** 当前视图下的待确认项：底稿视图显示全部语言稿，语言稿视图只显示该语言 */
const pendingItemsView = computed<PendingItem[]>(() =>
  activeDraftId.value
    ? project.value.pendingItems.filter((item) => item.draftId === activeDraftId.value)
    : project.value.pendingItems,
)

const reasonLabelMap: Record<PendingItem['reason'], MessageKey> = {
  ambiguous: 'reasonAmbiguous',
  missing: 'reasonMissing',
  offset: 'reasonOffset',
  'time-changed': 'reasonTimeChanged',
}
const reasonLabel = (reason: PendingItem['reason']) => store.t(reasonLabelMap[reason])
const reasonTagType = (reason: PendingItem['reason']) =>
  reason === 'ambiguous' ? 'danger' : reason === 'missing' ? 'warning' : reason === 'offset' ? 'info' : 'warning'

const cueIndex = (cueId?: string) => project.value.cues.findIndex((cue) => cue.id === cueId)
const cueRef = (cueId?: string) => {
  const index = cueIndex(cueId)
  return index < 0 ? '' : store.t('cueRef', { index: index + 1 })
}
const cueShort = (cueId?: string) => {
  const cue = project.value.cues.find((item) => item.id === cueId)
  return cue ? `${cueRef(cueId)} · ${formatTime(cue.start)}` : ''
}
const entryOf = (item: PendingItem): TargetEntry | undefined =>
  project.value.looseEntries.find((entry) => entry.id === item.entryId)
const draftOf = (draftId: string) => project.value.drafts.find((draft) => draft.id === draftId)
const looseEntriesFor = (item: PendingItem) => project.value.looseEntries.filter((entry) => entry.draftId === item.draftId)

function updateSelected(patch: Partial<Cue>, label = 'update-cue') {
  if (selectedCue.value) store.updateCue(selectedCue.value.id, patch, label)
}
function updateTarget(text: string) {
  if (selectedCue.value) store.updateTarget(selectedCue.value.id, text)
}
function tone(text: string) {
  const polite = (text.match(/您|请|劳驾|麻烦|敬请/g) ?? []).length
  const casual = (text.match(/你|咱们|[？?]$/g) ?? []).length
  if (polite > casual) return 'polite'
  if (casual > polite) return 'casual'
  return 'neutral'
}
function addressee(text: string) {
  const matches = text.match(/林博士|陈工|主持人|博士|老师|先生|女士|团队/g)
  return matches?.[0] ?? ''
}
function cueWarnings(cue: Cue): CueConflict[] {
  const index = project.value.cues.findIndex((item) => item.id === cue.id)
  const previous = project.value.cues[index - 1]
  const next = project.value.cues[index + 1]
  const warnings: CueConflict[] = []
  if (!previous) return warnings
  if (previous.actorId !== cue.actorId) warnings.push({ cueId: cue.id, type: 'actor', message: store.t('actorSwitch', { from: actorName(previous.actorId), to: actorName(cue.actorId) }) })
  const fromTone = tone(targetOf(previous) || previous.source)
  const currentTone = tone(targetOf(cue) || cue.source)
  if (fromTone !== 'neutral' && currentTone !== 'neutral' && fromTone !== currentTone) warnings.push({ cueId: cue.id, type: 'tone', message: store.t('toneSwitch', { from: fromTone, to: currentTone }) })
  const fromAddress = addressee(previous.source)
  const currentAddress = addressee(cue.source)
  if (fromAddress && currentAddress && fromAddress !== currentAddress) warnings.push({ cueId: cue.id, type: 'address', message: store.t('speakerSwitch', { from: fromAddress, to: currentAddress }) })
  if (!next) return warnings
  return warnings
}
function termMismatches(cue: Cue) {
  const target = targetOf(cue)
  return project.value.terms.filter((term) => cue.termIds.includes(term.id) && target && !target.includes(term.target))
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const count = store.importText(await file.text(), file.name)
    ElMessage.success(store.t('importDone', { count }))
  } catch {
    ElMessage.error(store.t('importError'))
  } finally {
    input.value = ''
  }
}
function openDraftDialog() {
  if (!project.value.cues.length) {
    ElMessage.warning(store.t('importDraftBase'))
    return
  }
  draftFileName.value = ''
  draftText.value = ''
  draftLanguage.value = project.value.activeDraftId
    ? draftOf(activeDraftId.value!)?.language ?? 'en-US'
    : guessDraftLanguage('')
  draftDialog.value = true
  nextTick(() => draftFileInput.value?.click())
}
async function onDraftFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  draftText.value = await file.text()
  draftFileName.value = file.name
  draftLanguage.value = guessDraftLanguage(file.name)
}
function confirmDraftImport() {
  if (!draftText.value) {
    ElMessage.error(store.t('importError'))
    return
  }
  try {
    const result = store.importDraftSrt(draftText.value, draftLanguage.value, '')
    ElMessage.success(store.t('draftImportDone', {
      language: draftLanguage.value,
      matched: result.matched,
      pending: result.pending,
    }))
    draftDialog.value = false
  } catch {
    ElMessage.error(store.t('importError'))
  }
}
function doAssign(item: PendingItem) {
  const cueId = assignChoice.value[item.id]
  if (!cueId) return
  store.assignPending(item.id, cueId)
  delete assignChoice.value[item.id]
}
function doAttach(item: PendingItem) {
  const entryId = attachChoice.value[item.id]
  if (!entryId) return
  store.attachLooseEntry(item.id, entryId)
  delete attachChoice.value[item.id]
}
function requestDelete(id: string) {
  ElMessageBox.confirm(store.t('confirmDelete'), { type: 'warning', confirmButtonText: store.t('delete') })
    .then(() => store.deleteCue(id))
    .catch(() => undefined)
}
function createSnapshot() {
  store.createSnapshot(snapshotName.value)
  snapshotName.value = ''
  snapshotDialog.value = false
  ElMessage.success(store.t('savedNow'))
}
function requestExport() {
  const issues = store.exportIssues(activeDraftId.value)
  if (!issues.emptyCueIds.length && !issues.pendingIds.length) {
    store.exportSrt(activeDraftId.value)
    return
  }
  exportEmpty.value = issues.emptyCueIds
  exportPending.value = issues.pendingIds
  exportDialog.value = true
}
function confirmExport() {
  store.exportSrt(activeDraftId.value)
  exportDialog.value = false
}
const pendingById = (id: string) => project.value.pendingItems.find((item) => item.id === id)
function pendingTagText(id: string) {
  const item = pendingById(id)
  if (!item) return store.t('looseEntryHint')
  const where = cueRef(item.cueId)
  const entry = entryOf(item)
  const tail = where || (entry ? store.t('entryLabel', { order: entry.order }) : store.t('looseEntryHint'))
  return `${reasonLabel(item.reason)} · ${tail}`
}
function jumpToPending(id: string) {
  const item = pendingById(id)
  if (item?.cueId) {
    store.selectCue(item.cueId)
    exportDialog.value = false
  }
}
function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return
  const key = event.key.toLowerCase()
  if ((event.metaKey || event.ctrlKey) && key === 'z') {
    event.preventDefault(); event.shiftKey ? store.redo() : store.undo(); return
  }
  if ((event.metaKey || event.ctrlKey) && key === 'y') { event.preventDefault(); store.redo(); return }
  const list = filteredCues.value
  const index = list.findIndex((cue) => cue.id === store.selectedCueId)
  if (key === 'j') { event.preventDefault(); store.selectCue(list[Math.min(list.length - 1, index + 1)]?.id ?? null); nextTick(() => document.querySelector('.cue-row.active')?.scrollIntoView({ block: 'nearest' })) }
  if (key === 'k') { event.preventDefault(); store.selectCue(list[Math.max(0, index - 1)]?.id ?? null); nextTick(() => document.querySelector('.cue-row.active')?.scrollIntoView({ block: 'nearest' })) }
  if ((key === 'a' || key === 's') && selectedCue.value) store.markStatus(selectedCue.value.id, 'reviewed')
  if (key === 'x' && selectedCue.value) store.markStatus(selectedCue.value.id, 'issue')
  if (key === 'l' && selectedCue.value) store.toggleLock(selectedCue.value.id)
}
function setOnline(value: boolean) {
  store.setOnline(value)
  ElMessage({ message: store.t(value ? 'online' : 'offline'), type: value ? 'success' : 'warning' })
}
onMounted(async () => {
  await store.initialize()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('online', handleOnline)
  window.addEventListener('offline', handleOffline)
  await nextTick()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('online', handleOnline)
  window.removeEventListener('offline', handleOffline)
})
const handleOnline = () => setOnline(true)
const handleOffline = () => setOnline(false)
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <div class="brand-mark"><Monitor /></div>
        <div>
          <h1>{{ store.t('appTitle') }}</h1>
          <p>{{ store.t('subtitle') }}</p>
        </div>
      </div>
      <div class="top-actions">
        <el-select v-model="activeDraftSelect" size="small" class="draft-select">
          <el-option :label="store.t('baseOnly')" value="base" />
          <el-option
            v-for="draft in project.drafts" :key="draft.id"
            :label="`${store.draftLabel(draft)}${store.pendingCount(draft.id) ? ` · ${store.t('pendingBadge', { count: store.pendingCount(draft.id) })}` : ''}`"
            :value="draft.id"
          />
        </el-select>
        <el-select v-model="project.language" size="small" class="language-select" @change="store.setLocale">
          <el-option label="简体中文" value="zh-CN" />
          <el-option label="English" value="en-US" />
          <el-option label="日本語" value="ja-JP" />
        </el-select>
        <span class="save-state" :class="saveState"><i />{{ saveLabel }}</span>
        <input ref="fileInput" class="file-input" type="file" accept=".srt,.txt,text/plain" @change="importFile" />
        <el-button :icon="UploadFilled" @click="fileInput?.click()">{{ store.t('import') }}</el-button>
        <el-button :icon="Download" @click="requestExport">{{ store.t('export') }}</el-button>
        <el-button type="primary" :icon="DocumentCopy" @click="snapshotDialog = true">{{ store.t('snapshot') }}</el-button>
      </div>
    </header>

    <div v-if="!online" class="network-banner offline">{{ store.t('offline') }}</div>

    <div v-if="conflict" class="conflict-banner">
      <div>
        <strong>{{ store.t('conflictTitle') }}</strong>
        <span>{{ store.t('conflictBody') }}</span>
      </div>
      <div class="conflict-actions">
        <el-button size="small" @click="store.loadLatest">{{ store.t('loadLatest') }}</el-button>
        <el-button size="small" type="danger" @click="store.keepMine">{{ store.t('keepMine') }}</el-button>
      </div>
    </div>

    <main class="workspace">
      <aside class="left-panel panel">
        <section>
          <div class="section-heading">
            <span><el-icon><Files /></el-icon>{{ store.t('drafts') }}</span>
            <el-button size="small" text type="primary" @click="openDraftDialog">{{ store.t('addDraft') }}</el-button>
          </div>
          <button class="actor-filter" :class="{ active: activeDraftSelect === 'base' }" @click="activeDraftSelect = 'base'">
            <span class="actor-dot all" />{{ store.t('baseOnly') }}
            <b>{{ project.cues.length }}</b>
          </button>
          <button
            v-for="draft in project.drafts" :key="draft.id"
            class="actor-filter" :class="{ active: activeDraftId === draft.id }"
            @click="store.setActiveDraft(draft.id)"
          >
            <span class="actor-dot" :class="{ pending: store.pendingCount(draft.id) > 0 }" />
            {{ store.draftLabel(draft) }}
            <b v-if="store.pendingCount(draft.id)" class="pending-count">{{ store.t('pendingBadge', { count: store.pendingCount(draft.id) }) }}</b>
          </button>
        </section>
        <section>
          <div class="section-heading">
            <span><el-icon><Files /></el-icon>{{ store.t('actors') }}</span>
            <small>{{ project.actors.length }}</small>
          </div>
          <button class="actor-filter" :class="{ active: actorFilter === 'all' }" @click="actorFilter = 'all'">
            <span class="actor-dot all" />{{ store.t('allActors') }}
            <b>{{ project.cues.length }}</b>
          </button>
          <button v-for="actor in project.actors" :key="actor.id" class="actor-filter" :class="{ active: actorFilter === actor.id }" @click="actorFilter = actor.id">
            <span class="actor-dot" :style="{ background: actor.color }" />{{ actor.name }}
            <b>{{ project.cues.filter((cue) => cue.actorId === actor.id).length }}</b>
          </button>
        </section>
        <section>
          <div class="section-heading"><span><el-icon><EditPen /></el-icon>{{ store.t('terms') }}</span><small>{{ project.terms.length }}</small></div>
          <div v-for="term in project.terms" :key="term.id" class="term-card">
            <div><b>{{ term.source }}</b><span>→ {{ term.target }}</span></div>
            <small>{{ term.note }}</small>
          </div>
          <p class="section-note">{{ store.t('termHint') }}</p>
        </section>
      </aside>

      <section class="center-panel">
        <div class="project-strip">
          <div>
            <el-input v-model="project.title" class="title-input" @input="store.markChanged('title')" />
            <div class="project-meta">
              <span>{{ store.t('cueCount', { count: project.cues.length }) }}</span>
              <span>{{ store.t('characterCount', { count: totalCharacters }) }}</span>
              <span>revision {{ project.revision }}</span>
            </div>
          </div>
          <div class="history-actions">
            <el-button-group>
              <el-button :icon="RefreshLeft" :disabled="!store.past.length" @click="store.undo">{{ store.t('undo') }}</el-button>
              <el-button :icon="RefreshRight" :disabled="!store.future.length" @click="store.redo">{{ store.t('redo') }}</el-button>
            </el-button-group>
          </div>
        </div>

        <div class="timeline-card">
          <div class="section-heading">
            <span><el-icon><Clock /></el-icon>{{ store.t('timeline') }}</span>
            <div class="zoom-control"><small>{{ store.t('zoom') }}</small><el-slider v-model="timelineZoom" :min="0.7" :max="3" :step="0.1" /></div>
          </div>
          <div class="timeline-scroll">
            <div class="timeline" :style="{ width: `${timelineZoom * 100}%` }">
              <button
                v-for="cue in filteredCues" :key="cue.id" class="timeline-block" :class="{ active: cue.id === selectedCueId, issue: cue.status === 'issue', locked: cue.locked, pending: linkStatusOf(cue) === 'pending' }"
                :style="{ left: `${(cue.start / store.totalDuration) * 100}%`, width: `${Math.max(1.8, ((cue.end - cue.start) / store.totalDuration) * 100)}%`, borderColor: actorColor(cue.actorId) }"
                :title="`${formatTime(cue.start)} · ${cue.source}`" @click="store.selectCue(cue.id)"
              ><span>{{ actorName(cue.actorId).split('/')[0] }}</span><b>{{ targetOf(cue) || cue.source }}</b></button>
              <div class="timeline-ruler"><span v-for="tick in [0, 15, 30, 45, 60]" :key="tick" :style="{ left: `${(tick / store.totalDuration) * 100}%` }">{{ tick }}s</span></div>
            </div>
          </div>
        </div>

        <div v-if="pendingItemsView.length" class="pending-card">
          <div class="section-heading">
            <span class="pending-heading"><el-icon><Warning /></el-icon>{{ store.t('pendingReview', { count: pendingItemsView.length }) }}</span>
            <el-button size="small" text type="primary" @click="openDraftDialog">{{ store.t('addDraft') }}</el-button>
          </div>
          <div v-for="item in pendingItemsView" :key="item.id" class="pending-row">
            <div class="pending-info">
              <el-tag size="small" :type="reasonTagType(item.reason)">{{ reasonLabel(item.reason) }}</el-tag>
              <el-tag v-if="!activeDraftId" size="small" effect="plain">{{ draftOf(item.draftId) ? store.draftLabel(draftOf(item.draftId)!) : item.draftId }}</el-tag>
              <div v-if="entryOf(item)" class="pending-entry">
                <b>{{ store.t('entryLabel', { order: entryOf(item)!.order }) }}</b>
                <code>{{ item.detail }}</code>
                <p>{{ entryOf(item)!.text }}</p>
              </div>
              <div v-else-if="item.cueId" class="pending-entry">
                <b>{{ cueShort(item.cueId) }}</b>
              </div>
              <div v-else class="pending-entry">
                <b>{{ store.t('looseEntryHint') }}</b>
                <code>{{ item.detail }}</code>
              </div>
            </div>
            <div class="pending-actions">
              <template v-if="entryOf(item)">
                <el-select
                  :model-value="assignChoice[item.id] ?? ''" size="small" class="assign-select"
                  :placeholder="store.t('assignToCue')"
                  @change="(value: string) => assignChoice[item.id] = value"
                >
                  <el-option
                    v-for="(cue, ci) in project.cues" :key="cue.id"
                    :label="`${store.t('cueRef', { index: ci + 1 })} · ${formatTime(cue.start)} · ${cue.source.slice(0, 18)}`"
                    :value="cue.id"
                  />
                </el-select>
                <el-button size="small" type="primary" :disabled="!assignChoice[item.id]" @click="doAssign(item)">{{ store.t('assign') }}</el-button>
                <el-button size="small" text @click="store.discardPending(item.id)">{{ store.t('discardEntry') }}</el-button>
              </template>
              <template v-else-if="item.reason === 'missing'">
                <el-select
                  :model-value="attachChoice[item.id] ?? ''" size="small" class="assign-select"
                  :placeholder="store.t('assignToCue')"
                  @change="(value: string) => attachChoice[item.id] = value"
                >
                  <el-option
                    v-for="entry in looseEntriesFor(item)" :key="entry.id"
                    :label="`${store.t('entryLabel', { order: entry.order })} · ${formatTime(entry.start)} · ${entry.text.slice(0, 18)}`"
                    :value="entry.id"
                  />
                </el-select>
                <el-button size="small" type="primary" :disabled="!attachChoice[item.id]" @click="doAttach(item)">{{ store.t('assign') }}</el-button>
                <el-button size="small" @click="store.markEmpty(item.id)">{{ store.t('markEmpty') }}</el-button>
              </template>
              <template v-else-if="item.reason === 'time-changed'">
                <el-button size="small" type="primary" @click="store.confirmPending(item.id)">{{ store.t('confirmLink') }}</el-button>
                <el-button size="small" @click="store.markEmpty(item.id)">{{ store.t('markEmpty') }}</el-button>
              </template>
            </div>
          </div>
        </div>

        <div class="cue-toolbar">
          <div class="section-heading"><span>{{ store.t('cues') }}</span><el-tag size="small" type="info">{{ filteredCues.length }}</el-tag></div>
          <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索原文或译文" class="cue-search" />
          <el-select v-model="actorFilter" class="actor-mobile-filter">
            <el-option :label="store.t('allActors')" value="all" />
            <el-option v-for="actor in project.actors" :key="actor.id" :label="actor.name" :value="actor.id" />
          </el-select>
        </div>

        <div class="cue-list">
          <article
            v-for="(cue, index) in filteredCues" :key="cue.id" class="cue-row" :class="{ active: cue.id === selectedCueId, issue: cue.status === 'issue', locked: cue.locked }"
            tabindex="0" @click="store.selectCue(cue.id)" @keydown.enter="store.selectCue(cue.id)"
          >
            <div class="cue-number">{{ String(index + 1).padStart(2, '0') }}</div>
            <div class="cue-main">
              <div class="cue-topline">
                <span class="actor-pill" :style="{ '--actor': actorColor(cue.actorId) }">{{ actorName(cue.actorId) }}</span>
                <code>{{ formatTime(cue.start) }} → {{ formatTime(cue.end) }}</code>
                <el-tag size="small" :type="statusType(cue.status)">{{ statusLabel(cue.status) }}</el-tag>
                <el-tag v-if="activeDraftId" size="small" :type="linkTagType(linkStatusOf(cue))">{{ linkTagLabel(linkStatusOf(cue)) }}</el-tag>
                <el-icon v-if="cue.locked"><Lock /></el-icon>
                <span class="cue-warning-count" v-if="cueWarnings(cue).length">{{ cueWarnings(cue).length }} context</span>
              </div>
              <p class="source-text">{{ cue.source }}</p>
              <p v-if="activeDraftId" class="target-text" :class="{ empty: !targetOf(cue) }">{{ targetOf(cue) || store.t('emptyTarget') }}</p>
            </div>
            <div class="cue-quick-actions">
              <el-button size="small" text :icon="MagicStick" @click.stop="store.splitCue(cue.id)">{{ store.t('split') }}</el-button>
              <el-button size="small" text :icon="Files" @click.stop="store.mergeNext(cue.id)">{{ store.t('merge') }}</el-button>
              <el-button size="small" text :icon="Delete" @click.stop="requestDelete(cue.id)" />
            </div>
          </article>
          <div v-if="!filteredCues.length" class="empty-state">{{ store.t('empty') }}</div>
        </div>
      </section>

      <aside class="right-panel panel">
        <div class="section-heading">
          <span><el-icon><EditPen /></el-icon>{{ store.t('inspector') }}</span>
          <span v-if="selectedCue" class="cue-index">#{{ project.cues.findIndex((cue) => cue.id === selectedCue?.id) + 1 }}</span>
        </div>
        <div v-if="selectedCue" class="inspector">
          <template v-if="selectedCue.locked">
            <div class="locked-note"><el-icon><Lock /></el-icon>{{ store.t('locked') }}</div>
          </template>
          <div v-if="activeDraftId" class="draft-inspector-line">
            <el-tag size="small" :type="linkTagType(linkStatusOf(selectedCue))">{{ linkTagLabel(linkStatusOf(selectedCue)) }}</el-tag>
            <span v-if="project.drafts.find((draft) => draft.id === activeDraftId)">
              {{ store.draftLabel(project.drafts.find((draft) => draft.id === activeDraftId)!) }}
            </span>
          </div>
          <label>{{ store.t('actor') }}</label>
          <el-select :model-value="selectedCue.actorId" :disabled="selectedCue.locked" @change="updateSelected({ actorId: String($event) }, 'actor')">
            <el-option v-for="actor in project.actors" :key="actor.id" :label="actor.name" :value="actor.id" />
          </el-select>
          <div class="two-columns">
            <div><label>{{ store.t('start') }}</label><el-input-number :model-value="selectedCue.start" :disabled="selectedCue.locked" :min="0" :step="0.1" controls-position="right" @change="updateSelected({ start: Number($event) }, 'start-time')" /></div>
            <div><label>{{ store.t('end') }}</label><el-input-number :model-value="selectedCue.end" :disabled="selectedCue.locked" :min="selectedCue.start + 0.1" :step="0.1" controls-position="right" @change="updateSelected({ end: Number($event) }, 'end-time')" /></div>
          </div>
          <label>{{ store.t('source') }}</label>
          <el-input :model-value="selectedCue.source" type="textarea" :rows="4" :disabled="selectedCue.locked" @change="updateSelected({ source: String($event) }, 'source-text')" />
          <label>{{ store.t('target') }}</label>
          <el-input
            :model-value="selectedTarget" type="textarea" :rows="5"
            :disabled="selectedCue.locked || !activeDraftId"
            :placeholder="activeDraftId ? store.t('emptyTarget') : store.t('baseOnly')"
            @change="updateTarget(String($event))"
          />
          <div class="two-columns">
            <div><label>{{ store.t('speed') }}</label><el-input-number :model-value="selectedCue.speed" :disabled="selectedCue.locked" :min="0.5" :max="1.8" :step="0.01" controls-position="right" @change="updateSelected({ speed: Number($event) }, 'speed')" /></div>
            <div><label>{{ store.t('status') }}</label><el-select :model-value="selectedCue.status" :disabled="selectedCue.locked" @change="store.markStatus(selectedCue.id, $event)"><el-option :label="store.t('draft')" value="draft" /><el-option :label="store.t('reviewed')" value="reviewed" /><el-option :label="store.t('issue')" value="issue" /></el-select></div>
          </div>
          <label>{{ store.t('termsUsed') }}</label>
          <el-select :model-value="selectedCue.termIds" multiple :disabled="selectedCue.locked" @change="updateSelected({ termIds: $event }, 'terms')">
            <el-option v-for="term in project.terms" :key="term.id" :label="`${term.source} → ${term.target}`" :value="term.id" />
          </el-select>
          <div class="inspector-actions">
            <el-button :icon="selectedCue.locked ? Unlock : Lock" @click="store.toggleLock(selectedCue.id)">{{ selectedCue.locked ? store.t('unlock') : store.t('lock') }}</el-button>
            <el-button @click="store.moveCue(selectedCue.id, -1)">↑ {{ store.t('moveUp') }}</el-button>
            <el-button @click="store.moveCue(selectedCue.id, 1)">↓ {{ store.t('moveDown') }}</el-button>
          </div>

          <div class="check-card">
            <h3>{{ store.t('warnings') }}</h3>
            <p v-if="!selectedWarnings.length" class="check-ok">{{ store.t('noWarnings') }}</p>
            <p v-for="warning in selectedWarnings" :key="warning.type" class="check-warning">{{ warning.message }}</p>
            <p v-for="term in selectedTermMismatches" :key="term.id" class="check-warning">{{ store.t('termMismatch', { source: term.source, target: term.target }) }}</p>
            <p v-if="selectedCue.termIds.length && !selectedTermMismatches.length" class="check-ok">{{ store.t('noTermMismatch') }}</p>
          </div>
        </div>
        <div v-else class="empty-inspector">{{ store.t('selectHint') }}</div>
      </aside>
    </main>

    <footer class="shortcut-bar">
      <strong>{{ store.t('shortcuts') }}</strong>
      <span><kbd>J</kbd> {{ store.t('shortcutNext') }}</span>
      <span><kbd>K</kbd> {{ store.t('shortcutPrev') }}</span>
      <span><kbd>A</kbd> {{ store.t('shortcutReview') }}</span>
      <span><kbd>X</kbd> {{ store.t('shortcutIssue') }}</span>
      <span><kbd>L</kbd> {{ store.t('shortcutLock') }}</span>
      <span><kbd>Ctrl/⌘ Z</kbd> {{ store.t('shortcutUndo') }}</span>
    </footer>

    <el-dialog v-model="snapshotDialog" :title="store.t('snapshot')" width="460px">
      <el-input v-model="snapshotName" :placeholder="store.t('newSnapshotName')" @keyup.enter="createSnapshot" />
      <div class="snapshot-list">
        <div v-for="snapshot in project.snapshots" :key="snapshot.id" class="snapshot-item">
          <div><b>{{ snapshot.name }}</b><small>{{ store.t('createdAt') }} {{ new Date(snapshot.createdAt).toLocaleString() }}</small></div>
          <span>{{ store.t('cueCount', { count: snapshot.cues.length }) }}</span>
          <el-button size="small" @click="store.restoreSnapshot(snapshot.id); snapshotDialog = false">{{ store.t('restore') }}</el-button>
        </div>
        <p v-if="!project.snapshots.length" class="empty-state">{{ store.t('noSnapshots') }}</p>
      </div>
      <template #footer><el-button type="primary" @click="createSnapshot">{{ store.t('snapshot') }}</el-button></template>
    </el-dialog>

    <el-dialog v-model="draftDialog" :title="store.t('importDraftTitle')" width="520px">
      <div class="draft-dialog-body">
        <label>{{ store.t('importDraftLanguage') }}</label>
        <el-select v-model="draftLanguage">
          <el-option
            v-for="preset in DRAFT_PRESETS" :key="preset.language"
            :label="preset.labels[project.language]" :value="preset.language"
          />
        </el-select>
        <label>{{ store.t('importDraftFile') }}</label>
        <input ref="draftFileInput" class="file-input" type="file" accept=".srt,text/plain" @change="onDraftFileChange" />
        <el-button :icon="UploadFilled" @click="draftFileInput?.click()">{{ store.t('importDraftFile') }}</el-button>
        <span v-if="draftFileName" class="draft-file-name">{{ draftFileName }}</span>
        <p v-if="!project.cues.length" class="check-warning">{{ store.t('importDraftBase') }}</p>
      </div>
      <template #footer>
        <el-button @click="draftDialog = false">{{ store.t('cancel') }}</el-button>
        <el-button type="primary" :disabled="!draftText" @click="confirmDraftImport">{{ store.t('importDraftStart') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="exportDialog" :title="store.t('exportTitle', { language: activeDraftId && project.drafts.find((draft) => draft.id === activeDraftId) ? store.draftLabel(project.drafts.find((draft) => draft.id === activeDraftId)!) : store.t('baseOnly') })" width="520px">
      <p class="check-warning">
        {{ store.t('exportBlocked', { empty: exportEmpty.length, pending: exportPending.length }) }}
      </p>
      <div v-if="exportEmpty.length" class="export-list">
        <b>{{ store.t('exportEmptyTitle') }}</b>
        <el-tag
          v-for="cueId in exportEmpty" :key="cueId" size="small" type="info" class="export-tag"
          @click="store.selectCue(cueId)"
        >{{ cueRef(cueId) }}</el-tag>
      </div>
      <div v-if="exportPending.length" class="export-list">
        <b>{{ store.t('exportPendingTitle') }}</b>
        <el-tag
          v-for="itemId in exportPending" :key="itemId" size="small" :type="reasonTagType(pendingById(itemId)?.reason ?? 'offset')" class="export-tag"
          @click="jumpToPending(itemId)"
        >{{ pendingTagText(itemId) }}</el-tag>
      </div>
      <template #footer>
        <el-button @click="exportDialog = false">{{ store.t('cancel') }}</el-button>
        <el-button type="danger" @click="confirmExport">{{ store.t('exportAnyway') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>
