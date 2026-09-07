import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_REQUEST_V1_JSON_SCHEMA,
  parseCapabilityRequestV1,
  parseRouteDecisionV1,
  parseScheduleDecisionV1,
  ROUTE_DECISION_V1_JSON_SCHEMA,
  SCHEDULE_DECISION_V1_JSON_SCHEMA,
} from '../src/index.ts'
import type { JsonSchema } from '../src/index.ts'

const request = {
  schemaVersion: 1, target: 'worker', taskId: 'session-1', objective: 'Fix the parser.',
  profile: { coding: 90, reasoning: 70, toolUse: 40, repoContext: 80, risk: 20, difficulty: 60 },
  constraints: { maxWorkers: 1, maxOutputTokens: 32000, maxLatencyMs: 60000, allowPaidFallback: false, allowedProviders: ['provider-disabled'], requiredTools: ['targeted_verify'] },
  affinity: { workerId: 'session-1:worker:1', modelFamily: 'deepseek', snapshotId: 'snap-1' },
} as const

describe('CapabilityRequestV1', () => {
  it('returns a detached projection with every nested value frozen', () => {
    const input = {
      ...request,
      profile: { ...request.profile },
      constraints: {
        ...request.constraints,
        allowedProviders: [...request.constraints.allowedProviders],
        requiredTools: [...request.constraints.requiredTools],
      },
      affinity: { ...request.affinity },
      priorHandoff: {
        schemaVersion: 1,
        status: 'completed',
        summary: 'Finished.',
        changedFiles: ['src/parser.ts'],
        decisions: ['Kept the parser strict.'],
        verification: [{
          schemaVersion: 1,
          commandName: 'typecheck',
          args: [],
          exitCode: 0,
          status: 'passed',
          stdout: 'ok',
          stderr: '',
          truncated: false,
          durationMs: 10,
        }],
        blockers: [],
      },
    }
    const parsed = parseCapabilityRequestV1(input)

    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    expect(parsed.profile).not.toBe(input.profile)
    expect(parsed.constraints).not.toBe(input.constraints)
    expect(parsed.constraints.allowedProviders).not.toBe(input.constraints.allowedProviders)
    expect(parsed.constraints.requiredTools).not.toBe(input.constraints.requiredTools)
    expect(parsed.affinity).not.toBe(input.affinity)
    expect(parsed.priorHandoff).not.toBe(input.priorHandoff)
    expect(parsed.priorHandoff?.changedFiles).not.toBe(input.priorHandoff?.changedFiles)
    expect(parsed.priorHandoff?.decisions).not.toBe(input.priorHandoff?.decisions)
    expect(parsed.priorHandoff?.verification).not.toBe(input.priorHandoff?.verification)
    expect(parsed.priorHandoff?.verification[0]).not.toBe(input.priorHandoff?.verification[0])

    expectDeepFrozen(parsed)
    input.profile.risk = 99
    input.constraints.requiredTools.push('mutated')
    input.priorHandoff.changedFiles.push('mutated.ts')
    input.priorHandoff.verification[0].stdout = 'mutated'
    expect(parsed.profile.risk).toBe(20)
    expect(parsed.constraints.requiredTools).toEqual(['targeted_verify'])
    expect(parsed.priorHandoff?.changedFiles).toEqual(['src/parser.ts'])
    expect(parsed.priorHandoff?.verification[0].stdout).toBe('ok')
    expect(CAPABILITY_REQUEST_V1_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false })
  })
  it.each([
    { ...request, authorization: 'secret' },
    { ...request, objective: 'x'.repeat(16_385) },
    { ...request, profile: { ...request.profile, risk: 101 } },
    { ...request, constraints: { ...request.constraints, maxWorkers: 9 } },
    { ...request, constraints: { ...request.constraints, maxOutputTokens: 128_001 } },
  ])('rejects unknown or out-of-bound input %#', value => {
    expect(() => parseCapabilityRequestV1(value)).toThrow()
  })

  it('accepts the widened parallel worker bound and rejects one over it', () => {
    const accepted = { ...request, constraints: { ...request.constraints, maxWorkers: 8 } }
    const rejected = { ...request, constraints: { ...request.constraints, maxWorkers: 9 } }
    expect(parseCapabilityRequestV1(accepted).constraints.maxWorkers).toBe(8)
    expect(() => parseCapabilityRequestV1(rejected)).toThrow()
    expect(schemaAccepts(accepted, CAPABILITY_REQUEST_V1_JSON_SCHEMA)).toBe(true)
    expect(schemaAccepts(rejected, CAPABILITY_REQUEST_V1_JSON_SCHEMA)).toBe(false)
    expect(parserAccepts(accepted, parseCapabilityRequestV1)).toBe(true)
    expect(parserAccepts(rejected, parseCapabilityRequestV1)).toBe(false)
  })
})

describe('RouteDecisionV1 and ScheduleDecisionV1', () => {
  const route = { provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000, reasoningEffort: 'high', promptProfile: 'coding-v1', modelFamily: 'deepseek' } as const

  it('parses exact route and schedule decisions', () => {
    const parsedRoute = parseRouteDecisionV1(route)
    const parsedSchedule = parseScheduleDecisionV1({ schemaVersion: 1, mode: 'single-worker', route, workerCount: 1, source: 'scheduler', policyVersion: 'v0.3.0', affinityKey: 'session-1:worker:1:1', explanationCode: 'TASK_BASELINE' })
    expect(parsedRoute).toEqual(route)
    expect(parsedSchedule).toMatchObject({ source: 'scheduler', route })
    expectDeepFrozen(parsedRoute)
    expectDeepFrozen(parsedSchedule)
    expect(parsedSchedule.route).not.toBe(route)
    expect(parsedSchedule.route).not.toBe(parsedRoute)
    expect(Object.isFrozen(ROUTE_DECISION_V1_JSON_SCHEMA)).toBe(true)
    expectDeepFrozen(CAPABILITY_REQUEST_V1_JSON_SCHEMA)
    expectDeepFrozen(ROUTE_DECISION_V1_JSON_SCHEMA)
    expectDeepFrozen(SCHEDULE_DECISION_V1_JSON_SCHEMA)
    expect(SCHEDULE_DECISION_V1_JSON_SCHEMA).toMatchObject({ additionalProperties: false })
  })

  it('rejects unsupported modes, worker counts, and route fields', () => {
    expect(() => parseScheduleDecisionV1({ schemaVersion: 1, mode: 'parallel-workers', route, workerCount: 2, source: 'scheduler', policyVersion: 'v0.3.0' })).toThrow()
    expect(() => parseRouteDecisionV1({ ...route, endpoint: 'https://example.invalid' })).toThrow()
    expect(SCHEDULE_DECISION_V1_JSON_SCHEMA).toMatchObject({ properties: { workerCount: { enum: [0, 1] } } })
  })
})

describe('schemas and parsers reject the same representative invalid values', () => {
  const handoff = {
    schemaVersion: 1,
    status: 'completed',
    summary: 'Finished.',
    changedFiles: [],
    decisions: [],
    verification: [{
      schemaVersion: 1,
      commandName: 'typecheck',
      args: [],
      exitCode: 0,
      status: 'passed',
      stdout: '',
      stderr: '',
      truncated: false,
      durationMs: 0,
    }],
    blockers: [],
  } as const

  it.each([
    [CAPABILITY_REQUEST_V1_JSON_SCHEMA, { ...request, target: '' }, parseCapabilityRequestV1],
    [CAPABILITY_REQUEST_V1_JSON_SCHEMA, { ...request, taskId: '   ' }, parseCapabilityRequestV1],
    [CAPABILITY_REQUEST_V1_JSON_SCHEMA, { ...request, objective: 'contains\0nul' }, parseCapabilityRequestV1],
    [CAPABILITY_REQUEST_V1_JSON_SCHEMA, { ...request, constraints: { ...request.constraints, requiredTools: ['   '] } }, parseCapabilityRequestV1],
    [CAPABILITY_REQUEST_V1_JSON_SCHEMA, { ...request, priorHandoff: { ...handoff, verification: [{ ...handoff.verification[0], exitCode: Number.MAX_SAFE_INTEGER + 1 }] } }, parseCapabilityRequestV1],
    [ROUTE_DECISION_V1_JSON_SCHEMA, { provider: '   ', model: 'baseline-disabled', maxTokens: 32000 }, parseRouteDecisionV1],
    [ROUTE_DECISION_V1_JSON_SCHEMA, { provider: 'provider-disabled', model: 'bad\0model', maxTokens: 32000 }, parseRouteDecisionV1],
  ] as const)('does not accept %# in Schema when its parser rejects it', (schema, value, parser) => {
    expect(schemaAccepts(value, schema)).toBe(false)
    expect(() => parser(value)).toThrow()
  })

  it.each([
    [
      'direct mode requires zero workers',
      SCHEDULE_DECISION_V1_JSON_SCHEMA,
      { schemaVersion: 1, mode: 'direct', route: { provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000 }, workerCount: 1, source: 'scheduler', policyVersion: 'v0.3.0' },
      parseScheduleDecisionV1,
      false,
    ],
    [
      'single-worker mode requires one worker',
      SCHEDULE_DECISION_V1_JSON_SCHEMA,
      { schemaVersion: 1, mode: 'single-worker', route: { provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000 }, workerCount: 0, source: 'scheduler', policyVersion: 'v0.3.0' },
      parseScheduleDecisionV1,
      false,
    ],
    [
      'direct mode with zero workers is accepted',
      SCHEDULE_DECISION_V1_JSON_SCHEMA,
      { schemaVersion: 1, mode: 'direct', route: { provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000 }, workerCount: 0, source: 'scheduler', policyVersion: 'v0.3.0' },
      parseScheduleDecisionV1,
      true,
    ],
    [
      'completed handoff with failed verification requires the marker',
      CAPABILITY_REQUEST_V1_JSON_SCHEMA,
      { ...request, priorHandoff: { ...handoff, verification: [{ ...handoff.verification[0], status: 'failed', exitCode: 1 }] } },
      parseCapabilityRequestV1,
      false,
    ],
    [
      'completed handoff with failed verification and marker is accepted',
      CAPABILITY_REQUEST_V1_JSON_SCHEMA,
      { ...request, priorHandoff: { ...handoff, summary: 'Finished. [verification: failed]', verification: [{ ...handoff.verification[0], status: 'failed', exitCode: 1 }] } },
      parseCapabilityRequestV1,
      true,
    ],
  ] as const)('keeps Schema and parser acceptance aligned for %#', (_name, schema, value, parser, expected) => {
    expect(schemaAccepts(value, schema)).toBe(expected)
    expect(parserAccepts(value, parser)).toBe(expected)
  })
})

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeepFrozen(child)
}

type ConditionalJsonSchema = JsonSchema & {
  readonly allOf?: readonly JsonSchema[]
  readonly contains?: JsonSchema
  readonly if?: JsonSchema
  readonly then?: JsonSchema
}

function schemaAccepts(value: unknown, schema: ConditionalJsonSchema): boolean {
  if (schema.const !== undefined && value !== schema.const) return false
  if (schema.enum && !schema.enum.some(candidate => Object.is(candidate, value))) return false
  if (schema.oneOf && !schema.oneOf.some(candidate => schemaAccepts(value, candidate))) return false
  if (schema.allOf && schema.allOf.some(candidate => !schemaAccepts(value, candidate))) return false
  if (schema.if && schemaAccepts(value, schema.if) && schema.then && !schemaAccepts(value, schema.then)) return false
  if (schema.type === 'null' && value !== null) return false
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false
    if (schema.minLength !== undefined && [...value].length < schema.minLength) return false
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return false
    const pattern = (schema as JsonSchema & { readonly pattern?: string }).pattern
    if (pattern && !new RegExp(pattern).test(value)) return false
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (schema.type === 'integer' && !Number.isInteger(value)) return false
    if (schema.minimum !== undefined && value < schema.minimum) return false
    if (schema.maximum !== undefined && value > schema.maximum) return false
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return false
    if (schema.minLength !== undefined && value.length < schema.minLength) return false
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false
    if (schema.items && value.some(item => !schemaAccepts(item, schema.items!))) return false
    if (schema.contains && !value.some(item => schemaAccepts(item, schema.contains!))) return false
  }
  if (schema.type === 'object' || schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const record = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (!Object.prototype.hasOwnProperty.call(record, key)) return false
    if (schema.additionalProperties === false && schema.properties && Object.keys(record).some(key => !(key in schema.properties!))) return false
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(record, key) && !schemaAccepts(record[key], childSchema)) return false
    }
  }
  return true
}

function parserAccepts(value: unknown, parser: (value: unknown) => unknown): boolean {
  try {
    parser(value)
    return true
  } catch {
    return false
  }
}
