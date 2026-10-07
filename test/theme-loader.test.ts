import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { readThemeMetadata } from '../src/theme/loader.js'

async function tempRepo(files: Record<string, string>): Promise<string> {
  const repoDir = await mkdtemp(path.join(os.tmpdir(), 'komari-theme-meta-'))
  for (const [relative, content] of Object.entries(files)) {
    await writeFile(path.join(repoDir, relative), content)
  }
  return repoDir
}

test('reads Komari theme settings defaults from komari-theme.json', async () => {
  const manifest = {
    short: 'Glassmorphism',
    configuration: {
      type: 'managed',
      data: [
        { key: 'layout', type: 'select', options: [{ label: 'Paper', value: 'paper' }, { label: 'Glass', value: 'glass' }] },
        { key: 'show_banner', type: 'switch' },
        { key: 'accent', default: 'blue' },
      ],
    },
  }
  const repoDir = await tempRepo({
    'komari-theme.json': JSON.stringify(manifest),
  })

  try {
    await assert.doesNotReject(() => readThemeMetadata(repoDir))
    await assert.deepEqual(await readThemeMetadata(repoDir), {
      kind: 'komari',
      short: 'Glassmorphism',
      manifest,
      themeSettings: {
        layout: 'paper',
        show_banner: false,
        accent: 'blue',
      },
    })
  } finally {
    await rm(repoDir, { recursive: true, force: true })
  }
})

test('detects Monitor manifests and preserves typed config defaults', async () => {
  const manifest = { short: 'doraemon', config: [
    { type: 'title', label: '基础设置' },
    { key: 'enabled', type: 'boolean', default: true },
    { key: 'interval', type: 'number', default: 3, min: 1, max: 60 },
  ] }
  const directory = await tempRepo({ 'theme.json': JSON.stringify(manifest) })
  try {
    assert.deepEqual(await readThemeMetadata(directory), {
      kind: 'monitor', short: 'doraemon', manifest, themeSettings: { enabled: true, interval: 3 },
    })
    await writeFile(path.join(directory, 'komari-theme.json'), '{"short":"old"}')
    assert.equal((await readThemeMetadata(directory)).kind, 'komari')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rejects malformed Monitor manifest rather than silently starting with wrong protocol', async () => {
  const directory = await tempRepo({ 'theme.json': '{"short":"broken"}' })
  try {
    await assert.rejects(readThemeMetadata(directory), /short and config/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
