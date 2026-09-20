import { useMemo, useState } from 'react'
import type { TEvent } from '../types'
import {
  buildImportBatch,
  parseImportDsl,
  type ImportBatch,
  type ImportParseResult,
  type ParsedConstraintItem,
  type ParsedEventItem,
  type ParsedObservationItem,
} from '../lib/import-dsl'
import { formatFullDateTime } from '../lib/format'

interface Props {
  events: TEvent[]
  /** 确认后一次性合并（仅在零错误时可调用）；合并不覆盖任何现有数据 */
  onApply: (batch: ImportBatch) => void
  /** 测试用：直接提供一份解析结果（SSR 无法触发点击解析时使用） */
  initialParsed?: ImportParseResult
}

const PLACEHOLDER = `# 以 # 开头的行会被忽略，空行同样忽略；名称 / 备注使用 JSON 字符串（支持转义）
EVENT "值班告警触发" | "监控系统 P1 告警"
EVENT "服务恢复"
REL "值班告警触发" earlier "服务恢复" 8..20
OBS "值班告警触发" 2026-09-20T08:00..2026-09-20T08:00`

export default function ImportPanel({ events, onApply, initialParsed }: Props) {
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState<ImportParseResult | null>(initialParsed ?? null)
  /** 已确认合并的批次数量提示（一次性展示后随下次解析清除） */
  const [appliedMsg, setAppliedMsg] = useState<string | null>(null)

  const canParse = text.trim().length > 0

  const doParse = () => {
    if (!canParse) return
    setParsed(parseImportDsl(text, events))
    setAppliedMsg(null)
  }

  const reset = () => {
    setText('')
    setParsed(null)
    setAppliedMsg(null)
  }

  const batch = useMemo(() => (parsed ? buildImportBatch(parsed, events) : null), [parsed, events])

  const apply = () => {
    if (!batch) return
    if (
      !window.confirm(
        `确认导入？将一次性新增 ${batch.events.length} 个事件、${batch.constraints.length} 条约束、${batch.observations.length} 条观测；不会修改或覆盖任何现有数据。`,
      )
    ) {
      return
    }
    onApply(batch)
    setAppliedMsg(
      `已合并：新增 ${batch.events.length} 个事件、${batch.constraints.length} 条约束、${batch.observations.length} 条观测。`,
    )
    setParsed(null)
    setText('')
  }

  const nameSet = useMemo(() => new Set(events.map((e) => e.name)), [events])

  return (
    <div className="panel import-panel">
      <h3>
        批量证词导入
        <span className="count">
          粘贴多行 DSL：EVENT / REL / OBS · 先解析为只读预览，零错误才可确认合并 · 不覆盖现有数据
        </span>
      </h3>

      <details open>
        <summary className="import-summary">展开 / 收起 DSL 输入框（查看语法说明）</summary>

        <div className="import-syntax">
          <code>EVENT &quot;名称&quot; | &quot;备注&quot;</code>
          <span className="sep">·</span>
          <code>REL &quot;A&quot; earlier|later &quot;B&quot; min..max</code>
          <span className="sep">·</span>
          <code>OBS &quot;事件&quot; start..end</code>
          <div className="import-syntax-note">
            名称与备注均为 <strong>JSON 字符串</strong>（双引号包裹，支持 <code>\n</code>、<code>\"</code>、
            <code>\uXXXX</code> 等转义）；<code>earlier</code> = A 早于 B，<code>later</code> = A 晚于 B，
            区间为 <code>0 ≤ min ≤ max</code> 的整数分钟；时间格式 <code>YYYY-MM-DDTHH:mm</code>
            （<code>T</code> 也可写作空格），终点早于起点即非法。引用可指向现有事件或同批 EVENT：
            重名、重复声明、引用不唯一 / 缺失、非法区间与时间格式都会<strong>定位到具体行号</strong>，
            任一错误均禁止写入。
          </div>
        </div>

        <textarea
          className="import-textarea"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            // 编辑后旧预览作废，避免与新文本错位
            if (parsed) setParsed(null)
          }}
          placeholder={PLACEHOLDER}
          spellCheck={false}
          rows={10}
          aria-label="批量证词 DSL 输入"
        />

        <div className="add-row">
          <button className="primary" onClick={doParse} disabled={!canParse}>
            解析并预览
          </button>
          <button onClick={reset} disabled={!text && !parsed}>
            清空
          </button>
          {parsed && (
            <span className="import-reparse-hint">文本修改后需重新点击「解析并预览」</span>
          )}
        </div>
      </details>

      {appliedMsg && <div className="import-applied">{appliedMsg}</div>}

      {parsed && <ImportPreview parsed={parsed} existingNames={nameSet} batchReady={batch !== null} onApply={apply} />}
    </div>
  )
}

/** 只读预览：逐行列出新增事件 / 约束 / 观测；错误按原行号定位 */
function ImportPreview({
  parsed,
  existingNames,
  batchReady,
  onApply,
}: {
  parsed: ImportParseResult
  existingNames: Set<string>
  batchReady: boolean
  onApply: () => void
}) {
  const { items, errors } = parsed

  return (
    <div className="import-preview">
      <div className="import-preview-head">
        <strong>只读预览</strong>
        <span className="count">
          待新增事件 {parsed.events.length} 个 · 约束 {parsed.constraints.length} 条 · 观测{' '}
          {parsed.observations.length} 条
        </span>
      </div>

      {!parsed.hasInput && <div className="empty-hint">没有任何可导入语句（仅空行 / 注释）。</div>}

      {errors.length > 0 && (
        <div className="import-errors">
          <div className="import-errors-title">
            ⛔ 发现 {errors.length} 个错误（已定位原行号）：存在任何错误均<strong>禁止写入</strong>
            ，请修正后重新解析。
          </div>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>
                <code className="import-line-no">第 {e.line} 行</code>
                <span>{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {batchReady && (
        <div className="import-ready">
          ✅ 解析通过，全部语句有效。确认后将<strong>一次性合并并持久化</strong>到浏览器本地存储，
          现有事件 / 约束 / 观测均不会被覆盖。
        </div>
      )}

      {items.length > 0 && (
        <table className="windows import-table">
          <thead>
            <tr>
              <th style={{ width: 70 }}>原行</th>
              <th style={{ width: 64 }}>类型</th>
              <th>将新增的内容</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              if (it.kind === 'event') return <EventPreviewRow key={`e${it.line}`} it={it} existing={existingNames.has(it.name)} />
              if (it.kind === 'constraint')
                return <ConstraintPreviewRow key={`c${it.line}`} it={it} existingNames={existingNames} />
              return <ObservationPreviewRow key={`o${it.line}`} it={it} existingNames={existingNames} />
            })}
          </tbody>
        </table>
      )}

      <div className="add-row">
        <button className="primary" onClick={onApply} disabled={!batchReady} title={batchReady ? '' : '存在解析错误，禁止写入'}>
          确认合并并持久化
        </button>
        {!batchReady && <span className="import-blocked-hint">请先修正全部错误</span>}
      </div>
    </div>
  )
}

function LineNo({ line }: { line: number }) {
  return <code className="order-no">L{line}</code>
}

function EventPreviewRow({ it, existing }: { it: ParsedEventItem; existing: boolean }) {
  const bad = it.firstLine !== it.line || existing
  return (
    <tr className={bad ? 'import-bad-row' : ''}>
      <td><LineNo line={it.line} /></td>
      <td><span className="badge import-kind event">EVENT</span></td>
      <td>
        事件「{it.name}」
        {it.note && <> · 备注：{it.note}</>}
        {existing && <span className="badge invalid-badge">与现有事件重名</span>}
        {it.firstLine !== it.line && <span className="badge invalid-badge">重复声明（首次 L{it.firstLine}）</span>}
      </td>
    </tr>
  )
}

function ConstraintPreviewRow({ it, existingNames }: { it: ParsedConstraintItem; existingNames: Set<string> }) {
  const rel = it.relation === 'earlier' ? '早于' : '晚于'
  const range = it.min === it.max ? `${it.min}` : `${it.min}..${it.max}`
  const refTag = (name: string, isNew: boolean) =>
    isNew ? (
      <span className="badge interval" title="同批 EVENT 声明">新</span>
    ) : existingNames.has(name) ? (
      <span className="badge observed" title="引用现有事件">现有</span>
    ) : (
      <span className="badge invalid-badge">引用缺失</span>
    )
  return (
    <tr className={it.duplicate ? 'import-bad-row' : ''}>
      <td><LineNo line={it.line} /></td>
      <td><span className="badge import-kind rel">REL</span></td>
      <td>
        「{it.aName}」{refTag(it.aName, it.aIsNew)} {rel} 「{it.bName}」{refTag(it.bName, it.bIsNew)} {range} 分钟
        {it.duplicate && <span className="badge invalid-badge">重复声明</span>}
      </td>
    </tr>
  )
}

function ObservationPreviewRow({ it, existingNames }: { it: ParsedObservationItem; existingNames: Set<string> }) {
  const exact = it.start === it.end
  return (
    <tr className={it.duplicate ? 'import-bad-row' : ''}>
      <td><LineNo line={it.line} /></td>
      <td><span className="badge import-kind obs">OBS</span></td>
      <td>
        「{it.eventName}」
        {it.eventIsNew ? (
          <span className="badge interval" title="同批 EVENT 声明">新</span>
        ) : existingNames.has(it.eventName) ? (
          <span className="badge observed" title="引用现有事件">现有</span>
        ) : (
          <span className="badge invalid-badge">引用缺失</span>
        )}
        发生于 {formatFullDateTime(it.start)}
        {exact ? '（精确时刻）' : <> ~ {formatFullDateTime(it.end)}</>}
        {it.duplicate && <span className="badge invalid-badge">重复声明</span>}
      </td>
    </tr>
  )
}
