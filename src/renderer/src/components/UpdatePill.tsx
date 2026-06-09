/**
 * Hive IDE — title-bar update pill (feat/auto-updater).
 *
 * Hidden until the updater reports an in-flight or ready update, then renders a
 * compact pill in the title bar:
 *   - available   → "Update available"
 *   - downloading → "Updating… NN%"
 *   - downloaded  → "Restart to update"  (click → quitAndInstall)
 *
 * Only the `downloaded` state is actionable; the earlier states are
 * informational (the download proceeds automatically). Idle / not-available /
 * unsupported / checking / error render nothing.
 */
import { Icon } from './primitives'
import { useUpdaterStore } from '../store/updaterStore'

const SHOW = new Set(['available', 'downloading', 'downloaded'])

export function UpdatePill() {
  const status = useUpdaterStore((s) => s.status)
  const quitAndInstall = useUpdaterStore((s) => s.quitAndInstall)

  if (!SHOW.has(status.phase)) return null

  const ready = status.phase === 'downloaded'
  const label =
    status.phase === 'downloaded'
      ? 'Restart to update'
      : status.phase === 'downloading'
        ? `Updating… ${status.percent != null ? Math.round(status.percent) : 0}%`
        : 'Update available'

  return (
    <button
      type="button"
      className={'tb-pill' + (ready ? ' ready' : '')}
      title={ready ? 'Restart to install the update' : label}
      aria-label={label}
      onClick={() => {
        if (ready) quitAndInstall()
      }}
    >
      <Icon name={ready ? 'rocket' : 'download'} size={13} />
      <span className="tp-label">{label}</span>
    </button>
  )
}

export default UpdatePill
