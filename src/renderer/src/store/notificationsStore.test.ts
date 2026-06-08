/**
 * Notifications store tests (E11-09).
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { notify, useNotificationsStore } from './notificationsStore'

beforeEach(() => useNotificationsStore.setState({ items: [], unread: 0 }))

describe('notificationsStore', () => {
  it('adds a notification and bumps unread', () => {
    const id = notify('info', 'hello')
    const s = useNotificationsStore.getState()
    expect(s.items).toHaveLength(1)
    expect(s.items[0].id).toBe(id)
    expect(s.unread).toBe(1)
  })

  it('dismiss deactivates without removing', () => {
    const id = notify('error', 'boom')
    useNotificationsStore.getState().dismiss(id)
    const item = useNotificationsStore.getState().items.find((i) => i.id === id)
    expect(item?.active).toBe(false)
  })

  it('remove deletes the notification', () => {
    const id = notify('warning', 'careful')
    useNotificationsStore.getState().remove(id)
    expect(useNotificationsStore.getState().items).toHaveLength(0)
  })

  it('markRead resets unread; clear empties everything', () => {
    notify('info', 'a')
    notify('info', 'b')
    useNotificationsStore.getState().markRead()
    expect(useNotificationsStore.getState().unread).toBe(0)
    useNotificationsStore.getState().clear()
    expect(useNotificationsStore.getState().items).toHaveLength(0)
  })
})
