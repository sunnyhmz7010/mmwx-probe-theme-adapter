import { mkdtemp, mkdir, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

import { RUNTIME_DIR, type AppConfig } from '../config.js'
import { createLogger, type Logger } from '../log.js'
import { acquireTheme } from './repository.js'
import { buildTheme, detectBuildPlan } from './builder.js'
import type { LoadedTheme, ThemeSource } from './types.js'

interface ThemeManifest {
  short?: unknown
  config?: unknown
  configuration?: unknown
  [key: string]: unknown
}

interface ThemeConfigurationItem {
  key?: unknown
  type?: unknown
  default?: unknown
  options?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function defaultThemeSettingValue(item: ThemeConfigurationItem): unknown {
  const type = stringOrUndefined(item.type)?.toLowerCase()
  if (type === 'switch' || type === 'boolean') return false
  if (type === 'number' || type === 'integer' || type === 'slider') return 0
  if (type === 'select' || type === 'radio') {
    const options = item.options
    if (Array.isArray(options) && options.length > 0) {
      const first = options[0]
      if (isRecord(first)) {
        const value = first.value ?? first.key ?? first.label ?? first.name
        if (value !== undefined) return value
      }
      return first
    }
    return ''
  }
  return ''
}

async function readThemeDocumentTitle(indexPath: string): Promise<string | undefined> {
  try {
    const html = await readFile(indexPath, 'utf8')
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (!match) return undefined
    const title = match[1].trim()
    return title || undefined
  } catch {
    return undefined
  }
}

function manifestThemeSettings(manifest: ThemeManifest | null): Record<string, unknown> | null {
  if (!manifest) return null
  const configuration = isRecord(manifest.configuration) ? manifest.configuration : undefined
  const rawData = manifest.config ?? configuration?.data
  if (!Array.isArray(rawData)) {
    if (isRecord(rawData)) return rawData
    return null
  }

  const settings: Record<string, unknown> = {}
  for (const item of rawData) {
    if (!isRecord(item)) continue
    const key = stringOrUndefined(item.key)
    if (!key) continue
    if (Object.prototype.hasOwnProperty.call(item, 'default') && item.default !== undefined) {
      settings[key] = item.default
      continue
    }
    settings[key] = defaultThemeSettingValue(item)
  }
  return settings
}

async function readThemeManifest(repoDir: string): Promise<{ kind: 'komari' | 'monitor'; manifest: ThemeManifest | null }> {
  for (const [kind, filename] of [['komari', 'komari-theme.json'], ['monitor', 'theme.json']] as const) {
    try {
      const manifest: unknown = JSON.parse(await readFile(path.join(repoDir, filename), 'utf8'))
      if (!isRecord(manifest)) throw new Error(`Theme ${filename} must be an object`)
      if (kind === 'monitor' && (!stringOrUndefined(manifest.short) || !Array.isArray(manifest.config))) {
        throw new Error('Monitor theme.json must declare short and config')
      }
      return { kind, manifest }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      if (error instanceof SyntaxError) throw new Error(`Theme ${filename} is not valid JSON`)
      throw error
    }
  }
  return { kind: 'komari', manifest: null }
}

function themeConfigurationSummary(manifest: ThemeManifest | null): { configuration: string; fields: number } {
  if (Array.isArray(manifest?.config)) return { configuration: 'managed', fields: manifest.config.length }
  const configuration = isRecord(manifest?.configuration) ? manifest.configuration : undefined
  if (!configuration) return { configuration: 'none', fields: 0 }
  const type = stringOrUndefined(configuration.type)?.toLowerCase() || 'managed'
  const data = configuration.data
  return { configuration: type, fields: Array.isArray(data) ? data.length : isRecord(data) ? Object.keys(data).length : 0 }
}

export async function readThemeMetadata(repoDir: string): Promise<{ kind: 'komari' | 'monitor'; short?: string; manifest: Record<string, unknown> | null; themeSettings: Record<string, unknown> | null }> {
  const { kind, manifest } = await readThemeManifest(repoDir)
  return {
    kind,
    short: stringOrUndefined(manifest?.short),
    manifest,
    themeSettings: manifestThemeSettings(manifest),
  }
}

export async function loadTheme(config: AppConfig, logger: Logger = createLogger([config.probeToken])): Promise<LoadedTheme> {
  const source: ThemeSource = {
    repoUrl: config.themeRepo,
    ref: config.themeRef,
    gitProxy: config.themeGitProxy || undefined,
  }
  const themesDir = path.resolve(RUNTIME_DIR, 'themes')
  const currentDir = path.join(themesDir, 'current')
  await mkdir(themesDir, { recursive: true })
  const workspace = await mkdtemp(path.join(themesDir, '.theme-'))
  const repoDir = path.join(workspace, 'repo')
  const outputDir = path.join(workspace, 'output')

  try {
    logger.info('主题加载开始', { repository: source.repoUrl, ref: source.ref })
    await acquireTheme(source, repoDir, logger)
    const metadata = await readThemeMetadata(repoDir)
    logger.info('主题配置声明已读取', {
      short: metadata.short || 'unknown',
      kind: metadata.kind,
      ...themeConfigurationSummary(metadata.manifest),
    })
    const plan = await detectBuildPlan(repoDir)
    logger.info('主题构建计划已确定', {
      packageManager: plan.packageManager,
      installCommand: plan.installArgs.join(' ') || 'none',
      buildCommand: plan.buildArgs.join(' ') || 'none',
      outputCandidates: plan.outputCandidates.join(','),
    })
    await buildTheme(plan, repoDir, outputDir, logger)
    const title = await readThemeDocumentTitle(path.join(outputDir, 'index.html'))

    const previousDir = `${currentDir}.previous-${Date.now()}`
    await rm(previousDir, { recursive: true, force: true })
    try {
      await rename(currentDir, previousDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(outputDir, currentDir)
    await rm(previousDir, { recursive: true, force: true })
    logger.info('主题加载完成', { directory: currentDir, indexPath: path.join(currentDir, 'index.html') })
    return {
      directory: currentDir,
      kind: metadata.kind,
      indexPath: path.join(currentDir, 'index.html'),
      title,
      short: metadata.short,
      manifest: metadata.manifest,
      themeSettings: metadata.themeSettings,
      source,
    }
  } catch (error: unknown) {
    logger.error('主题加载失败', {
      reason: error instanceof Error ? error.message : 'unknown error',
      repository: source.repoUrl,
      ref: source.ref,
    })
    throw error
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}
