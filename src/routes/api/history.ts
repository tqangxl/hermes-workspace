import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import {
  SESSIONS_API_UNAVAILABLE_MESSAGE,
  ensureGatewayProbed,
  getGatewayCapabilities,
  getMessages,
  listSessions,
  toChatMessage,
} from '../../server/claude-api'
import {
  resolveMainChatSessionId,
  resolveSessionKey,
  shouldBindMainToPortableSession,
} from '../../server/session-utils'
import { isAuthenticated } from '@/server/auth-middleware'
import { getLocalSession, getLocalMessages, getLocalMessagesPage } from '../../server/local-session-store'

/**
 * Normalize a local-cache message's `content` field into a content
 * part array the client can render.
 *
 * The local store historically accepted any content shape — sometimes
 * a raw string, sometimes a JSON-encoded array of parts. When we hand
 * it back to the client, we MUST produce a real `[{type, text, ...}]`
 * array, not a string that itself looks like JSON. Otherwise the
 * client's textFromMessage would either coerce the string with String()
 * and produce "[object Object]" (when content is an object) or render
 * the literal JSON text inside the bubble (when content is a
 * JSON-encoded string of the array — the double-encoding bug).
 *
 * To keep both old and new persisted shapes working, this function
 * peeks at the input:
 *   - If it's already an array of parts, return it as-is.
 *   - If it's a string that parses to an array of parts, return that.
 *   - Otherwise wrap as a single text part (string-ifying objects).
 */
function normalizeLocalContentToParts(content: unknown): Array<{
  type: 'text'
  text: string
}> {
  if (Array.isArray(content)) {
    return content
      .filter((p): p is { type: string; text?: unknown } =>
        typeof p === 'object' && p !== null,
      )
      .map((p) => {
        if (p.type === 'text' && typeof p.text === 'string') {
          return { type: 'text' as const, text: p.text }
        }
        // Unknown / non-text part — stringify so the client still sees it.
        return {
          type: 'text' as const,
          text: stringifySafe(p),
        }
      })
  }
  if (typeof content === 'string') {
    const trimmed = content.trim()
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) {
          // Recurse with the parsed array so we get the same shape.
          return normalizeLocalContentToParts(parsed)
        }
      } catch {
        // Not valid JSON — fall through and treat the string as text.
      }
    }
    return [{ type: 'text', text: content }]
  }
  if (content == null) {
    return [{ type: 'text', text: '' }]
  }
  if (typeof content === 'object') {
    return [{ type: 'text', text: stringifySafe(content) }]
  }
  return [{ type: 'text', text: String(content) }]
}

function stringifySafe(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

export const Route = createFileRoute('/api/history')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        await ensureGatewayProbed()
        const capabilities = getGatewayCapabilities()
        if (!capabilities.sessions) {
          return json({
            sessionKey: 'new',
            sessionId: 'new',
            messages: [],
            source: 'unavailable',
            message: SESSIONS_API_UNAVAILABLE_MESSAGE,
          })
        }
        try {
          const url = new URL(request.url)
          // limit=0 means "use the default" (50 for the first page, full
          // for callers that explicitly pass limit=0 with a `before`
          // cursor). Treat negative values as "use the default" too.
          const limitParam = Number(url.searchParams.get('limit') || '50')
          const limit =
            Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 50
          // `before` is an opaque cursor — currently a millisecond
          // timestamp. The server returns messages whose timestamp is
          // strictly less than this value, in chronological order. If
          // omitted, the server returns the most recent `limit` rows.
          const beforeParam = url.searchParams.get('before')?.trim()
          const beforeTs = beforeParam ? Number(beforeParam) : undefined
          const hasBefore =
            typeof beforeTs === 'number' && Number.isFinite(beforeTs)
          const rawSessionKey = url.searchParams.get('sessionKey')?.trim()
          const friendlyId = url.searchParams.get('friendlyId')?.trim()
          let { sessionKey } = await resolveSessionKey({
            rawSessionKey,
            friendlyId,
            defaultKey: 'main',
          })
          const pinPortableMain = shouldBindMainToPortableSession({
            sessionKey,
            dashboardAvailable: capabilities.dashboard.available,
            enhancedChat: capabilities.enhancedChat,
          })
          // Keep /chat/new empty until the first message creates a real session.
          if (sessionKey === 'new') {
            return json({
              sessionKey: 'new',
              sessionId: 'new',
              messages: [],
            })
          }
          // "main" doesn't exist in Claude — resolve it to the user's real
          // main chat session. We prefer (in order):
          //   1. The most recent session with a real human-set title
          //      (label !== id, e.g. "hows everything"). This is what users
          //      actually mean by "main".
          //   2. The most recent non-internal session with messages.
          // Cron + Operations per-agent sessions are skipped so the
          // orchestrator chat doesn't latch onto runtime junk.
          if (sessionKey === 'main' && !pinPortableMain) {
            try {
              const sessions = await listSessions(30, 0)
              const candidate = resolveMainChatSessionId(sessions)
              if (candidate) {
                sessionKey = candidate
              } else {
                return json({
                  sessionKey: 'new',
                  sessionId: 'new',
                  messages: [],
                })
              }
            } catch {
              return json({ sessionKey: 'new', sessionId: 'new', messages: [] })
            }
          }

          if (pinPortableMain) {
            // Portable main: local-session-store is the source of truth.
            // Use cursor-paginated read so the client can request older
            // pages when the user scrolls to the top.
            const page = getLocalMessagesPage('main', {
              limit,
              beforeTs: hasBefore ? beforeTs : undefined,
            })
            const sliced = page.messages
            return json({
              sessionKey: 'main',
              sessionId: 'main',
              // local-session-store entries are already in canonical
              // shape after normalizeLocalContentToParts(). Don't run
              // them through toChatMessage() — it would re-wrap a
              // content array as a single text part, which the client
              // renders as "[object Object]" in the bubble.
              messages: sliced.map((m, index) => ({
                id: m.id,
                role: m.role,
                content: normalizeLocalContentToParts(m.content),
                timestamp: m.timestamp,
                historyIndex: index,
                __moreBefore: page.hasMore ? true : undefined,
              })),
              hasMore: page.hasMore,
              // Echo the cursor so the client can verify the page
              // boundaries. `nextBefore` is the timestamp the client
              // should pass on the next `before=` request.
              nextBefore:
                page.hasMore && sliced.length > 0
                  ? sliced[0].timestamp
                  : undefined,
            })
          }
          let remoteMessages: Awaited<ReturnType<typeof getMessages>> = []
          try {
            remoteMessages = await getMessages(sessionKey)
          } catch {
            remoteMessages = []
          }

          // For paginated requests, the upstream /api/sessions/:id/messages
          // doesn't support cursors yet, so we have to fetch the full list
          // and slice here. This is fine for typical chat sizes (a few
          // hundred messages); if a session grows beyond that, add cursor
          // support to the Hermes Agent /api/sessions endpoint.
          let messages = remoteMessages
          if (hasBefore) {
            messages = messages
              .filter((m) => {
                const ts = (m as Record<string, unknown>).timestamp
                return typeof ts === 'number' && ts < (beforeTs as number)
              })
              .sort(
                (a, b) =>
                  ((a as Record<string, unknown>).timestamp as number) -
                  ((b as Record<string, unknown>).timestamp as number),
              )
            messages = messages.slice(-limit)
          } else {
            messages = messages
              .sort(
                (a, b) =>
                  ((a as Record<string, unknown>).timestamp as number) -
                  ((b as Record<string, unknown>).timestamp as number),
              )
              .slice(-limit)
          }

          // MERGE local tail into the response. The local cache is the
          // most-recent persistence boundary (sync fsync on every
          // appendLocalMessage). The remote session may not have caught
          // up yet — especially right after the user hits Send and
          // the process is briefly killed or the connection drops. If we
          // returned only the remote transcript, any message that's in
          // local but not yet committed remotely would silently vanish
          // on reload.
          //
          // Dedup by message id (local ids are stable UUIDs assigned at
          // write time). Sort by timestamp so the merged transcript is
          // ordered the way the user typed it.
          //
          // IMPORTANT: the local tail must keep its `content` as a real
          // `[{type, text}]` array. toChatMessage() below assumes `msg.content`
          // is a raw string and re-wraps it as a single text part; if we run
          // it on local-tail messages whose content is already an array,
          // it nests a text part whose text field is the whole array, which
          // renders as "[object Object]" in the bubble. So we mark local
          // entries and only pipe remote (string-content) messages through
          // toChatMessage.
          const localSession = getLocalSession(sessionKey)
          const alreadyCanonical: Array<Record<string, unknown>> = []
          if (localSession) {
            const localPage = getLocalMessagesPage(sessionKey, {
              limit: 200,
              beforeTs: hasBefore ? beforeTs : undefined,
            })
            const localMessages = localPage.messages
            if (localMessages.length > 0) {
              const remoteIds = new Set(
                messages
                  .map((m) => {
                    const id = (m as Record<string, unknown>).id
                    return typeof id === 'string' ? id : null
                  })
                  .filter((id): id is string => Boolean(id)),
              )
              for (const m of localMessages) {
                if (remoteIds.has(m.id)) continue
                alreadyCanonical.push({
                  id: m.id,
                  role: m.role,
                  content: normalizeLocalContentToParts(m.content),
                  timestamp: m.timestamp,
                  // Tag so the frontend can render a "saved locally" hint
                  __source: 'local-tail' as const,
                })
              }

              if (alreadyCanonical.length > 0) {
                const merged = [...messages, ...alreadyCanonical].sort(
                  (a, b) => {
                    const aTs =
                      typeof (a as Record<string, unknown>).timestamp ===
                      'number'
                        ? ((a as Record<string, unknown>).timestamp as number)
                        : 0
                    const bTs =
                      typeof (b as Record<string, unknown>).timestamp ===
                      'number'
                        ? ((b as Record<string, unknown>).timestamp as number)
                        : 0
                    return aTs - bTs
                  },
                )
                messages = merged as typeof messages
              }
            }
          }

          // hasMore / nextBefore mirror the portable path so the client
          // can drive a uniform reverse-infinite-scroll UI regardless of
          // whether the session is portable or backed by the remote
          // Hermes Agent API.
          const pageSlice = messages
          const oldestInPage =
            pageSlice.length > 0
              ? ((pageSlice[0] as Record<string, unknown>).timestamp as
                  | number
                  | undefined) ?? undefined
              : undefined
          const pageHasMore = (() => {
            if (!hasBefore) {
              // First page: there's more if the total count exceeded the
              // initial limit. We don't know the absolute total here
              // without a separate count, so we approximate: if we sliced
              // exactly `limit` and there's any chance more exist, signal
              // hasMore. Since the upstream doesn't expose totals, treat
              // the page as having more whenever it filled the limit.
              return pageSlice.length >= limit
            }
            // Subsequent page: hasMore if we managed to fill the limit
            // AND there might be even older messages (we don't know,
            // but if we hit the limit, probably yes).
            return pageSlice.length >= limit
          })()

          return json({
            sessionKey,
            sessionId: sessionKey,
            hasMore: pageHasMore,
            nextBefore: pageHasMore ? oldestInPage : undefined,
            messages: pageSlice.map((message, index) => {
              // Local-tail messages are already in canonical
              // {role, content: [{type:'text', text}]} shape — just attach
              // historyIndex and ship them. Running them through
              // toChatMessage() would re-wrap the content array as a text
              // part, which the client renders as "[object Object]".
              if (
                (message as Record<string, unknown>).__source === 'local-tail'
              ) {
                return { ...message, historyIndex: index }
              }
              return toChatMessage(message, { historyIndex: index })
            }),
          })
        } catch (err) {
          return json(
            {
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})
