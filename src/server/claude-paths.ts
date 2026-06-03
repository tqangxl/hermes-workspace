import { homedir } from 'node:os'
import { dirname, join, normalize, sep } from 'node:path'
import { existsSync } from 'node:fs'

function isProfilesChild(pathValue: string): boolean {
  const parts = normalize(pathValue).split(sep).filter(Boolean)
  return parts.length >= 2 && parts.at(-2) === 'profiles'
}

function isProfileHome(pathValue: string): boolean {
  const parts = normalize(pathValue).split(sep).filter(Boolean)
  return parts.length >= 3 && parts.at(-3) === 'profiles' && parts.at(-1) === 'home'
}

function hermesRootFromProfile(pathValue: string): string | null {
  if (isProfilesChild(pathValue)) {
    return dirname(dirname(pathValue))
  }
  if (isProfileHome(pathValue)) {
    return dirname(dirname(dirname(pathValue)))
  }
  return null
}

export function getHermesRoot(): string {
  const envHome = process.env.HERMES_HOME || process.env.CLAUDE_HOME
  if (envHome) {
    const profileRoot = hermesRootFromProfile(envHome)
    if (profileRoot) return profileRoot
    return envHome
  }

  const osHome = homedir()
  const profileRoot = hermesRootFromProfile(osHome)
  if (profileRoot) return profileRoot
  return join(osHome, '.hermes')
}

// 自动检测 profiles 目录布局，兼容两种结构：
//   Layout A: HERMES_HOME = D:\ai\hermes\profiles
//            hermesRoot = D:\ai\hermes (检测到 profiles 子目录自动回溯)
//            workers = D:\ai\hermes\profiles\{workerId}\
//   Layout B: HERMES_HOME = D:\ai\hermes
//            hermesRoot = D:\ai\hermes
//            workers = D:\ai\hermes\profiles\{workerId}\
//   Layout C: HERMES_HOME = D:\ai\hermes\profiles
//            hermesRoot = D:\ai\hermes
//            workers = D:\ai\hermes\profiles\profiles\{workerId}\
// 检测方式：同时检查 HERMES_HOME 和 hermesRoot/profiles/ 两个路径，
// 以实际存在 worker 的那个为准（优先 HERMES_HOME，再 fallback 到 hermesRoot/profiles/）
const _profilesDir = (() => {
  const envHome = process.env.HERMES_HOME || process.env.CLAUDE_HOME
  const hermesRoot = getHermesRoot()

  // candidateA: HERMES_HOME 本身就是 profiles 目录
  // hermes.exe 会把这种情况当作 hermes root，往上两级找根目录
  const candidateA = envHome || hermesRoot
  // candidateB: hermesRoot/profiles/ — 标准布局
  const candidateB = join(hermesRoot, 'profiles')

  const testWorkers = ['jamestang', 'orchestrator', 'builder']
  const workersExistAt = (base: string): string | null => {
    for (const worker of testWorkers) {
      if (existsSync(join(base, worker))) return base
    }
    return null
  }

  // 优先：HERMES_HOME 就是 profiles 目录
  if (envHome && workersExistAt(envHome) && workersExistAt(envHome) === envHome) {
    return envHome
  }

  // 其次：HERMES_HOME/profiles/<worker> — HERMES_HOME 是 profiles root
  const deeperA = join(envHome || hermesRoot, 'profiles')
  if (envHome && workersExistAt(deeperA) === deeperA) {
    return deeperA
  }

  // 标准：hermesRoot/profiles/<worker>
  if (workersExistAt(candidateB) === candidateB) {
    return candidateB
  }

  // 降级：HERMES_HOME 本身（Layout A）
  if (envHome && workersExistAt(envHome) === envHome) {
    return envHome
  }

  // 最终 fallback
  return candidateB || envHome || hermesRoot
})()

export function getProfilesDir(): string {
  return _profilesDir
}

export function getWorkspaceHermesHome(): string {
  return getHermesRoot()
}

export function getProfileHermesHome(profileId: string): string {
  return join(getProfilesDir(), profileId)
}

export function getUserHomeForHermesRoot(): string {
  const root = getHermesRoot()
  if (root.endsWith(`${sep}.hermes`)) return dirname(root)
  return homedir()
}

export function getLocalBinDir(): string {
  return join(getUserHomeForHermesRoot(), '.local', 'bin')
}

// Legacy aliases for callers not yet renamed.
export const getClaudeRoot = getHermesRoot
export const getWorkspaceClaudeHome = getWorkspaceHermesHome
export const getProfileClaudeHome = getProfileHermesHome
export const getUserHomeForClaudeRoot = getUserHomeForHermesRoot
