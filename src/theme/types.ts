export interface ThemeSource {
  repoUrl: string
  ref: string
  gitProxy?: string
}

export type PackageManager = 'pnpm' | 'bun' | 'npm' | 'none'

export interface BuildPlan {
  packageManager: PackageManager
  installArgs: readonly string[]
  buildArgs: readonly string[]
  outputCandidates: readonly string[]
}

export interface LoadedTheme {
  kind?: 'komari' | 'monitor'
  directory: string
  indexPath: string
  title?: string
  short?: string
  manifest?: Record<string, unknown> | null
  themeSettings?: Record<string, unknown> | null
  source: ThemeSource
}
