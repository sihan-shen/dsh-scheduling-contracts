import { describe, expect, it } from 'vitest'
import {
  MAX_VERIFICATION_ARG_BYTES,
  MAX_VERIFICATION_ARGS,
  MAX_VERIFICATION_COMMANDS,
  PARALLEL_VERIFICATION_POLICY_V1_JSON_SCHEMA,
  parseDagValidationLimitsV1,
  parseParallelVerificationPolicyV1,
} from '../src/index.ts'

describe('parseParallelVerificationPolicyV1', () => {
  it('projects ordered commands into a detached deeply frozen policy', () => {
    const input = { schemaVersion: 1, scope: 'dag' as const, commands: [{ name: 'typecheck', args: [] }] }
    const parsed = parseParallelVerificationPolicyV1(input)

    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    expect(parsed.commands).not.toBe(input.commands)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.commands)).toBe(true)
    expect(Object.isFrozen(parsed.commands[0])).toBe(true)
  })

  it.each([
    ['scope', { schemaVersion: 1, scope: 'worker', commands: [] }],
    ['command count', { schemaVersion: 1, scope: 'level', commands: Array.from({ length: MAX_VERIFICATION_COMMANDS + 1 }, () => ({ name: 'typecheck', args: [] })) }],
    ['argument count', { schemaVersion: 1, scope: 'level', commands: [{ name: 'test:profile', args: Array.from({ length: MAX_VERIFICATION_ARGS + 1 }, () => 'arg') }] }],
    ['argument bytes', { schemaVersion: 1, scope: 'level', commands: [{ name: 'test:profile', args: ['x'.repeat(MAX_VERIFICATION_ARG_BYTES + 1)] }] }],
    ['unknown key', { schemaVersion: 1, scope: 'level', commands: [], extra: true }],
  ])('rejects structural violation %s', (_label, value) => expect(() => parseParallelVerificationPolicyV1(value)).toThrow())

  it('rejects overlong arguments with the documented byte-bound message', () => {
    expect(() => parseParallelVerificationPolicyV1({ schemaVersion: 1, scope: 'level', commands: [{ name: 'test:profile', args: ['x'.repeat(257)] }] })).toThrow(/256 UTF-8 bytes/u)
  })

  it('exports a closed, deeply frozen literal schema', () => {
    expect(PARALLEL_VERIFICATION_POLICY_V1_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false })
    expect(Object.isFrozen(PARALLEL_VERIFICATION_POLICY_V1_JSON_SCHEMA)).toBe(true)
    expect(Object.isFrozen(PARALLEL_VERIFICATION_POLICY_V1_JSON_SCHEMA.properties?.commands)).toBe(true)
  })
})

describe('parseDagValidationLimitsV1', () => {
  it('accepts bounded deployment validation limits', () => {
    expect(parseDagValidationLimitsV1({ schemaVersion: 1, maxNodes: 16, maxLevels: 4, maxWidth: 8, maxCumulativeWorkers: 16 })).toMatchObject({ maxWidth: 8 })
  })
})
