/**
 * Hive IDE — external-change banner (STORY-026).
 *
 * Rendered over the editor area when the file in the active tab was
 * modified on disk by something outside the IDE *while it was dirty*. The
 * user gets three choices:
 *
 *   Reload      → re-read disk, replace buffer, clear dirty, dismiss
 *   Keep yours  → just dismiss; buffer stays as-is, tab stays dirty
 *   Compare     → DISABLED in REQ-002; the side-by-side diff view lands
 *                 in the git REQ. Rendered with a tooltip pointing at that.
 *
 * The banner is pure presentation. State (when to show it, what path it
 * relates to) lives in `Editor.tsx`'s `pendingExternalChange` state — see
 * the comments there. The store-level reload + dismiss side effects are
 * passed in as props.
 *
 * Styling lives in `styles/ide.css` under `.external-change-banner` —
 * intentionally separate from `.agent-banner` so future visual tweaks to
 * either one don't bleed into the other.
 */
import { Icon } from './primitives'

export interface ExternalChangeBannerProps {
  /** Absolute path of the file the banner is about. Shown in `title=`. */
  path: string
  /** Called when the user clicks "Reload". */
  onReload: () => void
  /** Called when the user clicks "Keep yours". */
  onKeep: () => void
}

export function ExternalChangeBanner({
  path,
  onReload,
  onKeep,
}: ExternalChangeBannerProps) {
  return (
    <div
      className="external-change-banner"
      role="status"
      aria-live="polite"
      title={path}
    >
      <span className="ecb-icon" aria-hidden>
        <Icon name="alert-triangle" size={14} />
      </span>
      <span className="ecb-msg">This file changed on disk.</span>
      <span className="ecb-sp" />
      <button
        type="button"
        className="ecb-btn ecb-btn-primary"
        onClick={onReload}
      >
        Reload
      </button>
      <button type="button" className="ecb-btn" onClick={onKeep}>
        Keep yours
      </button>
      <button
        type="button"
        className="ecb-btn ecb-btn-disabled"
        disabled
        title="Coming in git REQ"
      >
        Compare
      </button>
    </div>
  )
}

export default ExternalChangeBanner
