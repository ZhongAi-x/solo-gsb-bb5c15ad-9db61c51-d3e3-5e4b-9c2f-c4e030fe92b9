/**
 * 批量证词导入 DSL。
 *
 * 支持三类语句（每行一条，名称与备注均为 JSON 字符串，支持 JSON 转义）：
 *
 *   EVENT "名称" [| "备注"]
 *   REL   "A" earlier|later "B" min..max
 *   OBS   "事件" start..end
 *
 * - 空行及以 # 开头的注释行被忽略；
 * - 先完整解析为只读预览（含逐行定位的错误），任一错误都禁止写入；
 * - 引用可指向现有事件或同批 EVENT：同批重名 / 与现有事件重名、
 *   现有事件本身重名（引用不唯一）、引用缺失、非法区间与非法时间格式
 *   都会定位到原始行号。
 */
import type { Constraint, TimeObservation, TEvent } from '../types'
import { uid } from './samples'

// ==================== 解析结果类型 ====================

/** 解析得到的 EVENT 语句（预览态，尚未分配持久化 id） */
export interface ParsedEventItem {
  kind: 'event'
  line: number
  name: string
  note: string
  /** 同批 EVENT 首次声明的行号（非首条声明时不等于 line） */
  firstLine: number
  /** 名称与现有事件重名（预览中标记，禁止写入） */
  existing: boolean
}

/** 解析得到的 REL 语句（预览态） */
export interface ParsedConstraintItem {
  kind: 'constraint'
  line: number
  aName: string
  relation: 'earlier' | 'later'
  bName: string
  min: number
  max: number
  /** 引用是否解析到同批 EVENT（否则为现有事件）；存在错误时仍可能为 true */
  aIsNew: boolean
  bIsNew: boolean
  /** 与同批更早一条 REL 完全重复（重复声明） */
  duplicate: boolean
}

/** 解析得到的 OBS 语句（预览态） */
export interface ParsedObservationItem {
  kind: 'observation'
  line: number
  eventName: string
  start: string
  end: string
  eventIsNew: boolean
  /** 与同批更早一条 OBS 完全重复（重复声明） */
  duplicate: boolean
}

export type ParsedItem = ParsedEventItem | ParsedConstraintItem | ParsedObservationItem

/** 定位到原始行的解析错误 */
export interface ImportError {
  line: number
  message: string
}

/** 一次 DSL 解析的完整只读结果（不包含任何持久化 id） */
export interface ImportParseResult {
  /** 全部非空非注释语句，按原文行序排列 */
  items: ParsedItem[]
  events: ParsedEventItem[]
  constraints: ParsedConstraintItem[]
  observations: ParsedObservationItem[]
  /** 全部错误，按行号升序；非空时禁止写入 */
  errors: ImportError[]
  /** 输入中是否存在任何非空非注释语句 */
  hasInput: boolean
}

/** 解析成功后可一次性合并进 AppState 的批次（已分配新 id、不触碰现有数据） */
export interface ImportBatch {
  events: TEvent[]
  constraints: Constraint[]
  observations: TimeObservation[]
}

// ==================== 词法分析 ====================

const JSON_STRING_ERROR_HINTS: Array<[RegExp, string]> = [
  [/^Unexpected end of JSON input/i, '字符串缺少结束引号'],
  [/^Unexpected token /i, '非法转义或字符串内容'],
  [/^Unexpected non-whitespace character/i, '字符串内容不合法'],
]

/**
 * 单行词法分析器：按顺序消费「JSON 字符串 / 单词 / 区间 / 竖线 / 空格」，
 * 所有格式错误都记录到本行错误列表并返回失败（调用方随即放弃本行）。
 */
class LineTokenizer {
  pos = 0

  constructor(
    readonly text: string,
    private readonly pushError: (message: string) => void,
  ) {}

  fail(message: string): false {
    this.pushError(message)
    return false
  }

  skipSpaces(): void {
    while (this.pos < this.text.length && (this.text[this.pos] === ' ' || this.text[this.pos] === '\t')) this.pos++
  }

  atEnd(): boolean {
    this.skipSpaces()
    return this.pos >= this.text.length
  }

  /** 不移动位置地判断后面是否还有非空白内容 */
  hasMore(): boolean {
    for (let i = this.pos; i < this.text.length; i++) {
      if (this.text[i] !== ' ' && this.text[i] !== '\t') return true
    }
    return false
  }

  /** 消费一个字面量标点（前后允许空格） */
  consumePunct(punct: string): boolean {
    this.skipSpaces()
    if (this.text.startsWith(punct, this.pos)) {
      this.pos += punct.length
      return true
    }
    return this.fail(`应为 "${punct}"`)
  }

  /** 要求当前位置与上一个 token 之间至少有一个空格 / 制表符分隔 */
  requireSpace(): boolean {
    const before = this.pos
    this.skipSpaces()
    if (this.pos > before) return true
    return this.fail('与前一部分之间需要空格分隔')
  }

  /** 读取一个 JSON 字符串字面量（双引号、JSON 转义），返回解码后的值 */
  readJsonString(): string | null {
    this.skipSpaces()
    if (this.text[this.pos] !== '"') {
      this.fail('应为 JSON 字符串（以英文双引号开头，如 "名称"）')
      return null
    }
    const start = this.pos
    this.pos++ // 跳过开头引号
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]
      if (ch === '\\') {
        this.pos += 2 // \" \\ \/ \b \f \n \r \t \uXXXX
        continue
      }
      if (ch === '"') {
        this.pos++ // 跳过结尾引号
        const raw = this.text.slice(start, this.pos)
        try {
          const value = JSON.parse(raw)
          if (typeof value !== 'string') {
            this.fail('JSON 字符串解码结果不是字符串')
            return null
          }
          return value
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e)
          let hint = '非法的 JSON 字符串'
          for (const [re, msg] of JSON_STRING_ERROR_HINTS) {
            if (re.test(detail)) {
              hint = msg
              break
            }
          }
          this.fail(`${hint}：${detail}`)
          return null
        }
      }
      this.pos++
    }
    this.fail('字符串缺少结束引号')
    return null
  }

  /** 读取一个无空格单词（如 earlier / later） */
  readWord(): string | null {
    this.skipSpaces()
    const start = this.pos
    while (this.pos < this.text.length && this.text[this.pos] !== ' ' && this.text[this.pos] !== '\t') this.pos++
    const word = this.text.slice(start, this.pos)
    if (!word) {
      this.fail('缺少内容')
      return null
    }
    return word
  }

  /** 读取剩余内容直到行尾，去掉首尾空格（用于区间 start..end 或检测多余内容） */
  readRemainder(): string {
    const rest = this.text.slice(this.pos).trim()
    this.pos = this.text.length
    return rest
  }
}

/** 解析一个 `min..max` 形式的非负整数区间（.. 两侧允许空格） */
function parseMinMax(rest: string): { min: number; max: number } | null {
  const m = /^(-?\d+)\s*\.\.\s*(-?\d+)$/.exec(rest)
  if (!m) return null
  const min = Number(m[1])
  const max = Number(m[2])
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null
  return { min, max }
}

/**
 * 校验绝对时间并归一化为 datetime-local 格式 yyyy-MM-ddTHH:mm（本地时间分量）。
 * 接受 `YYYY-MM-DDTHH:mm` 与 `YYYY-MM-DD HH:mm` 两种写法（分钟精度），
 * 通过 Date.UTC 往返校验拒绝 2026-02-30 等不存在的日期。
 */
export function parseDslDateTime(input: string): string | null {
  const m = /^(\d{4,})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(input)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const hour = Number(m[4])
  const minute = Number(m[5])
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null
  // 真实存在性校验（闰年 / 大小月）
  const ms = Date.UTC(year, month - 1, day, hour, minute)
  const d = new Date(ms)
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day ||
    d.getUTCHours() !== hour ||
    d.getUTCMinutes() !== minute
  ) {
    return null
  }
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`
}

// ==================== 逐行解析 ====================

type RawConstraint = Omit<ParsedConstraintItem, 'aIsNew' | 'bIsNew' | 'duplicate'>
type RawObservation = Omit<ParsedObservationItem, 'eventIsNew' | 'duplicate'>

function parseEventBody(line: number, body: string, pushError: (m: string) => void): ParsedEventItem | null {
  const tk = new LineTokenizer(body, pushError)
  const name = tk.readJsonString()
  if (name === null) return null
  const trimmedName = name.trim()
  if (!trimmedName) {
    pushError('EVENT 名称不能为空')
    return null
  }
  let note = ''
  if (!tk.atEnd()) {
    tk.skipSpaces()
    if (tk.text[tk.pos] !== '|') {
      pushError(`EVENT 语句存在无法识别的多余内容："${tk.readRemainder()}"（备注前需要用 | 分隔）`)
      return null
    }
    tk.pos++ // 消费 |
    const noteValue = tk.readJsonString()
    if (noteValue === null) return null
    note = noteValue.trim()
  }
  if (!tk.atEnd()) {
    pushError(`EVENT 语句存在无法识别的多余内容："${tk.readRemainder()}"`)
    return null
  }
  return { kind: 'event', line, name: trimmedName, note, firstLine: line, existing: false }
}

function parseConstraintBody(line: number, body: string, pushError: (m: string) => void): RawConstraint | null {
  const tk = new LineTokenizer(body, pushError)
  const aName = tk.readJsonString()
  if (aName === null) return null
  if (!aName.trim()) {
    pushError('REL 事件 A 的名称不能为空')
    return null
  }
  if (!tk.requireSpace()) return null
  const relWord = tk.readWord()
  if (relWord === null) return null
  if (relWord !== 'earlier' && relWord !== 'later') {
    pushError(`关系必须为 earlier 或 later，实际为 "${relWord}"`)
    return null
  }
  if (!tk.requireSpace()) return null
  const bName = tk.readJsonString()
  if (bName === null) return null
  if (!bName.trim()) {
    pushError('REL 事件 B 的名称不能为空')
    return null
  }
  if (!tk.hasMore()) {
    pushError('REL 语句缺少时间区间：应为 "A" earlier|later "B" min..max')
    return null
  }
  if (!tk.requireSpace()) return null
  const rangeText = tk.readRemainder()
  const range = parseMinMax(rangeText)
  if (!range) {
    const shown = rangeText || '（空）'
    pushError(`非法区间 “${shown}”：应为 min..max 形式的非负整数，如 5..15`)
    return null
  }
  if (range.min < 0) {
    pushError(`非法区间 ${range.min}..${range.max}：最小值不能为负数`)
    return null
  }
  if (range.min > range.max) {
    pushError(`非法区间 ${range.min}..${range.max}：最小值 ${range.min} 大于最大值 ${range.max}`)
    return null
  }
  return {
    kind: 'constraint',
    line,
    aName: aName.trim(),
    relation: relWord,
    bName: bName.trim(),
    min: range.min,
    max: range.max,
  }
}

function parseObservationBody(line: number, body: string, pushError: (m: string) => void): RawObservation | null {
  const tk = new LineTokenizer(body, pushError)
  const eventName = tk.readJsonString()
  if (eventName === null) return null
  if (!eventName.trim()) {
    pushError('OBS 事件名称不能为空')
    return null
  }
  if (!tk.hasMore()) {
    pushError('OBS 语句缺少时间区间：应为 "事件" start..end')
    return null
  }
  if (!tk.requireSpace()) return null
  const rest = tk.readRemainder()
  const sepIdx = rest.indexOf('..')
  if (sepIdx < 0) {
    pushError(`OBS 缺少时间区间分隔符 ".."：应为 "事件" start..end`)
    return null
  }
  const startText = rest.slice(0, sepIdx).trim()
  const endText = rest.slice(sepIdx + 2).trim()
  if (!startText || !endText) {
    pushError('OBS 时间区间不完整：起点与终点都必须填写')
    return null
  }
  if (endText.includes('..')) {
    pushError(`OBS 时间区间存在多余的 ".."："${rest}"`)
    return null
  }
  const start = parseDslDateTime(startText)
  if (!start) {
    pushError(`非法时间格式 "${startText}"：应为 YYYY-MM-DDTHH:mm（如 2026-09-20T08:30）`)
    return null
  }
  // 终点在合法时间之后还带有空格 / 多余 token 时，单独给出更明确的定位
  const endDateTimeMatch = /^(\d{4,}-\d{2}-\d{2}[T ]\d{2}:\d{2})/.exec(endText)
  const endPrefix = endDateTimeMatch?.[1] ?? null
  const end = endPrefix ? parseDslDateTime(endPrefix.replace(' ', 'T')) : null
  if (!end) {
    pushError(`非法时间格式 "${endText}"：应为 YYYY-MM-DDTHH:mm（如 2026-09-20T09:00）`)
    return null
  }
  if (endPrefix !== null && endText.length > endPrefix.length) {
    pushError(`OBS 语句存在无法识别的多余内容："${endText.slice(endPrefix.length).trim()}"`)
    return null
  }
  if (new Date(end).getTime() < new Date(start).getTime()) {
    pushError(`非法观测区间：终点 ${end} 早于起点 ${start}`)
    return null
  }
  return { kind: 'observation', line, eventName: eventName.trim(), start, end }
}

// ==================== 整体解析 ====================

/**
 * 把多行 DSL 完整解析为只读预览。
 * @param text 原始多行文本
 * @param existingEvents 当前已持久化的事件（引用可指向它们）
 */
export function parseImportDsl(text: string, existingEvents: readonly TEvent[]): ImportParseResult {
  const lines = text.split(/\r\n|\r|\n/)
  const errors: ImportError[] = []
  const pushError = (line: number) => (message: string) => errors.push({ line, message })

  const events: ParsedEventItem[] = []
  const rawConstraints: RawConstraint[] = []
  const rawObservations: RawObservation[] = []
  let hasInput = false

  // —— 第一遍：逐行做词法 / 语法解析 ——
  lines.forEach((rawLine, idx) => {
    const line = idx + 1
    const trimmed = rawLine.trim()
    if (!trimmed) return // 忽略空行
    if (trimmed.startsWith('#')) return // 忽略整行注释
    hasInput = true

    const spaceIdx = trimmed.search(/\s/)
    const keyword = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx)
    const body = spaceIdx < 0 ? '' : trimmed.slice(spaceIdx + 1).trimStart()
    const fail = pushError(line)

    if (keyword === 'EVENT') {
      if (!body) {
        fail('EVENT 语句缺少名称：EVENT "名称" [| "备注"]')
        return
      }
      const ev = parseEventBody(line, body, fail)
      if (ev) events.push(ev)
    } else if (keyword === 'REL') {
      if (!body) {
        fail('REL 语句缺少内容：REL "A" earlier|later "B" min..max')
        return
      }
      const c = parseConstraintBody(line, body, fail)
      if (c) rawConstraints.push(c)
    } else if (keyword === 'OBS') {
      if (!body) {
        fail('OBS 语句缺少内容：OBS "事件" start..end')
        return
      }
      const o = parseObservationBody(line, body, fail)
      if (o) rawObservations.push(o)
    } else {
      fail(`未知语句类型 "${keyword}"：仅支持 EVENT / REL / OBS（关键字需大写）`)
    }
  })

  // —— 第二遍：名称表（现有事件 + 同批 EVENT），用于引用解析 ——
  const batchByName = new Map<string, { firstLine: number; count: number }>()
  for (const ev of events) {
    const entry = batchByName.get(ev.name)
    if (entry) {
      ev.firstLine = entry.firstLine
      entry.count++
    } else {
      batchByName.set(ev.name, { firstLine: ev.line, count: 1 })
    }
  }
  const existingByName = new Map<string, number>()
  existingEvents.forEach((ev) => {
    existingByName.set(ev.name, (existingByName.get(ev.name) ?? 0) + 1)
  })

  /** 解析一个事件引用名：返回是否同批新事件；任何歧义 / 缺失都定位到引用行 */
  const resolveName = (name: string, line: number): { isNew: boolean } | null => {
    const batch = batchByName.get(name)
    const existingCount = existingByName.get(name) ?? 0
    if (batch && batch.count > 1) {
      errors.push({
        line,
        message: `引用不唯一：事件 "${name}" 在本批中被重复声明（首次在第 ${batch.firstLine} 行）`,
      })
      return null
    }
    if (batch && existingCount > 0) {
      errors.push({
        line,
        message: `引用不唯一：事件 "${name}" 既在第 ${batch.firstLine} 行声明，又已存在于当前数据中（导入不覆盖现有数据，请改名后再试）`,
      })
      return null
    }
    if (existingCount > 1) {
      errors.push({ line, message: `引用不唯一：当前数据中已有 ${existingCount} 个名为 "${name}" 的事件` })
      return null
    }
    if (batch) return { isNew: true }
    if (existingCount === 1) return { isNew: false }
    errors.push({ line, message: `引用的事件 "${name}" 不存在：请先在本批中用 EVENT 声明，或使用已有事件名` })
    return null
  }

  // —— EVENT 重名 / 重复声明 ——
  for (const ev of events) {
    if (ev.firstLine !== ev.line) {
      errors.push({
        line: ev.line,
        message: `重复声明事件 "${ev.name}"：本批第 ${ev.firstLine} 行已声明过同名事件`,
      })
    } else if ((existingByName.get(ev.name) ?? 0) > 0) {
      ev.existing = true
      errors.push({
        line: ev.line,
        message: `事件 "${ev.name}" 与现有数据重名：导入不会覆盖现有事件，请改名后再试`,
      })
    }
  }

  // —— REL：引用解析、自引用与重复声明 ——
  const seenConstraints = new Set<string>()
  const constraints: ParsedConstraintItem[] = rawConstraints.map((c) => {
    const a = resolveName(c.aName, c.line)
    const b = resolveName(c.bName, c.line)
    const item: ParsedConstraintItem = {
      ...c,
      aIsNew: a?.isNew ?? batchByName.has(c.aName),
      bIsNew: b?.isNew ?? batchByName.has(c.bName),
      duplicate: false,
    }
    if (a && b && c.aName === c.bName) {
      errors.push({ line: c.line, message: `REL 语句的两个事件不能相同（"${c.aName}"）` })
    }
    const key = JSON.stringify([c.aName, c.relation, c.bName, c.min, c.max])
    if (seenConstraints.has(key)) {
      item.duplicate = true
      errors.push({ line: c.line, message: `重复声明约束：与本批中更早的一条 REL 完全相同` })
    } else {
      seenConstraints.add(key)
    }
    return item
  })

  // —— OBS：引用解析与重复声明 ——
  const seenObservations = new Set<string>()
  const observations: ParsedObservationItem[] = rawObservations.map((o) => {
    const ref = resolveName(o.eventName, o.line)
    const item: ParsedObservationItem = {
      ...o,
      eventIsNew: ref?.isNew ?? batchByName.has(o.eventName),
      duplicate: false,
    }
    const key = JSON.stringify([o.eventName, o.start, o.end])
    if (seenObservations.has(key)) {
      item.duplicate = true
      errors.push({ line: o.line, message: `重复声明观测：与本批中更早的一条 OBS 完全相同` })
    } else {
      seenObservations.add(key)
    }
    return item
  })

  // 统一按行号升序，保证预览与错误列表行序稳定（同类型内部仍保持声明顺序）
  errors.sort((x, y) => x.line - y.line || (x.message < y.message ? -1 : x.message > y.message ? 1 : 0))

  const items: ParsedItem[] = [
    ...events,
    ...constraints,
    ...observations,
  ].sort((x, y) => x.line - y.line)

  return { items, events, constraints, observations, errors, hasInput }
}

/**
 * 把解析成功（无任何错误）的结果转为可合并批次：
 * 为全部同批新事件分配 id，约束与观测引用映射到新事件或现有事件的 id。
 * 返回 null 表示存在错误或没有任何可导入内容。
 */
export function buildImportBatch(
  parsed: ImportParseResult,
  existingEvents: readonly TEvent[],
): ImportBatch | null {
  if (parsed.errors.length > 0) return null

  // 现有事件名 → id（解析阶段已保证引用唯一）
  const nameToId = new Map<string, string>()
  for (const ev of existingEvents) {
    if (!nameToId.has(ev.name)) nameToId.set(ev.name, ev.id)
  }

  const events: TEvent[] = []
  for (const ev of parsed.events) {
    const id = uid('ev')
    nameToId.set(ev.name, id)
    events.push({ id, name: ev.name, note: ev.note || undefined })
  }

  const constraints: Constraint[] = parsed.constraints.map((c) => ({
    id: uid('ct'),
    aId: nameToId.get(c.aName) as string,
    bId: nameToId.get(c.bName) as string,
    relation: c.relation,
    min: c.min,
    max: c.max,
    enabled: true,
  }))

  const obsList: TimeObservation[] = parsed.observations.map((o) => ({
    id: uid('obs'),
    eventId: nameToId.get(o.eventName) as string,
    start: o.start,
    end: o.end,
  }))

  if (events.length === 0 && constraints.length === 0 && obsList.length === 0) return null
  return { events, constraints, observations: obsList }
}
