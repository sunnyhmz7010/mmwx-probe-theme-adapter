import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { test } from 'node:test'
import WebSocket, { WebSocketServer } from 'ws'

import { createApiRouter } from '../src/http/api.js'
import { createHttpServer } from '../src/http/server.js'
import type { AppConfig } from '../src/config.js'
import type { LoadedTheme } from '../src/theme/types.js'
import { KomariDataService } from '../src/komari/service.js'
import { ProbeStreamRelay } from '../src/mmwx/stream-relay.js'

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mmwxOrigin: 'http://127.0.0.1:0',
    probeToken: 'probe-secret',
    themeRepo: 'https://github.com/acme/theme',
    themeRef: 'main',
    themeGitProxy: '',
    ...overrides,
  }
}

async function reservePort(): Promise<number> {
  const server = http.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function tempTheme(): Promise<LoadedTheme> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mmwx-theme-'))
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><head><title>服务器状态</title></head><body>theme</body></html>')
  await mkdir(path.join(dir, 'assets'), { recursive: true })
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("theme")')
  return {
    directory: dir,
    indexPath: path.join(dir, 'index.html'),
    title: '服务器状态',
    short: 'Emerald',
    manifest: {
      short: 'Emerald',
      configuration: {
        type: 'managed',
        data: [
          { key: 'showNotice', type: 'switch', default: false },
          { key: 'defaultViewMode', type: 'select', options: 'card,list', default: 'card' },
        ],
      },
    },
    source: { repoUrl: 'https://github.com/acme/theme', ref: 'main' },
  }
}

async function httpGet(baseUrl: string, pathname: string): Promise<{ status: number; contentType?: string; location?: string; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}${pathname}`, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        contentType: res.headers['content-type'] as string | undefined,
        location: res.headers.location as string | undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
  })
}

test('serves /ping health check as plain text pong', async () => {
  const theme = await tempTheme()
  const port = await reservePort()
  const mmwx = {
    fetchProbe: async () => ({ servers: [{ name: 'node-0', online: true }] }),
    fetchSeries: async () => ({ systems: [] }),
    streamUrl: () => 'ws://127.0.0.1:1/api/public/probe-ws',
    probeHeaders: () => ({ 'X-MMwx-Probe-Token': 'probe-secret' }),
  } as never
  const hub = new ProbeStreamRelay(mmwx)
  hub.start()
  const api = createApiRouter(new KomariDataService(hub))
  const serverHandle = createHttpServer(config(), theme, api, hub, undefined, port)

  try {
    await serverHandle.listen()
    const health = await httpGet(`http://127.0.0.1:${port}`, '/ping')
    assert.equal(health.status, 200)
    assert.match(health.contentType ?? '', /text\/plain/)
    assert.equal(health.body, 'pong')
  } finally {
    await serverHandle.close()
    await rm(theme.directory, { recursive: true, force: true })
  }
})

test('serves static assets and SPA fallback safely', async () => {
  const theme = await tempTheme()
  const port = await reservePort()
  const mmwx = {
    fetchProbe: async () => ({ servers: [{ name: 'node-0', online: true }] }),
    fetchSeries: async () => ({ systems: [] }),
    streamUrl: () => 'ws://127.0.0.1:1/api/public/probe-ws',
    probeHeaders: () => ({ 'X-MMwx-Probe-Token': 'probe-secret' }),
  } as never
  const hub = new ProbeStreamRelay(mmwx)
  hub.start()
  const api = createApiRouter(new KomariDataService(hub))
  const serverHandle = createHttpServer(config(), theme, api, hub, undefined, port)

  try {
    await serverHandle.listen()
    const baseUrl = `http://127.0.0.1:${port}`
    const asset = await httpGet(baseUrl, '/assets/app.js')
    assert.equal(asset.status, 200)
    assert.match(asset.contentType ?? '', /javascript/)
    assert.match(asset.body, /theme/)

    const fallback = await httpGet(baseUrl, '/dashboard')
    assert.equal(fallback.status, 200)
    assert.match(fallback.contentType ?? '', /html/)
    assert.match(fallback.body, /theme/)
    assert.match(fallback.body, /fetch\("\/api\/probe"/)
    assert.match(fallback.body, /document\.title=title/)
    assert.match(fallback.body, /link\.href=icon/)
    assert.doesNotMatch(fallback.body, /text\(d\.logo\)\|\|text\(d\.icon\)/)

    const manifest = await httpGet(baseUrl, '/themes/Emerald/komari-theme.json')
    assert.equal(manifest.status, 200)
    assert.match(manifest.contentType ?? '', /application\/json/)
    assert.deepEqual(JSON.parse(manifest.body), theme.manifest)

    const admin = await httpGet(baseUrl, '/admin')
    assert.equal(admin.status, 200)
    assert.match(admin.contentType ?? '', /html/)
    assert.match(admin.body, /MMWX Probe Theme Adapter Settings/)
    assert.match(admin.body, /\/api\/admin\/theme\/settings/)

    const adhesiveAdmin = await httpGet(baseUrl, '/admin/dashboard')
    assert.equal(adhesiveAdmin.status, 302)
    assert.equal(adhesiveAdmin.location, '/admin')

    const adminSub = await httpGet(baseUrl, '/admin/settings/theme')
    assert.equal(adminSub.status, 404)
    const adminOther = await httpGet(baseUrl, '/admin/anything')
    assert.equal(adminOther.status, 404)

    const builtinFlag = await httpGet(baseUrl, '/assets/flags/US.svg')
    assert.equal(builtinFlag.status, 200)
    assert.match(builtinFlag.contentType ?? '', /image\/svg\+xml/)

    const builtinLogo = await httpGet(baseUrl, '/assets/logo/os-debian.svg')
    assert.equal(builtinLogo.status, 200)
    assert.match(builtinLogo.contentType ?? '', /image\/svg\+xml/)

    const missingFlag = await httpGet(baseUrl, '/assets/flags/ZZ.svg')
    assert.equal(missingFlag.status, 404)
  } finally {
    await serverHandle.close()
    await rm(theme.directory, { recursive: true, force: true })
  }
})

test('serves the probe icon from /favicon.ico instead of the SPA HTML fallback', async () => {
  const theme = await tempTheme()
  const port = await reservePort()
  const mmwx = {
    fetchProbe: async () => ({
      icon: 'data:image/png;base64,iVBORw0KGgo=',
      servers: [{ name: 'node-0', online: true }],
    }),
    fetchSeries: async () => ({ systems: [] }),
    streamUrl: () => 'ws://127.0.0.1:1/api/public/probe-ws',
    probeHeaders: () => ({ 'X-MMwx-Probe-Token': 'probe-secret' }),
  } as never
  const hub = new ProbeStreamRelay(mmwx)
  hub.start()
  const api = createApiRouter(new KomariDataService(hub))
  const serverHandle = createHttpServer(config(), theme, api, hub, undefined, port)

  try {
    await serverHandle.listen()
    const response = await fetch(`http://127.0.0.1:${port}/favicon.ico`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /image\/png/)
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())].slice(0, 4), [137, 80, 78, 71])
  } finally {
    await serverHandle.close()
    await rm(theme.directory, { recursive: true, force: true })
  }
})

test('routes websocket clients and broadcasts a shared stream hub connection', async () => {
  const theme = await tempTheme()
  const upstream = new WebSocketServer({ port: 0 })
  const upstreamHeaders: string[] = []
  const upstreamConnections: string[] = []
  upstream.on('connection', (socket, request) => {
    upstreamConnections.push(String(request.socket.remotePort ?? ''))
    upstreamHeaders.push(String(request.headers['x-mmwx-probe-token'] ?? ''))
    socket.send(JSON.stringify({ servers: [{ name: 'node-0', online: true }] }))
  })
  await once(upstream, 'listening')
  const upstreamAddress = upstream.address()
  assert.ok(upstreamAddress && typeof upstreamAddress === 'object')

  const mmwx = {
    fetchProbe: async () => ({ servers: [{ name: 'node-0', online: true }] }),
    fetchSeries: async () => ({ systems: [] }),
    streamUrl: () => `ws://127.0.0.1:${upstreamAddress.port}/api/public/probe-ws`,
    probeHeaders: () => ({ 'X-MMwx-Probe-Token': 'probe-secret' }),
  } as never
  const hub = new ProbeStreamRelay(mmwx)
  const api = createApiRouter(new KomariDataService(hub))
  const port = await reservePort()
  const serverHandle = createHttpServer(config(), theme, api, hub, undefined, port)

  try {
    await serverHandle.listen()
    // 常驻采样生命周期由 start() 显式开启，与生产入口 main.ts 一致。
    hub.start()
    const basePort = port

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${basePort}/api/clients`)
      socket.on('open', () => socket.send('get'))
      socket.once('message', (data) => {
        const payload = JSON.parse(data.toString()) as { online: boolean; data: unknown[] }
        assert.equal(payload.online, true)
        assert.equal(Array.isArray(payload.data), true)
        socket.close()
      })
      socket.once('close', resolve)
      socket.once('error', reject)
    })

    const streamMessages: string[] = []
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${basePort}/api/stream`)
      socket.on('message', (data) => streamMessages.push(data.toString()))
      socket.once('close', resolve)
      socket.once('error', reject)
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) socket.close()
      }, 150).unref()
      setTimeout(() => {
        socket.close()
        resolve()
      }, 700).unref()
    })

    assert.equal(upstreamHeaders[0], 'probe-secret')
    assert.ok(streamMessages.some((message) => {
      try {
        return JSON.stringify(JSON.parse(message)) === JSON.stringify({ servers: [{ name: 'node-0', online: true }] })
      } catch {
        return false
      }
    }))
  } finally {
    await serverHandle.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    await rm(theme.directory, { recursive: true, force: true })
  }
})
