import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  forwardRef,
  type CSSProperties,
} from 'react'

export interface InlineEditableHandle {
  /** Enter edit mode programmatically (e.g. from a context menu). */
  startEditing: () => void
}

export interface InlineEditableProps {
  /** Current text. */
  value: string
  /** Called with the trimmed, non-empty new value on commit. */
  onCommit: (next: string) => void
  /** Optional className for the static text element AND the edit input. */
  className?: string
  /** Optional inline style. */
  style?: CSSProperties
  /** Accessible label for the edit input. */
  ariaLabel?: string
}

/**
 * Baseline chrome reset for the edit input so it blends into whatever
 * surface it's rendered on (terminal chip, title bar, table row) instead
 * of showing the browser's default light input box. Font is inherited so
 * the consumer's className (e.g. `term-tab-label`) still drives typography.
 * Consumer-supplied `style` is merged on top and wins.
 */
const EDIT_INPUT_STYLE: CSSProperties = {
  font: 'inherit',
  color: 'inherit',
  background: 'var(--bg-surface)',
  border: '1px solid var(--accent)',
  borderRadius: 'var(--r-sm)',
  padding: '0 4px',
  margin: 0,
  outline: 'none',
  minWidth: 0,
  maxWidth: '100%',
}

/**
 * Renders `value` as text. Double-click (or an imperative `startEditing()`)
 * swaps it for a focused input. Enter / blur commit the trimmed value
 * (no-op when empty or unchanged); Escape cancels.
 */
export const InlineEditable = forwardRef<InlineEditableHandle, InlineEditableProps>(
  function InlineEditable({ value, onCommit, className, style, ariaLabel }, ref) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(value)
    const inputRef = useRef<HTMLInputElement | null>(null)
    const committedRef = useRef(false)

    useImperativeHandle(ref, () => ({
      startEditing: () => {
        committedRef.current = false
        setDraft(value)
        setEditing(true)
      },
    }))

    useEffect(() => {
      if (editing && inputRef.current) {
        inputRef.current.focus()
        inputRef.current.select()
      }
    }, [editing])

    function commit(): void {
      if (committedRef.current) return
      committedRef.current = true
      const trimmed = draft.trim()
      setEditing(false)
      if (trimmed !== '' && trimmed !== value) onCommit(trimmed)
    }

    function cancel(): void {
      committedRef.current = true
      setEditing(false)
      setDraft(value)
    }

    if (!editing) {
      return (
        <span
          className={className}
          style={style}
          onDoubleClick={() => {
            committedRef.current = false
            setDraft(value)
            setEditing(true)
          }}
        >
          {value}
        </span>
      )
    }

    return (
      <input
        ref={inputRef}
        className={className}
        style={{ ...EDIT_INPUT_STYLE, ...style }}
        aria-label={ariaLabel ?? 'Rename'}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
        onBlur={commit}
      />
    )
  },
)
