import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import YAML from 'yaml'
import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  ensureGatewayProbed,
  getGatewayCapabilities,
} from '../../server/claude-api'
import { BEARER_TOKEN, CLAUDE_API } from '../../server/gateway-capabilities'
import {
  ensureDiscovery,
  getDiscoveredModels,
  ensureProviderInConfig,
} from '../../server/local-provider-discovery'
import { getActiveProfileName } from '../../server/profiles-browser'

export function getClaudeHome(): string {
  const baseHome = process.env.HERMES_HOME ?? process.env.CLAUDE_HOME ?? path.join(os.homedir(), '.hermes')
  const active = getActiveProfileName()
  return active === 'default'
    ? baseHome
    : path.join(baseHome, 'profiles', active)
}

function getModelsPath(): string {
  return path.join(getClaudeHome(), 'models.json')
}

function getConfigPath(): string {
  return path.join(getClaudeHome(), 'config.yaml')
}

export function getActiveGatewayApi(): string {
  if (process.env.HERMES_API_URL || process.env.CLAUDE_API_URL) {
    return (process.env.HERMES_API_URL || process.env.CLAUDE_API_URL)!.trim().replace(/\/+$/, '')
  }
  try {
    const configPath = getConfigPath()
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = YAML.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const config = parsed as Record<string, unknown>
        const platforms = config.platforms as Record<string, unknown>
        const apiServer = platforms?.api_server as Record<string, unknown>
        const extra = apiServer?.extra as Record<string, unknown>
        const port = extra?.port
        if (typeof port === 'number' || (typeof port === 'string' && !isNaN(parseInt(port, 10)))) {
          return `http://127.0.0.1:${port}`
        }
      }
    }
  } catch {
    // fall through
  }
  return 'http://127.0.0.1:8642'
}

function readStaticProfileModels(): Array<ModelEntry> {
  const staticModels: Array<ModelEntry> = []
  try {
    const configPath = getConfigPath()
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = YAML.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const config = parsed as Record<string, unknown>
        if (config.providers && typeof config.providers === 'object') {
          const providers = config.providers as Record<string, unknown>
          for (const [providerId, providerVal] of Object.entries(providers)) {
            if (providerVal && typeof providerVal === 'object') {
              const p = providerVal as Record<string, unknown>
              if (p.models && typeof p.models === 'object') {
                const modelsMap = p.models as Record<string, unknown>
                for (const modelId of Object.keys(modelsMap)) {
                  staticModels.push({
                    id: modelId,
                    name: modelId,
                    provider: providerId,
                    source: 'static-config'
                  })
                }
              }
              if (typeof p.model === 'string' && p.model.trim()) {
                staticModels.push({
                  id: p.model.trim(),
                  name: p.model.trim(),
                  provider: providerId,
                  source: 'static-config'
                })
              }
            }
          }
        }
        if (config.model_aliases && typeof config.model_aliases === 'object') {
          const aliases = config.model_aliases as Record<string, unknown>
          for (const [aliasName, aliasVal] of Object.entries(aliases)) {
            if (aliasVal && typeof aliasVal === 'object') {
              const a = aliasVal as Record<string, unknown>
              const modelId = typeof a.model === 'string' ? a.model.trim() : ''
              const provider = typeof a.provider === 'string' ? a.provider.trim() : 'unknown'
              if (modelId) {
                staticModels.push({
                  id: modelId,
                  name: `${aliasName} (${modelId})`,
                  provider: provider,
                  source: 'model-aliases'
                })
              }
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }
  return staticModels
}

type ModelEntry = {
  provider?: string
  id?: string
  name?: string
  [key: string]: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value))
    return value as Record<string, unknown>
  return {}
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeModel(entry: unknown): ModelEntry | null {
  if (typeof entry === 'string') {
    const id = entry.trim()
    if (!id) return null
    return {
      id,
      name: id,
      provider: id.includes('/') ? id.split('/')[0] : 'unknown',
    }
  }
  const record = asRecord(entry)
  const id =
    readString(record.id) || readString(record.name) || readString(record.model)
  if (!id) return null
  return {
    ...record,
    id,
    name:
      readString(record.name) ||
      readString(record.display_name) ||
      readString(record.label) ||
      id,
    provider:
      readString(record.provider) ||
      readString(record.owned_by) ||
      (id.includes('/') ? id.split('/')[0] : 'unknown'),
  }
}

export function mergeModelEntries(...sources: Array<Array<ModelEntry>>): Array<ModelEntry> {
  const merged: Array<ModelEntry> = []
  const seen = new Set<string>()

  for (const source of sources) {
    for (const model of source) {
      const normalized = normalizeModel(model)
      if (!normalized || seen.has(normalized.id)) continue
      merged.push(normalized)
      seen.add(normalized.id)
    }
  }

  return merged
}

/**
 * Read user-configured models from active profile's models.json.
 */
function readClaudeModelsJson(): Array<ModelEntry> {
  try {
    const modelsPath = getModelsPath()
    if (!fs.existsSync(modelsPath)) return []
    const raw = fs.readFileSync(modelsPath, 'utf-8')
    const entries = JSON.parse(raw)
    if (!Array.isArray(entries)) return []
    return entries
      .map((entry: unknown): ModelEntry | null => {
        const record = asRecord(entry)
        // models.json uses "model" field for the model ID
        const modelId = readString(record.model) || readString(record.id)
        if (!modelId) return null
        return {
          id: modelId,
          name: readString(record.name) || modelId,
          provider: readString(record.provider) || 'unknown',
        }
      })
      .filter((entry): entry is ModelEntry => entry !== null)
  } catch {
    return []
  }
}

const DEFAULT_ACCEPTED_TIMEOUT_S = 120
const DEFAULT_HANDOFF_TIMEOUT_S = 300

function readStreamTimeouts(): { streamAcceptedTimeoutMs: number; streamHandoffTimeoutMs: number } {
  let acceptedS = DEFAULT_ACCEPTED_TIMEOUT_S
  let handoffS = DEFAULT_HANDOFF_TIMEOUT_S
  try {
    const configPath = getConfigPath()
    if (fs.existsSync(configPath)) {
      const parsed = YAML.parse(fs.readFileSync(configPath, 'utf-8'))
      const ws =
        parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).workspace === 'object'
          ? ((parsed as Record<string, unknown>).workspace as Record<string, unknown>)
          : {}
      if (typeof ws.stream_accepted_timeout === 'number' && ws.stream_accepted_timeout > 0)
        acceptedS = ws.stream_accepted_timeout
      if (typeof ws.stream_handoff_timeout === 'number' && ws.stream_handoff_timeout > 0)
        handoffS = ws.stream_handoff_timeout
    }
  } catch {
    // fall through to defaults
  }
  const envAccepted = parseInt(process.env.STREAM_ACCEPTED_TIMEOUT_MS ?? '', 10)
  const envHandoff = parseInt(process.env.STREAM_HANDOFF_TIMEOUT_MS ?? '', 10)
  return {
    streamAcceptedTimeoutMs: Number.isFinite(envAccepted) && envAccepted > 0 ? envAccepted : acceptedS * 1000,
    streamHandoffTimeoutMs: Number.isFinite(envHandoff) && envHandoff > 0 ? envHandoff : handoffS * 1000,
  }
}

/**
 * Read the default model from active profile's config.yaml using a proper YAML parser.
 */
function readClaudeDefaultModel(): ModelEntry | null {
  try {
    const configPath = getConfigPath()
    if (!fs.existsSync(configPath)) return null
    const raw = fs.readFileSync(configPath, 'utf-8')
    const parsed = YAML.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const config = parsed as Record<string, unknown>
    let modelId = ''
    let provider = ''
    const modelField = config.model
    if (typeof modelField === 'string') {
      modelId = modelField
      provider = (config.provider as string) || 'unknown'
    } else if (modelField && typeof modelField === 'object') {
      const modelObj = modelField as Record<string, unknown>
      modelId = (modelObj.default as string) || ''
      provider =
        (modelObj.provider as string) ||
        (config.provider as string) ||
        'unknown'
    }
    if (!modelId) return null
    return { id: modelId, name: modelId, provider }
  } catch {
    return null
  }
}

/**
 * Fallback: fetch models from the hermes-agent /v1/models endpoint.
 */
async function fetchClaudeModels(gatewayApi = getActiveGatewayApi()): Promise<Array<ModelEntry>> {
  const headers: Record<string, string> = {}
  if (BEARER_TOKEN) headers['Authorization'] = `Bearer ${BEARER_TOKEN}`
  const response = await fetch(`${gatewayApi}/v1/models`, { headers })
  if (!response.ok)
    throw new Error(`Hermes models request failed (${response.status})`)
  const payload = asRecord(await response.json())
  const rawModels = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : []
  return rawModels
    .map(normalizeModel)
    .filter((e): e is ModelEntry => e !== null)
}

export const Route = createFileRoute('/api/models')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        await ensureGatewayProbed()

        try {
          // Primary: read user-configured models from ~/.hermes/models.json
          let models = readClaudeModelsJson()
          let source = 'models.json'

          // Merge static main models and model aliases from the active profile config
          const staticModels = readStaticProfileModels()
          models = mergeModelEntries(models, staticModels)

          // Ensure the default model from config.yaml is always first
          const defaultModel = readClaudeDefaultModel()
          if (defaultModel) {
            models = models.filter((m) => m.id !== defaultModel.id)
            models.unshift(defaultModel)
          }

          // Merge the authoritative Hermes model catalog whenever it is
          // available. Previously, a non-empty models.json stopped here, so the
          // Operations picker only showed the local Workspace subset and drifted
          // from the CLI/backend model universe.
          if (getGatewayCapabilities().models) {
            try {
              const activeGateway = getActiveGatewayApi()
              const hermesModels = await fetchClaudeModels(activeGateway)
              models = mergeModelEntries(models, hermesModels)
              source = source === 'models.json' ? 'models.json+hermes-agent' : 'hermes-agent'
            } catch (err) {
              console.warn('[models-api] Failed to fetch dynamic models from active gateway:', err instanceof Error ? err.message : err)
            }
          }

          // Merge auto-discovered local models (Ollama, Atomic Chat, etc.)
          await ensureDiscovery()
          const localModels = getDiscoveredModels()
          models = mergeModelEntries(models, localModels)
          for (const m of localModels) {
            ensureProviderInConfig(m.provider)
          }

          const configuredProviders = Array.from(
            new Set(
              models
                .map((model) =>
                  typeof model.provider === 'string' ? model.provider : '',
                )
                .filter(Boolean),
            ),
          )

          const streamTimeouts = readStreamTimeouts()

          return json({
            ok: true,
            object: 'list',
            data: models,
            models,
            configuredProviders,
            source,
            ...streamTimeouts,
          })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 503 },
          )
        }
      },
    },
  },
})
