import type { Cue, ImportedEntry } from '../types'
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

/** 解析 SRT 为轻量条目（保留文件内顺序），供译文匹配导入使用 */
export const parseSrtEntries = (text: string): ImportedEntry[] => {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/)
  const entries: ImportedEntry[] = []
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean)
    const timeLineIndex = lines.findIndex((line) => line.includes('-->'))
    if (timeLineIndex < 0) continue
    const [from, to] = lines[timeLineIndex].split('-->').map((part) => part.trim().split(' ')[0])
    const content = lines.slice(timeLineIndex + 1).join('\n').trim()
    if (!content) continue
    entries.push({ index: entries.length + 1, start: parseTime(from), end: parseTime(to), text: content })
  }
  return entries
}

const emptyCue = (start: number, end: number, source: string, actorId: string): Cue => ({
  id: makeId('cue'),
  start,
  end,
  source,
  translations: {},
  actorId,
  speed: 1,
  termIds: [],
  status: 'draft',
  locked: false,
})

export const parseSrt = (text: string, actorId = 'actor-narrator'): Cue[] =>
  parseSrtEntries(text).map((entry) => emptyCue(entry.start, entry.end, entry.text, actorId))

export const parseScript = (text: string, actors: { id: string; name: string }[]): Cue[] => {
  const lines = text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.map((line, index) => {
    const match = line.match(/^([^：:]{1,18})[：:]\s*(.+)$/)
    const actorName = match?.[1]?.trim()
    const content = match?.[2]?.trim() || line
    const actor = actors.find((item) => item.name === actorName) ?? actors[0]
    return emptyCue(index * 4, index * 4 + 3.5, content, actor?.id ?? 'actor-narrator')
  })
}

/** 导出指定语言的 SRT；无译文时回退为原文（涉及项会在导出前单独提示） */
export const toSrt = (cues: Cue[], language: string): string =>
  [...cues]
    .sort((a, b) => a.start - b.start)
    .map((cue, index) => {
      const text = cue.translations[language]?.text.trim() || cue.source
      return `${index + 1}\n${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${text}`
    })
    .join('\n\n') + '\n'
