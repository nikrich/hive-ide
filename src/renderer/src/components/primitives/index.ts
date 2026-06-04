/**
 * Shared visual primitives — barrel re-export.
 *
 * Downstream renderer code should import from here so component locations
 * can be refactored without touching call sites:
 *
 *     import { Icon, RoleAva, StatusChip, Btn } from '../primitives'
 */

export { Icon } from './Icon'
export type { IconProps } from './Icon'

export { Pulse } from './Pulse'

export { StatusChip } from './StatusChip'
export type { StatusChipProps, StatusKey } from './StatusChip'

export { RoleAva } from './RoleAva'
export type { RoleAvaProps } from './RoleAva'

export { Btn } from './Btn'
export type { BtnProps, BtnKind } from './Btn'

export { StoryProgress } from './StoryProgress'
export type { StoryProgressProps, StoryProgressCounts } from './StoryProgress'

export { fileIcon } from './fileIcon'
export type { FileIconResult } from './fileIcon'

export { hexA } from './hexA'

export { InlineEditable } from './InlineEditable'
export type { InlineEditableProps, InlineEditableHandle } from './InlineEditable'

export { ContextMenu } from './ContextMenu'
export type { ContextMenuProps, ContextMenuItem } from './ContextMenu'
