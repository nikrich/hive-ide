import { describe, it, expect } from 'vitest'

import { nextDrillTarget } from './folderDrill'
import type { DirEntry } from '../../../types/workspace'

function entry(name: string, isDir: boolean): DirEntry {
  return { name, path: `/root/${name}`, isDir, isSymlink: false, mtime: 0 }
}

describe('nextDrillTarget', () => {
  it('drills into a folder whose only entry is a subdirectory', () => {
    expect(nextDrillTarget([entry('example', true)])).toBe('/root/example')
  })

  it('stops when the only entry is a file', () => {
    expect(nextDrillTarget([entry('Main.java', false)])).toBeNull()
  })

  it('stops when there are multiple entries (a branch)', () => {
    expect(
      nextDrillTarget([entry('a', true), entry('b', true)]),
    ).toBeNull()
  })

  it('stops when a file sits alongside a subfolder', () => {
    expect(
      nextDrillTarget([entry('pkg', true), entry('README.md', false)]),
    ).toBeNull()
  })

  it('stops on an empty folder', () => {
    expect(nextDrillTarget([])).toBeNull()
  })
})
