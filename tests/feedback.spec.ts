import { describe, expect, it } from 'vitest'
import {
  BUDGET_VIEW_V1_JSON_SCHEMA,
  SCHEDULE_FEEDBACK_V1_JSON_SCHEMA,
  SCHEDULE_SELECTED_V1_JSON_SCHEMA,
  parseBudgetViewV1,
  parseScheduleFeedbackV1,
  parseScheduleSelectedV1,
} from '../src/index.ts'
import type { JsonSchema } from '../src/index.ts'

describe('BudgetViewV1', () => {
  it('accepts internally consistent counters and freezes the projection', () => {
    const view = parseBudgetViewV1({ maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 24, admittedPluginToolActions: 3, remainingWorkers: 1, remainingPluginToolActions: 21 })
    expect(view).toEqual({ maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 24, admittedPluginToolActions: 3, remainingWorkers: 1, remainingPluginToolActions: 21 })
    expect(Object.isFrozen(view)).toBe(true)
    expect('admitWorker' in view).toBe(false)
  })
  it('rejects forged remaining counts and methods', () => {
    expect(() => parseBudgetViewV1({ maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 1, admittedPluginToolActions: 0, remainingWorkers: 0, remainingPluginToolActions: 1 })).toThrow()
    expect(() => parseBudgetViewV1({ maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 1, admittedPluginToolActions: 0, remainingWorkers: 1, remainingPluginToolActions: 1, admitWorker() {} })).toThrow()
  })
  it('accepts cumulative worker counters through the DAG bound and rejects one over it', () => {
    const accepted = { maxWorkers: 16, admittedWorkers: 8, maxPluginToolActions: 24, admittedPluginToolActions: 1, remainingWorkers: 8, remainingPluginToolActions: 23 }
    const rejected = { maxWorkers: 17, admittedWorkers: 0, maxPluginToolActions: 24, admittedPluginToolActions: 0, remainingWorkers: 17, remainingPluginToolActions: 24 }
    expect(parseBudgetViewV1(accepted).remainingWorkers).toBe(8)
    expect(() => parseBudgetViewV1(rejected)).toThrow()
    expect(schemaAccepts(accepted, BUDGET_VIEW_V1_JSON_SCHEMA)).toBe(true)
    expect(schemaAccepts(rejected, BUDGET_VIEW_V1_JSON_SCHEMA)).toBe(false)
    expect(parserAccepts(accepted, parseBudgetViewV1)).toBe(true)
    expect(parserAccepts(rejected, parseBudgetViewV1)).toBe(false)
  })
})

describe('ScheduleFeedbackV1 and ScheduleSelectedV1', () => {
  it('projects bounded feedback through a JSON boundary and omits sensitive keys', () => {
    const feedback = parseScheduleFeedbackV1({ schemaVersion: 1, requestId: 'session-1', outcome: 'budget-rejected', budgetRejection: { code: 'WORKER_LIMIT', limit: 1, observed: 2 }, actual: { provider: 'provider-disabled', model: 'baseline-disabled', durationMs: 15, toolCalls: 0 } })
    expect(JSON.parse(JSON.stringify(feedback))).toEqual(feedback)
    expect(() => parseScheduleFeedbackV1({ ...feedback, transcript: 'SECRET' })).toThrow()
    expect(() => parseScheduleFeedbackV1({ ...feedback, outcome: 'budget-rejected', budgetRejection: undefined })).toThrow()
  })

  it('projects selected routes without credentials', () => {
    const selected = parseScheduleSelectedV1({ schemaVersion: 1, target: 'worker', source: 'scheduler', provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000, policyVersion: 'v0.3.0' })
    expect(selected).toEqual({ schemaVersion: 1, target: 'worker', source: 'scheduler', provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000, policyVersion: 'v0.3.0' })
    expect(() => parseScheduleSelectedV1({ ...selected, credential: 'SECRET' })).toThrow()
  })

  it('contextually discriminates legacy and fully correlated worker selections', () => {
    const legacy = { schemaVersion: 1, target: 'worker', source: 'scheduler', provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000, policyVersion: 'v0.3.0' } as const
    const correlation = { fanoutId: 'root:dag:1:aggregate', nodeId: 'worker-a', requestId: 'root:dag:1:node:worker-a' } as const
    const parallel = { ...legacy, ...correlation }

    expect(parseScheduleSelectedV1(legacy)).toEqual(legacy)
    expect(parseScheduleSelectedV1(parallel)).toEqual(parallel)
    expect(parseScheduleSelectedV1(legacy, 'legacy')).toEqual(legacy)
    expect(parseScheduleSelectedV1(parallel, 'parallel')).toEqual(parallel)
    expect(() => parseScheduleSelectedV1(legacy, 'parallel')).toThrow(/parallel/u)
    expect(() => parseScheduleSelectedV1(parallel, 'legacy')).toThrow(/legacy/u)
    expectDeepFrozen(parseScheduleSelectedV1(parallel, 'parallel'))
  })

  it.each([
    { fanoutId: 'root:dag:1:aggregate' },
    { nodeId: 'worker-a' },
    { requestId: 'root:dag:1:node:worker-a' },
    { fanoutId: 'root:dag:1:aggregate', nodeId: 'worker-a' },
    { fanoutId: 'root:dag:1:aggregate', requestId: 'root:dag:1:node:worker-a' },
    { nodeId: 'worker-a', requestId: 'root:dag:1:node:worker-a' },
  ])('rejects a partial worker schedule correlation triple %#', partialCorrelation => {
    expect(() => parseScheduleSelectedV1({
      schemaVersion: 1,
      target: 'worker',
      source: 'scheduler',
      provider: 'provider-disabled',
      model: 'baseline-disabled',
      maxTokens: 32000,
      ...partialCorrelation,
    })).toThrow(/correlation|triple|branch/u)
  })

  it('forbids a correlation triple on root selections and accepts it only on workers', () => {
    const correlation = { fanoutId: 'root:dag:1:aggregate', nodeId: 'worker-a', requestId: 'root:dag:1:node:worker-a' } as const
    const route = { schemaVersion: 1, source: 'scheduler', provider: 'provider-disabled', model: 'baseline-disabled', maxTokens: 32000 } as const
    const root = { ...route, target: 'root', ...correlation } as const
    const worker = { ...route, target: 'worker', ...correlation } as const

    expect(() => parseScheduleSelectedV1(root)).toThrow(/root/u)
    expect(() => parseScheduleSelectedV1(root, 'parallel')).toThrow(/root/u)
    expect(parseScheduleSelectedV1(worker, 'parallel')).toEqual(worker)
    expect(schemaAccepts(root, SCHEDULE_SELECTED_V1_JSON_SCHEMA)).toBe(false)
    expect(schemaAccepts(worker, SCHEDULE_SELECTED_V1_JSON_SCHEMA)).toBe(true)
  })

  it('detaches and freezes nested handoff feedback', () => {
    const input = {
      schemaVersion: 1,
      requestId: 'session-1',
      outcome: 'completed',
      handoff: {
        schemaVersion: 1,
        status: 'completed',
        summary: 'Finished.',
        changedFiles: ['src/parser.ts'],
        decisions: ['Kept the parser strict.'],
        verification: [],
        blockers: [],
      },
      verification: [],
    }
    const feedback = parseScheduleFeedbackV1(input)
    expect(feedback.handoff).not.toBe(input.handoff)
    expect(feedback.handoff?.changedFiles).not.toBe(input.handoff.changedFiles)
    expect(Object.isFrozen(feedback)).toBe(true)
    expect(Object.isFrozen(feedback.handoff)).toBe(true)
    expect(Object.isFrozen(feedback.handoff?.changedFiles)).toBe(true)
    input.handoff.changedFiles.push('mutated.ts')
    expect(feedback.handoff?.changedFiles).toEqual(['src/parser.ts'])
  })

  it('exports closed, frozen schemas for all new contracts', () => {
    expect(BUDGET_VIEW_V1_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false })
    expect(SCHEDULE_FEEDBACK_V1_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false })
    expect(SCHEDULE_SELECTED_V1_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false })
    expectDeepFrozen(BUDGET_VIEW_V1_JSON_SCHEMA)
    expectDeepFrozen(SCHEDULE_FEEDBACK_V1_JSON_SCHEMA)
    expectDeepFrozen(SCHEDULE_SELECTED_V1_JSON_SCHEMA)
  })

  it.each([
    [
      'accepts consistent counters',
      { maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 24, admittedPluginToolActions: 3, remainingWorkers: 1, remainingPluginToolActions: 21 },
      true,
    ],
    [
      'rejects admitted workers above the worker limit',
      { maxWorkers: 0, admittedWorkers: 1, maxPluginToolActions: 24, admittedPluginToolActions: 3, remainingWorkers: 0, remainingPluginToolActions: 21 },
      false,
    ],
    [
      'rejects a forged remaining worker count',
      { maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 24, admittedPluginToolActions: 3, remainingWorkers: 0, remainingPluginToolActions: 21 },
      false,
    ],
    [
      'rejects admitted plugin actions above the action limit',
      { maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 2, admittedPluginToolActions: 3, remainingWorkers: 1, remainingPluginToolActions: 0 },
      false,
    ],
    [
      'rejects a forged remaining plugin action count',
      { maxWorkers: 1, admittedWorkers: 0, maxPluginToolActions: 24, admittedPluginToolActions: 3, remainingWorkers: 1, remainingPluginToolActions: 20 },
      false,
    ],
  ] as const)('keeps the BudgetViewV1 Schema aligned with its parser for %s', (_name, value, expected) => {
    expect(schemaAccepts(value, BUDGET_VIEW_V1_JSON_SCHEMA)).toBe(expected)
    expect(parserAccepts(value, parseBudgetViewV1)).toBe(expected)
  })

  it.each([
    [
      'accepts budget rejection for budget-rejected outcome',
      { schemaVersion: 1, requestId: 'session-1', outcome: 'budget-rejected', budgetRejection: { code: 'WORKER_LIMIT', limit: 1, observed: 2 } },
      true,
    ],
    [
      'rejects a budget rejection on completed outcome',
      { schemaVersion: 1, requestId: 'session-1', outcome: 'completed', budgetRejection: { code: 'WORKER_LIMIT', limit: 1, observed: 2 } },
      false,
    ],
    [
      'rejects a budget rejection on blocked outcome',
      { schemaVersion: 1, requestId: 'session-1', outcome: 'blocked', budgetRejection: { code: 'WORKER_LIMIT', limit: 1, observed: 2 } },
      false,
    ],
    [
      'rejects a budget-rejected outcome without a budget rejection',
      { schemaVersion: 1, requestId: 'session-1', outcome: 'budget-rejected' },
      false,
    ],
  ] as const)('keeps the ScheduleFeedbackV1 Schema aligned with its parser for %s', (_name, value, expected) => {
    expect(schemaAccepts(value, SCHEDULE_FEEDBACK_V1_JSON_SCHEMA)).toBe(expected)
    expect(parserAccepts(value, parseScheduleFeedbackV1)).toBe(expected)
  })
})

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectDeepFrozen(child)
}

type ConditionalJsonSchema = JsonSchema & {
  readonly not?: JsonSchema
}

function schemaAccepts(value: unknown, schema: ConditionalJsonSchema): boolean {
  if (schema.const !== undefined && value !== schema.const) return false
  if (schema.enum && !schema.enum.some(candidate => Object.is(candidate, value))) return false
  if (schema.oneOf && !schema.oneOf.some(candidate => schemaAccepts(value, candidate))) return false
  if (schema.allOf && schema.allOf.some(candidate => !schemaAccepts(value, candidate))) return false
  if (schema.not && schemaAccepts(value, schema.not)) return false
  if (schema.if && schemaAccepts(value, schema.if) && schema.then && !schemaAccepts(value, schema.then)) return false
  if (schema.type === 'null' && value !== null) return false
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false
    if (schema.minLength !== undefined && [...value].length < schema.minLength) return false
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return false
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return false
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (schema.type === 'integer' && !Number.isInteger(value)) return false
    if (schema.minimum !== undefined && value < schema.minimum) return false
    if (schema.maximum !== undefined && value > schema.maximum) return false
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return false
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

function parserAccepts<T>(value: unknown, parser: (value: unknown) => T): boolean {
  try {
    parser(value)
    return true
  } catch {
    return false
  }
}
