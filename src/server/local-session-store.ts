import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), '.runtime')
const SESSIONS_FILE = join(DATA_DIR, 'local-sessions.json')
const SESSIONS_FILE_TMP = `${SESSIONS_FILE}.tmp`
const MAX_MESSAGES_PER_SESSION = 500

export type LocalSession = {
  id: string
  title: string | null
  model: string | null
  createdAt: number
  updatedAt: number
  messageCount: number
}

export type LocalMessage = {
  id: string
  role: string
  content: string
  timestamp: number
  toolCalls?: unknown
  toolCallId?: string
  toolName?: string
}

type StoreData = {
  sessions: Record<string, LocalSession>
  messages: Record<string, Array<LocalMessage>>
}

let store: StoreData = { sessions: {}, messages: {} }

function loadFromDisk(): void {
  try {
    if (existsSync(SESSIONS_FILE)) {
      const raw = readFileSync(SESSIONS_FILE, 'utf-8')
      const parsed = JSON.parse(raw) as StoreData
      if (parsed.sessions && parsed.messages) {
        store = parsed
      }
    }
  } catch {
    // ignore corrupt local cache
  }
}

function saveToDisk(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    // Atomic write: write to a temp file, then rename. The rename is atomic
    // on the same filesystem, so readers (or a process restart mid-write)
    // always see either the old full file or the new full file — never a
    // half-written one. writeFileSync opens, writes, and closes; closing
    // the fd flushes kernel buffers to disk on most platforms.
    const data = JSON.stringify(store, null, 2)
    writeFileSync(SESSIONS_FILE_TMP, data)
    renameSync(SESSIONS_FILE_TMP, SESSIONS_FILE)
  } catch {
    // ignore cache write failures — caller's message is still in memory
    // and the next appendLocalMessage call will retry the save.
  }
}

loadFromDisk()

export function listLocalSessions(): Array<LocalSession> {
  return Object.values(store.sessions).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getLocalSession(sessionId: string): LocalSession | null {
  return store.sessions[sessionId] ?? null
}

export function ensureLocalSession(
  sessionId: string,
  model?: string,
): LocalSession {
  if (!store.sessions[sessionId]) {
    store.sessions[sessionId] = {
      id: sessionId,
      title: null,
      model: model ?? null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
    }
    store.messages[sessionId] = []
    saveToDisk()
  }
  return store.sessions[sessionId]
}

export function updateLocalSessionTitle(
  sessionId: string,
  title: string,
): void {
  const session = store.sessions[sessionId]
  if (session) {
    session.title = title
    session.updatedAt = Date.now()
    saveToDisk()
  }
}

export function touchLocalSession(sessionId: string): void {
  const session = store.sessions[sessionId]
  if (session) session.updatedAt = Date.now()
}

export function deleteLocalSession(sessionId: string): void {
  delete store.sessions[sessionId]
  delete store.messages[sessionId]
  saveToDisk()
}

export function getLocalMessages(sessionId: string): Array<LocalMessage> {
  return store.messages[sessionId] ?? []
}

/**
 * Cursor-paginated read. Returns up to `limit` messages whose
 * timestamp is strictly less than `beforeTs`. If `beforeTs` is
 * undefined, returns the most recent `limit` messages.
 *
 * Returned array is in chronological order (oldest -> newest) so the
 * caller can just append/prepend without resorting.
 */
export function getLocalMessagesPage(
  sessionId: string,
  options: { limit?: number; beforeTs?: number; fromTs?: number } = {},
): { messages: Array<LocalMessage>; hasMore: boolean; total: number } {
  const all = store.messages[sessionId] ?? []
  const total = all.length
  if (total === 0) {
    return { messages: [], hasMore: false, total: 0 }
  }
  const limit = options.limit && options.limit > 0 ? options.limit : 50
  const beforeTs = options.beforeTs
  const fromTs = options.fromTs

  // All entries are kept in insertion order (oldest -> newest). We
  // apply the lower bound (fromTs) and upper bound (beforeTs) first,
  // then slice off the last `limit` from the eligible window. This
  // matches /api/history's behavior on the remote side.
  let startIndex = 0
  let endIndex = all.length

  if (typeof fromTs === 'number') {
    // First index with ts >= fromTs. Everything at or after this
    // index is in the eligible window.
    let i = 0
    for (; i < all.length; i += 1) {
      const ts = all[i].timestamp
      if (typeof ts === 'number' && ts >= fromTs) break
    }
    startIndex = i
  }
  if (typeof beforeTs === 'number') {
    // First index with ts >= beforeTs. Everything before this index
    // has ts < beforeTs (strictly), so the eligible upper bound is
    // exclusive of beforeTs.
    let i = startIndex
    for (; i < all.length; i += 1) {
      if (typeof all[i].timestamp === 'number' && all[i].timestamp >= beforeTs) {
        break
      }
    }
    endIndex = i
  }

  const eligibleLength = endIndex - startIndex
  const sliceStart = Math.max(startIndex, endIndex - limit)
  const slice = all.slice(sliceStart, endIndex)
  return {
    messages: slice,
    hasMore: sliceStart > startIndex,
    total,
  }
}

export function appendLocalMessage(
  sessionId: string,
  message: LocalMessage,
): void {
  ensureLocalSession(sessionId)
  if (!store.messages[sessionId]) store.messages[sessionId] = []
  store.messages[sessionId].push(message)
  if (store.messages[sessionId].length > MAX_MESSAGES_PER_SESSION) {
    store.messages[sessionId] = store.messages[sessionId].slice(
      -MAX_MESSAGES_PER_SESSION,
    )
  }
  const session = store.sessions[sessionId]
  if (session) {
    session.messageCount = store.messages[sessionId].length
    session.updatedAt = Date.now()
  }
  // SYNCHRONOUS SAVE — no debounce. The previous 2s debounce caused
  // message loss when the process was killed or the user navigated away
  // before the timer fired. The on-disk file is the source of truth for
  // any future reload; if save fails, the in-memory copy is still
  // returned by getLocalMessages, and the next appendLocalMessage call
  // will retry the save.
  saveToDisk()
}
