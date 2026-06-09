/**
 * Settings boot hook (E4-01).
 *
 * Mounted once near the app root. On mount it fetches the merged settings
 * bundle from main and hydrates the renderer settings store, then subscribes
 * to `event:settings:changed` so the store stays in sync with every write —
 * whether it came from the in-app settings editor or an external hand-edit of
 * `settings.json`.
 */

import { useEffect } from 'react'

import { useSettingsStore } from '../store/settingsStore'

export function useSettingsBoot(): void {
  const hydrate = useSettingsStore((s) => s.hydrate)

  useEffect(() => {
    let cancelled = false
    const bridge = window.hive?.settings
    if (!bridge) return

    const refresh = (): void => {
      void bridge
        .get()
        .then((bundle) => {
          if (!cancelled) hydrate(bundle)
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error('settings.get failed', err)
        })
    }

    refresh()

    // The push carries the merged settings for an instant live update; we
    // also refetch the full bundle so the raw `user` layer stays accurate
    // after an external hand-edit of settings.json.
    const unsubscribe = bridge.onChange((settings) => {
      if (!cancelled) hydrate({ settings })
      refresh()
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [hydrate])
}
