import assert from 'node:assert/strict'
import { once } from 'node:events'
import http from 'node:http'
import { test } from 'node:test'

import { createApiRouter } from '../src/http/api.js'
import { KomariDataService } from '../src/komari/service.js'
import type { ProbePayload, ProbeSeriesPayload, SeriesQuery } from '../src/mmwx/types.js'

interface TestResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: unknown
}

const defaultPublicSettings = {
  sitename: '妙妙屋 X 主控',
  description: '',
  theme: 'junimo',
  theme_settings: {},
  private_site: false,
  record_enabled: true,
  record_preserve_time: 24,
  ping_record_preserve_time: 24,
  custom_head: '',
  custom_body: '',
  oauth_enable: false,
  oauth_provider: '',
  disable_password_login: false,
  cors_origin_check_enabled: true,
  visitor_audit_enabled: false,
}

function fakeService(overrides: Record<string, unknown> = {}): KomariDataService {
  return {
    getProbePayload: async () => ({
      enabled: true,
      show_globe: true,
      show_daily_trend: true,
      show_traffic_hotspots: true,
      show_traffic_7d: true,
      show_resource_heatmap: true,
      show_traffic_quota: true,
      show_renewal_timeline: true,
      show_health_score: true,
      title: '妙妙屋 X 主控',
      appearance: { theme: 'junimo', color_mode: 'light', revision: 'main' },
      servers: [{
        name: 'node-0',
        online: true,
        daily_traffic: [{ date: '2026-08-21', uplink: 1, downlink: 2, total: 3 }],
        traffic_used_up: 1,
        traffic_used_down: 2,
        traffic_used_total: 3,
        period_start: '2026-08-01T00:00:00.000Z',
        period_end: '2026-09-01T00:00:00.000Z',
      }],
    } as ProbePayload),
    getSeriesPayload: async () => ({
      pings: [{ serverId: 0, route: 'Google', points: [{ timestamp: '2026-08-21T00:00:00.000Z', value: 10, loss: 0 }] }],
      systems: [{ serverId: 0, points: [{ timestamp: '2026-08-21T00:00:00.000Z', cpu: 1 }] }],
    } as ProbeSeriesPayload),
    getSnapshot: async () => ({
      nodes: [{ uuid: 'mmwx-0', name: 'node-0', online: true }],
      records: [{ uuid: 'mmwx-0', online: true, updated_at: '2026-08-21T00:00:00.000Z' }],
    }),
    getPingHistory: async () => ({
      count: 1,
      records: [{ task_id: 0, time: '2026-08-21T00:00:00.000Z', value: 10, client: 'mmwx-0' }],
      tasks: [{ id: 0, name: 'Google', clients: ['mmwx-0'], default_on: true, type: 'icmp', interval: 30 }],
      basic_info: { clients: ['mmwx-0'] },
    }),
    getLoadHistory: async () => ({
      count: 1,
      records: [{ client: 'mmwx-0', time: '2026-08-21T00:00:00.000Z', cpu: 1 }],
    }),
    getMe: async () => ({
      logged_in: false,
      username: 'Guest',
      uuid: '',
      sso_id: '',
      sso_type: '',
      '2fa_enabled': false,
    }),
    getPublicInfo: async () => defaultPublicSettings,
    getPublicSettings: async () => defaultPublicSettings,
    getVersion: async () => ({ version: 'v0.0.1', hash: 'test-hash' }),
    ...overrides,
  } as unknown as KomariDataService
}

async function withApi(service: KomariDataService, run: (baseUrl: string) => Promise<void>, options: Parameters<typeof createApiRouter>[1] = {}): Promise<void> {
  const router = createApiRouter(service, options)
  const server = http.createServer((request, response) => {
    router.handle(request, response).then((handled: boolean) => {
      if (!handled && !response.headersSent) {
        response.writeHead(500)
        response.end()
      }
    }).catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown' }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

async function request(baseUrl: string, path: string, init: RequestInit = {}): Promise<TestResponse> {
  const response = await fetch(`${baseUrl}${path}`, init)
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.json(),
  }
}

function assertJsonHeaders(response: TestResponse): void {
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['x-content-type-options'], 'nosniff')
  assert.equal(response.headers['cache-control'], 'no-store')
}

test('API routes return Komari-compatible public resources', async () => {
  await withApi(fakeService(), async (baseUrl) => {
    const nodes = await request(baseUrl, '/api/nodes')
    assert.equal(nodes.status, 200)
    assertJsonHeaders(nodes)
    assert.deepEqual(nodes.body, { status: 'success', message: 'success', data: [{ uuid: 'mmwx-0', name: 'node-0', online: true }] })

    const publicInfo = await request(baseUrl, '/api/public')
    assert.equal(publicInfo.status, 200)
    assert.deepEqual(publicInfo.body, { status: 'success', message: 'success', data: defaultPublicSettings })

  const me = await request(baseUrl, '/api/me')
  assert.equal(me.status, 200)
  assert.deepEqual(me.body, {
    logged_in: false,
    username: 'Guest',
    uuid: '',
    sso_id: '',
    sso_type: '',
    '2fa_enabled': false,
  })
  })
})

test('API version endpoint returns adapter version information', async () => {
  await withApi(fakeService(), async (baseUrl) => {
    const version = await request(baseUrl, '/api/version')
    assert.equal(version.status, 200)
    assertJsonHeaders(version)
    assert.deepEqual(version.body, {
      status: 'success',
      message: 'success',
      data: { version: 'v0.0.1', hash: 'test-hash' },
    })
  })
})

test('API routes expose MMWX probe-compatible fixed HTTP paths', async () => {
  const seen: unknown[] = []
  await withApi(fakeService({
    getRawProbePayload: async () => {
      seen.push(['raw-probe'])
      return {
        enabled: false,
        upstream_raw_marker: true,
        servers: [{
          name: 'raw-node',
        }],
      } as ProbePayload
    },
    getProbePayload: async () => {
      seen.push(['translated-probe'])
      return {
        enabled: true,
        title: 'translated',
        servers: [{ name: 'translated-node', online: true }],
      } as ProbePayload
    },
    getSeriesPayload: async (query: SeriesQuery) => {
      seen.push(['series', query])
      return { pings: [], systems: [] }
    },
  } as Partial<KomariDataService>), async (baseUrl) => {
    const probe = await request(baseUrl, '/api/probe')
    assert.equal(probe.status, 200)
    assertJsonHeaders(probe)
    assert.deepEqual(probe.body, {
      enabled: false,
      upstream_raw_marker: true,
      servers: [{
        name: 'raw-node',
      }],
    })

    const series = await request(baseUrl, '/api/series?hours=24&metric=system')
    assert.equal(series.status, 200)
    assert.deepEqual(series.body, { pings: [], systems: [] })
    assert.deepEqual(seen, [
      ['raw-probe'],
      ['series', { hours: '24', metric: 'system' }],
    ])
  })
})

test('MMWX probe-compatible HTTP paths bypass the Komari cache layer', async () => {
  let probeCalls = 0
  let seriesCalls = 0
  const service = new KomariDataService({
    fetchProbe: async () => {
      probeCalls += 1
      return {
        enabled: true,
        marker: `probe-${probeCalls}`,
        servers: [],
      } as ProbePayload
    },
    fetchSeries: async (query: SeriesQuery) => {
      seriesCalls += 1
      return {
        marker: `series-${seriesCalls}`,
        query,
      } as ProbeSeriesPayload
    },
  })

  await withApi(service, async (baseUrl) => {
    assert.deepEqual((await request(baseUrl, '/api/probe')).body, { enabled: true, marker: 'probe-1', servers: [] })
    assert.deepEqual((await request(baseUrl, '/api/probe')).body, { enabled: true, marker: 'probe-2', servers: [] })

    assert.deepEqual((await request(baseUrl, '/api/series?range=24h')).body, { marker: 'series-1', query: { range: '24h' } })
    assert.deepEqual((await request(baseUrl, '/api/series?range=24h')).body, { marker: 'series-2', query: { range: '24h' } })
  })

  assert.equal(probeCalls, 2)
  assert.equal(seriesCalls, 2)
})

test('API routes return ping and load history with validated UUIDs', async () => {
  const seen: unknown[] = []
  await withApi(fakeService({
    getPingHistory: async (query: unknown) => {
      seen.push(['ping', query])
      return { count: 0, records: [], tasks: [], basic_info: { clients: [] } }
    },
    getLoadHistory: async (uuid: string, query: unknown) => {
      seen.push(['load', uuid, query])
      return { count: 0, records: [] }
    },
  } as Partial<KomariDataService>), async (baseUrl) => {
    const ping = await request(baseUrl, '/api/records/ping?hours=1')
    assert.equal(ping.status, 200)
    assert.deepEqual(ping.body, { count: 0, records: [], tasks: [], basic_info: { clients: [] } })

    const load = await request(baseUrl, '/api/records/load?uuid=mmwx-0&hours=1')
    assert.equal(load.status, 200)
    assert.deepEqual(load.body, { count: 0, records: [] })

    const invalid = await request(baseUrl, '/api/records/load?uuid=evil&hours=1')
    assert.equal(invalid.status, 400)
    assert.deepEqual(seen, [
      ['ping', { hours: '1' }],
      ['load', 'mmwx-0', { uuid: 'mmwx-0', hours: '1' }],
    ])
  })
})

test('Komari load history requests system metrics from the MMWX series API', async () => {
  const seen: SeriesQuery[] = []
  const service = new KomariDataService({
    fetchProbe: async () => ({ servers: [] }),
    fetchSeries: async (query: SeriesQuery) => {
      seen.push(query)
      return {
        success: true,
        bucket_sec: 300,
        generated_at: 1787313000,
        series: {
          cpu_pct: [{ t: 1787312700, value: 12 }],
          mem_used: [{ t: 1787312700, value: 34 }],
          upload_speed: [{ t: 1787312700, value: 56 }],
          download_speed: [{ t: 1787312700, value: 78 }],
        },
      }
    },
  })

  const history = await service.getLoadHistory('mmwx-0', { uuid: 'mmwx-0', hours: '24' })

  assert.deepEqual(seen, [{ server: '0', range: '24h', metric: 'system' }])
  assert.deepEqual(history.records, [{
    client: 'mmwx-0',
    time: '2026-08-21T11:45:00.000Z',
    cpu: 12,
    ram: 34,
    net_out: 56,
    net_in: 78,
  }])
})

test('Komari ping history uses latency and loss points from the MMWX series API', async () => {
  const seen: SeriesQuery[] = []
  const service = new KomariDataService({
    fetchProbe: async () => ({ servers: [{ name: 'node-0' }, { name: 'node-1' }] }),
    fetchSeries: async (query: SeriesQuery) => {
      seen.push(query)
      return {
        success: true,
        bucket_sec: 300,
        generated_at: 1787313000,
        all_series: [
          {
            key: 'google',
            label: 'Google',
            buckets: [{ ms: 10, loss: 0 }, { ms: 11, loss: 1 }],
          },
          {
            key: 'cloudflare',
            label: 'Cloudflare',
            buckets: [{ ms: 20, loss: 2 }, { ms: null, loss: 100 }],
          },
        ],
      }
    },
  })

  const history = await service.getPingHistory({ uuid: 'mmwx-0', task_id: '0', hours: '24' })

  assert.deepEqual(seen, [{ server: '0', range: '24h', all: '1' }])
  assert.deepEqual(history, {
    count: 4,
    records: [
      { task_id: 1, time: '2026-08-21T11:45:00.000Z', value: 10, loss: 0, client: 'mmwx-0' },
      { task_id: 2, time: '2026-08-21T11:45:00.000Z', value: 20, loss: 2, client: 'mmwx-0' },
      { task_id: 1, time: '2026-08-21T11:50:00.000Z', value: 11, loss: 1, client: 'mmwx-0' },
      { task_id: 2, time: '2026-08-21T11:50:00.000Z', value: null, loss: 100, client: 'mmwx-0' },
    ],
    tasks: [
      { id: 1, name: 'Google', clients: ['mmwx-0'], default_on: true, type: 'icmp', interval: 30 },
      { id: 2, name: 'Cloudflare', clients: ['mmwx-0'], default_on: true, type: 'icmp', interval: 30 },
    ],
    basic_info: { clients: ['mmwx-0'] },
  })
})

test('API routes reject unsupported methods, unknown API paths, and upstream failures as JSON', async () => {
  await withApi(fakeService({
    getSnapshot: async () => {
      throw Object.assign(new Error('upstream failed'), { statusCode: 502 })
    },
  }), async (baseUrl) => {
    const method = await request(baseUrl, '/api/nodes', { method: 'POST' })
    assert.equal(method.status, 405)
    assertJsonHeaders(method)

    const unknown = await request(baseUrl, '/api/unknown')
    assert.equal(unknown.status, 404)
    assertJsonHeaders(unknown)

    const upstream = await request(baseUrl, '/api/nodes')
    assert.equal(upstream.status, 502)
    assertJsonHeaders(upstream)
    assert.deepEqual(upstream.body, { status: 'error', message: 'upstream failed', data: null })
  })
})

test('RPC2 supports read-only public methods and rejects unknown or mutating methods', async () => {
  await withApi(fakeService(), async (baseUrl) => {
    const nodes = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nodes.list' }),
    })
    assert.equal(nodes.status, 200)
    assert.deepEqual(nodes.body, { jsonrpc: '2.0', id: 1, result: [{ uuid: 'mmwx-0', name: 'node-0', online: true }] })

    const ping = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'records.ping', params: { hours: 1 } }),
    })
    assert.equal(ping.status, 200)
    assert.equal((ping.body as { result?: { count?: number } }).result?.count, 1)

    const unknown = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'admin.deleteNode' }),
    })
    assert.equal(unknown.status, 200)
    assert.deepEqual(unknown.body, { jsonrpc: '2.0', id: 3, error: { code: -32601, message: 'Method not found' } })
  })
})

test('RPC2 exposes the full Komari compatibility payloads needed by adhesive-note', async () => {
  const node = {
    uuid: 'mmwx-0',
    name: 'node-0',
    cpu_name: 'Intel(R) Xeon(R) CPU E5-2697 v2 @ 2.70GHz',
    virtualization: 'kvm',
    arch: 'amd64',
    cpu_cores: 2,
    cpu_physical_cores: 2,
    os: 'Debian GNU/Linux 12 (bookworm)',
    kernel_version: '6.1.0-52-amd64',
    gpu_name: 'None',
    region: '🇺🇸',
    mem_total: 8 * 1024 ** 3,
    swap_total: 2 * 1024 ** 3,
    disk_total: 50 * 1024 ** 3,
    weight: 10,
    price: 9.5,
    billing_cycle: 30,
    auto_renewal: true,
    currency: '$',
    expired_at: '2026-09-21T00:00:00.000Z',
    group: 'default',
    tags: 'prod,edge',
    hidden: false,
    traffic_limit: 1024 ** 4,
    traffic_limit_type: 'max',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-21T00:00:00.000Z',
    public_remark: 'main node',
  }
  const status = {
    client: node.uuid,
    time: '2026-08-21T12:00:00.000Z',
    cpu: 12.5,
    gpu: 0,
    ram: 3 * 1024 ** 3,
    ram_total: 8 * 1024 ** 3,
    swap: 128 * 1024 ** 2,
    swap_total: 2 * 1024 ** 3,
    load: 0.42,
    load5: 0.3,
    load15: 0.2,
    temp: 36.5,
    disk: 20 * 1024 ** 3,
    disk_total: 50 * 1024 ** 3,
    net_in: 1024,
    net_out: 2048,
    net_total_up: 111,
    net_total_down: 222,
    process: 88,
    connections: 24,
    connections_udp: 2,
    online: true,
    uptime: 123456,
  }
  const recent = [status]
  const loadRecords = {
    count: 1,
    records: [{
      client: node.uuid,
      time: '2026-08-21T11:55:00.000Z',
      cpu: 12.5,
      gpu: 0,
      ram: 3 * 1024 ** 3,
      ram_total: 0,
      swap: 128 * 1024 ** 2,
      swap_total: 0,
      load: 0.42,
      temp: 36.5,
      disk: 20 * 1024 ** 3,
      disk_total: 0,
      net_in: 1024,
      net_out: 2048,
      net_total_up: 111,
      net_total_down: 222,
      traffic_up: 2048,
      traffic_down: 1024,
      process: 88,
      connections: 24,
      connections_udp: 2,
    }],
    has_gpu_data: false,
    gpu_devices: [],
  }
  const pingRecords = {
    count: 2,
    records: [
      { task_id: 0, time: '2026-08-21T11:55:00.000Z', value: 18, client: node.uuid },
      { task_id: 0, time: '2026-08-21T12:00:00.000Z', value: -1, client: node.uuid },
    ],
    tasks: [{
      id: 0,
      name: 'Google',
      type: 'icmp',
      interval: 30,
      default_on: true,
      total: 2,
      loss: 50,
      min: 18,
      max: 18,
      avg: 18,
    }],
    basic_info: { clients: [node.uuid] },
  }
  const settings = {
    sitename: '妙妙屋 X 主控',
    description: '',
    theme: 'AdhesiveNote',
    theme_settings: { layout: 'paper' },
    private_site: false,
    record_enabled: true,
    record_preserve_time: 24,
    ping_record_preserve_time: 24,
    custom_head: '',
    custom_body: '',
    oauth_enable: false,
    oauth_provider: '',
    disable_password_login: false,
    cors_origin_check_enabled: true,
    visitor_audit_enabled: false,
  }

  await withApi(fakeService({
    getNodesInformation: async () => [node],
    getPublicSettings: async () => settings,
    getPublicInfo: async () => settings,
    getNodesLatestStatus: async () => ({ [node.uuid]: status }),
    getNodeRecentStatus: async () => ({ count: 1, records: [recent[0]] }),
    getClientRecentRecords: async () => recent,
    getLoadRecords: async () => loadRecords,
    getPingRecords: async () => pingRecords,
    getVersion: async () => ({ version: 'v0.2.0', hash: 'deadbee' }),
  }), async (baseUrl) => {
    const nodes = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'public:getNodesInformation' }),
    })
    assert.equal(nodes.status, 200)
    assert.deepEqual(nodes.body, { jsonrpc: '2.0', id: 10, result: [node] })

    const meResp = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'common:getMe' }),
    })
    assert.equal(meResp.status, 200)
    assert.deepEqual(meResp.body, { jsonrpc: '2.0', id: 11, result: { logged_in: false, username: 'Guest', uuid: '', sso_id: '', sso_type: '', '2fa_enabled': false } })

    const publicMeResp = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 12, method: 'public:getMe' }),
    })
    assert.equal(publicMeResp.status, 200)
    assert.deepEqual(publicMeResp.body, { jsonrpc: '2.0', id: 12, result: { logged_in: false, username: 'Guest', uuid: '', sso_id: '', sso_type: '', '2fa_enabled': false } })

    const publicInfoResp = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 13, method: 'common:getPublicInfo' }),
    })
    assert.equal(publicInfoResp.status, 200)
    assert.deepEqual(publicInfoResp.body, { jsonrpc: '2.0', id: 13, result: settings })

    const statusResp = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 14, method: 'common:getNodesLatestStatus' }),
    })
    assert.equal(statusResp.status, 200)
    assert.deepEqual(statusResp.body, { jsonrpc: '2.0', id: 14, result: { [node.uuid]: status } })

    const recentStatusResp = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 15, method: 'common:getNodeRecentStatus', params: { uuid: node.uuid } }),
    })
    assert.equal(recentStatusResp.status, 200)
    assert.deepEqual(recentStatusResp.body, { jsonrpc: '2.0', id: 15, result: { count: 1, records: [recent[0]] } })

    const recentResp = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 16, method: 'public:getClientRecentRecords', params: { uuid: node.uuid } }),
    })
    assert.equal(recentResp.status, 200)
    assert.deepEqual(recentResp.body, { jsonrpc: '2.0', id: 16, result: recent })

    const settingsResp = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 17, method: 'public:getPublicSettings' }),
    })
    assert.equal(settingsResp.status, 200)
    assert.deepEqual(settingsResp.body, { jsonrpc: '2.0', id: 17, result: settings })

    const versionResp = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 18, method: 'public:getVersion' }),
    })
    assert.equal(versionResp.status, 200)
    assert.deepEqual(versionResp.body, { jsonrpc: '2.0', id: 18, result: { version: 'v0.2.0', hash: 'deadbee' } })

    const loadResp = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 19, method: 'public:getRecordsByUUID', params: { uuid: node.uuid, load_type: 'all', hours: '24' } }),
    })
    assert.equal(loadResp.status, 200)
    assert.deepEqual(loadResp.body, { jsonrpc: '2.0', id: 19, result: loadRecords })

    const pingResp = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'public:getPingRecords', params: { uuid: node.uuid, hours: '24' } }),
    })
    assert.equal(pingResp.status, 200)
    assert.deepEqual(pingResp.body, { jsonrpc: '2.0', id: 20, result: pingRecords })
  })
})

test('Komari common ping records aggregate every node when uuid is omitted', async () => {
  const service = new KomariDataService({
    fetchProbe: async () => ({ servers: [{ name: 'node-0' }, { name: 'node-1' }] }),
    fetchSeries: async (query: SeriesQuery) => ({
      success: true,
      bucket_sec: 300,
      generated_at: 1787313000,
      all_series: [{
        key: 'google',
        label: 'Google',
        buckets: [{ ms: Number(query.server) + 10, loss: 0 }],
      }],
    }),
  })

  const records = await service.getRecords({ type: 'ping', hours: '1' })

  assert.equal(records.count, 2)
  assert.deepEqual(records.records.map((record) => [record.client, 'value' in record ? record.value : undefined]), [
    ['mmwx-0', 10],
    ['mmwx-1', 11],
  ])
})

test('RPC2 exposes Komari built-in discovery and backend version aliases', async () => {
  await withApi(fakeService(), async (baseUrl) => {
    const methods = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'rpc.getMethods', params: { internal: true } }),
    })
    assert.equal(methods.status, 200)
    assert.ok(Array.isArray((methods.body as { result?: unknown }).result))
    assert.ok(((methods.body as { result: string[] }).result).includes('common:getNodes'))
    assert.ok(((methods.body as { result: string[] }).result).includes('common:getBackendVersion'))

    const help = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'rpc.getHelp', params: { method: 'common:getNodes' } }),
    })
    assert.equal(help.status, 200)
    assert.deepEqual((help.body as { result?: unknown }).result, {
      name: 'common:getNodes',
      summary: '获取节点信息',
      description: '获取所有可见节点的 Komari 客户端信息。',
      params: [],
      returns: 'Record<string, Client>',
    })

    const version = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'common:getBackendVersion' }),
    })
    assert.equal(version.status, 200)
    assert.deepEqual(version.body, {
      jsonrpc: '2.0',
      id: 22,
      result: { version: 'v0.0.1', hash: 'test-hash' },
    })
  })
})

test('RPC2 supports node filtering and recent-status limits', async () => {
  const nodes = {
    'mmwx-0': { uuid: 'mmwx-0', name: 'node-0' },
    'mmwx-1': { uuid: 'mmwx-1', name: 'node-1' },
  }
  const statuses = {
    'mmwx-0': { client: 'mmwx-0', time: '2026-08-21T00:00:00.000Z' },
    'mmwx-1': { client: 'mmwx-1', time: '2026-08-21T00:00:00.000Z' },
  }
  await withApi(fakeService({
    getNodes: async (uuid?: string) => uuid ? nodes[uuid as keyof typeof nodes] ?? null : nodes,
    getNodesLatestStatus: async (query: SeriesQuery = {}) => query.uuid === 'mmwx-1' ? { 'mmwx-1': statuses['mmwx-1'] } : statuses,
    getNodeRecentStatus: async (_uuid: string, limit?: number) => ({
      count: limit === 1 ? 1 : 2,
      records: limit === 1 ? [statuses['mmwx-0']] : [statuses['mmwx-0'], statuses['mmwx-1']],
    }),
  }), async (baseUrl) => {
    const node = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 23, method: 'common:getNodes', params: { uuid: 'mmwx-1' } }),
    })
    assert.deepEqual(node.body, { jsonrpc: '2.0', id: 23, result: { uuid: 'mmwx-1', name: 'node-1' } })

    const status = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 24, method: 'common:getNodesLatestStatus', params: { uuid: 'mmwx-1' } }),
    })
    assert.deepEqual(status.body, { jsonrpc: '2.0', id: 24, result: { 'mmwx-1': statuses['mmwx-1'] } })

    const recent = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 25, method: 'common:getNodeRecentStatus', params: { uuid: 'mmwx-0', limit: 1 } }),
    })
    assert.deepEqual(recent.body, { jsonrpc: '2.0', id: 25, result: { count: 1, records: [statuses['mmwx-0']] } })
  })
})

test('RPC2 supports Junimo metric and common compatibility methods', async () => {
  const node = {
    uuid: 'mmwx-0',
    token: 'hidden-token',
    name: 'node-0',
    cpu_name: 'Intel Xeon',
    virtualization: 'kvm',
    arch: 'amd64',
    cpu_cores: 2,
    cpu_physical_cores: 2,
    os: 'Debian GNU/Linux 12 (bookworm)',
    kernel_version: '6.1.0',
    gpu_name: 'None',
    ipv4: '10.0.0.2',
    ipv6: '::1',
    region: '🇺🇸',
    remark: 'private',
    public_remark: 'public remark',
    mem_total: 8 * 1024 ** 3,
    swap_total: 2 * 1024 ** 3,
    disk_total: 50 * 1024 ** 3,
    version: 'v1.2.3',
    weight: 10,
    price: 9.5,
    billing_cycle: 30,
    auto_renewal: true,
    currency: '$',
    expired_at: '2026-09-21T00:00:00.000Z',
    group: 'default',
    tags: 'prod;edge',
    hidden: false,
    traffic_limit: 1024 ** 4,
    traffic_limit_type: 'sum',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-21T00:00:00.000Z',
  }

  await withApi(fakeService({
    getNodes: async () => ({ [node.uuid]: node }),
    getNodesLatestStatus: async () => ({
      [node.uuid]: {
        client: node.uuid,
        time: '2026-08-21T12:00:00.000Z',
        cpu: 12.5,
        gpu: 0,
        ram: 3 * 1024 ** 3,
        ram_total: 8 * 1024 ** 3,
        swap: 128 * 1024 ** 2,
        swap_total: 2 * 1024 ** 3,
        load: 0.42,
        load5: 0.3,
        load15: 0.2,
        temp: 36.5,
        disk: 20 * 1024 ** 3,
        disk_total: 50 * 1024 ** 3,
        net_in: 1024,
        net_out: 2048,
        net_total_up: 111,
        net_total_down: 222,
        process: 88,
        connections: 24,
        connections_udp: 2,
        online: true,
        uptime: 123456,
      },
    }),
    getRecords: async () => ({
      count: 2,
      records: [{
        client: node.uuid,
        time: '2026-08-21T11:55:00.000Z',
        cpu: 12.5,
        gpu: 0,
        ram: 3 * 1024 ** 3,
        ram_total: 0,
        swap: 128 * 1024 ** 2,
        swap_total: 0,
        load: 0.42,
        temp: 36.5,
        disk: 20 * 1024 ** 3,
        disk_total: 0,
        net_in: 1024,
        net_out: 2048,
        net_total_up: 111,
        net_total_down: 222,
        process: 88,
        connections: 24,
        connections_udp: 2,
      }],
      tasks: [{
        id: 0,
        name: 'Google',
        type: 'icmp',
        interval: 60,
        default_on: true,
        total: 2,
        loss: 50,
        min: 18,
        max: 20,
        avg: 19,
      }],
      from: '2026-08-21T11:00:00.000Z',
      to: '2026-08-21T12:00:00.000Z',
    }),
    getQueryMetrics: async () => ({
      start: '2026-08-21T00:00:00.000Z',
      end: '2026-08-21T12:00:00.000Z',
      count: 3,
      series: [
        {
          metric_key: 'cpu.usage',
          entity_id: node.uuid,
          interval_seconds: 300,
          points: [{ time: '2026-08-21T12:00:00.000Z', value: 12.5, count: 1 }],
        },
        {
          metric_key: 'traffic.up',
          entity_id: node.uuid,
          interval_seconds: 300,
          points: [{ time: '2026-08-21T12:00:00.000Z', value: 1234, count: 1 }],
        },
        {
          metric_key: 'traffic.down',
          entity_id: node.uuid,
          interval_seconds: 300,
          points: [{ time: '2026-08-21T12:00:00.000Z', value: 5678, count: 1 }],
        },
      ],
    }),
    getPingMetricStats: async () => ({
      count: 1,
      stats: [{
        entity_id: node.uuid,
        task_id: 0,
        name: 'Google',
        type: 'icmp',
        interval: 60,
        total: 2,
        valid: 1,
        loss: 50,
        min: 18,
        max: 20,
        avg: 19,
        latest: 20,
        p50: 19,
        p99: 20,
        stddev: 1,
        p99_p50_ratio: 1,
      }],
    }),
    getPublicPingTasks: async () => ([{
      id: 0,
      name: 'Google',
      clients: [node.uuid],
      default_on: true,
      type: 'icmp',
      interval: 60,
      target: 'google.com',
    }]),
  }), async (baseUrl) => {
    const nodes = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'common:getNodes' }),
    })
    assert.equal(nodes.status, 200)
    assert.deepEqual(nodes.body, { jsonrpc: '2.0', id: 20, result: { [node.uuid]: node } })

    const records = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'common:getRecords', params: { uuid: node.uuid, type: 'load', hours: 4 } }),
    })
    assert.equal(records.status, 200)
    assert.equal((records.body as { result?: { count?: number } }).result?.count, 2)

    const metrics = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'public:queryMetrics', params: { metric_keys: ['cpu.usage', 'traffic.up', 'traffic.down'], entity_ids: [node.uuid], hours: 24 } }),
    })
    assert.equal(metrics.status, 200)
    assert.equal((metrics.body as { result?: { series?: Array<{ metric_key?: string }> } }).result?.series?.[0]?.metric_key, 'cpu.usage')

    const pingStats = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 23, method: 'public:getPingMetricStats', params: { entity_ids: [node.uuid], task_ids: [0], hours: 24 } }),
    })
    assert.equal(pingStats.status, 200)
    assert.equal((pingStats.body as { result?: { stats?: Array<{ loss?: number }> } }).result?.stats?.[0]?.loss, 50)

    const pingTasks = await request(baseUrl, '/api/rpc2', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', id: 24, method: 'public:getPublicPingTasks' }),
    })
    assert.equal(pingTasks.status, 200)
    assert.equal((pingTasks.body as { result?: Array<{ name?: string }> }).result?.[0]?.name, 'Google')
  })
})

test('API routes expose readonly Komari admin compatibility resources', async () => {
  const node = {
    uuid: 'mmwx-1',
    name: 'readonly-node',
    cpu_name: 'AMD EPYC',
    virtualization: 'kvm',
    arch: 'amd64',
    cpu_cores: 2,
    cpu_physical_cores: 2,
    os: 'Debian',
    kernel_version: '6.1',
    gpu_name: 'None',
    region: 'US',
    mem_total: 1024,
    swap_total: 0,
    disk_total: 2048,
    weight: 0,
    price: 0,
    billing_cycle: 30,
    auto_renewal: false,
    currency: '$',
    expired_at: '0001-01-01T00:00:00.000Z',
    group: '',
    tags: '',
    hidden: false,
    traffic_limit: 0,
    traffic_limit_type: 'max',
    created_at: '2026-08-21T00:00:00.000Z',
    updated_at: '2026-08-21T00:00:00.000Z',
  }

  await withApi(fakeService({
    getNodesInformation: async () => [node],
    getPublicPingTasks: async () => ([{
      id: 1,
      name: 'Google',
      clients: [node.uuid],
      default_on: true,
      type: 'icmp',
      interval: 60,
      target: 'google.com',
    }]),
  }), async (baseUrl) => {
    const clients = await request(baseUrl, '/api/admin/client/list')
    assert.equal(clients.status, 200)
    assert.deepEqual((clients.body as { data?: unknown }).data, [node])

    const ping = await request(baseUrl, '/api/admin/ping')
    assert.equal(ping.status, 200)
    assert.equal((ping.body as { data?: Array<{ id?: number }> }).data?.[0]?.id, 1)

    const write = await request(baseUrl, '/api/admin/theme/settings', { method: 'POST', body: '{}' })
    assert.equal(write.status, 403)
  })
})

test('API routes save theme settings only with a verified admin session', async () => {
  const saved: unknown[] = []
  await withApi(fakeService({
    updateThemeSettings: async (settings: Record<string, unknown>) => {
      saved.push(settings)
      return { ...settings, saved: true }
    },
  }), async (baseUrl) => {
    const missing = await request(baseUrl, '/api/admin/theme/settings', {
      method: 'POST',
      body: JSON.stringify({ showNotice: true }),
    })
    assert.equal(missing.status, 401)
    assert.deepEqual(missing.body, { status: 'error', message: '请先完成管理员验证', data: null })

    const wrong = await request(baseUrl, '/api/admin/theme/settings', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
      body: JSON.stringify({ showNotice: true }),
    })
    assert.equal(wrong.status, 401)

    const directTokenSave = await request(baseUrl, '/api/admin/theme/settings', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ showNotice: true }),
    })
    assert.equal(directTokenSave.status, 401)
    assert.deepEqual(directTokenSave.body, { status: 'error', message: '请先完成管理员验证', data: null })
    assert.equal(directTokenSave.headers['set-cookie'], undefined)
    assert.deepEqual(saved, [])

    const verified = await request(baseUrl, '/api/admin/auth/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret' },
    })
    assert.equal(verified.status, 200)
    const setCookie = Array.isArray(verified.headers['set-cookie'])
      ? verified.headers['set-cookie'][0]
      : verified.headers['set-cookie']
    assert.match(setCookie ?? '', /^mmwx_admin_session=.*; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Lax$/)
    const sessionCookie = setCookie?.split(';', 1)[0]
    assert.ok(sessionCookie)

    const savedResp = await request(baseUrl, '/api/admin/theme/settings', {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ showNotice: true }),
    })
    assert.equal(savedResp.status, 200)
    assert.deepEqual(savedResp.body, { status: 'success', message: 'success', data: { showNotice: true, saved: true } })
    assert.deepEqual(saved, [{ showNotice: true }])
  }, { adminToken: 'admin-secret' })
})

test('admin token verification is independent and rejects wrong tokens even with an existing session', async () => {
  const logs: string[] = []
  await withApi(fakeService(), async (baseUrl) => {
    const wrong = await request(baseUrl, '/api/admin/auth/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong' },
    })
    assert.equal(wrong.status, 401)
    assert.deepEqual(wrong.body, { status: 'error', message: '管理员 Token 无效', data: null })
    assert.equal(wrong.headers['set-cookie'], undefined)

    const verified = await request(baseUrl, '/api/admin/auth/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret' },
    })
    assert.equal(verified.status, 200)
    assert.deepEqual(verified.body, {
      status: 'success',
      message: '验证成功',
      data: { logged_in: true },
    })
    const setCookie = Array.isArray(verified.headers['set-cookie'])
      ? verified.headers['set-cookie'][0]
      : verified.headers['set-cookie']
    assert.match(setCookie ?? '', /mmwx_admin_session=/)
    assert.match(setCookie ?? '', /; HttpOnly; /)
    assert.match(setCookie ?? '', /; Path=\/;/)
    assert.match(setCookie ?? '', /; SameSite=Lax$/)

    const sessionCookie = setCookie?.split(';', 1)[0]
    assert.ok(sessionCookie)
    const wrongWithSession = await request(baseUrl, '/api/admin/auth/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong', Cookie: sessionCookie },
    })
    assert.equal(wrongWithSession.status, 401)
    assert.deepEqual(wrongWithSession.body, { status: 'error', message: '管理员 Token 无效', data: null })
    assert.equal(wrongWithSession.headers['set-cookie'], undefined)
  }, {
    adminToken: 'admin-secret',
    logger: {
      info(message: string) { logs.push(`info:${message}`) },
      warn(message: string) { logs.push(`warn:${message}`) },
      error(message: string) { logs.push(`error:${message}`) },
    },
  })
  assert.ok(logs.some((line) => line.includes('管理员 Token 验证成功')))
  assert.ok(logs.some((line) => line.includes('管理员 Token 验证失败')))
})

test('saving theme settings establishes a browser session for frontend theme management', async () => {
  const saved: unknown[] = []
  await withApi(fakeService({
    updateThemeSettings: async (settings: Record<string, unknown>) => {
      saved.push(settings)
      return settings
    },
  }), async (baseUrl) => {
    const tokenSave = await request(baseUrl, '/api/admin/auth/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret' },
    })
    assert.equal(tokenSave.status, 200)
    const setCookie = Array.isArray(tokenSave.headers['set-cookie'])
      ? tokenSave.headers['set-cookie'][0]
      : tokenSave.headers['set-cookie']
    assert.match(setCookie ?? '', /mmwx_admin_session=/)

    const sessionCookie = setCookie?.split(';', 1)[0]
    assert.ok(sessionCookie)

    const me = await request(baseUrl, '/api/me', {
      headers: { Cookie: sessionCookie },
    })
    assert.deepEqual(me.body, {
      logged_in: true,
      username: 'admin',
      uuid: '',
      sso_id: '',
      sso_type: '',
      '2fa_enabled': false,
    })

    const frontendSave = await request(baseUrl, '/api/admin/theme/settings', {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ frontend: true }),
    })
    assert.equal(frontendSave.status, 200)
    assert.deepEqual(saved, [{ frontend: true }])
  }, { adminToken: 'admin-secret' })
})

test('admin logout clears the browser session and blocks subsequent theme writes', async () => {
  const logs: string[] = []
  await withApi(fakeService(), async (baseUrl) => {
    const logoutBeforeLogin = await request(baseUrl, '/api/admin/auth/logout', { method: 'POST' })
    assert.equal(logoutBeforeLogin.status, 200)

    const verified = await request(baseUrl, '/api/admin/auth/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret' },
    })
    const setCookie = Array.isArray(verified.headers['set-cookie'])
      ? verified.headers['set-cookie'][0]
      : verified.headers['set-cookie']
    const sessionCookie = setCookie?.split(';', 1)[0]
    assert.ok(sessionCookie)

    const logout = await request(baseUrl, '/api/admin/auth/logout', {
      method: 'POST',
      headers: { Cookie: sessionCookie },
    })
    assert.equal(logout.status, 200)
    assert.deepEqual(logout.body, { status: 'success', message: '已退出登录', data: null })
    const clearedCookie = Array.isArray(logout.headers['set-cookie'])
      ? logout.headers['set-cookie'][0]
      : logout.headers['set-cookie']
    assert.match(clearedCookie ?? '', /^mmwx_admin_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Lax$/)

    const me = await request(baseUrl, '/api/me', { headers: { Cookie: 'mmwx_admin_session=' } })
    assert.equal((me.body as { logged_in?: boolean }).logged_in, false)

    const save = await request(baseUrl, '/api/admin/theme/settings', {
      method: 'POST',
      headers: { Cookie: 'mmwx_admin_session=', 'Content-Type': 'application/json' },
      body: JSON.stringify({ afterLogout: true }),
    })
    assert.equal(save.status, 401)
    assert.deepEqual(save.body, { status: 'error', message: '请先完成管理员验证', data: null })
  }, {
    adminToken: 'admin-secret',
    logger: {
      info(message: string) { logs.push(`info:${message}`) },
      warn(message: string) { logs.push(`warn:${message}`) },
      error(message: string) { logs.push(`error:${message}`) },
    },
  })
  assert.ok(logs.some((line) => line.includes('管理员退出登录')))
})

test('theme settings persistence failures are logged', async () => {
  const logs: string[] = []
  await withApi(fakeService({
    updateThemeSettings: async () => {
      throw new Error('write failed')
    },
  }), async (baseUrl) => {
    const verified = await request(baseUrl, '/api/admin/auth/verify', {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-secret' },
    })
    const setCookie = Array.isArray(verified.headers['set-cookie'])
      ? verified.headers['set-cookie'][0]
      : verified.headers['set-cookie']
    const sessionCookie = setCookie?.split(';', 1)[0]
    assert.ok(sessionCookie)

    const saved = await request(baseUrl, '/api/admin/theme/settings', {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ frontend: true }),
    })
    assert.equal(saved.status, 500)
  }, {
    adminToken: 'admin-secret',
    logger: {
      info(message: string) { logs.push(`info:${message}`) },
      warn(message: string) { logs.push(`warn:${message}`) },
      error(message: string) { logs.push(`error:${message}`) },
    },
  })
  assert.ok(logs.some((line) => line.includes('主题配置写入失败')))
})
