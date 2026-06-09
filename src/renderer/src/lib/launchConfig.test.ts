/**
 * launch.json parsing tests (E3-02).
 */

import { describe, expect, it } from 'vitest'

import { parseLaunchConfig, stripJsonComments } from './launchConfig'

describe('stripJsonComments', () => {
  it('removes line + block comments but keeps string content', () => {
    const input = '{\n  // a comment\n  "name": "a//b", /* blk */ "x": 1\n}'
    const out = stripJsonComments(input)
    expect(out).not.toContain('a comment')
    expect(out).not.toContain('blk')
    expect(out).toContain('"a//b"')
  })
})

describe('parseLaunchConfig', () => {
  it('parses a JSONC launch.json with comments + trailing commas', () => {
    const text = `{
      // Node debug
      "version": "0.2.0",
      "configurations": [
        {
          "type": "node",
          "request": "launch",
          "name": "Run app",
          "program": "\${workspaceFolder}/index.js", // entry
        },
      ],
    }`
    const cfg = parseLaunchConfig(text)
    expect(cfg.version).toBe('0.2.0')
    expect(cfg.configurations).toHaveLength(1)
    expect(cfg.configurations[0]).toMatchObject({
      type: 'node',
      request: 'launch',
      name: 'Run app',
    })
  })

  it('defaults request to launch and drops invalid entries', () => {
    const cfg = parseLaunchConfig(
      '{"configurations":[{"type":"node","name":"x"},{"name":"no-type"},5]}',
    )
    expect(cfg.configurations).toHaveLength(1)
    expect(cfg.configurations[0].request).toBe('launch')
  })

  it('returns empty config for blank / invalid input', () => {
    expect(parseLaunchConfig('').configurations).toEqual([])
    expect(parseLaunchConfig('   ').configurations).toEqual([])
  })
})
