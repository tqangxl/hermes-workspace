import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import * as yaml from 'yaml'
import { isAuthenticated } from '../../server/auth-middleware'
import { getLocalBinDir, getProfilesDir } from '../../server/claude-paths'
import { formatSwarmWorkerLabel, isSwarmWorkerId, resolveSwarmWorkerDisplayName, rosterByWorkerId } from '../../server/swarm-roster'
import type { SwarmRosterWorker } from '../../server/swarm-roster'

// ---- Types ----------------------------------------------------------------

export type WorkerModelAuthStatus =
  | 'ready'               // fully healthy
  | 'gateway-allowlist-missing' // GATEWAY_ALLOW_ALL_USERS not configured
  | 'api-key-invalid'    // API key wrong/expired/403
  | 'fallback-active'   // using fallback model
  | 'not-configured'     // no config at all
  | 'unknown'

export type WorkerHealth = {
  workerId: string
  displayName: string
  humanLabel: string
  role: string
  specialty: string | null
  mission: string | null
  skills: Array<string>
  capabilities: Array<string>
  profileFound: boolean
  wrapperFound: boolean
  model: string
  provider: string
  recentAuthErrors: number   // real API-key errors (401/403)
  recentFallbacks: number
  lastErrorAt: string | null
  lastErrorMessage: string | null
  lastFallbackAt: string | null
  lastFallbackMessage: string | null
  allowlistWarning: boolean   // GATEWAY_ALLOW_ALL_USERS missing
  allowlistWarningMessage: string | null
  modelAuthStatus: WorkerModelAuthStatus
  primaryAuthOk: boolean | null
  fallbackActive: boolean
  fallbackProvider: string | null
  fallbackModel: string | null
}

export type SwarmHealthSummary = {
  totalWorkers: number
  wrappersConfigured: number
  totalApiKeyErrors24h: number
  totalFallbacks24h: number
  workersUsingFallback: number
  workersWithApiKeyErrors: number
  workersWithAllowlistWarning: number
  distinctModels: Array<string>
  distinctProviders: Array<string>
  degraded: boolean
  warnings: Array<string>
}

// ---- Helpers ----------------------------------------------------------------

export function resolveWorkerWrapperName(workerId: string, worker?: Pick<SwarmRosterWorker, 'wrapper'> | null): string {
  return worker?.wrapper?.trim() || workerId
}

function listSwarmIds(): Array<string> {
  const dir = getProfilesDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => isSwarmWorkerId(name))
    .sort()
}

function readWorkerConfig(profilePath: string): { model: string; provider: string } {
  const configPath = join(profilePath, 'config.yaml')
  if (!existsSync(configPath)) return { model: 'unknown', provider: 'unknown' }
  try {
    const raw = yaml.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    const modelVal = raw.model
    if (typeof modelVal === 'object' && modelVal !== null) {
      const obj = modelVal as Record<string, unknown>
      return {
        model: String(obj.default ?? obj.name ?? 'unknown'),
        provider: String(obj.provider ?? raw.provider ?? 'unknown'),
      }
    }
    return {
      model: String(modelVal ?? 'unknown'),
      provider: String(raw.provider ?? 'unknown'),
    }
  } catch {
    return { model: 'unknown', provider: 'unknown' }
  }
}

function formatModelDisplay(model: string, provider: string): string {
  const value = `${model} ${provider}`.toLowerCase()
  if (value.includes('claude-opus-4-7') || value.includes('opus-4-7')) return 'Opus 4.7'
  if (value.includes('claude-opus-4-6') || value.includes('opus-4-6')) return 'Opus 4.6'
  if (value.includes('gpt-5.5')) return 'GPT-5.5'
  if (value.includes('gpt-5.4')) return 'GPT-5.4'
  if (value.includes('gpt-5.3')) return 'GPT-5.3'
  return model === 'unknown' ? provider : model
}

function formatProviderDisplay(provider: string): string {
  const value = provider.toLowerCase()
  if (value.includes('anthropic-billing-proxy')) return 'Anthropic Opus'
  if (value.includes('openai-codex')) return 'OpenAI Codex'
  if (value === 'unknown') return 'Unknown'
  return provider.replace(/^custom:/, '').replace(/[-_]/g, ' ')
}

// ---- Core log parser --------------------------------------------------------

/**
 * Parse errors.log for three distinct failure categories:
 *   1. gateway-allowlist-missing  — GATEWAY_ALLOW_ALL_USERS not set
 *   2. api-key-invalid            — real API key failures (401/403 etc.)
 *   3. fallback-active           — fallback model was used
 *
 * Returns raw counts so the caller can decide what to surface.
 */
export function parseWorkerLogEvents(text: string): {
  apiKeyErrorCount: number
  fallbackCount: number
  allowlistWarningCount: number
  lastApiKeyErrorAt: string | null
  lastApiKeyErrorMessage: string | null
  lastAllowlistWarningAt: string | null
  lastAllowlistWarningMessage: string | null
  lastFallbackAt: string | null
  lastFallbackMessage: string | null
  fallbackProvider: string | null
  fallbackModel: string | null
} {
  // Only trigger on genuine API-key failures (not HTTP header 401s in logs)
  const apiKeyPatterns = [
    /primary provider auth failed/i,
    /no codex credentials/i,
    /no .*oauth token found/i,
    /copilot token validation failed/i,
    /AuthenticationError/i,
    /Error code: (?:401|403)\b/i,    // explicit 401/403 — avoid matching 503/500/502
    /Error code: 403\b/i,
    /^Command failed:/im,              // "Command failed: ..." — real execution failure
    /Command failed:/i,
  ]
  const allowlistPatterns = [
    /GATEWAY_ALLOW_ALL_USERS.*not.*set/i,
    /All unauthorized users will be denied/i,
    /No user allowlists configured/i,
  ]
  const fallbackPatterns = [
    /falling through to fallback:\s*([^/\s]+)\/([^\s]+)/i,
    /fallback:\s*([^/\s]+)\/([^\s]+)/i,
  ]

  let apiKeyErrorCount = 0
  let fallbackCount = 0
  let allowlistWarningCount = 0
  let lastApiKeyErrorAt: string | null = null
  let lastApiKeyErrorMessage: string | null = null
  let lastAllowlistWarningAt: string | null = null
  let lastAllowlistWarningMessage: string | null = null
  let lastFallbackAt: string | null = null
  let lastFallbackMessage: string | null = null
  let fallbackProvider: string | null = null
  let fallbackModel: string | null = null

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const tsMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})(?:,\d{3})?/)
    const ts = tsMatch?.[1] ?? null

    // Allowlist warnings — always count, but they don't make primaryAuthOk = false
    for (const pattern of allowlistPatterns) {
      if (pattern.test(line)) {
        allowlistWarningCount += 1
        lastAllowlistWarningAt = ts
        lastAllowlistWarningMessage = line.slice(0, 320)
        break
      }
    }

    // API key errors — these DO affect primaryAuthOk
    for (const pattern of apiKeyPatterns) {
      if (pattern.test(line)) {
        apiKeyErrorCount += 1
        lastApiKeyErrorAt = ts
        lastApiKeyErrorMessage = line.slice(0, 320)
        break
      }
    }

    // Fallback events
    for (const pattern of fallbackPatterns) {
      const match = line.match(pattern)
      if (!match) continue
      fallbackCount += 1
      fallbackProvider = match[1]
      fallbackModel = match[2]
      lastFallbackAt = ts
      lastFallbackMessage = line.slice(0, 320)
      break
    }
  }

  return {
    apiKeyErrorCount,
    fallbackCount,
    allowlistWarningCount,
    lastApiKeyErrorAt,
    lastApiKeyErrorMessage,
    lastAllowlistWarningAt,
    lastAllowlistWarningMessage,
    lastFallbackAt,
    lastFallbackMessage,
    fallbackProvider,
    fallbackModel,
  }
}

function scanWorkerLog(profilePath: string): ReturnType<typeof parseWorkerLogEvents> {
  const errorsLog = join(profilePath, 'logs', 'errors.log')
  if (!existsSync(errorsLog)) return parseWorkerLogEvents('')
  try {
    const buffer = readFileSync(errorsLog, 'utf-8')
    const tail = buffer.length > 64_000 ? buffer.slice(-64_000) : buffer
    return parseWorkerLogEvents(tail)
  } catch {
    return parseWorkerLogEvents('')
  }
}

function hasOpenAiCodexAuth(profilePath: string): boolean {
  const authPath = join(profilePath, 'auth.json')
  if (!existsSync(authPath)) return false
  try {
    const raw = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, unknown>
    const providers = raw.providers && typeof raw.providers === 'object' ? raw.providers as Record<string, unknown> : raw
    const codex = providers['openai-codex']
    if (!codex || typeof codex !== 'object') return false
    const tokens = (codex as Record<string, unknown>).tokens
    return Boolean(
      tokens &&
      typeof tokens === 'object' &&
      (tokens as Record<string, unknown>).access_token &&
      (tokens as Record<string, unknown>).refresh_token,
    )
  } catch {
    return false
  }
}

// 读 .env 文件，检查 GATEWAY_ALLOW_ALL_USERS 是否已设置
function hasGatewayAllowAllUsers(profilePath: string): boolean {
  const envPath = join(profilePath, '.env')
  if (!existsSync(envPath)) return false
  try {
    const content = readFileSync(envPath, 'utf-8')
    return /\bGATEWAY_ALLOW_ALL_USERS\s*=\s*(?:true|1|yes|on)/i.test(content)
  } catch {
    return false
  }
}

// ---- Derived status helpers -------------------------------------------------

function deriveStatus(
  log: ReturnType<typeof parseWorkerLogEvents>,
  config: { model: string; provider: string },
  profilePath: string,
): { modelAuthStatus: WorkerModelAuthStatus; primaryAuthOk: boolean | null; allowlistWarning: boolean; allowlistWarningMessage: string | null } {
  const { apiKeyErrorCount, fallbackCount, allowlistWarningCount } = log
  // 优先读配置文件判断，不依赖旧日志
  const hasAllowlistConfig = hasGatewayAllowAllUsers(profilePath)
  const hasApiKeyError = apiKeyErrorCount > 0
  const hasFallback = fallbackCount > 0
  const isCodex = config.provider === 'openai-codex'

  // API key 错误优先
  if (hasApiKeyError) {
    return {
      modelAuthStatus: 'api-key-invalid',
      primaryAuthOk: false,
      allowlistWarning: !hasAllowlistConfig,
      allowlistWarningMessage: !hasAllowlistConfig ? 'GATEWAY_ALLOW_ALL_USERS 未配置' : null,
    }
  }
  if (hasFallback) {
    return {
      modelAuthStatus: 'fallback-active',
      primaryAuthOk: false,
      allowlistWarning: !hasAllowlistConfig,
      allowlistWarningMessage: !hasAllowlistConfig ? 'GATEWAY_ALLOW_ALL_USERS 未配置' : null,
    }
  }
  // 配置里没有 allowall 才显示警告
  if (!hasAllowlistConfig) {
    return {
      modelAuthStatus: 'gateway-allowlist-missing',
      primaryAuthOk: true,
      allowlistWarning: true,
      allowlistWarningMessage: 'GATEWAY_ALLOW_ALL_USERS 未配置 — gateway dispatch 会被阻止',
    }
  }
  // 完全健康
  return {
    modelAuthStatus: isCodex && !hasOpenAiCodexAuth(profilePath) ? 'not-configured' : 'ready',
    primaryAuthOk: true,
    allowlistWarning: false,
    allowlistWarningMessage: null,
  }
}

// ---- Summary ---------------------------------------------------------------

export function summarizeSwarmHealth(workers: Array<WorkerHealth>): SwarmHealthSummary {
  const workersWithApiKeyErrors = workers.filter((w) => w.recentAuthErrors > 0).length
  const workersWithAllowlistWarning = workers.filter((w) => w.allowlistWarning).length
  const workersUsingFallback = workers.filter((w) => w.fallbackActive).length
  const distinctModels = Array.from(new Set(workers.map((w) => formatModelDisplay(w.model, w.provider)))).filter((v) => v !== 'unknown')
  const distinctProviders = Array.from(new Set(workers.map((w) => formatProviderDisplay(w.provider)))).filter((v) => v !== 'unknown')
  const totalApiKeyErrors = workers.reduce((s, w) => s + w.recentAuthErrors, 0)
  const totalFallbacks = workers.reduce((s, w) => s + w.recentFallbacks, 0)

  const warnings: Array<string> = []
  if (workersWithAllowlistWarning > 0) {
    warnings.push(`${workersWithAllowlistWarning} worker(s) missing GATEWAY_ALLOW_ALL_USERS — add it to ~/.hermes/.env or the worker profile .env to allow dispatch.`)
  }
  if (workersWithApiKeyErrors > 0) {
    warnings.push(`${workersWithApiKeyErrors} worker(s) have invalid API keys — check key_env / api_key in config.yaml and .env.`)
  }
  if (workersUsingFallback > 0) {
    warnings.push(`${workersUsingFallback} worker(s) fell back to an alternative model — primary model auth is degraded.`)
  }

  return {
    totalWorkers: workers.length,
    wrappersConfigured: workers.filter((w) => w.wrapperFound).length,
    totalApiKeyErrors24h: totalApiKeyErrors,
    totalFallbacks24h: totalFallbacks,
    workersUsingFallback,
    workersWithApiKeyErrors,
    workersWithAllowlistWarning,
    distinctModels,
    distinctProviders,
    degraded: workersWithApiKeyErrors > 0 || workersUsingFallback > 0 || workersWithAllowlistWarning > 0,
    warnings,
  }
}

// ---- Route -----------------------------------------------------------------

export const Route = createFileRoute('/api/swarm-health')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        const workspaceModel = formatModelDisplay(
          process.env.HERMES_DEFAULT_MODEL ?? process.env.CLAUDE_DEFAULT_MODEL ?? 'unknown',
          (process.env.HERMES_API_URL ?? process.env.CLAUDE_API_URL)?.includes('anthropic') ? 'anthropic' : 'unknown',
        )
        const apiUrl = process.env.HERMES_API_URL ?? process.env.CLAUDE_API_URL ?? null
        const profilesBase = getProfilesDir()
        const swarmIds = listSwarmIds()
        const wrapperBase = getLocalBinDir()
        const roster = rosterByWorkerId(swarmIds)

        const workers: Array<WorkerHealth> = swarmIds.map((id) => {
          const worker = roster.get(id)
          // getProfilesDir() 返回 profiles 根目录，workers 在 profilesBase/profiles/<id>/
          const profilePath = join(profilesBase, 'profiles', id)
          const wrapperName = resolveWorkerWrapperName(id, worker)
          const profileWrapper = join(profilePath, wrapperName)
          const localBinWrapper = join(wrapperBase, wrapperName)
          const wrapperFound =
            existsSync(profileWrapper) ||
            (process.platform === 'win32' && existsSync(`${profileWrapper}.bat`)) ||
            existsSync(localBinWrapper) ||
            (process.platform === 'win32' && existsSync(`${localBinWrapper}.bat`))
          const config = readWorkerConfig(profilePath)
          const log = scanWorkerLog(profilePath)
          const { modelAuthStatus, primaryAuthOk, allowlistWarning, allowlistWarningMessage } = deriveStatus(log, config, profilePath)

          return {
            workerId: id,
            displayName: resolveSwarmWorkerDisplayName(id, worker),
            humanLabel: formatSwarmWorkerLabel(id, worker),
            role: worker?.role?.trim() || 'Worker',
            specialty: worker?.specialty?.trim() || null,
            mission: worker?.mission?.trim() || null,
            skills: worker?.skills?.length ? worker.skills : [],
            capabilities: worker?.capabilities?.length ? worker.capabilities : [],
            profileFound: existsSync(profilePath),
            wrapperFound,
            model: config.model,
            provider: config.provider,
            recentAuthErrors: log.apiKeyErrorCount,
            recentFallbacks: log.fallbackCount,
            lastErrorAt: log.lastApiKeyErrorAt,
            lastErrorMessage: log.lastApiKeyErrorMessage,
            lastFallbackAt: log.lastFallbackAt,
            lastFallbackMessage: log.lastFallbackMessage,
            allowlistWarning,
            allowlistWarningMessage,
            modelAuthStatus,
            primaryAuthOk,
            fallbackActive: log.fallbackCount > 0,
            fallbackProvider: log.fallbackProvider,
            fallbackModel: log.fallbackModel,
          }
        })

        const summary = summarizeSwarmHealth(workers)

        return json({ checkedAt: Date.now(), workspaceModel, agentApiUrl: apiUrl, claudeApiUrl: apiUrl, workers, summary })
      },
    },
  },
})
