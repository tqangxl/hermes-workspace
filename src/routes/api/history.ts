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
import { getLocalSession, getLocalMessages } from '../../server/local-session-store'

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
          const limit = Number(url.searchParams.get('limit') || '200')
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
            const localMessages = getLocalMessages('main')
            return json({
              sessionKey: 'main',
              sessionId: 'main',
              messages: localMessages.map((m, index) => ({
                id: m.id,
                role: m.role,
                content: normalizeLocalContentToParts(m.content),
                timestamp: m.timestamp,
                historyIndex: index,
              })),
            })
          }
          let messages: Awaited<ReturnType<typeof getMessages>> = []
          try {
            messages = await getMessages(sessionKey)
          } catch {
            messages = []
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
          const localSession = getLocalSession(sessionKey)
          if (localSession) {
            const localMessages = getLocalMessages(sessionKey)
            if (localMessages.length > 0) {
              const remoteIds = new Set(
                messages
                  .map((m) => {
                    const id = (m as Record<string, unknown>).id
                    return typeof id === 'string' ? id : null
                  })
                  .filter((id): id is string => Boolean(id)),
              )
              const tailOnly = localMessages
                .filter((m) => !remoteIds.has(m.id))
                .map((m) => ({
                  id: m.id,
                  role: m.role,
                  content: normalizeLocalContentToParts(m.content),
                  timestamp: m.timestamp,
                  // Tag so the frontend can render a "saved locally" hint
                  __source: 'local-tail' as const,
                }))

              if (tailOnly.length > 0) {
                const merged = [...messages, ...tailOnly].sort(
                  (a, b) => {
                    const aTs =
                      typeof a.timestamp === 'number' ? a.timestamp : 0
                    const bTs =
                      typeof b.timestamp === 'number' ? b.timestamp : 0
                    return aTs - bTs
                  },
                )
                messages = merged as typeof messages
              }
            }
          }

          const boundedMessages = limit > 0 ? messages.slice(-limit) : messages

          return json({
            sessionKey,
            sessionId: sessionKey,
            messages: boundedMessages.map((message, index) =>
              toChatMessage(message, { historyIndex: index }),
            ),
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
