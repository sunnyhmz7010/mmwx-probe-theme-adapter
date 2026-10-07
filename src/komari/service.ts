import type { MmwxMetricPoint, MmwxProbeSeriesBucket, MmwxSystemMetricSeries, MmwxSystemSeriesPoint, ProbeAppearance, ProbeBucket, ProbeDailyTraffic, ProbePayload, ProbeReturnRoute, ProbeSeriesPayload, ProbeServer, SeriesQuery } from '../mmwx/types.js'
import type { ProbeHistoryBuffer } from '../mmwx/history-buffer.js'
import type { FileThemeSettingsStore } from '../theme/settings-store.js'
import { validateMonitorSettings } from '../theme/settings-store.js'
import { ADAPTER_VERSION } from '../version.js'
import {
  toKomariLoadRecords,
  toKomariNode,
  toKomariNodeStatusMap,
  toKomariPublicNodes,
  toKomariRecentStatusRecords,
  toKomariRecord,
  toKomariPingRecords,
  toLoadHistory,
  toPingHistory,
  toPingSeriesHistory,
  toSystemMetricHistory,
} from './mapper.js'
import type {
  KomariCommonRecords,
  KomariLoadRecords,
  KomariMetricPoint,
  KomariMetricSeries,
  KomariMeInfo,
  KomariNodeStatus,
  KomariNodeStatusMap,
  KomariPingMetricStat,
  KomariPingMetricStats,
  KomariPingRecords,
  KomariPublicPingTask,
  KomariPublicNode,
  KomariPublicSettings,
  KomariRecentStatusResp,
  KomariSnapshot,
  KomariQueryMetrics,
  KomariVersionInfo,
  LoadHistory,
  LoadHistoryRecord,
  PingHistory,
  PingHistoryRecord,
  PingTask,
} from './types.js'

interface DataClient {
  fetchProbe(): Promise<ProbePayload>
  fetchSeries(query: SeriesQuery): Promise<ProbeSeriesPayload>
}

interface ThemeSource {
  repoUrl: string
  ref: string
  themeTitle?: string
  themeShort?: string
  themeSettings?: Record<string, unknown> | null
  themeSettingsStore?: FileThemeSettingsStore
  themeManifest?: Record<string, unknown> | null
}

interface SnapshotValue {
  snapshot: KomariSnapshot
  payload: ProbePayload
}

interface SeriesCacheEntry {
  expiresAt: number
  payload: ProbeSeriesPayload
}

const BUILD_HASH = process.env.GITHUB_SHA?.trim() || process.env.GIT_COMMIT?.trim() || 'unknown'
const SERIES_CACHE_TTL_MS = 30_000
const SERIES_CACHE_MAX_ENTRIES = 128

function numberOrUndefined(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const numeric = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

function firstFinite(values: readonly unknown[]): number | undefined {
  for (const value of values) {
    const numeric = numberOrUndefined(value)
    if (numeric !== undefined) return numeric
  }
  return undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed ? trimmed : undefined
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function dateOnlyOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value === 'number') {
    const timestamp = value > 1e12 ? value : value * 1000
    return new Date(timestamp).toISOString().slice(0, 10)
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const dateMatch = trimmed.match(/^(\d{4}-\d{2}-\d{2})/)
    if (dateMatch) return dateMatch[1]
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      const timestamp = numeric > 1e12 ? numeric : numeric * 1000
      return new Date(timestamp).toISOString().slice(0, 10)
    }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString().slice(0, 10)
  }
  return undefined
}

function dateTimeOrUndefined(value: unknown): string | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value === 'number') {
    const timestamp = value > 1e12 ? value : value * 1000
    return new Date(timestamp).toISOString()
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric)) {
      const timestamp = numeric > 1e12 ? numeric : numeric * 1000
      return new Date(timestamp).toISOString()
    }
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return undefined
}

function themeNameFromSource(source?: ThemeSource): string {
  const short = stringOrUndefined(source?.themeShort)
  if (short) return short
  const repoName = source?.repoUrl
    ?.split('/')
    .filter(Boolean)
    .at(-1)
    ?.replace(/\.git$/i, '')
    ?.trim()
  if (!repoName) return 'pixel'
  const normalized = repoName.replace(/^komari-theme-/i, '').replace(/_/g, '-').trim()
  return normalized || 'pixel'
}

function themeTitleFromSource(source?: ThemeSource): string {
  const title = stringOrUndefined(source?.themeTitle)
  if (title) return title
  return themeNameFromSource(source)
}

function normalizeProbeAppearance(input: ProbeAppearance | null | undefined, source?: ThemeSource): NonNullable<ProbePayload['appearance']> {
  return {
    theme: stringOrUndefined(input?.theme) || themeNameFromSource(source),
    color_mode: input?.color_mode === 'dark' || input?.color_mode === 'system' ? input.color_mode : 'light',
    revision: stringOrUndefined(input?.revision) || stringOrUndefined(source?.ref),
  }
}

function normalizeProbeLicenseBadge(input: ProbePayload['license_badge']): ProbePayload['license_badge'] | undefined {
  const name = stringOrUndefined(input?.name)
  const displayName = stringOrUndefined(input?.display_name)
  if (!name && !displayName) return undefined
  return {
    ...(name ? { name } : {}),
    ...(displayName ? { display_name: displayName } : {}),
  }
}

function normalizeDailyTraffic(rows: ProbeServer['daily_traffic']): ProbeDailyTraffic[] {
  const result: ProbeDailyTraffic[] = []
  for (const row of rows ?? []) {
    const date = dateOnlyOrUndefined(row?.date)
    if (!date) continue
    const uplink = numberOrUndefined(row?.uplink) ?? 0
    const downlink = numberOrUndefined(row?.downlink) ?? 0
    result.push({
      date,
      uplink,
      downlink,
      total: numberOrUndefined(row?.total) ?? uplink + downlink,
    })
  }
  return result
}

function normalizePingBuckets(input: ProbeBucket['buckets']): MmwxProbeSeriesBucket[] {
  const buckets: MmwxProbeSeriesBucket[] = []
  for (const bucket of input ?? []) {
    const ms = numberOrUndefined(bucket?.ms)
    const loss = numberOrUndefined(bucket?.loss)
    if (ms === undefined && loss === undefined) continue
    buckets.push({
      ...(ms !== undefined ? { ms } : {}),
      ...(loss !== undefined ? { loss } : {}),
    })
  }
  return buckets
}

function normalizeProbePingSeries(input: ProbeBucket, index: number): ProbeBucket {
  const label = stringOrUndefined(input.label) || stringOrUndefined(input.name) || stringOrUndefined(input.key) || `Ping ${index + 1}`
  const currentMs = numberOrUndefined(input.current_ms ?? input.value ?? input.latency)
  const lossPct = numberOrUndefined(input.loss_pct ?? input.loss)
  const buckets = normalizePingBuckets(input.buckets)
  if (buckets.length === 0 && (currentMs !== undefined || lossPct !== undefined)) {
    buckets.push({
      ...(currentMs !== undefined ? { ms: currentMs } : {}),
      ...(lossPct !== undefined ? { loss: lossPct } : {}),
    })
  }
  return {
    ...(stringOrUndefined(input.key) ? { key: stringOrUndefined(input.key) } : {}),
    label,
    ...(stringOrUndefined(input.isp) ? { isp: stringOrUndefined(input.isp) } : {}),
    current_ms: currentMs ?? -1,
    loss_pct: lossPct ?? 0,
    buckets,
  }
}

function normalizeReturnRoute(input: ProbeReturnRoute): ProbeReturnRoute | undefined {
  const routeType = stringOrUndefined(input.route_type ?? input.name ?? input.host ?? input.region ?? input.country)
  const carrier = stringOrUndefined(input.carrier)
  const region = stringOrUndefined(input.region)
  const testedAt = dateTimeOrUndefined(input.tested_at)
  const name = stringOrUndefined(input.name)
  const host = stringOrUndefined(input.host)
  const country = stringOrUndefined(input.country)
  const latency = numberOrUndefined(input.latency)
  const loss = numberOrUndefined(input.loss)
  if (!routeType && !carrier && !region && !testedAt && !name && !host && !country && latency === undefined && loss === undefined) return undefined
  return {
    ...(carrier ? { carrier } : {}),
    ...(region ? { region } : {}),
    ...(routeType ? { route_type: routeType } : {}),
    ...(testedAt ? { tested_at: testedAt } : {}),
    ...(name ? { name } : {}),
    ...(host ? { host } : {}),
    ...(country ? { country } : {}),
    ...(latency !== undefined ? { latency } : {}),
    ...(loss !== undefined ? { loss } : {}),
  }
}

function normalizeProbeServer(server: ProbeServer, index: number): ProbeServer {
  const periodStart = dateOnlyOrUndefined(server.period_start)
  const periodEnd = dateOnlyOrUndefined(server.period_end)
  const dailyTrafficStart = dateOnlyOrUndefined(server.daily_traffic_start)
  const dailyTrafficEnd = dateOnlyOrUndefined(server.daily_traffic_end)
  const expiresAt = dateOnlyOrUndefined(server.expires_at)
  const routes = server.return_routes ?? server.routes
  const trafficPeriod = stringOrUndefined(server.trafficPeriod) || (periodStart && periodEnd ? `${periodStart}/${periodEnd}` : undefined)
  const dailyTraffic = normalizeDailyTraffic(server.daily_traffic)
  const returnRoutes = routes?.map((route) => normalizeReturnRoute(route)).filter((route): route is ProbeReturnRoute => route !== undefined)
  const ping = server.ping?.map(normalizeProbePingSeries)
  return {
    id: server.id,
    name: stringOrUndefined(server.name) || stringOrUndefined(server.host) || `MMWX Node ${index + 1}`,
    ...(stringOrUndefined(server.host) ? { host: stringOrUndefined(server.host) } : {}),
    ...(stringOrUndefined(server.cpu_name) ? { cpu_name: stringOrUndefined(server.cpu_name) } : {}),
    ...(stringOrUndefined(server.cpu_model ?? server.cpu_name) ? { cpu_model: stringOrUndefined(server.cpu_model ?? server.cpu_name) } : {}),
    ...(stringOrUndefined(server.virtualization) ? { virtualization: stringOrUndefined(server.virtualization) } : {}),
    ...(stringOrUndefined(server.arch) ? { arch: stringOrUndefined(server.arch) } : {}),
    ...(numberOrUndefined(server.cpu_cores) !== undefined ? { cpu_cores: numberOrUndefined(server.cpu_cores) } : {}),
    ...(numberOrUndefined(server.cpu_physical_cores) !== undefined ? { cpu_physical_cores: numberOrUndefined(server.cpu_physical_cores) } : {}),
    ...(numberOrUndefined(server.cpu_threads) !== undefined ? { cpu_threads: numberOrUndefined(server.cpu_threads) } : {}),
    ...(stringOrUndefined(server.os) ? { os: stringOrUndefined(server.os) } : {}),
    ...(stringOrUndefined(server.kernel_version) ? { kernel_version: stringOrUndefined(server.kernel_version) } : {}),
    ...(stringOrUndefined(server.kernel) ? { kernel: stringOrUndefined(server.kernel) } : {}),
    ...(stringOrUndefined(server.gpu_name) ? { gpu_name: stringOrUndefined(server.gpu_name) } : {}),
    ...(numberOrUndefined(server.gpu) !== undefined ? { gpu: numberOrUndefined(server.gpu) } : {}),
    ...(stringOrUndefined(server.region) ? { region: stringOrUndefined(server.region) } : {}),
    ...(stringOrUndefined(server.region_country) ? { region_country: stringOrUndefined(server.region_country) } : {}),
    ...(stringOrUndefined(server.region_name) ? { region_name: stringOrUndefined(server.region_name) } : {}),
    ...(stringOrUndefined(server.region_city) ? { region_city: stringOrUndefined(server.region_city) } : {}),
    ...(stringOrUndefined(server.provider_name) ? { provider_name: stringOrUndefined(server.provider_name) } : {}),
    ...(stringOrUndefined(server.provider_url) ? { provider_url: stringOrUndefined(server.provider_url) } : {}),
    ...(stringOrUndefined(server.country) ? { country: stringOrUndefined(server.country) } : {}),
    ...(stringOrUndefined(server.revision) ? { revision: stringOrUndefined(server.revision) } : {}),
    online: server.online !== false,
    ...(numberOrUndefined(server.cpu) !== undefined ? { cpu: numberOrUndefined(server.cpu) } : {}),
    ...(numberOrUndefined(server.cpu_pct) !== undefined ? { cpu_pct: numberOrUndefined(server.cpu_pct) } : {}),
    ...(numberOrUndefined(server.memory) !== undefined ? { memory: numberOrUndefined(server.memory) } : {}),
    ...(numberOrUndefined(server.mem_used) !== undefined ? { mem_used: numberOrUndefined(server.mem_used) } : {}),
    ...(numberOrUndefined(server.mem_total) !== undefined ? { mem_total: numberOrUndefined(server.mem_total) } : {}),
    ...(numberOrUndefined(server.swap) !== undefined ? { swap: numberOrUndefined(server.swap) } : {}),
    ...(numberOrUndefined(server.swap_total) !== undefined ? { swap_total: numberOrUndefined(server.swap_total) } : {}),
    ...(numberOrUndefined(server.disk_used) !== undefined ? { disk_used: numberOrUndefined(server.disk_used) } : {}),
    ...(numberOrUndefined(server.disk_total) !== undefined ? { disk_total: numberOrUndefined(server.disk_total) } : {}),
    ...(Array.isArray(server.load) ? { load: server.load.map((value) => numberOrUndefined(value) ?? value) } : stringOrUndefined(server.loadavg) ? { loadavg: stringOrUndefined(server.loadavg) } : numberOrUndefined(server.load) !== undefined ? { load: numberOrUndefined(server.load) } : {}),
    ...(numberOrUndefined(server.temp) !== undefined ? { temp: numberOrUndefined(server.temp) } : {}),
    ...(numberOrUndefined(server.upload) !== undefined ? { upload: numberOrUndefined(server.upload) } : {}),
    ...(numberOrUndefined(server.upload_speed) !== undefined ? { upload_speed: numberOrUndefined(server.upload_speed) } : {}),
    ...(numberOrUndefined(server.download) !== undefined ? { download: numberOrUndefined(server.download) } : {}),
    ...(numberOrUndefined(server.download_speed) !== undefined ? { download_speed: numberOrUndefined(server.download_speed) } : {}),
    ...(numberOrUndefined(server.uplink) !== undefined ? { uplink: numberOrUndefined(server.uplink) } : {}),
    ...(numberOrUndefined(server.downlink) !== undefined ? { downlink: numberOrUndefined(server.downlink) } : {}),
    ...(numberOrUndefined(server.totalUpload) !== undefined ? { totalUpload: numberOrUndefined(server.totalUpload) } : {}),
    ...(numberOrUndefined(server.totalDownload) !== undefined ? { totalDownload: numberOrUndefined(server.totalDownload) } : {}),
    ...(numberOrUndefined(server.net_total_up) !== undefined ? { net_total_up: numberOrUndefined(server.net_total_up) } : {}),
    ...(numberOrUndefined(server.net_total_down) !== undefined ? { net_total_down: numberOrUndefined(server.net_total_down) } : {}),
    ...(trafficPeriod ? { trafficPeriod } : {}),
    ...(dailyTraffic.length > 0 ? { daily_traffic: dailyTraffic } : {}),
    ...(stringOrUndefined(server.traffic_source) ? { traffic_source: stringOrUndefined(server.traffic_source) } : {}),
    ...(stringOrUndefined(server.traffic_used_scope) ? { traffic_used_scope: stringOrUndefined(server.traffic_used_scope) } : {}),
    ...(numberOrUndefined(server.traffic_adjustment) !== undefined ? { traffic_adjustment: numberOrUndefined(server.traffic_adjustment) } : {}),
    ...(numberOrUndefined(server.boot_traffic_up) !== undefined ? { boot_traffic_up: numberOrUndefined(server.boot_traffic_up) } : {}),
    ...(numberOrUndefined(server.boot_traffic_down) !== undefined ? { boot_traffic_down: numberOrUndefined(server.boot_traffic_down) } : {}),
    ...(stringOrUndefined(server.boot_traffic_scope) ? { boot_traffic_scope: stringOrUndefined(server.boot_traffic_scope) } : {}),
    ...(numberOrUndefined(server.cumulative_up) !== undefined ? { cumulative_up: numberOrUndefined(server.cumulative_up) } : {}),
    ...(numberOrUndefined(server.cumulative_down) !== undefined ? { cumulative_down: numberOrUndefined(server.cumulative_down) } : {}),
    ...(stringOrUndefined(server.cumulative_traffic_scope) ? { cumulative_traffic_scope: stringOrUndefined(server.cumulative_traffic_scope) } : {}),
    ...(stringOrUndefined(server.daily_traffic_scope) ? { daily_traffic_scope: stringOrUndefined(server.daily_traffic_scope) } : {}),
    ...(dailyTrafficStart ? { daily_traffic_start: dailyTrafficStart } : {}),
    ...(dailyTrafficEnd ? { daily_traffic_end: dailyTrafficEnd } : {}),
    ...(stringOrUndefined(server.traffic_stats_mode) ? { traffic_stats_mode: stringOrUndefined(server.traffic_stats_mode) } : {}),
    ...(numberOrUndefined(server.traffic_used_up) !== undefined ? { traffic_used_up: numberOrUndefined(server.traffic_used_up) } : {}),
    ...(numberOrUndefined(server.traffic_used_down) !== undefined ? { traffic_used_down: numberOrUndefined(server.traffic_used_down) } : {}),
    ...(numberOrUndefined(server.traffic_used_total) !== undefined ? { traffic_used_total: numberOrUndefined(server.traffic_used_total) } : {}),
    ...(numberOrUndefined(server.traffic_used) !== undefined ? { traffic_used: numberOrUndefined(server.traffic_used) } : {}),
    ...(periodStart ? { period_start: periodStart } : {}),
    ...(periodEnd ? { period_end: periodEnd } : {}),
    ...(numberOrUndefined(server.process) !== undefined ? { process: numberOrUndefined(server.process) } : {}),
    ...(numberOrUndefined(server.tcp_connections) !== undefined ? { tcp_connections: numberOrUndefined(server.tcp_connections) } : {}),
    ...(numberOrUndefined(server.udp_connections) !== undefined ? { udp_connections: numberOrUndefined(server.udp_connections) } : {}),
    ...(numberOrUndefined(server.uptime) !== undefined ? { uptime: numberOrUndefined(server.uptime) } : {}),
    ...(numberOrUndefined(server.weight) !== undefined ? { weight: numberOrUndefined(server.weight) } : {}),
    ...(numberOrUndefined(server.price) !== undefined ? { price: numberOrUndefined(server.price) } : {}),
    ...(numberOrUndefined(server.billing_cycle) !== undefined ? { billing_cycle: numberOrUndefined(server.billing_cycle) } : {}),
    auto_renewal: server.auto_renewal === true,
    ...(stringOrUndefined(server.currency) ? { currency: stringOrUndefined(server.currency) } : {}),
    ...(dateOnlyOrUndefined(server.expired_at) ? { expired_at: dateOnlyOrUndefined(server.expired_at) } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(numberOrUndefined(server.renewal_price) !== undefined ? { renewal_price: numberOrUndefined(server.renewal_price) } : {}),
    ...(numberOrUndefined(server.renewal_price_cny) !== undefined ? { renewal_price_cny: numberOrUndefined(server.renewal_price_cny) } : {}),
    ...(stringOrUndefined(server.renewal_cycle) ? { renewal_cycle: stringOrUndefined(server.renewal_cycle) } : {}),
    ...(stringOrUndefined(server.renewal_currency) ? { renewal_currency: stringOrUndefined(server.renewal_currency) } : {}),
    ...(stringOrUndefined(server.group) ? { group: stringOrUndefined(server.group) } : {}),
    ...(stringOrUndefined(server.tags) ? { tags: stringOrUndefined(server.tags) } : {}),
    hidden: server.hidden === true,
    ...(numberOrUndefined(server.traffic_limit) !== undefined ? { traffic_limit: numberOrUndefined(server.traffic_limit) } : {}),
    ...(stringOrUndefined(server.traffic_limit_type) ? { traffic_limit_type: stringOrUndefined(server.traffic_limit_type) } : {}),
    ...(dateTimeOrUndefined(server.created_at) ? { created_at: dateTimeOrUndefined(server.created_at) } : {}),
    ...(dateTimeOrUndefined(server.updated_at) ? { updated_at: dateTimeOrUndefined(server.updated_at) } : {}),
    ...(stringOrUndefined(server.public_remark) ? { public_remark: stringOrUndefined(server.public_remark) } : {}),
    ...(ping?.length ? { ping } : {}),
    ...(returnRoutes?.length ? { return_routes: returnRoutes } : {}),
    ...(returnRoutes?.length ? { routes: returnRoutes } : {}),
  }
}

function toProbePayload(payload: ProbePayload, source?: ThemeSource): ProbePayload {
  const servers = payload.servers.map((server, index) => normalizeProbeServer(server, index))
  const appearance = normalizeProbeAppearance(payload.appearance, source)
  const logo = stringOrUndefined(payload.logo)
  const icon = stringOrUndefined(payload.icon)
  return {
    enabled: payload.enabled !== false,
    show_globe: payload.show_globe ?? true,
    show_daily_trend: payload.show_daily_trend ?? true,
    show_traffic_hotspots: payload.show_traffic_hotspots ?? true,
    show_traffic_7d: payload.show_traffic_7d ?? true,
    show_resource_heatmap: payload.show_resource_heatmap ?? true,
    show_traffic_quota: payload.show_traffic_quota ?? true,
    show_renewal_timeline: payload.show_renewal_timeline ?? true,
    show_health_score: payload.show_health_score ?? true,
    title: stringOrUndefined(payload.title) || themeTitleFromSource(source),
    ...(logo ? { logo } : {}),
    ...(icon ? { icon } : {}),
    appearance,
    ...(normalizeProbeLicenseBadge(payload.license_badge) ? { license_badge: normalizeProbeLicenseBadge(payload.license_badge) } : {}),
    servers,
    ...(payload.updatedAt !== undefined ? { updatedAt: payload.updatedAt } : {}),
  }
}

function loadAverage(value: unknown): { load1?: number; load5?: number; load15?: number } | undefined {
  const load: { load1?: number; load5?: number; load15?: number } = {}
  if (Array.isArray(value)) {
    const [load1, load5, load15] = value.map(numberOrUndefined)
    if (load1 !== undefined) load.load1 = load1
    if (load5 !== undefined) load.load5 = load5
    if (load15 !== undefined) load.load15 = load15
  } else if (typeof value === 'string' && value.trim().includes(' ')) {
    const [load1, load5, load15] = value.trim().split(/\s+/).map(numberOrUndefined)
    if (load1 !== undefined) load.load1 = load1
    if (load5 !== undefined) load.load5 = load5
    if (load15 !== undefined) load.load15 = load15
  } else {
    const load1 = numberOrUndefined(value)
    if (load1 !== undefined) load.load1 = load1
  }
  return Object.keys(load).length > 0 ? load : undefined
}

export class KomariServiceError extends Error {
  public readonly statusCode = 502

  public constructor(message: string, public readonly cause?: unknown) {
    super(message)
    this.name = 'KomariServiceError'
  }
}

export class KomariDataService {
  private snapshotInflight?: Promise<SnapshotValue>
  private readonly seriesInflight = new Map<string, Promise<ProbeSeriesPayload>>()
  private readonly seriesCache = new Map<string, SeriesCacheEntry>()

  public constructor(
    private readonly client: DataClient,
    private readonly themeSource?: ThemeSource,
    private readonly history?: ProbeHistoryBuffer,
  ) {}

  public async getSnapshot(): Promise<KomariSnapshot> {
    return (await this.getSnapshotValue()).snapshot
  }

  public async getRawProbePayload(): Promise<ProbePayload> {
    return await this.client.fetchProbe()
  }

  public async getProbePayload(): Promise<ProbePayload> {
    return toProbePayload((await this.getSnapshotValue()).payload, this.themeSource)
  }

  public async getNodesInformation(includeHidden = false): Promise<KomariPublicNode[]> {
    const nodes = toKomariPublicNodes(await this.getProbePayload())
    return includeHidden ? nodes : nodes.filter((node) => !node.hidden)
  }

  public async getNodes(uuid?: string): Promise<Record<string, KomariPublicNode> | KomariPublicNode | null> {
    const nodes = await this.getNodesInformation()
    if (uuid !== undefined) return nodes.find((node) => node.uuid === uuid) ?? null
    return Object.fromEntries(nodes.map((node) => [node.uuid, node]))
  }

  public async getPublicInfo(): Promise<KomariPublicSettings> {
    return await this.getPublicSettings()
  }

  public async getMe(): Promise<KomariMeInfo> {
    return {
      logged_in: false,
      username: 'Guest',
      uuid: '',
      sso_id: '',
      sso_type: '',
      '2fa_enabled': false,
    }
  }

  public async getPublicSettings(): Promise<KomariPublicSettings> {
    const probe = await this.getProbePayload()
    const themeSettings = await this.resolveThemeSettings(probe)
    const icon = stringOrUndefined(probe.icon)
    const sitename = stringOrUndefined(probe.title) || themeTitleFromSource(this.themeSource)
    const customHeadParts: string[] = []
    if (icon) {
      customHeadParts.push(`<link rel="icon" href="${escapeHtmlAttribute(icon)}">`)
    }
    if (sitename) {
      customHeadParts.push(`<script>document.title=${JSON.stringify(sitename).replaceAll('<', '\\u003c')};</script>`)
    }
    return {
      sitename,
      description: '',
      theme: probe.appearance?.theme || themeNameFromSource(this.themeSource),
      theme_settings: themeSettings,
      private_site: false,
      record_enabled: true,
      record_preserve_time: 24,
      ping_record_preserve_time: 24,
      custom_head: customHeadParts.join(''),
      custom_body: '',
      oauth_enable: false,
      oauth_provider: '',
      disable_password_login: false,
      allow_cors: true,
      cors_origin_check_enabled: true,
      visitor_audit_enabled: false,
    }
  }

  public async getNodesLatestStatus(query: SeriesQuery = {}): Promise<KomariNodeStatusMap> {
    const status = toKomariNodeStatusMap(await this.getProbePayload())
    const entityIds = resolveEntityIds(query)
    if (entityIds.length === 0) return status
    const wanted = new Set(entityIds)
    return Object.fromEntries(Object.entries(status).filter(([uuid]) => wanted.has(uuid)))
  }

  public async getClientRecentRecords(query: SeriesQuery = {}): Promise<KomariNodeStatus[]> {
    const records = toKomariRecentStatusRecords(await this.getProbePayload())
    const entityIds = resolveEntityIds(query)
    if (entityIds.length === 0) return records
    const wanted = new Set(entityIds)
    return records.filter((record) => wanted.has(record.client))
  }

  public async getNodeRecentStatus(uuid: string, limit?: number): Promise<KomariRecentStatusResp> {
    const records = await this.getClientRecentRecords({ uuid })
    const normalizedLimit = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : undefined
    const limited = normalizedLimit === undefined ? records : records.slice(-normalizedLimit)
    return { count: limited.length, records: limited }
  }

  public async getVersion(): Promise<KomariVersionInfo> {
    return {
      version: ADAPTER_VERSION,
      hash: BUILD_HASH,
    }
  }

  public async getSeriesPayload(query: SeriesQuery): Promise<ProbeSeriesPayload> {
    return await this.client.fetchSeries(query)
  }

  public async getRecords(query: SeriesQuery): Promise<KomariCommonRecords> {
    const type = stringQueryValue(query.type).toLowerCase()
    if (type === 'ping') {
      const history = await this.getPingHistory(query)
      return {
        ...toKomariPingRecords(history),
        has_gpu_data: false,
        gpu_devices: [],
        ...historyRange(query),
      }
    }

    const entityIds = await this.resolveEntityIdsOrAll(query)
    const histories = await Promise.all(entityIds.map((entityId) => this.getLoadHistory(entityId, query)))
    const history: LoadHistory = {
      count: histories.reduce((count, item) => count + item.count, 0),
      records: histories.flatMap((item) => item.records).sort((left, right) => {
        const timeDiff = Date.parse(left.time) - Date.parse(right.time)
        if (timeDiff !== 0) return timeDiff
        return left.client.localeCompare(right.client)
      }),
    }
    return {
      ...toKomariLoadRecords(history),
      ...historyRange(query),
    }
  }

  public async getQueryMetrics(query: SeriesQuery): Promise<KomariQueryMetrics> {
    const entityIds = await this.resolveEntityIdsOrAll(query)
    const metricKeys = resolveMetricKeys(query)
    const systemMetricKeys = metricKeys.filter((metricKey) => !isPingMetricKey(metricKey))
    const pingMetricKeys = metricKeys.filter(isPingMetricKey)
    const series: KomariMetricSeries[] = []

    if (systemMetricKeys.length > 0) {
      const [payload, current] = await Promise.all([
        this.getSeries({
          server: entityIds[0] ? String(serverIndexFromUuid(entityIds[0])) : query.server,
          range: rangeFromQuery(query),
          metric: stringQueryValue(query.metric) || 'system',
        }),
        this.getProbePayload(),
      ])
      const pointsByEntity = collectQueryMetricSeries(payload, entityIds, systemMetricKeys, current)
      series.push(...[...pointsByEntity.values()].flat())
    }

    if (pingMetricKeys.length > 0) {
      series.push(...collectPingQueryMetricSeries(
        await this.getPingHistoryForEntityIds(entityIds, query),
        entityIds,
        pingMetricKeys,
        normalizeTaskIdFilter(resolveNumericList(query.task_ids ?? query.task_id)),
      ))
    }

    const { start, end } = seriesBounds(series)
    return {
      start,
      end,
      count: series.length,
      series,
    }
  }

  public async getPingMetricStats(query: SeriesQuery): Promise<KomariPingMetricStats> {
    const entityIds = await this.resolveEntityIdsOrAll(query)
    const taskIds = normalizeTaskIdFilter(resolveNumericList(query.task_ids ?? query.task_id))
    const stats = summarisePingMetricStats(await this.getPingHistoryForEntityIds(entityIds, query), entityIds, taskIds)
    return { count: stats.length, stats }
  }

  public async getPublicPingTasks(query: SeriesQuery = {}): Promise<KomariPublicPingTask[]> {
    const probe = await this.getProbePayload()
    return this.getPublicPingTasksFromProbe(probe, query)
  }

  private async getPublicPingTasksFromProbe(probe: ProbePayload, query: SeriesQuery): Promise<KomariPublicPingTask[]> {
    const entityIds = await this.resolveEntityIdsOrAll(query, probe)
    const wanted = new Set(entityIds)
    const snapshotTasks = toPingHistory(probe.servers, new Date()).tasks
      .map((task) => ({
        ...task,
        clients: task.clients.filter((client) => wanted.has(client)),
        target: task.name,
      }))
      .filter((task) => task.clients.length > 0)
    if (snapshotTasks.length > 0) return snapshotTasks

    const history = await this.getPingHistoryForEntityIds(entityIds, query)
    return history.tasks.map((task) => ({ ...task, target: task.name }))
  }

  public async getPingHistory(query: SeriesQuery): Promise<PingHistory> {
    const entityIds = await this.resolveEntityIdsOrAll(query)
    return this.getPingHistoryForEntityIds(entityIds, query)
  }

  private async getPingHistoryForEntityIds(entityIds: readonly string[], query: SeriesQuery): Promise<PingHistory> {
    const histories = await Promise.all(entityIds.map((entityId) => this.getPingHistoryForUuid(entityId, query)))
    return mergePingHistories(histories)
  }

  private async getPingHistoryForUuid(uuid: string, query: SeriesQuery): Promise<PingHistory> {
    const index = serverIndexFromUuid(uuid)
    const payload = await this.getSeries({ server: String(index), range: rangeFromQuery(query), all: '1' })
    const fromSeries = (payload.pings || payload.all_series || payload.series)
      ? toPingSeriesHistory(payload, index)
      : { count: 0, records: [], tasks: [], basic_info: { clients: [] } }
    return this.withBufferedPingHistory(index, fromSeries)
  }

  // 实时帧逐次样本优先，主控聚合桶只填补缓冲未覆盖的时段（如刚重启的冷启动窗口）。
  private withBufferedPingHistory(index: number, fromSeries: PingHistory): PingHistory {
    const buffered = this.history?.snapshotPing(index)
    if (!buffered || buffered.size === 0) return fromSeries
    const client = `mmwx-${index}`
    const idByName = new Map<string, number>()
    for (const task of fromSeries.tasks) idByName.set(task.name, task.id)
    let nextId = fromSeries.tasks.reduce((max, task) => Math.max(max, task.id), 0)
    const tasks: PingTask[] = fromSeries.tasks.map((task) => ({ ...task, clients: [...new Set([...task.clients, client])].sort() }))
    for (const name of buffered.keys()) {
      if (idByName.has(name)) continue
      nextId += 1
      idByName.set(name, nextId)
      tasks.push({ id: nextId, name, clients: [client], default_on: true, type: 'icmp', interval: 30 })
    }
    const merged = new Map<string, PingHistoryRecord>()
    for (const [name, points] of buffered) {
      const taskId = idByName.get(name)
      if (taskId === undefined) continue
      for (const point of points) {
        merged.set(`${name}|${point.t}`, {
          task_id: taskId,
          time: new Date(point.t).toISOString(),
          value: point.value,
          loss: point.loss,
          client,
        })
      }
    }
    const nameById = new Map(fromSeries.tasks.map((task) => [task.id, task.name]))
    for (const record of fromSeries.records) {
      const name = nameById.get(record.task_id) ?? `task-${record.task_id}`
      const key = `${name}|${Date.parse(record.time)}`
      if (!merged.has(key)) merged.set(key, record)
    }
    const records = [...merged.values()].sort((left, right) => {
      const timeDiff = Date.parse(left.time) - Date.parse(right.time)
      if (timeDiff !== 0) return timeDiff
      return left.task_id - right.task_id
    })
    return { count: records.length, records, tasks, basic_info: { clients: [client] } }
  }

  public async getLoadHistory(uuid: string, query: SeriesQuery): Promise<LoadHistory> {
    const index = serverIndexFromUuid(uuid)
    const payload = await this.getSeries({ server: String(index), range: rangeFromQuery(query), metric: 'system' })
    const fromSeries = isSystemMetricSeries(payload.series)
      ? toSystemMetricHistory(payload.series, index)
      : toLoadHistory({ ...(payload.systems?.find((item) => Number(item.serverId) === index) ?? payload.systems?.[0] ?? { points: [] }), serverId: index })
    return this.withBufferedLoadHistory(index, fromSeries)
  }

  // 与 ping 同策略：缓冲逐帧样本优先，聚合序列补冷启动窗口，按时间戳去重。
  private withBufferedLoadHistory(index: number, fromSeries: LoadHistory): LoadHistory {
    const buffered = this.history?.snapshotLoad(index)
    if (!buffered || buffered.length === 0) return fromSeries
    const client = `mmwx-${index}`
    const merged = new Map<number, LoadHistoryRecord>()
    for (const point of buffered) {
      const record: LoadHistoryRecord = { client, time: new Date(point.t).toISOString() }
      if (point.cpu !== undefined) record.cpu = point.cpu
      if (point.ram !== undefined) record.ram = point.ram
      if (point.mem_total !== undefined) record.mem_total = point.mem_total
      if (point.disk !== undefined) record.disk = point.disk
      if (point.load !== undefined) record.load = point.load
      if (point.net_out !== undefined) record.net_out = point.net_out
      if (point.net_in !== undefined) record.net_in = point.net_in
      if (point.net_total_up !== undefined) record.net_total_up = point.net_total_up
      if (point.net_total_down !== undefined) record.net_total_down = point.net_total_down
      merged.set(point.t, record)
    }
    for (const record of fromSeries.records) {
      const t = Date.parse(record.time)
      if (!merged.has(t)) merged.set(t, record)
    }
    const records = [...merged.values()].sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
    return { count: records.length, records }
  }

  public async getLoadRecords(uuid: string, query: SeriesQuery): Promise<KomariLoadRecords> {
    return toKomariLoadRecords(await this.getLoadHistory(uuid, query))
  }

  public async getPingRecords(query: SeriesQuery): Promise<KomariPingRecords> {
    return toKomariPingRecords(await this.getPingHistory(query))
  }

  private async resolveThemeSettings(probe?: ProbePayload): Promise<Record<string, unknown>> {
    const base = {
      ...(this.themeSource?.themeSettings ?? {}),
      ...(await this.readStoredThemeSettings()),
    }
    if (!isJunimoTheme(this.themeSource)) return base
    if (base.homepagePingBindings !== undefined) return base

    try {
      const tasks = probe
        ? await this.getPublicPingTasksFromProbe(probe, {})
        : await this.getPublicPingTasks()
      const homepagePingBindings = Object.fromEntries(tasks
        .filter((task) => task.id > 0 && task.clients.length > 0)
        .map((task) => [String(task.id), task.clients]))
      if (Object.keys(homepagePingBindings).length === 0) return base
      return {
        ...(base.showPingChart === undefined ? { showPingChart: true } : {}),
        ...base,
        homepagePingBindings,
      }
    } catch {
      return base
    }
  }

  public async getThemeSettings(): Promise<Record<string, unknown>> {
    return await this.resolveThemeSettings()
  }

  public async updateThemeSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.themeSource?.themeSettingsStore) throw Object.assign(new Error('theme settings store is not configured'), { statusCode: 403 })
    if (Array.isArray(this.themeSource.themeManifest?.config)) validateMonitorSettings(settings, this.themeSource.themeManifest.config)
    await this.themeSource.themeSettingsStore.write(settings)
    return await this.resolveThemeSettings()
  }

  private async readStoredThemeSettings(): Promise<Record<string, unknown>> {
    if (!this.themeSource?.themeSettingsStore) return {}
    return await this.themeSource.themeSettingsStore.read()
  }

  private async getSnapshotValue(): Promise<SnapshotValue> {
    if (this.snapshotInflight) return this.snapshotInflight

    this.snapshotInflight = this.client.fetchProbe()
      .then((payload) => {
        const value = { snapshot: toSnapshot(payload), payload }
        return value
      })
      .catch((error: unknown) => {
        throw new KomariServiceError('MMWX probe snapshot unavailable', error)
      })
      .finally(() => {
        this.snapshotInflight = undefined
      })
    return this.snapshotInflight
  }

  private async getSeries(query: SeriesQuery): Promise<ProbeSeriesPayload> {
    const key = stableKey(query)
    const cached = this.seriesCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      this.seriesCache.delete(key)
      this.seriesCache.set(key, cached)
      return cached.payload
    }
    if (cached) this.seriesCache.delete(key)

    const inflight = this.seriesInflight.get(key)
    if (inflight) return inflight

    const request = this.client.fetchSeries(query)
      .then((payload) => {
        this.cacheSeries(key, payload)
        return payload
      })
      .catch((error: unknown) => {
        throw new KomariServiceError('MMWX probe history unavailable', error)
      })
      .finally(() => {
        this.seriesInflight.delete(key)
      })
    this.seriesInflight.set(key, request)
    return request
  }

  // 聚合历史短时缓存；实时缓冲仍在每次映射时合并，避免频繁回源时冻结当前点。
  private cacheSeries(key: string, payload: ProbeSeriesPayload): void {
    const now = Date.now()
    for (const [cachedKey, entry] of this.seriesCache) {
      if (entry.expiresAt <= now) this.seriesCache.delete(cachedKey)
    }
    this.seriesCache.delete(key)
    this.seriesCache.set(key, { expiresAt: now + SERIES_CACHE_TTL_MS, payload })
    while (this.seriesCache.size > SERIES_CACHE_MAX_ENTRIES) {
      const oldestKey = this.seriesCache.keys().next().value
      if (oldestKey === undefined) break
      this.seriesCache.delete(oldestKey)
    }
  }

  private async resolveEntityIdsOrAll(query: SeriesQuery, probe?: ProbePayload): Promise<string[]> {
    const entityIds = resolveEntityIds(query)
    if (entityIds.length > 0) return entityIds
    if (probe) return toKomariPublicNodes(probe).filter((node) => !node.hidden).map((node) => node.uuid)
    return (await this.getNodesInformation()).map((node) => node.uuid)
  }
}

function toSnapshot(payload: ProbePayload): KomariSnapshot {
  const now = new Date()
  return {
    nodes: payload.servers.map(toKomariNode),
    records: payload.servers.map((server, index) => toKomariRecord(server, index, now)),
  }
}

function stableKey(query: SeriesQuery): string {
  return JSON.stringify(Object.entries(query)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)))
}

function serverIndexFromUuid(uuid: unknown): number {
  if (typeof uuid !== 'string') return 0
  const match = uuid.match(/^mmwx-(0|[1-9]\d*)$/)
  return match ? Number(match[1]) : 0
}

function serverIndexFromServerId(serverId: string | number | undefined): number {
  const numeric = numberOrUndefined(serverId)
  if (numeric !== undefined && numeric >= 0) return Math.trunc(numeric)
  return serverIndexFromUuid(serverId)
}

function rangeFromQuery(query: SeriesQuery): string {
  if (typeof query.range === 'string' && /^(?:1h|6h|24h)$/.test(query.range)) return query.range
  const raw = query.hours
  const hours = typeof raw === 'number' ? raw : Number(raw)
  if (hours <= 1) return '1h'
  if (hours <= 6) return '6h'
  return '24h'
}

function historyRange(query: SeriesQuery): { from?: string; to?: string } {
  const hours = query.hours === undefined ? undefined : Number(query.hours)
  if (hours === undefined || !Number.isFinite(hours)) return {}
  const to = new Date()
  const from = new Date(to.getTime() - Math.max(hours, 0) * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString() }
}

function stringQueryValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  return ''
}

function resolveEntityIds(query: SeriesQuery): string[] {
  const raw = query.entity_ids ?? query.entity_id ?? query.uuid
  if (Array.isArray(raw)) {
    const ids = raw.map((value) => normalizeEntityId(String(value))).filter(Boolean)
    if (ids.length > 0) return ids
  }
  if (typeof raw === 'string' && raw.trim()) return [normalizeEntityId(raw.trim())]
  if (typeof raw === 'number' && Number.isFinite(raw)) return [`mmwx-${Math.trunc(raw)}`]
  const server = query.server
  if (Array.isArray(server)) {
    const ids = server.map((value) => normalizeEntityId(String(value))).filter(Boolean)
    if (ids.length > 0) return ids
  }
  if (typeof server === 'string' && server.trim()) return [normalizeEntityId(server.trim())]
  if (typeof server === 'number' && Number.isFinite(server)) return [`mmwx-${Math.trunc(server)}`]
  return []
}

function resolveMetricKeys(query: SeriesQuery): string[] {
  const raw = query.metric_keys ?? query.metric_key ?? query.metrics ?? query.metric
  if (Array.isArray(raw)) return raw.map((value) => String(value)).filter(Boolean)
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split(',').map((value) => value.trim()).filter(Boolean)
  }
  return ['cpu.usage', 'memory.used', 'memory.total', 'swap.used', 'swap.total', 'load.average', 'disk.used', 'disk.total', 'net.in.rate', 'net.out.rate', 'net.total.up', 'net.total.down', 'process.count', 'connections.tcp', 'connections.udp', 'traffic.up', 'traffic.down']
}

function resolveNumericList(value: unknown): number[] {
  if (Array.isArray(value)) return value.map((item) => Number(item)).filter((item) => Number.isFinite(item))
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((item) => Number(item.trim())).filter((item) => Number.isFinite(item))
  }
  if (typeof value === 'number' && Number.isFinite(value)) return [Math.trunc(value)]
  return []
}

function seriesBounds(series: readonly KomariMetricSeries[]): { start?: string; end?: string } {
  let startMs = Number.POSITIVE_INFINITY
  let endMs = Number.NEGATIVE_INFINITY
  for (const item of series) {
    for (const point of item.points) {
      const timestamp = Date.parse(point.time)
      if (!Number.isFinite(timestamp)) continue
      if (timestamp < startMs) startMs = timestamp
      if (timestamp > endMs) endMs = timestamp
    }
  }
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return {}
  const start = new Date(startMs)
  const end = new Date(endMs)
  return { start: start.toISOString(), end: end.toISOString() }
}

function mergePingHistories(histories: readonly PingHistory[]): PingHistory {
  const records = histories.flatMap((history) => history.records)
  const tasksByKey = new Map<string, PingHistory['tasks'][number]>()
  for (const task of histories.flatMap((history) => history.tasks)) {
    const key = `${task.id}:${task.name}`
    const existing = tasksByKey.get(key)
    if (!existing) {
      tasksByKey.set(key, { ...task, clients: [...task.clients] })
      continue
    }
    existing.clients = [...new Set([...existing.clients, ...task.clients])].sort()
  }
  records.sort((left, right) => {
    const timeDiff = Date.parse(left.time) - Date.parse(right.time)
    if (timeDiff !== 0) return timeDiff
    if (left.task_id !== right.task_id) return left.task_id - right.task_id
    return left.client.localeCompare(right.client)
  })
  const clients = [...new Set(histories.flatMap((history) => history.basic_info.clients))].sort()
  return {
    count: records.length,
    records,
    tasks: [...tasksByKey.values()],
    basic_info: { clients },
  }
}

function isPingMetricKey(metricKey: string): boolean {
  return metricKey === 'ping.latency_ms' || metricKey === 'ping.loss'
}

function isJunimoTheme(source?: ThemeSource): boolean {
  const values = [
    source?.themeShort,
    themeNameFromSource(source),
    source?.repoUrl,
  ]
  return values.some((value) => typeof value === 'string' && value.toLowerCase().includes('junimo'))
}

function normalizeTaskIdFilter(taskIds: readonly number[]): number[] {
  return [...new Set(taskIds.map((taskId) => taskId === 0 ? 1 : Math.trunc(taskId)).filter((taskId) => Number.isFinite(taskId)))]
}

function collectQueryMetricSeries(
  payload: ProbeSeriesPayload,
  entityIds: readonly string[],
  metricKeys: readonly string[],
  currentPayload?: ProbePayload,
): Map<string, KomariMetricSeries[]> {
  const result = new Map<string, KomariMetricSeries[]>()
  const systems = payload.systems ?? []
  const targets = entityIds.length > 0
    ? [...new Set(entityIds)]
    : [...new Set(systems.map((item) => `mmwx-${serverIndexFromServerId(item.serverId)}`))]

  if (systems.length > 0) {
    for (const entityId of targets) {
      const index = serverIndexFromUuid(entityId)
      const source = systems.find((item) => serverIndexFromServerId(item.serverId) === index) ?? systems[0]
      const series = metricKeys.map((metricKey) => systemMetricSeriesFromPoints(entityId, metricKey, source.points)).filter((item): item is KomariMetricSeries => item !== undefined)
      mergeCurrentMetricFallback(series, entityId, metricKeys, currentPayload)
      result.set(entityId, series)
    }
    return result
  }

  const directSeries = payload.series
  if (isSystemMetricSeries(directSeries)) {
    const entityId = targets[0] ?? 'mmwx-0'
    const series = metricKeys.map((metricKey) => directMetricSeriesFromPayload(entityId, metricKey, directSeries)).filter((item): item is KomariMetricSeries => item !== undefined)
    mergeCurrentMetricFallback(series, entityId, metricKeys, currentPayload)
    result.set(entityId, series)
    return result
  }

  for (const entityId of targets) {
    const series: KomariMetricSeries[] = []
    mergeCurrentMetricFallback(series, entityId, metricKeys, currentPayload)
    if (series.length > 0) result.set(entityId, series)
  }

  return result
}

function mergeCurrentMetricFallback(series: KomariMetricSeries[], entityId: string, metricKeys: readonly string[], currentPayload?: ProbePayload): void {
  const server = currentPayload?.servers[serverIndexFromUuid(entityId)]
  if (!server) return
  for (const metricKey of metricKeys) {
    const index = series.findIndex((item) => item.metric_key === metricKey && item.entity_id === entityId)
    if (index >= 0 && !isEmptyMetricSeries(series[index])) continue
    const fallback = currentMetricSeries(entityId, metricKey, server, currentPayload)
    if (!fallback) continue
    if (index >= 0) {
      series[index] = fallback
    } else {
      series.push(fallback)
    }
  }
}

function isEmptyMetricSeries(series: KomariMetricSeries | undefined): boolean {
  if (!series || series.points.length === 0) return true
  return series.points.every((point) => point.count === 0 || point.value === null)
}

function currentMetricSeries(entityId: string, metricKey: string, server: ProbeServer, payload: ProbePayload): KomariMetricSeries | undefined {
  const value = currentMetricValue(server, metricKey)
  if (value === undefined) return undefined
  return {
    metric_key: metricKey,
    entity_id: entityId,
    interval_seconds: 300,
    points: [{
      time: dateTimeOrUndefined(server.updated_at) ?? dateTimeOrUndefined(payload.updatedAt) ?? new Date().toISOString(),
      value,
      count: 1,
    }],
  }
}

// 无历史序列时的兜底：主题对 traffic.up/down 序列逐点求和得出当日流量，
// 因此这里必须给出最近一天的用量，而不是累计计数器（否则计数器会被当成一个桶计进当日流量）。
function lastDailyTrafficValue(server: ProbeServer, direction: 'uplink' | 'downlink'): number | undefined {
  const entries = Array.isArray(server.daily_traffic) ? server.daily_traffic : []
  const last = entries[entries.length - 1]
  if (!last) return undefined
  return numberOrUndefined(last[direction])
}

function currentMetricValue(server: ProbeServer, metricKey: string): number | undefined {
  switch (metricKey) {
    case 'cpu.usage': return firstFinite([server.cpu, server.cpu_pct])
    case 'memory.used': return firstFinite([server.memory, server.mem_used])
    case 'memory.total': return numberOrUndefined(server.mem_total)
    case 'swap.used': return numberOrUndefined(server.swap)
    case 'swap.total': return numberOrUndefined(server.swap_total)
    case 'load.average':
    case 'load.1': return loadAverage(server.load ?? server.loadavg)?.load1
    case 'load.5': return loadAverage(server.load ?? server.loadavg)?.load5
    case 'load.15': return loadAverage(server.load ?? server.loadavg)?.load15
    case 'disk.used': return numberOrUndefined(server.disk_used)
    case 'disk.total': return numberOrUndefined(server.disk_total)
    case 'net.in.rate': return firstFinite([server.download, server.download_speed])
    case 'net.out.rate': return firstFinite([server.upload, server.upload_speed])
    case 'net.total.up': return firstFinite([server.net_total_up, server.totalUpload, server.cumulative_up, server.traffic_used_up])
    case 'net.total.down': return firstFinite([server.net_total_down, server.totalDownload, server.cumulative_down, server.traffic_used_down])
    case 'traffic.up': return lastDailyTrafficValue(server, 'uplink')
    case 'traffic.down': return lastDailyTrafficValue(server, 'downlink')
    case 'process.count': return numberOrUndefined(server.process)
    case 'connections.tcp': return numberOrUndefined(server.tcp_connections)
    case 'connections.udp': return numberOrUndefined(server.udp_connections)
    default: return undefined
  }
}

function normalizePingLossRatio(loss: unknown): number | undefined {
  const numeric = numberOrUndefined(loss)
  if (numeric === undefined || numeric < 0) return undefined
  return numeric / 100
}

function collectPingQueryMetricSeries(
  history: PingHistory,
  entityIds: readonly string[],
  metricKeys: readonly string[],
  taskIds: readonly number[],
): KomariMetricSeries[] {
  const entityFilter = new Set(entityIds)
  const taskFilter = new Set(taskIds)
  const groups = new Map<string, PingHistory['records']>()

  for (const record of history.records) {
    if (entityFilter.size > 0 && !entityFilter.has(record.client)) continue
    if (taskFilter.size > 0 && !taskFilter.has(record.task_id)) continue
    const key = `${record.client}:${record.task_id}`
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }

  const result: KomariMetricSeries[] = []
  for (const [key, records] of groups) {
    const [entityId, taskId] = key.split(':')
    const sorted = [...records].sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
    for (const metricKey of metricKeys) {
      const points = sorted.map((record): KomariMetricPoint => {
        const value = metricKey === 'ping.loss'
          ? normalizePingLossRatio(record.loss)
          : typeof record.value === 'number' && record.value >= 0 ? record.value : undefined
        return {
          time: record.time,
          value: value ?? null,
          count: value === undefined ? 0 : 1,
        }
      })
      if (points.length === 0) continue
      result.push({
        metric_key: metricKey,
        entity_id: entityId ?? '',
        tags: { task_id: taskId ?? '' },
        interval_seconds: inferIntervalSeconds(points),
        points,
      })
    }
  }
  return result
}

// LuminaPlus 等主题按「逐点求和」消费 queryMetrics 的 traffic.up/traffic.down 序列，
// 这两个指标必须输出每个时间桶的增量字节；net.total.up/down 才是累计计数器语义。
// 主控序列的累计字段（cumulative_* / net_total_*）在此转换为相邻差分（计数器回退记 0）。
function toDeltaMetricPoints(points: readonly KomariMetricPoint[]): KomariMetricPoint[] {
  const sorted = [...points].sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
  let previous: number | undefined
  return sorted.map((point) => {
    if (point.count === 0 || point.value === null || !Number.isFinite(point.value)) {
      return { ...point, value: null, count: 0 }
    }
    const current = point.value
    if (previous === undefined) {
      previous = current
      return { ...point, value: 0, count: 1 }
    }
    const delta = Math.max(0, current - previous)
    previous = current
    return { ...point, value: delta, count: 1 }
  })
}

function systemMetricSeriesFromPoints(entityId: string, metricKey: string, points: readonly MmwxSystemSeriesPoint[]): KomariMetricSeries | undefined {
  const mapped = points.map((point) => systemMetricPoint(point, metricKey)).filter((point): point is KomariMetricPoint => point !== undefined)
  if (mapped.length === 0) return undefined
  const resolved = isCumulativeTrafficSeries(metricKey, points) ? toDeltaMetricPoints(mapped) : mapped
  return {
    metric_key: metricKey,
    entity_id: entityId,
    interval_seconds: inferIntervalSeconds(mapped),
    points: resolved,
  }
}

// 判断 traffic.up/down 序列的取值是否来自累计字段（cumulative_* / net_total_*）：
// 是则需要转增量；若主控只给了 traffic_*（按字段名为桶内增量），则原样输出。
function isCumulativeTrafficSeries(metricKey: string, points: readonly MmwxSystemSeriesPoint[]): boolean {
  if (metricKey !== 'traffic.up' && metricKey !== 'traffic.down') return false
  return points.some((point) => {
    const cumulative = metricKey === 'traffic.up'
      ? numberOrUndefined(point.cumulative_up ?? point.net_total_up)
      : numberOrUndefined(point.cumulative_down ?? point.net_total_down)
    return cumulative !== undefined
  })
}

function directMetricSeriesFromPayload(entityId: string, metricKey: string, payload: MmwxSystemMetricSeries): KomariMetricSeries | undefined {
  const points = directMetricPoints(payload, metricKey)
  if (points.length === 0) return undefined
  const resolved = isCumulativeTrafficDirectSeries(metricKey, payload) ? toDeltaMetricPoints(points) : points
  return {
    metric_key: metricKey,
    entity_id: entityId,
    interval_seconds: inferIntervalSeconds(points),
    points: resolved,
  }
}

// 同 systemMetricSeriesFromPoints：直连序列里 traffic.up/down 只有在累计字段
// （cumulative_*）真实存在时才需要转增量，否则 traffic_* 本身就是桶内增量。
function isCumulativeTrafficDirectSeries(metricKey: string, payload: MmwxSystemMetricSeries): boolean {
  if (metricKey === 'traffic.up') return Array.isArray(payload.cumulative_up) && payload.cumulative_up.length > 0
  if (metricKey === 'traffic.down') return Array.isArray(payload.cumulative_down) && payload.cumulative_down.length > 0
  return false
}

function directMetricPoints(payload: MmwxSystemMetricSeries, metricKey: string): KomariMetricPoint[] {
  const source = metricSourceByKey(payload, metricKey)
  return (source ?? []).map((point) => {
    const time = metricPointTime(point)
    const value = numberOrUndefined(point.value)
    if (time === undefined) return undefined
    return { time, value: value ?? null, count: Number.isFinite(value ?? NaN) ? 1 : 0 }
  }).filter((point): point is KomariMetricPoint => point !== undefined)
}

function metricSourceByKey(payload: MmwxSystemMetricSeries, metricKey: string): readonly MmwxMetricPoint[] | undefined {
  switch (metricKey) {
    case 'cpu.usage': return payload.cpu_pct
    case 'memory.used': return payload.mem_used
    case 'memory.total': return payload.mem_total
    case 'swap.used': return payload.swap_used
    case 'swap.total': return payload.swap_total
    case 'load.average':
    case 'load.1': return payload.load1 ?? payload.load
    case 'load.5': return payload.load5
    case 'load.15': return payload.load15
    case 'disk.used': return payload.disk_used
    case 'disk.total': return payload.disk_total
    case 'net.in.rate': return payload.download_speed
    case 'net.out.rate': return payload.upload_speed
    case 'net.total.up':
    case 'traffic.up': return payload.cumulative_up ?? payload.traffic_up
    case 'net.total.down':
    case 'traffic.down': return payload.cumulative_down ?? payload.traffic_down
    case 'process.count': return payload.process
    case 'connections.tcp': return payload.tcp_connections
    case 'connections.udp': return payload.udp_connections
    default: return undefined
  }
}

function systemMetricPoint(point: MmwxSystemSeriesPoint, metricKey: string): KomariMetricPoint | undefined {
  const time = metricPointTime(point)
  if (time === undefined) return undefined
  const value = systemMetricValue(point, metricKey)
  return { time, value, count: value === null ? 0 : 1 }
}

function systemMetricValue(point: MmwxSystemSeriesPoint, metricKey: string): number | null {
  switch (metricKey) {
    case 'cpu.usage':
      return numberOrUndefined(point.cpu) ?? null
    case 'memory.used':
      return numberOrUndefined(point.memory) ?? null
    case 'memory.total':
      return numberOrUndefined(point.mem_total) ?? null
    case 'swap.used':
      return numberOrUndefined(point.swap) ?? null
    case 'swap.total':
      return numberOrUndefined(point.swap_total) ?? null
    case 'load.average':
    case 'load.1':
      return loadAverage(point.load)?.load1 ?? null
    case 'load.5':
      return loadAverage(point.load)?.load5 ?? null
    case 'load.15':
      return loadAverage(point.load)?.load15 ?? null
    case 'disk.used':
      return numberOrUndefined(point.disk_used) ?? null
    case 'disk.total':
      return numberOrUndefined(point.disk_total) ?? null
    case 'net.in.rate':
      return numberOrUndefined(point.download_speed ?? point.download) ?? null
    case 'net.out.rate':
      return numberOrUndefined(point.upload_speed ?? point.upload) ?? null
    case 'net.total.up':
    case 'traffic.up':
      return numberOrUndefined(point.cumulative_up ?? point.net_total_up ?? point.traffic_up) ?? null
    case 'net.total.down':
    case 'traffic.down':
      return numberOrUndefined(point.cumulative_down ?? point.net_total_down ?? point.traffic_down) ?? null
    case 'process.count':
      return numberOrUndefined(point.process) ?? null
    case 'connections.tcp':
      return numberOrUndefined(point.tcp_connections) ?? null
    case 'connections.udp':
      return numberOrUndefined(point.udp_connections) ?? null
    default:
      return numberOrUndefined(point.load) ?? null
  }
}

function metricPointTime(point: MmwxMetricPoint | MmwxSystemSeriesPoint): string | undefined {
  const raw = 't' in point ? point.t : point.timestamp
  if (raw === undefined || raw === null || raw === '') return undefined
  if (typeof raw === 'number') return new Date(raw > 1e12 ? raw : raw * 1000).toISOString()
  const numeric = Number(raw)
  if (Number.isFinite(numeric)) {
    return new Date(numeric > 1e12 ? numeric : numeric * 1000).toISOString()
  }
  const parsed = Date.parse(String(raw))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined
}

function inferIntervalSeconds(points: readonly KomariMetricPoint[]): number {
  if (points.length < 2) return 300
  const sorted = [...points].sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
  const diffs = sorted.slice(1).map((point, index) => {
    const current = Date.parse(point.time)
    const previous = Date.parse(sorted[index].time)
    return Math.max(1, Math.round((current - previous) / 1000))
  }).filter((value) => Number.isFinite(value) && value > 0)
  return diffs[0] ?? 300
}

function summarisePingMetricStats(history: PingHistory, entityIds: readonly string[], taskIds: readonly number[]): KomariPingMetricStat[] {
  const entityFilter = new Set(entityIds)
  const taskFilter = new Set(taskIds)
  const taskById = new Map(history.tasks.map((task) => [task.id, task]))
  const groups = new Map<string, PingHistory['records']>()

  for (const record of history.records) {
    if (entityFilter.size > 0 && !entityFilter.has(record.client)) continue
    if (taskFilter.size > 0 && !taskFilter.has(record.task_id)) continue
    const key = `${record.client}:${record.task_id}`
    const group = groups.get(key) ?? []
    group.push(record)
    groups.set(key, group)
  }

  return [...groups.entries()].map(([key, records]) => {
    const [entityId, taskIdRaw] = key.split(':')
    const taskId = Number(taskIdRaw)
    const task = taskById.get(taskId)
    const values = records
      .map((record) => typeof record.value === 'number' && record.value >= 0 ? record.value : undefined)
      .filter((value): value is number => value !== undefined)
      .sort((left, right) => left - right)
    const total = records.length
    const valid = values.length
    const loss = total > 0 ? Math.round(((total - valid) / total) * 100) : 0
    const latest = latestPingValue(records)
    const min = valid > 0 ? values[0] : 0
    const max = valid > 0 ? values[values.length - 1] : 0
    const avg = valid > 0 ? Math.round(values.reduce((sum, value) => sum + value, 0) / valid) : 0
    const p50 = valid > 0 ? percentile(values, 0.5) : null
    const p99 = valid > 0 ? percentile(values, 0.99) : null
    const stddev = valid > 0 ? standardDeviation(values) : null
    return {
      entity_id: entityId,
      task_id: taskId,
      name: task?.name ?? `Ping ${taskId}`,
      type: task?.type ?? 'icmp',
      interval: task?.interval ?? 30,
      total,
      valid,
      loss,
      min,
      max,
      avg,
      latest,
      p50,
      p99,
      stddev,
      p99_p50_ratio: p50 && p50 > 0 && p99 !== null ? Number((p99 / p50).toFixed(2)) : null,
    }
  })
}

function latestPingValue(records: readonly PingHistory['records'][number][]): number | null {
  const latest = [...records].sort((left, right) => Date.parse(left.time) - Date.parse(right.time)).at(-1)
  return latest && typeof latest.value === 'number' && latest.value >= 0 ? latest.value : null
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1))
  return values[index] ?? null
}

function standardDeviation(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length
  return Number(Math.sqrt(variance).toFixed(2))
}

function normalizeEntityId(value: string): string {
  if (/^mmwx-(0|[1-9]\d*)$/.test(value)) return value
  if (/^(0|[1-9]\d*)$/.test(value)) return `mmwx-${value}`
  return value
}

function isSystemMetricSeries(value: unknown): value is MmwxSystemMetricSeries {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray((value as { buckets?: unknown }).buckets)
    && (
      Array.isArray((value as { cpu_pct?: unknown }).cpu_pct)
      || Array.isArray((value as { mem_used?: unknown }).mem_used)
      || Array.isArray((value as { upload_speed?: unknown }).upload_speed)
      || Array.isArray((value as { download_speed?: unknown }).download_speed)
    )
}
