/**
 * Monaco ← plugin glue — REQ-006.
 *
 * Iterates a plugin's `contributes.languages[]` and registers each
 * language with Monaco:
 *
 *   1. `monaco.languages.register({ id, extensions, aliases })`
 *   2. If `configuration` is set on the contribution, fetch the JSON via
 *      `window.hive.plugins.readAsset`, then
 *      `monaco.languages.setLanguageConfiguration(id, parsed)`.
 *   3. If `grammar` is set, fetch the JSON the same way, then
 *      `monaco.languages.setMonarchTokensProvider(id, parsed)`.
 *
 * Registration is idempotent at the language-id level — Monaco itself
 * tolerates double-registration but the user can spawn duplicates of
 * the Monarch grammar, so we guard with a module-level set of registered
 * `<pluginId>:<languageId>` keys.
 *
 * If asset fetch / parse fails for one contribution, we log and skip it;
 * other contributions in the same manifest still get registered. The
 * Plugins view will reflect the on-disk state on the next refresh — we
 * deliberately don't surface per-contribution errors back through the
 * store in REQ-006, since the failure cases are rare and recoverable
 * (the user re-edits the plugin's grammar.json).
 */

import type * as Monaco from 'monaco-editor'

import type { LoadedPlugin } from '../../../types/workspace'

/**
 * Module-level guard set. Keys are `<pluginId>:<languageId>` so two
 * plugins contributing the same language id stay distinguishable — the
 * second one will still set its own configuration / grammar, the
 * `monaco.languages.register` call is just a no-op.
 *
 * Cleared by {@link forgetPluginRegistrations} when a plugin is
 * uninstalled or disabled (lets the user re-enable + see grammar
 * changes without restarting the IDE).
 */
const registered = new Set<string>()

type MonacoNamespace = typeof Monaco

/**
 * Register every language contribution declared by `plugin`. Skips
 * invalid plugins (callers should already filter by `valid`, but the
 * guard is here too in case of a stale list).
 *
 * Returns the language ids that were registered (or attempted). Mostly
 * useful for tests + future telemetry.
 */
export async function registerPluginWithMonaco(
  plugin: LoadedPlugin,
  monaco: MonacoNamespace,
): Promise<string[]> {
  if (!plugin.valid) return []
  const contributions = plugin.manifest.contributes?.languages
  if (contributions === undefined || contributions.length === 0) return []

  const out: string[] = []
  for (const lang of contributions) {
    const key = `${plugin.manifest.id}:${lang.id}`
    if (registered.has(key)) continue

    try {
      monaco.languages.register({
        id: lang.id,
        extensions: lang.extensions,
        aliases: lang.aliases,
      })

      if (lang.configuration !== undefined) {
        const json = await window.hive.plugins.readAsset(
          plugin.manifest.id,
          lang.configuration,
        )
        const parsed = JSON.parse(json) as Monaco.languages.LanguageConfiguration
        monaco.languages.setLanguageConfiguration(lang.id, parsed)
      }

      if (lang.grammar !== undefined) {
        const json = await window.hive.plugins.readAsset(
          plugin.manifest.id,
          lang.grammar,
        )
        const parsed = JSON.parse(json) as Monaco.languages.IMonarchLanguage
        monaco.languages.setMonarchTokensProvider(lang.id, parsed)
      }

      registered.add(key)
      out.push(lang.id)
    } catch (err) {
      // Don't let one broken contribution take out the rest of the plugin.
      // eslint-disable-next-line no-console
      console.error(
        `[plugins] failed to register ${plugin.manifest.id}:${lang.id}:`,
        err,
      )
    }
  }
  return out
}

/**
 * Drop every cached registration belonging to `pluginId`. Called when a
 * plugin is disabled or uninstalled so re-enabling it later picks up
 * any on-disk changes (e.g. the user edited `grammar.json`).
 *
 * Monaco doesn't expose an `unregister` API, so we can only reset the
 * *configuration* / *tokens provider* on the next register call — the
 * language id itself stays in Monaco's registry for the rest of the
 * session. That's fine: it's just a string in a map.
 */
export function forgetPluginRegistrations(pluginId: string): void {
  const prefix = `${pluginId}:`
  for (const key of Array.from(registered)) {
    if (key.startsWith(prefix)) registered.delete(key)
  }
}

/**
 * Test-only escape hatch — wipe every recorded registration. Production
 * code should never call this; it's exported so the unit-tests can run
 * a clean slate per case.
 */
export function _resetPluginRegistrations(): void {
  registered.clear()
}
