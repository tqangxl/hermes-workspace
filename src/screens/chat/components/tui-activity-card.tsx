import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'

/**
 * TUI-style activity card.
 *
 * Renders thinking + all tool calls as a single card above the assistant
 * message bubble. Rows mimic Claude Code / Codex CLI tool output:
 *
 *   💭 Thinking 4s
 *     ⎿ Looking at chat component…
 *   ● Read message-item.tsx
 *     ⎿ 1240 lines
 *   ● Edit message-item.tsx
 *     ⎿ 2 changes
 *   ○ exec pnpm build
 *     ⎿ running…
 */

export type TuiToolSection = {
  key: string
  type: string
  input?: Record<string, unknown>
  preview?: string
  outputText: string
  errorText?: string
  state:
    | 'input-streaming'
    | 'input-available'
    | 'output-available'
    | 'output-error'
}

type TuiActivityCardProps = {
  toolSections: Array<TuiToolSection>
  thinking?: string | null
  thinkingElapsedSeconds?: number
  isStreaming: boolean
  expandAll?: boolean
  /** Format a tool's display label from name+args */
  formatLabel: (name: string, args?: Record<string, unknown>) => string
  /** Get the most useful single arg to show next to the label */
  formatArg: (name: string, args?: Record<string, unknown>) => string | null
}

/**
 * Tiny inline copy-to-clipboard button. Shows a "Copied" checkmark for
 * ~1.5s after a successful copy, then resets. Failures (e.g. insecure
 * context) silently no-op rather than throwing.
 */
function CopyButton({
  text,
  label = 'Copy',
  className,
}: {
  text: string
  label?: string
  className?: string
}) {
  const [copied, setCopied] = useState(false)
  const handleClick = useCallback(async () => {
    try {
      if (
        typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function'
      ) {
        await navigator.clipboard.writeText(text)
      } else if (typeof document !== 'undefined') {
        // Fallback for non-secure contexts
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'absolute'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
      const id = window.setTimeout(() => setCopied(false), 1500)
      return () => window.clearTimeout(id)
    } catch {
      // Ignore copy failures (insecure context, permissions, etc.)
      setCopied(false)
      return undefined
    }
  }, [text])
  return (
    <button
      type="button"
      onClick={handleClick}
      className={
        className ??
        'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider opacity-50 hover:opacity-100 transition-opacity'
      }
      style={{
        color: copied
          ? 'var(--theme-success, #22c55e)'
          : 'var(--theme-muted)',
        border: '1px solid var(--theme-border)',
      }}
      title={copied ? 'Copied!' : label}
    >
      {copied ? '✓ copied' : label}
    </button>
  )
}

function statusDot(
  state: TuiToolSection['state'],
  isStreamingActive: boolean,
): string {
  if (state === 'output-error') return '✗'
  if (state === 'output-available') return '●'
  // input-available / input-streaming = pending
  return isStreamingActive ? '○' : '●'
}

function statusColor(
  state: TuiToolSection['state'],
  isStreamingActive: boolean,
): string {
  if (state === 'output-error') return 'var(--theme-danger, #ef4444)'
  if (state === 'output-available') return 'var(--theme-success, #22c55e)'
  return isStreamingActive
    ? 'var(--theme-accent, #6366f1)'
    : 'var(--theme-muted, #888)'
}

function summarizeOutput(text: string, maxLen = 120): string {
  const trimmed = text.trim()
  if (!trimmed) return ''
  // First non-empty line, capped
  const firstLine = trimmed.split('\n').find((line) => line.trim()) ?? ''
  const compact = firstLine.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLen) return compact
  return `${compact.slice(0, maxLen - 1)}…`
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m ${s}s`
}

/**
 * Render the tool's input in the most useful way for each tool type.
 * For shell-style tools (command / cmd / shell_command / bash), show the
 * full command on its own line — that's the part the user actually
 * wants to see, not a JSON wrapper. For file tools (read/edit/write),
 * surface the file path on its own line and dump the rest as JSON.
 * For everything else, fall back to a pretty-printed JSON dump.
 */
function formatToolInput(section: TuiToolSection): string {
  const input = section.input
  if (!input || typeof input !== 'object') return ''

  const tool = section.type.toLowerCase()
  const isShell =
    tool === 'bash' ||
    tool === 'shell' ||
    tool === 'exec' ||
    tool === 'command' ||
    tool === 'run_command' ||
    tool === 'shell_command'
  const isFileRead =
    tool === 'read' ||
    tool === 'read_file' ||
    tool === 'file_read' ||
    tool === 'cat'
  const isFileWrite =
    tool === 'write' ||
    tool === 'write_file' ||
    tool === 'edit' ||
    tool === 'edit_file' ||
    tool === 'create' ||
    tool === 'create_file' ||
    tool === 'apply_patch'

  const pickString = (...keys: Array<string>): string | null => {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === 'string' && value.trim().length > 0) return value
    }
    return null
  }

  if (isShell) {
    const command = pickString('command', 'cmd', 'shell_command', 'script')
    if (command) {
      // If there's a cwd, surface it as a header line so the user knows
      // the working directory. Don't dump it inside the command itself.
      const cwd = pickString('cwd', 'working_dir', 'workdir')
      const header = cwd ? `[cwd: ${cwd}]\n` : ''
      return `${header}$ ${command}`
    }
  }

  if (isFileRead || isFileWrite) {
    const path = pickString('path', 'file_path', 'file', 'filepath')
    if (path) {
      const rest: Record<string, unknown> = { ...input }
      // Don't repeat the path inside the rest
      for (const k of ['path', 'file_path', 'file', 'filepath']) {
        delete (rest as Record<string, unknown>)[k]
      }
      const restJson = Object.keys(rest).length
        ? `\n\n${JSON.stringify(rest, null, 2)}`
        : ''
      return `path: ${path}${restJson}`
    }
  }

  return JSON.stringify(input, null, 2)
}

function ToolRow({
  section,
  isStreamingActive,
  expandAll,
  formatLabel,
  formatArg,
}: {
  section: TuiToolSection
  isStreamingActive: boolean
  expandAll?: boolean
  formatLabel: (name: string, args?: Record<string, unknown>) => string
  formatArg: (name: string, args?: Record<string, unknown>) => string | null
}) {
  const isError = section.state === 'output-error'
  const isDone = section.state === 'output-available'
  const isPending = !isError && !isDone

  // Auto-expand when:
  //   1. Caller requested expandAll (e.g. user toggled "expand all")
  //   2. The run has finished and there's something to show — a finished tool
  //      call with no expanded view hides its real command/output behind a
  //      single truncated line, which makes the chat feel opaque. The whole
  //      point of "越用越想用" is that the user can SEE what the agent did.
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (expandAll) {
      setOpen(true)
      return
    }
    if (isDone || isError) {
      setOpen(true)
    }
  }, [expandAll, isDone, isError])

  // Per-row elapsed timer when running
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!isPending || !isStreamingActive) {
      setElapsed(0)
      return
    }
    setElapsed(0)
    const id = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(id)
  }, [isPending, isStreamingActive, section.key])

  const label = formatLabel(section.type, section.input)
  const arg = formatArg(section.type, section.input)
  const argLabel = section.preview ?? arg ?? null
  // No 60-char truncation here — show the full arg. The row already has a
  // hover state and the user can read the full text in the expanded panel
  // below. Truncating a shell command to "git s…" hides exactly the part
  // the user cares about.
  const argTruncated = argLabel

  const outputText = section.outputText || section.errorText || ''
  const outputSummary = isPending
    ? isStreamingActive
      ? 'running…'
      : 'pending'
    : summarizeOutput(outputText) || (isDone ? 'done' : 'failed')

  const dot = statusDot(section.state, isStreamingActive)
  const color = statusColor(section.state, isStreamingActive)

  const hasInputData =
    section.input && Object.keys(section.input).length > 0
  const hasOutputData = !!(section.outputText || section.errorText)
  const canExpand = hasInputData || hasOutputData

  return (
    <div className="font-mono text-[12px] leading-relaxed">
      <button
        type="button"
        onClick={() => canExpand && setOpen((v) => !v)}
        className={cn(
          'group flex w-full items-baseline gap-2 px-3 py-1.5 text-left rounded-sm',
          canExpand && 'hover:bg-[color-mix(in_srgb,var(--theme-accent)_8%,transparent)]',
          !canExpand && 'cursor-default',
        )}
      >
        <span
          className={cn(
            'shrink-0 leading-none',
            isPending && isStreamingActive && 'animate-pulse',
          )}
          style={{ color }}
        >
          {dot}
        </span>
        <span
          className="shrink-0 font-semibold"
          style={{ color: 'var(--theme-text)' }}
        >
          {label}
        </span>
        {argTruncated && argTruncated !== label ? (
          <span
            className="truncate min-w-0 opacity-70"
            style={{ color: 'var(--theme-muted)' }}
          >
            {argTruncated}
          </span>
        ) : null}
        <span className="flex-1" />
        {isPending && isStreamingActive && elapsed > 0 ? (
          <span
            className="shrink-0 tabular-nums text-[10px] opacity-60"
            style={{ color: 'var(--theme-muted)' }}
          >
            {formatElapsed(elapsed)}
          </span>
        ) : null}
        {canExpand ? (
          <span
            className="shrink-0 text-[10px] opacity-40"
            style={{ color: 'var(--theme-muted)' }}
          >
            {open ? '▾' : '▸'}
          </span>
        ) : null}
      </button>
      {/* Output preview line — TUI-style ⎿ */}
      <div
        className="flex items-baseline gap-1.5 px-3 pl-7 pb-0.5 opacity-70"
        style={{ color: isError ? 'var(--theme-danger, #ef4444)' : 'var(--theme-muted)' }}
      >
        <span className="shrink-0 leading-none opacity-50">⎿</span>
        <span className="truncate min-w-0">{outputSummary}</span>
      </div>
      {open && canExpand ? (
        <div
          className="mx-3 mt-2 mb-1 rounded border px-3 py-2 text-[11px]"
          style={{
            background: 'var(--code-bg, color-mix(in srgb, var(--theme-card) 70%, transparent))',
            borderColor: 'var(--theme-border)',
          }}
        >
          {hasInputData ? (
            <div>
              <div className="mb-0.5 flex items-center gap-2">
                <div
                  className="font-sans text-[9px] uppercase tracking-widest opacity-50"
                  style={{ color: 'var(--theme-muted)' }}
                >
                  Input
                </div>
                <span className="flex-1" />
                <CopyButton text={formatToolInput(section)} label="Copy" />
              </div>
              <pre
                className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded font-mono text-[10px]"
                style={{ color: 'var(--code-foreground, var(--theme-text))' }}
              >
                {formatToolInput(section)}
              </pre>
            </div>
          ) : null}
          {hasOutputData ? (
            <div className={cn(hasInputData && 'mt-1.5')}>
              <div className="mb-0.5 flex items-center gap-2">
                <div
                  className="font-sans text-[9px] uppercase tracking-widest opacity-50"
                  style={{
                    color: isError
                      ? 'var(--theme-danger, #ef4444)'
                      : 'var(--theme-muted)',
                  }}
                >
                  {isError ? 'Error' : 'Output'}
                </div>
                <span className="flex-1" />
                <CopyButton
                  text={section.outputText || section.errorText || ''}
                  label="Copy"
                />
              </div>
              <pre
                className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded font-mono text-[10px]"
                style={{
                  color: isError
                    ? 'var(--theme-danger, #ef4444)'
                    : 'var(--code-foreground, var(--theme-text))',
                }}
              >
                {section.outputText || section.errorText || ''}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function ThinkingRow({
  thinking,
  elapsedSeconds,
  isStreaming,
  expandAll,
}: {
  thinking: string
  elapsedSeconds: number
  isStreaming: boolean
  expandAll?: boolean
}) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (expandAll) setOpen(true)
  }, [expandAll])

  const summary = summarizeOutput(thinking) || 'thinking…'

  return (
    <div className="font-mono text-[12px] leading-relaxed">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex w-full items-baseline gap-2 px-3 py-1.5 text-left rounded-sm hover:bg-[color-mix(in_srgb,var(--theme-accent)_8%,transparent)]"
      >
        <span className="shrink-0 leading-none">💭</span>
        <span
          className="shrink-0 font-semibold"
          style={{ color: 'var(--theme-text)' }}
        >
          Thinking
        </span>
        <span className="flex-1" />
        {isStreaming && elapsedSeconds > 0 ? (
          <span
            className="shrink-0 tabular-nums text-[10px] opacity-60"
            style={{ color: 'var(--theme-muted)' }}
          >
            {formatElapsed(elapsedSeconds)}
          </span>
        ) : null}
        <span
          className="shrink-0 text-[10px] opacity-40"
          style={{ color: 'var(--theme-muted)' }}
        >
          {open ? '▾' : '▸'}
        </span>
      </button>
      <div
        className="flex items-baseline gap-1.5 px-3 pl-7 pb-0.5 opacity-70"
        style={{ color: 'var(--theme-muted)' }}
      >
        <span className="shrink-0 leading-none opacity-50">⎿</span>
        <span className="truncate min-w-0 italic">{summary}</span>
      </div>
      {open ? (
        <div
          className="mx-3 mt-2 mb-1 rounded border px-3 py-2 text-[11px]"
          style={{
            background: 'var(--code-bg, color-mix(in srgb, var(--theme-card) 70%, transparent))',
            borderColor: 'var(--theme-border)',
          }}
        >
          <p
            className="whitespace-pre-wrap text-pretty text-[12px]"
            style={{ color: 'var(--theme-text)' }}
          >
            {thinking}
          </p>
        </div>
      ) : null}
    </div>
  )
}

function TuiActivityCardComponent({
  toolSections,
  thinking,
  thinkingElapsedSeconds = 0,
  isStreaming,
  expandAll,
  formatLabel,
  formatArg,
}: TuiActivityCardProps) {
  const hasThinking = !!(thinking && thinking.trim().length > 0)
  const hasTools = toolSections.length > 0

  // Local "expand all" toggle so the user can flip the whole card open /
  // shut on demand. If the caller passed an explicit expandAll prop, that
  // wins (parent owns the state in that case).
  const [localExpandAll, setLocalExpandAll] = useState(false)
  const effectiveExpandAll = expandAll ?? localExpandAll
  const showExpandToggle = expandAll === undefined && !isStreaming

  const summary = useMemo(() => {
    if (!hasTools) return null
    const total = toolSections.length
    const errors = toolSections.filter((s) => s.state === 'output-error').length
    const running = toolSections.filter(
      (s) => s.state === 'input-available' || s.state === 'input-streaming',
    ).length
    const done = total - errors - running

    if (errors > 0) return `${errors} failed · ${done} done`
    if (running > 0) return `${running} running · ${done} done`
    return `${total} ${total === 1 ? 'tool' : 'tools'} · done`
  }, [toolSections, hasTools])

  const summaryColor =
    summary?.includes('failed')
      ? 'var(--theme-danger, #ef4444)'
      : summary?.includes('running')
        ? 'var(--theme-accent, #6366f1)'
        : 'var(--theme-success, #22c55e)'

  // During streaming with nothing to show yet, render a minimal "working" stub
  // so we don't pretend the agent is thinking when no thinking text was emitted.
  // (Hermes Agent currently emits tool.completed only after the run, not live.)
  const isWorkingStub = !hasThinking && !hasTools && isStreaming
  if (!hasThinking && !hasTools && !isWorkingStub) return null

  return (
    <div
      className="w-full max-w-[min(100%,720px)] overflow-hidden rounded-lg border"
      style={{
        background:
          'color-mix(in srgb, var(--theme-card2) 92%, var(--theme-bg) 8%)',
        borderColor:
          'color-mix(in srgb, var(--theme-border) 88%, transparent)',
      }}
    >
      <div
        className="flex items-center gap-2 border-b px-4 py-2.5"
        style={{
          borderColor:
            'color-mix(in srgb, var(--theme-border) 70%, transparent)',
          background:
            'color-mix(in srgb, var(--theme-card) 50%, transparent)',
        }}
      >
        <span
          className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: 'var(--theme-muted)' }}
        >
          {isStreaming ? '⚡ Working' : 'Activity'}
        </span>
        <span className="flex-1" />
        {summary ? (
          <span
            className="font-mono text-[10px] tabular-nums"
            style={{ color: summaryColor }}
          >
            {summary}
          </span>
        ) : null}
        {showExpandToggle ? (
          <button
            type="button"
            onClick={() => setLocalExpandAll((v) => !v)}
            className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider opacity-50 hover:opacity-100 transition-opacity"
            style={{
              color: 'var(--theme-muted)',
              border: '1px solid var(--theme-border)',
            }}
            title={effectiveExpandAll ? 'Collapse all rows' : 'Expand all rows'}
          >
            {effectiveExpandAll ? '▾ Collapse all' : '▸ Expand all'}
          </button>
        ) : null}
        {isStreaming ? (
          <span
            className="size-1.5 rounded-full animate-pulse"
            style={{ background: 'var(--theme-accent, #6366f1)' }}
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5 px-2 py-3">
        {hasThinking ? (
          <ThinkingRow
            thinking={thinking!}
            elapsedSeconds={thinkingElapsedSeconds}
            isStreaming={isStreaming}
            expandAll={effectiveExpandAll}
          />
        ) : null}
        {toolSections.map((section, index) => (
          <ToolRow
            key={section.key || `${section.type}-${index}`}
            section={section}
            isStreamingActive={isStreaming}
            expandAll={effectiveExpandAll}
            formatLabel={formatLabel}
            formatArg={formatArg}
          />
        ))}
        {isWorkingStub ? (
          <div
            className="flex items-baseline gap-2 px-3 py-1 font-mono text-[12px] leading-relaxed"
            style={{ color: 'var(--theme-muted)' }}
          >
            <span
              className="size-1.5 rounded-full animate-pulse"
              style={{ background: 'var(--theme-accent, #6366f1)' }}
            />
            <span className="opacity-80">working…</span>
            <span className="opacity-50 text-[10px]">
              tool activity will appear after the run
            </span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

export const TuiActivityCard = memo(TuiActivityCardComponent)
