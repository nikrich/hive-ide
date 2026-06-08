/**
 * Git decoration tests (E7-01).
 */

import { describe, expect, it } from 'vitest'

import { buildGitDecorations, type ScmSlots } from './gitDecorations'
import type { GitStatusEntry, Repo } from '../../../types/workspace'

const repo: Repo = { name: 'app', path: '/repo', isGitRepo: true }

const entry = (over: Partial<GitStatusEntry>): GitStatusEntry => ({
  path: 'src/a.ts',
  state: 'modified',
  staged: false,
  workingTree: true,
  ...over,
})

describe('buildGitDecorations', () => {
  it('maps repo-relative entries onto absolute paths', () => {
    const scm: ScmSlots = { '/repo': { entries: [entry({})] } }
    const { files } = buildGitDecorations(scm, [repo])
    expect(files.get('/repo/src/a.ts')).toBe('modified')
  })

  it('rolls a change indicator up to ancestor folders and the repo root', () => {
    const scm: ScmSlots = { '/repo': { entries: [entry({ path: 'src/deep/x.ts' })] } }
    const { dirs } = buildGitDecorations(scm, [repo])
    expect(dirs.has('/repo/src/deep')).toBe(true)
    expect(dirs.has('/repo/src')).toBe(true)
    expect(dirs.has('/repo')).toBe(true)
    expect(dirs.has('/repo/src/deep/x.ts')).toBe(false)
  })

  it('keeps the more severe state when a file has multiple records', () => {
    const scm: ScmSlots = {
      '/repo': {
        entries: [
          entry({ path: 'a.ts', state: 'added' }),
          entry({ path: 'a.ts', state: 'modified' }),
        ],
      },
    }
    const { files } = buildGitDecorations(scm, [repo])
    // modified (rank 2) is more severe than added (rank 4)
    expect(files.get('/repo/a.ts')).toBe('modified')
  })

  it('ignores repos with no snapshot', () => {
    const { files } = buildGitDecorations({}, [repo])
    expect(files.size).toBe(0)
  })
})
