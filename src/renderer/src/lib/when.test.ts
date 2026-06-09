/**
 * When-clause evaluator tests (E6-05).
 */

import { describe, expect, it, vi } from 'vitest'

import { evaluateWhen } from './when'

describe('evaluateWhen', () => {
  it('treats an empty / undefined clause as always true', () => {
    expect(evaluateWhen(undefined, {})).toBe(true)
    expect(evaluateWhen('', {})).toBe(true)
    expect(evaluateWhen('   ', {})).toBe(true)
  })

  it('truthy-tests a bare identifier', () => {
    expect(evaluateWhen('editorFocus', { editorFocus: true })).toBe(true)
    expect(evaluateWhen('editorFocus', { editorFocus: false })).toBe(false)
    expect(evaluateWhen('editorFocus', {})).toBe(false)
  })

  it('handles negation', () => {
    expect(evaluateWhen('!debugging', { debugging: false })).toBe(true)
    expect(evaluateWhen('!debugging', { debugging: true })).toBe(false)
  })

  it('handles && and ||', () => {
    const ctx = { a: true, b: false }
    expect(evaluateWhen('a && b', ctx)).toBe(false)
    expect(evaluateWhen('a || b', ctx)).toBe(true)
    expect(evaluateWhen('a && !b', ctx)).toBe(true)
  })

  it('respects precedence: && binds tighter than ||', () => {
    // false && false || true  →  (false) || true  →  true
    expect(evaluateWhen('a && b || c', { a: false, b: false, c: true })).toBe(
      true,
    )
  })

  it('honours parentheses', () => {
    expect(evaluateWhen('a && (b || c)', { a: true, b: false, c: true })).toBe(
      true,
    )
    expect(evaluateWhen('a && (b || c)', { a: true, b: false, c: false })).toBe(
      false,
    )
  })

  it('compares against string literals', () => {
    expect(evaluateWhen("view == 'ide'", { view: 'ide' })).toBe(true)
    expect(evaluateWhen("view == 'ide'", { view: 'scm' })).toBe(false)
    expect(evaluateWhen("view != 'ide'", { view: 'scm' })).toBe(true)
  })

  it('compares against numbers and booleans', () => {
    expect(evaluateWhen('count == 0', { count: 0 })).toBe(true)
    expect(evaluateWhen('flag == true', { flag: true })).toBe(true)
    expect(evaluateWhen('flag == false', { flag: true })).toBe(false)
  })

  it('returns false (and logs) on a malformed clause', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(evaluateWhen('a &&', {})).toBe(false)
    expect(evaluateWhen('== b', {})).toBe(false)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
