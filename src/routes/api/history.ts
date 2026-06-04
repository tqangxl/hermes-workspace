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
                content: [{ type: 'text', text: m.content }],
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
                  content: [{ type: 'text', text: m.content }],
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
