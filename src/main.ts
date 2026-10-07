import { describeConfig, loadConfig, HISTORY_BUFFER_PATH, THEME_SETTINGS_PATH } from './config.js'
import { MmwxClient } from './mmwx/client.js'
import { ProbeHistoryBuffer } from './mmwx/history-buffer.js'
import { FileHistoryBufferStore } from './mmwx/history-store.js'
import { ProbeStreamRelay } from './mmwx/stream-relay.js'
import { createApiRouter } from './http/api.js'
import { createHttpServer, type ServerHandle } from './http/server.js'
import { KomariDataService } from './komari/service.js'
import { createLogger, logError, logInfo } from './log.js'
import { loadTheme } from './theme/loader.js'
import { FileThemeSettingsStore } from './theme/settings-store.js'
import { MonitorDataService } from './monitor/service.js'

const HISTORY_FLUSH_INTERVAL_MS = 5 * 60 * 1000

export async function start(): Promise<ServerHandle> {
  const config = loadConfig(process.env)
  const logger = createLogger([config.probeToken])
  logger.info(`启动配置：${describeConfig(config)}`)
  const mmwx = new MmwxClient(config)
  const historyBuffer = new ProbeHistoryBuffer()
  const historyStore = new FileHistoryBufferStore(HISTORY_BUFFER_PATH)
  try {
    await historyStore.restore(historyBuffer)
  } catch (error) {
    logger.warn('历史采样缓冲恢复失败，以空缓冲启动', {
      reason: error instanceof Error ? error.message : 'unknown error',
    })
  }
  const hub = new ProbeStreamRelay(mmwx, historyBuffer)
  // 常驻采样：启动即连接主控并开启看门狗，主题加载期间不中断采样。
  hub.start()
  // 采样层已常驻，主题加载或监听失败时必须释放连接与定时器，避免进程挂住不退出。
  try {
    const theme = await loadTheme(config, logger)
    const themeSettingsStore = new FileThemeSettingsStore(theme.kind === 'monitor'
      ? THEME_SETTINGS_PATH.replace('.json', `-monitor-${encodeURIComponent(theme.short!)}.json`)
      : THEME_SETTINGS_PATH)
    const service = new KomariDataService(hub, {
      ...theme.source,
      themeTitle: theme.title,
      themeShort: theme.short,
      themeSettings: theme.themeSettings,
      themeSettingsStore,
      themeManifest: theme.manifest,
    }, historyBuffer)
    const monitor = theme.kind === 'monitor' ? new MonitorDataService(hub, historyBuffer) : undefined
    const api = createApiRouter(service, { adminToken: config.adminToken, logger, monitor, themeShort: theme.short })
    const server = createHttpServer(config, theme, api, hub, logger, undefined, monitor)

    // 历史采样缓冲定时落盘（unref：不阻止停机时的正常退出）。
    const historyFlushTimer = setInterval(() => {
      historyStore.flush(historyBuffer).catch((error: unknown) => {
        logger.warn('历史采样缓冲落盘失败', {
          reason: error instanceof Error ? error.message : 'unknown error',
        })
      })
    }, HISTORY_FLUSH_INTERVAL_MS)
    historyFlushTimer.unref()
    // 停机信号路径上同步落盘一次，保住最后一个周期内的增量。
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.once(signal, () => {
        try {
          historyStore.flushSync(historyBuffer)
        } catch {
          // 停机路径落盘失败不阻断退出。
        }
      })
    }

    await server.listen()
    return server
  } catch (error) {
    hub.close()
    throw error
  }
}

async function run(): Promise<void> {
  const server = await start()
  let closing = false
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return
    closing = true
    logInfo(`received ${signal}, shutting down`)
    await server.close()
    process.exitCode = 0
  }
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.once('SIGINT', () => void shutdown('SIGINT'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    logError('MMWX Komari adapter failed to start', {
      reason: error instanceof Error ? error.message : 'unknown error',
    })
    process.exitCode = 1
  })
}
import { pathToFileURL } from 'node:url'
