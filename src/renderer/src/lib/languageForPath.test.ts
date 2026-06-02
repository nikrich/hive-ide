import { describe, expect, it } from 'vitest'

import { languageForPath } from './languageForPath'

describe('languageForPath', () => {
  it('maps .ts files to typescript', () => {
    expect(languageForPath('/repo/src/foo.ts')).toBe('typescript')
  })

  it('maps .tsx files to typescript', () => {
    expect(languageForPath('/repo/src/Component.tsx')).toBe('typescript')
  })

  it('maps .js files to javascript', () => {
    expect(languageForPath('/repo/src/foo.js')).toBe('javascript')
  })

  it('maps .jsx files to javascript', () => {
    expect(languageForPath('/repo/src/Component.jsx')).toBe('javascript')
  })

  it('maps .json files to json', () => {
    expect(languageForPath('/repo/package.json')).toBe('json')
  })

  it('maps .css files to css', () => {
    expect(languageForPath('/repo/src/styles/app.css')).toBe('css')
  })

  it('maps .md files to markdown', () => {
    expect(languageForPath('/repo/README.md')).toBe('markdown')
  })

  it('falls back to plaintext for unknown extensions', () => {
    expect(languageForPath('/repo/notes.xyz')).toBe('plaintext')
  })

  it('falls back to plaintext for files with no extension', () => {
    expect(languageForPath('/repo/Makefile')).toBe('plaintext')
  })

  it('falls back to plaintext for paths with a trailing dot', () => {
    expect(languageForPath('/repo/README.')).toBe('plaintext')
  })

  it('falls back to plaintext for empty paths', () => {
    expect(languageForPath('')).toBe('plaintext')
  })

  it('matches extensions case-insensitively (upper-case)', () => {
    expect(languageForPath('/repo/src/Foo.TS')).toBe('typescript')
    expect(languageForPath('/repo/README.MD')).toBe('markdown')
    expect(languageForPath('/repo/package.JSON')).toBe('json')
  })

  it('matches extensions case-insensitively (mixed-case)', () => {
    expect(languageForPath('/repo/src/Component.TsX')).toBe('typescript')
    expect(languageForPath('/repo/src/styles/App.Css')).toBe('css')
  })

  it('uses only the last extension when multiple dots are present', () => {
    expect(languageForPath('/repo/src/Foo.test.ts')).toBe('typescript')
    expect(languageForPath('/repo/src/types.d.ts')).toBe('typescript')
  })

  it('treats directory-named-with-dot + extensionless file as plaintext', () => {
    // "/repo/foo.bar/file" — the file itself has no extension.
    expect(languageForPath('/repo/foo.bar/file')).toBe('plaintext')
  })
})
