import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type { KomariDataService } from '../komari/service.js'
import type { SeriesQuery } from '../mmwx/types.js'
import type { KomariMeInfo } from '../komari/types.js'
import { noopLogger, type Logger } from '../log.js'
import type { MonitorDataService } from '../monitor/service.js'

export interface ApiRouter {
  handle(request: IncomingMessage, response: ServerResponse): Promise<boolean>
}

export interface ApiRouterOptions {
  adminToken?: string
  logger?: Logger
  monitor?: MonitorDataService
  themeShort?: string
}

type Query = Record<string, string>

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: SeriesQuery
}

interface RpcMethodHelp {
  name: string
  summary: string
  description: string
  params: Array<{ name: string; type: string; description: string }>
  returns: string
}

const RPC_METHOD_HELP: Record<string, RpcMethodHelp> = {
  'common:getNodes': {
    name: 'common:getNodes',
    summary: '获取节点信息',
    description: '获取所有可见节点的 Komari 客户端信息。',
    params: [],
    returns: 'Record<string, Client>',
  },
  'common:getNodesLatestStatus': {
    name: 'common:getNodesLatestStatus',
    summary: '获取节点最新状态',
    description: '获取所有可见节点的最新运行状态。',
    params: [],
    returns: 'Record<string, NodeStatus>',
  },
  'common:getNodeRecentStatus': {
    name: 'common:getNodeRecentStatus',
    summary: '获取节点最近状态',
    description: '获取指定节点的最近状态记录。',
    params: [{ name: 'uuid', type: 'string', description: '节点 UUID' }],
    returns: '{ count: number; records: StatusRecord[] }',
  },
  'common:getPublicInfo': {
    name: 'common:getPublicInfo',
    summary: '获取公开站点信息',
    description: '获取公开站点设置与主题配置。',
    params: [],
    returns: 'PublicInfo',
  },
  'common:getBackendVersion': {
    name: 'common:getBackendVersion',
    summary: '获取后端版本',
    description: '获取适配器后端版本与构建哈希。',
    params: [],
    returns: 'VersionInfo',
  },
  'common:getMe': {
    name: 'common:getMe',
    summary: '获取当前用户',
    description: '获取当前访问者的登录状态。',
    params: [],
    returns: 'MeInfo',
  },
  'common:getRecords': {
    name: 'common:getRecords',
    summary: '获取历史记录',
    description: '获取节点负载或 Ping 历史记录。',
    params: [{ name: 'type', type: 'string', description: 'load 或 ping' }],
    returns: 'RecordsResponse',
  },
}

const RPC_METHODS = [
  'rpc.ping',
  'rpc.getMethods',
  'rpc.getHelp',
  'rpc.getVersion',
  ...Object.keys(RPC_METHOD_HELP),
  'public:getMe',
  'public:getNodesInformation',
  'public:getClientRecentRecords',
  'public:getPublicInfo',
  'public:getVersion',
  'public:getPingRecords',
  'public:getRecordsByUUID',
  'public:queryMetrics',
  'public:getPingMetricStats',
  'public:getPublicPingTasks',
]

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
}

const ADMIN_SESSION_COOKIE = 'mmwx_admin_session'
const ADMIN_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

export function createApiRouter(service: KomariDataService, options: ApiRouterOptions = {}): ApiRouter {
  const logger = options.logger ?? noopLogger
  return {
    async handle(request, response) {
      const url = new URL(request.url ?? '/', 'http://adapter.local')
      if (!url.pathname.startsWith('/api/')) return false

      try {
        if (url.pathname === '/api/rpc2') {
          if (request.method !== 'POST') return methodNotAllowed(response)
          return await handleRpc2(service, request, response, getAdminSessionMe(request, options.adminToken))
        }

        if (url.pathname === '/api/version' && request.method === 'GET') {
          return json(response, 200, envelope(await service.getVersion()))
        }

        if (url.pathname === '/api/admin/auth/verify' && request.method === 'POST') {
          if (!options.adminToken) {
            logger.warn('管理员 Token 验证失败', { reason: 'ADMIN_TOKEN 未配置', remoteAddress: request.socket.remoteAddress })
            return json(response, 403, envelope(null, '未配置 ADMIN_TOKEN，主题设置已禁用', 'error'))
          }
          if (!hasAdminToken(request, options.adminToken)) {
            logger.warn('管理员 Token 验证失败', { reason: 'Token 不匹配', remoteAddress: request.socket.remoteAddress })
            return json(response, 401, envelope(null, '管理员 Token 无效', 'error'))
          }
          logger.info('管理员 Token 验证成功', { remoteAddress: request.socket.remoteAddress })
          return json(
            response,
            200,
            envelope({ logged_in: true }, '验证成功'),
            { 'Set-Cookie': buildAdminSessionCookie(request, options.adminToken) },
          )
        }

        if (url.pathname === '/api/admin/auth/logout' && request.method === 'POST') {
          logger.info('管理员退出登录', { remoteAddress: request.socket.remoteAddress })
          return json(response, 200, envelope(null, '已退出登录'), { 'Set-Cookie': clearAdminSessionCookie(request) })
        }

        if (url.pathname === '/api/admin/theme/settings' && request.method === 'POST') {
          if (!options.adminToken) {
            logger.warn('主题配置写入被拒绝', { reason: 'ADMIN_TOKEN 未配置', remoteAddress: request.socket.remoteAddress })
            return json(response, 403, envelope(null, '未配置 ADMIN_TOKEN，主题设置已禁用', 'error'))
          }
          if (!hasAdminSession(request, options.adminToken)) {
            logger.warn('主题配置写入被拒绝', { reason: '未建立管理员会话', remoteAddress: request.socket.remoteAddress })
            return json(response, 401, envelope(null, '请先完成管理员验证', 'error'))
          }
          const body = await readJsonObject(request)
          let result: unknown
          try {
            result = await service.updateThemeSettings(body)
          } catch (error: unknown) {
            logger.error('主题配置写入失败', {
              reason: '持久化异常',
              remoteAddress: request.socket.remoteAddress,
            })
            throw error
          }
          logger.info('主题配置写入成功', {
            auth: 'session',
            remoteAddress: request.socket.remoteAddress,
          })
          return json(response, 200, envelope(result))
        }

        if (request.method !== 'GET') return methodNotAllowed(response)
        if (options.monitor) {
          if (url.pathname === '/api/nodes') return json(response, 200, await options.monitor.getSnapshot())
          if (url.pathname === '/api/me') {
            const pub = await service.getPublicSettings()
            return json(response, 200, {
              authed: Boolean(getAdminSessionMe(request, options.adminToken)),
              site_name: pub.sitename, public_page: true, github: false,
            })
          }
          const history = url.pathname.match(/^\/api\/nodes\/([^/]+)\/metrics$/)
          if (history) return json(response, 200, await options.monitor.getHistory(history[1], url.searchParams))
          if (url.pathname === `/api/themes/${encodeURIComponent(options.themeShort ?? '')}/config`) {
            return json(response, 200, await service.getThemeSettings())
          }
        }
        if (url.pathname === '/api/probe') {
          return json(response, 200, await service.getRawProbePayload())
        }
        if (url.pathname === '/api/series') {
          return json(response, 200, await service.getSeriesPayload(queryFrom(url)))
        }
        if (url.pathname === '/api/nodes') {
          const snapshot = await service.getSnapshot()
          return json(response, 200, envelope(snapshot.nodes))
        }
        if (url.pathname === '/api/admin/client/list') {
          return json(response, 200, envelope(await service.getNodesInformation()))
        }
        if (url.pathname === '/api/admin/ping') {
          return json(response, 200, envelope(await service.getPublicPingTasks(queryFrom(url))))
        }
        if (url.pathname === '/api/admin/theme/settings') {
          return json(response, 200, envelope(await service.getThemeSettings()))
        }
        if (url.pathname === '/api/public') {
          return json(response, 200, envelope(await service.getPublicSettings()))
        }
        if (url.pathname === '/api/me') {
          return json(response, 200, getAdminSessionMe(request, options.adminToken) ?? await service.getMe())
        }
        if (url.pathname === '/api/records/ping') {
          return json(response, 200, await service.getPingHistory(queryFrom(url)))
        }
        if (url.pathname === '/api/records/load') {
          const query = queryFrom(url)
          if (!isInternalUuid(query.uuid)) return json(response, 400, envelope(null, 'invalid uuid', 'error'))
          return json(response, 200, await service.getLoadHistory(query.uuid, query))
        }
        return json(response, 404, envelope(null, 'not found', 'error'))
      } catch (error: unknown) {
        const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
          ? (error as { statusCode: number }).statusCode
          : 500
        return json(response, statusCode, envelope(null, error instanceof Error ? escapeHtml(error.message) : 'upstream error', 'error'))
      }
    },
  }
}

function hasAdminToken(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization
  if (typeof header !== 'string') return false
  // 线性解析 Bearer 凭证，避免 \s+(.+) 歧义回溯带来的多项式 ReDoS
  if (header.slice(0, 6).toLowerCase() !== 'bearer') return false
  const rest = header.slice(6)
  if (!/^\s/.test(rest)) return false
  const token = rest.trimStart()
  return token.length > 0 && constantTimeEqual(token, expected)
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  if (actualBuffer.length !== expectedBuffer.length) return false
  return timingSafeEqual(actualBuffer, expectedBuffer)
}

function sessionSignature(payload: string, adminToken: string): string {
  return createHmac('sha256', adminToken).update(payload).digest('base64url')
}

function buildAdminSessionCookie(request: IncomingMessage, adminToken: string): string {
  const issuedAt = Math.floor(Date.now() / 1000)
  const payload = `v1.${issuedAt}.${randomBytes(24).toString('base64url')}`
  const value = `${payload}.${sessionSignature(payload, adminToken)}`
  const forwardedProto = request.headers['x-forwarded-proto']
  const isSecure = (request.socket as { encrypted?: boolean }).encrypted === true || forwardedProto === 'https'
  return `${ADMIN_SESSION_COOKIE}=${value}; Max-Age=${ADMIN_SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`
}

function clearAdminSessionCookie(request: IncomingMessage): string {
  const forwardedProto = request.headers['x-forwarded-proto']
  const isSecure = (request.socket as { encrypted?: boolean }).encrypted === true || forwardedProto === 'https'
  return `${ADMIN_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${isSecure ? '; Secure' : ''}`
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const cookieHeader = request.headers.cookie
  if (typeof cookieHeader !== 'string') return undefined
  for (const cookie of cookieHeader.split(';')) {
    const separator = cookie.indexOf('=')
    if (separator < 0) continue
    if (cookie.slice(0, separator).trim() !== name) continue
    return cookie.slice(separator + 1).trim()
  }
  return undefined
}

function hasAdminSession(request: IncomingMessage, adminToken: string, now = Math.floor(Date.now() / 1000)): boolean {
  const value = readCookie(request, ADMIN_SESSION_COOKIE)
  if (!value) return false
  const parts = value.split('.')
  if (parts.length !== 4 || parts[0] !== 'v1') return false
  const issuedAt = Number(parts[1])
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60 || now - issuedAt > ADMIN_SESSION_TTL_SECONDS) return false
  const payload = parts.slice(0, 3).join('.')
  const signature = parts[3]
  return constantTimeEqual(signature, sessionSignature(payload, adminToken))
}

function adminSessionMe(): KomariMeInfo {
  return {
    logged_in: true,
    username: 'admin',
    uuid: '',
    sso_id: '',
    sso_type: '',
    '2fa_enabled': false,
  }
}

export function getAdminSessionMe(request: IncomingMessage, adminToken?: string): KomariMeInfo | undefined {
  return adminToken && hasAdminSession(request, adminToken) ? adminSessionMe() : undefined
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readBody(request))
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw Object.assign(new Error('request body must be a JSON object'), { statusCode: 400 })
  }
  return parsed as Record<string, unknown>
}

function envelope(data: unknown, message = 'success', status = 'success'): { status: string; message: string; data: unknown } {
  return { status, message, data }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function methodNotAllowed(response: ServerResponse): boolean {
  return json(response, 405, envelope(null, 'method not allowed', 'error'))
}

function json(response: ServerResponse, statusCode: number, payload: unknown, extraHeaders?: Record<string, string | string[]>): boolean {
  response.writeHead(statusCode, { ...JSON_HEADERS, ...extraHeaders })
  response.end(JSON.stringify(payload))
  return true
}

function queryFrom(url: URL): Query {
  return Object.fromEntries(url.searchParams.entries())
}

function isInternalUuid(value: unknown): value is string {
  return typeof value === 'string' && /^mmwx-(0|[1-9]\d*)$/.test(value)
}

async function handleRpc2(service: KomariDataService, request: IncomingMessage, response: ServerResponse, me?: KomariMeInfo): Promise<boolean> {
  let rpc: JsonRpcRequest
  try {
    rpc = JSON.parse(await readBody(request)) as JsonRpcRequest
  } catch {
    return json(response, 200, rpcError(null, -32700, 'Parse error'))
  }

  return json(response, 200, await dispatchRpc2(service, rpc, me))
}

export async function dispatchRpc2(service: KomariDataService, rpc: JsonRpcRequest, me?: KomariMeInfo): Promise<unknown> {
  const id = rpc.id ?? null
  const params = rpc.params ?? {}
  try {
    if (rpc.method === 'rpc.ping') return rpcResult(id, 'pong')
    if (rpc.method === 'rpc.getMethods') return rpcResult(id, RPC_METHODS)
    if (rpc.method === 'rpc.getHelp') {
      const method = typeof params.method === 'string' ? params.method : undefined
      if (method) {
        const help = RPC_METHOD_HELP[method]
        return help ? rpcResult(id, help) : rpcError(id, -32601, 'Method not found')
      }
      return rpcResult(id, Object.values(RPC_METHOD_HELP))
    }
    if (rpc.method === 'rpc.getVersion' || rpc.method === 'common:getBackendVersion') {
      return rpcResult(id, await service.getVersion())
    }
    if (rpc.method === 'common:getMe' || rpc.method === 'public:getMe') {
      return rpcResult(id, me ?? await service.getMe())
    }
    if (rpc.method === 'common:getPublicInfo') {
      return rpcResult(id, await service.getPublicInfo())
    }
    if (rpc.method === 'nodes.list' || rpc.method === 'public.nodes' || rpc.method === 'public:getNodesInformation') {
      if (rpc.method === 'public:getNodesInformation') {
        return rpcResult(id, await service.getNodesInformation())
      }
      const snapshot = await service.getSnapshot()
      return rpcResult(id, snapshot.nodes)
    }
    if (rpc.method === 'public:getPublicSettings') {
      return rpcResult(id, await service.getPublicSettings())
    }
    if (rpc.method === 'common:getNodes') {
      return rpcResult(id, await service.getNodes(typeof params.uuid === 'string' ? params.uuid : undefined))
    }
    if (rpc.method === 'common:getNodesLatestStatus') {
      return rpcResult(id, await service.getNodesLatestStatus(params))
    }
    if (rpc.method === 'common:getNodeRecentStatus') {
      if (typeof params.uuid !== 'string' || !params.uuid) return rpcError(id, -32602, 'Invalid params')
      const limit = typeof params.limit === 'number' ? params.limit : undefined
      return rpcResult(id, await service.getNodeRecentStatus(params.uuid, limit))
    }
    if (rpc.method === 'public:getClientRecentRecords') {
      return rpcResult(id, await service.getClientRecentRecords(params))
    }
    if (rpc.method === 'public:getVersion') {
      return rpcResult(id, await service.getVersion())
    }
    if (rpc.method === 'records.ping' || rpc.method === 'public:getPingRecords') {
      if (rpc.method === 'public:getPingRecords') {
        return rpcResult(id, await service.getPingRecords(params))
      }
      return rpcResult(id, await service.getPingHistory(params))
    }
    if (rpc.method === 'common:getRecords') {
      return rpcResult(id, await service.getRecords(params))
    }
    if (rpc.method === 'records.load' || rpc.method === 'public:getRecordsByUUID') {
      if (!isInternalUuid(params.uuid)) return rpcError(id, -32602, 'Invalid params')
      if (rpc.method === 'public:getRecordsByUUID') {
        return rpcResult(id, await service.getLoadRecords(params.uuid, params))
      }
      return rpcResult(id, await service.getLoadHistory(params.uuid, params))
    }
    if (rpc.method === 'public:queryMetrics') {
      return rpcResult(id, await service.getQueryMetrics(params))
    }
    if (rpc.method === 'public:getPingMetricStats') {
      return rpcResult(id, await service.getPingMetricStats(params))
    }
    if (rpc.method === 'public:getPublicPingTasks') {
      return rpcResult(id, await service.getPublicPingTasks(params))
    }
    return rpcError(id, -32601, 'Method not found')
  } catch (error: unknown) {
    return rpcError(id, -32000, error instanceof Error ? escapeHtml(error.message) : 'Upstream error')
  }
}

function rpcResult(id: JsonRpcRequest['id'], result: unknown): { jsonrpc: '2.0'; id: JsonRpcRequest['id']; result: unknown } {
  return { jsonrpc: '2.0', id, result }
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string): { jsonrpc: '2.0'; id: JsonRpcRequest['id']; error: { code: number; message: string } } {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}
