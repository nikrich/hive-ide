/**
 * Renderer settings store tests (E4-01).
 *
 * Verifies hydrate, optimistic single-key set (with persistence round-trip),
 * and the non-React `getSetting` accessor. `window.hive.settings` is stubbed
 * so the persistence call is observable without a real bridge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '../../../types/settings'
import { getSetting, useSettingsStore } from './settingsStore'

const update = vi.fn(() => Promise.resolve(DEFAULT_SETTINGS))
const replace = vi.fn(() => Promise.resolve(DEFAULT_SETTINGS))

beforeEach(() => {
  update.mockClear()
  replace.mockClear()
  ;(globalThis as unknown as { window: { hive: unknown } }).window = {
    hive: {
      settings: {
        get: () => Promise.resolve({ settings: DEFAULT_SETTINGS, user: {}, path: '' }),
        update,
        replace,
        onChange: () => () => undefined,
      },
    },
  }
  // Reset store to defaults between tests.
  useSettingsStore.setState({
    settings: { ...DEFAULT_SETTINGS },
    user: {},
    path: '',
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('settingsStore', () => {
  it('starts from the defaults', () => {
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS)
  })

  it('hydrate replaces merged settings + user + path', () => {
    useSettingsStore.getState().hydrate({
      settings: { ...DEFAULT_SETTINGS, 'editor.minimap': true },
      user: { 'editor.minimap': true },
      path: '/tmp/settings.json',
    })
    const s = useSettingsStore.getState()
    expect(s.settings['editor.minimap']).toBe(true)
    expect(s.user).toEqual({ 'editor.minimap': true })
    expect(s.path).toBe('/tmp/settings.json')
  })

  it('set optimistically updates and persists the patch', () => {
    useSettingsStore.getState().set('editor.fontSize', 18)
    expect(useSettingsStore.getState().settings['editor.fontSize']).toBe(18)
    expect(useSettingsStore.getState().user['editor.fontSize']).toBe(18)
    expect(update).toHaveBeenCalledWith({ 'editor.fontSize': 18 })
  })

  it('replaceUser swaps the layer and persists', () => {
    useSettingsStore.getState().replaceUser({ 'editor.wordWrap': 'on' })
    expect(useSettingsStore.getState().user).toEqual({ 'editor.wordWrap': 'on' })
    expect(replace).toHaveBeenCalledWith({ 'editor.wordWrap': 'on' })
  })

  it('getSetting reads the current merged value outside React', () => {
    useSettingsStore.getState().set('editor.minimap', true)
    expect(getSetting('editor.minimap')).toBe(true)
  })
})
