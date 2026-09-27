<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Clock, Delete, DocumentCopy, Download, EditPen, Files, Lock, MagicStick, Monitor,
  RefreshLeft, RefreshRight, Search, Unlock, UploadFilled, Warning,
} from '@element-plus/icons-vue'
import { useEditorStore } from './store/editor'
import type { Cue, CueConflict, PendingItem } from './types'
import { formatTime } from './utils/subtitle'
import type { MessageKey } from './i18n'

const store = useEditorStore()
const { document: project, selectedCue, selectedCueId, visibleCues, saveState, conflict, online, timelineZoom, actorFilter, activeTargetLang } = storeToRefs(store)
const fileInput = ref<HTMLInputElement>()
const snapshotDialog = ref(false)
const snapshotName = ref('')
const search = ref('')

const LANGUAGE_KEYS: Record<string, MessageKey> = { zh: 'langZh', en: 'langEn', ja: 'langJa' }
const langName = (code: string) => LANGUAGE_KEYS[code] ? store.t(LANGUAGE_KEYS[code]) : code
const translationOf = (cue: Cue) => cue.translations[activeTargetLang.value]
const translationText = (cue: Cue) => translationOf(cue)?.text.trim() ?? ''

const filteredCues = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return visibleCues.value
  return visibleCues.value.filter((cue) =>
    [cue.source, ...Object.values(cue.translations).map((item) => item.text)].join(' ').toLowerCase().includes(query))
})
const selectedWarnings = computed(() => selectedCue.value ? cueWarnings(selectedCue.value) : [])
const selectedTermMismatches = computed(() => selectedCue.value ? termMismatches(selectedCue.value) : [])
const selectedTranslation = computed(() => selectedCue.value?.translations[activeTargetLang.value])
const totalCharacters = computed(() => project.value.cues.reduce((sum, cue) => sum + cue.source.length + Object.values(cue.translations).reduce((acc, item) => acc + item.text.length, 0), 0))
const saveLabel = computed(() => ({
  saved: store.t('saved'), dirty: store.t('dirty'), saving: store.t('saving'), conflict: store.t('conflict'),
}[saveState.value]))
const actorColor = (id: string) => project.value.actors.find((actor) => actor.id === id)?.color ?? '#6d7b91'
const actorName = (id: string) => project.value.actors.find((actor) => actor.id === id)?.name ?? '—'
const statusLabel = (status: Cue['status']) => store.t(status)
const statusType = (status: Cue['status']) => status === 'reviewed' ? 'success' : status === 'issue' ? 'danger' : 'info'
const cueNumber = (id: string | null) => {
  const index = project.value.cues.findIndex((cue) => cue.id === id)
  return index >= 0 ? `#${index + 1}` : '—'
}

function updateSelected(patch: Partial<Cue>, label = 'update-cue') {
  if (!selectedCue.value) return
  const hadConfirmed = Object.values(selectedCue.value.translations).some((item) => item.text.trim() && item.state === 'confirmed')
  store.updateCue(selectedCue.value.id, patch, label)
  if (hadConfirmed && (patch.start !== undefined || patch.end !== undefined)) ElMessage.info(store.t('timecodeReset'))
}
function updateTranslation(text: string) {
  if (selectedCue.value) store.updateTranslation(selectedCue.value.id, activeTargetLang.value, String(text))
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
  const fromTone = tone(translationText(previous) || previous.source)
  const currentTone = tone(translationText(cue) || cue.source)
  if (fromTone !== 'neutral' && currentTone !== 'neutral' && fromTone !== currentTone) warnings.push({ cueId: cue.id, type: 'tone', message: store.t('toneSwitch', { from: fromTone, to: currentTone }) })
  const fromAddress = addressee(previous.source)
  const currentAddress = addressee(cue.source)
  if (fromAddress && currentAddress && fromAddress !== currentAddress) warnings.push({ cueId: cue.id, type: 'address', message: store.t('speakerSwitch', { from: fromAddress, to: currentAddress }) })
  if (!next) return warnings
  return warnings
}
function termMismatches(cue: Cue) {
  const text = translationText(cue)
  return project.value.terms.filter((term) => cue.termIds.includes(term.id) && text && !text.includes(term.target))
}

// ---- 导入：先选文件，再决定作为底稿还是按语言归入译文 ----
const importDialog = ref(false)
const importMode = ref<'base' | 'translation'>('translation')
const importLang = ref('en')
const pendingFile = ref<{ name: string; text: string } | null>(null)

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    pendingFile.value = { name: file.name, text: await file.text() }
    importMode.value = file.name.toLowerCase().endsWith('.srt') ? 'translation' : 'base'
    importDialog.value = true
  } catch {
    ElMessage.error(store.t('importError'))
  } finally {
    input.value = ''
  }
}
function confirmImport() {
  const file = pendingFile.value
  importDialog.value = false
  if (!file) return
  try {
    if (importMode.value === 'base') {
      const count = store.importText(file.text, file.name)
      ElMessage.success(store.t('importDone', { count }))
    } else {
      const result = store.importTranslation(file.text, importLang.value)
      ElMessage.success(store.t('importResult', result))
      if (result.pending > 0) pendingDrawer.value = true
    }
  } catch {
    ElMessage.error(store.t('importError'))
  }
}

// ---- 导出：按语言导出，导出前指出空译文与待确认项 ----
const exportDialog = ref(false)
const exportLang = ref('en')
const exportIssues = computed(() => store.exportIssues(exportLang.value))
const hasExportIssues = computed(() => {
  const issues = exportIssues.value
  return issues.empty.length > 0 || issues.pending.length > 0 || issues.openItems.length > 0
})
function openExport() {
  if (!project.value.targetLanguages.includes(exportLang.value)) exportLang.value = activeTargetLang.value
  exportDialog.value = true
}
function confirmExport() {
  store.exportSrt(exportLang.value)
  exportDialog.value = false
}
const pendingItemLabel = (item: PendingItem) =>
  item.importedIndex != null ? store.t('importedLine', { index: item.importedIndex }) : `${store.t('reasonMissing')} ${cueNumber(item.cueId)}`

// ---- 待确认抽屉：校对员指定归属 ----
const pendingDrawer = ref(false)
const pendingChoices = ref<Record<string, string>>({})
const openItems = computed(() => store.openPendingItems)
const openImportedLines = (language: string) => openItems.value.filter((item) => item.language === language && item.importedText != null)
const REASON_KEYS: Record<PendingItem['reason'], MessageKey> = {
  ambiguous: 'reasonAmbiguous', shifted: 'reasonShifted', unmatched: 'reasonUnmatched', missing: 'reasonMissing',
}
const reasonType = (reason: PendingItem['reason']) =>
  reason === 'ambiguous' ? 'warning' : reason === 'shifted' ? 'warning' : reason === 'unmatched' ? 'danger' : 'info'
function cueOptionLabel(id: string) {
  const index = project.value.cues.findIndex((cue) => cue.id === id)
  const cue = project.value.cues[index]
  if (!cue) return '—'
  return `#${index + 1} · ${formatTime(cue.start)} · ${cue.source.slice(0, 24)}`
}
function assignPending(item: PendingItem) {
  const choice = pendingChoices.value[item.id] ?? (item.reason === 'missing' ? '' : item.cueId ?? '')
  if (!choice) return
  if (item.reason === 'missing') store.resolveMissingWithImport(item.id, choice)
  else store.resolvePendingAssign(item.id, choice)
}
function dismissPending(item: PendingItem) {
  store.resolvePendingDismiss(item.id)
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
        <el-select v-model="project.language" size="small" class="language-select" @change="store.setLocale">
          <el-option label="简体中文" value="zh-CN" />
          <el-option label="English" value="en-US" />
          <el-option label="日本語" value="ja-JP" />
        </el-select>
        <span class="save-state" :class="saveState"><i />{{ saveLabel }}</span>
        <input ref="fileInput" class="file-input" type="file" accept=".srt,.txt,text/plain" @change="importFile" />
        <el-button :icon="UploadFilled" @click="fileInput?.click()">{{ store.t('import') }}</el-button>
        <el-badge :value="store.openPendingCount" :hidden="!store.openPendingCount" :max="99">
          <el-button :icon="Warning" @click="pendingDrawer = true">{{ store.t('pending') }}</el-button>
        </el-badge>
        <el-button :icon="Download" @click="openExport">{{ store.t('export') }}</el-button>
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
                v-for="cue in filteredCues" :key="cue.id" class="timeline-block" :class="{ active: cue.id === selectedCueId, issue: cue.status === 'issue', locked: cue.locked }"
                :style="{ left: `${(cue.start / store.totalDuration) * 100}%`, width: `${Math.max(1.8, ((cue.end - cue.start) / store.totalDuration) * 100)}%`, borderColor: actorColor(cue.actorId) }"
                :title="`${formatTime(cue.start)} · ${cue.source}`" @click="store.selectCue(cue.id)"
              ><span>{{ actorName(cue.actorId).split('/')[0] }}</span><b>{{ translationText(cue) || cue.source }}</b></button>
              <div class="timeline-ruler"><span v-for="tick in [0, 15, 30, 45, 60]" :key="tick" :style="{ left: `${(tick / store.totalDuration) * 100}%` }">{{ tick }}s</span></div>
            </div>
          </div>
        </div>

        <div class="cue-toolbar">
          <div class="section-heading"><span>{{ store.t('cues') }}</span><el-tag size="small" type="info">{{ filteredCues.length }}</el-tag></div>
          <div class="cue-toolbar-right">
            <label class="active-lang-label">{{ store.t('activeLang') }}</label>
            <el-select :model-value="activeTargetLang" class="active-lang-select" @change="store.setActiveTargetLang(String($event))">
              <el-option v-for="lang in project.targetLanguages" :key="lang" :label="langName(lang)" :value="lang" />
            </el-select>
            <el-input v-model="search" :prefix-icon="Search" clearable placeholder="搜索原文或译文" class="cue-search" />
            <el-select v-model="actorFilter" class="actor-mobile-filter">
              <el-option :label="store.t('allActors')" value="all" />
              <el-option v-for="actor in project.actors" :key="actor.id" :label="actor.name" :value="actor.id" />
            </el-select>
          </div>
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
                <el-icon v-if="cue.locked"><Lock /></el-icon>
                <span class="lang-chips">
                  <i
                    v-for="lang in project.targetLanguages" :key="lang" class="lang-chip"
                    :class="{ filled: !!cue.translations[lang]?.text.trim(), pending: !!cue.translations[lang]?.text.trim() && cue.translations[lang].state === 'pending', current: lang === activeTargetLang }"
                  >{{ lang.toUpperCase() }}</i>
                </span>
                <span class="cue-warning-count" v-if="cueWarnings(cue).length">{{ cueWarnings(cue).length }} context</span>
              </div>
              <p class="source-text">{{ cue.source }}</p>
              <p class="target-text" :class="{ empty: !translationText(cue) }">
                {{ translationText(cue) || store.t('noTranslation') }}
                <el-tag v-if="translationText(cue) && translationOf(cue)?.state === 'pending'" size="small" type="warning" class="state-tag">{{ store.t('pendingReview') }}</el-tag>
              </p>
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
          <div class="translation-heading">
            <label>{{ store.t('target') }}</label>
            <el-select :model-value="activeTargetLang" size="small" class="inspector-lang-select" @change="store.setActiveTargetLang(String($event))">
              <el-option v-for="lang in project.targetLanguages" :key="lang" :label="langName(lang)" :value="lang" />
            </el-select>
            <el-tag v-if="selectedTranslation?.text.trim()" size="small" :type="selectedTranslation.state === 'pending' ? 'warning' : 'success'">
              {{ store.t(selectedTranslation.state === 'pending' ? 'pendingReview' : 'confirmed') }}
            </el-tag>
          </div>
          <el-input :model-value="selectedTranslation?.text ?? ''" type="textarea" :rows="5" :disabled="selectedCue.locked" @change="updateTranslation" />
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

    <el-dialog v-model="importDialog" :title="store.t('importTitle')" width="520px">
      <el-radio-group v-model="importMode" class="import-mode">
        <el-radio value="translation">{{ store.t('importModeTranslation') }}</el-radio>
        <el-radio value="base">{{ store.t('importModeBase') }}</el-radio>
      </el-radio-group>
      <div v-if="importMode === 'translation'" class="dialog-row">
        <label>{{ store.t('importLanguage') }}</label>
        <el-select v-model="importLang" class="dialog-select">
          <el-option value="zh" :label="store.t('langZh')" />
          <el-option value="en" :label="store.t('langEn')" />
          <el-option value="ja" :label="store.t('langJa')" />
        </el-select>
      </div>
      <template #footer>
        <el-button @click="importDialog = false">{{ store.t('cancel') }}</el-button>
        <el-button type="primary" @click="confirmImport">{{ store.t('confirmImport') }}</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="exportDialog" :title="store.t('exportTitle')" width="560px">
      <div class="dialog-row">
        <label>{{ store.t('exportLanguage') }}</label>
        <el-select v-model="exportLang" class="dialog-select">
          <el-option v-for="lang in project.targetLanguages" :key="lang" :label="langName(lang)" :value="lang" />
        </el-select>
      </div>
      <div v-if="hasExportIssues" class="export-issues">
        <p class="export-issues-title">{{ store.t('exportIssuesFound') }}</p>
        <div v-if="exportIssues.empty.length" class="issue-group">
          <b>{{ exportIssues.empty.length }} {{ store.t('exportEmpty') }}</b>
          <span v-for="id in exportIssues.empty" :key="id" class="cue-ref">{{ cueNumber(id) }}</span>
        </div>
        <div v-if="exportIssues.pending.length" class="issue-group">
          <b>{{ exportIssues.pending.length }} {{ store.t('exportPendingState') }}</b>
          <span v-for="id in exportIssues.pending" :key="id" class="cue-ref">{{ cueNumber(id) }}</span>
        </div>
        <div v-if="exportIssues.openItems.length" class="issue-group">
          <b>{{ exportIssues.openItems.length }} {{ store.t('exportOpenItems') }}</b>
          <span v-for="item in exportIssues.openItems" :key="item.id" class="cue-ref">{{ pendingItemLabel(item) }}</span>
        </div>
      </div>
      <p v-else class="export-clean">{{ store.t('exportClean') }}</p>
      <template #footer>
        <el-button @click="exportDialog = false">{{ store.t('cancel') }}</el-button>
        <el-button :type="hasExportIssues ? 'warning' : 'primary'" @click="confirmExport">{{ hasExportIssues ? store.t('exportAnyway') : store.t('exportNow') }}</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="pendingDrawer" :title="store.t('pendingTitle')" size="460px">
      <div v-if="!openItems.length" class="empty-state">{{ store.t('pendingEmpty') }}</div>
      <div v-for="item in openItems" :key="item.id" class="pending-card">
        <div class="pending-head">
          <el-tag size="small" effect="plain">{{ langName(item.language) }}</el-tag>
          <el-tag size="small" :type="reasonType(item.reason)">{{ store.t(REASON_KEYS[item.reason]) }}</el-tag>
          <span v-if="item.importedIndex != null" class="pending-ref">{{ store.t('importedLine', { index: item.importedIndex }) }}</span>
        </div>
        <template v-if="item.importedText != null">
          <code class="pending-time">{{ formatTime(item.importedStart ?? 0) }} → {{ formatTime(item.importedEnd ?? 0) }}</code>
          <p class="pending-text">{{ item.importedText }}</p>
          <el-select
            :model-value="pendingChoices[item.id] ?? item.cueId ?? ''" :placeholder="store.t('chooseCue')" class="pending-select"
            @update:model-value="pendingChoices[item.id] = String($event)"
          >
            <el-option v-for="cue in project.cues" :key="cue.id" :label="cueOptionLabel(cue.id)" :value="cue.id" />
          </el-select>
          <div class="pending-actions">
            <el-button size="small" type="primary" @click="assignPending(item)">{{ store.t('assign') }}</el-button>
            <el-button size="small" text @click="dismissPending(item)">{{ store.t('discardLine') }}</el-button>
          </div>
        </template>
        <template v-else>
          <p class="pending-text">{{ store.t('missingFor') }}：{{ cueOptionLabel(item.cueId ?? '') }}</p>
          <el-select
            :model-value="pendingChoices[item.id] ?? ''" :placeholder="store.t('chooseLine')" class="pending-select"
            @update:model-value="pendingChoices[item.id] = String($event)"
          >
            <el-option v-for="line in openImportedLines(item.language)" :key="line.id" :label="`#${line.importedIndex} · ${(line.importedText ?? '').slice(0, 24)}`" :value="line.id" />
          </el-select>
          <div class="pending-actions">
            <el-button size="small" type="primary" :disabled="!(pendingChoices[item.id])" @click="assignPending(item)">{{ store.t('assign') }}</el-button>
            <el-button size="small" text @click="dismissPending(item)">{{ store.t('keepEmpty') }}</el-button>
          </div>
        </template>
      </div>
    </el-drawer>
  </div>
</template>
