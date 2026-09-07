import type { JsonSchema } from './types.js'
import {
  MAX_DAG_DEPS,
  MAX_DAG_NODES,
  MAX_DAG_PATHS,
  MAX_PARALLEL_WORKERS,
} from './parallel-paths.js'
import { MAX_VERIFICATION_ARG_BYTES, MAX_VERIFICATION_ARGS, MAX_VERIFICATION_COMMANDS } from './parallel-verification.js'

// JSON Schema maxLength counts Unicode code points, while the parser also enforces
// the documented UTF-8 byte ceiling. These schemas cover every standard-expressible
// rule; parser validation remains authoritative for the byte-level ceiling.
const NO_NUL_PATTERN = '^[^\\u0000]*$'
const NON_EMPTY_TEXT_PATTERN = '^(?=[\\s\\S]*\\S)[^\\u0000]+$'
const boundedString: JsonSchema = { type: 'string', maxLength: 16_384, pattern: NO_NUL_PATTERN }
const boundedNonEmptyText: JsonSchema = { type: 'string', maxLength: 16_384, pattern: NON_EMPTY_TEXT_PATTERN }
const boundedIdentifier: JsonSchema = { type: 'string', minLength: 1, maxLength: 256, pattern: NON_EMPTY_TEXT_PATTERN }
const stringArray: JsonSchema = { type: 'array', maxItems: 128, items: boundedString }
const identifierArray: JsonSchema = { type: 'array', maxItems: 128, items: boundedIdentifier }

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

const verificationEvidence: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    commandName: boundedIdentifier,
    args: stringArray,
    exitCode: { oneOf: [{ type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, { type: 'null' }] },
    status: { type: 'string', enum: ['passed', 'failed', 'timed-out', 'spawn-error'] },
    stdout: boundedString,
    stderr: boundedString,
    truncated: { type: 'boolean' },
    durationMs: { type: 'integer', minimum: 0, maximum: 600_000 },
  },
  required: ['schemaVersion', 'commandName', 'args', 'exitCode', 'status', 'stdout', 'stderr', 'truncated', 'durationMs'],
}

const handoff: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
    summary: boundedString,
    changedFiles: stringArray,
    decisions: stringArray,
    verification: { type: 'array', maxItems: 128, items: verificationEvidence },
    blockers: stringArray,
  },
  required: ['schemaVersion', 'status', 'summary', 'changedFiles', 'decisions', 'verification', 'blockers'],
  if: {
    type: 'object',
    properties: {
      status: { const: 'completed' },
      verification: {
        type: 'array',
        contains: {
          type: 'object',
          required: ['status'],
          properties: {
            status: { enum: ['failed', 'timed-out', 'spawn-error'] },
          },
        },
      },
    },
    required: ['status', 'verification'],
  },
  then: {
    type: 'object',
    properties: {
      summary: { type: 'string', pattern: '\\[verification: failed\\]' },
    },
    required: ['summary'],
  },
}

const profile: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    coding: { type: 'number', minimum: 0, maximum: 100 },
    reasoning: { type: 'number', minimum: 0, maximum: 100 },
    toolUse: { type: 'number', minimum: 0, maximum: 100 },
    repoContext: { type: 'number', minimum: 0, maximum: 100 },
    risk: { type: 'number', minimum: 0, maximum: 100 },
    difficulty: { type: 'number', minimum: 0, maximum: 100 },
  },
  required: ['coding', 'reasoning', 'toolUse', 'repoContext', 'risk', 'difficulty'],
}

const constraints: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    maxWorkers: { type: 'integer', minimum: 0, maximum: MAX_PARALLEL_WORKERS },
    maxOutputTokens: { type: 'integer', minimum: 1, maximum: 128_000 },
    maxLatencyMs: { type: 'integer', minimum: 1, maximum: 600_000 },
    allowPaidFallback: { type: 'boolean' },
    allowedProviders: identifierArray,
    requiredTools: identifierArray,
  },
  required: ['maxWorkers', 'maxOutputTokens', 'maxLatencyMs', 'allowPaidFallback', 'requiredTools'],
}

const route: JsonSchema = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: boundedIdentifier,
    model: boundedIdentifier,
    maxTokens: { type: 'integer', minimum: 1, maximum: 128_000 },
    reasoningEffort: boundedIdentifier,
    promptProfile: boundedIdentifier,
    modelFamily: boundedIdentifier,
  },
  required: ['provider', 'model', 'maxTokens'],
})

const budgetRejection: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', enum: ['WORKER_LIMIT', 'PLUGIN_TOOL_LIMIT', 'DISPOSED'] },
    limit: { type: 'integer', minimum: 0, maximum: 32 },
    observed: { type: 'integer', minimum: 0, maximum: 32 },
  },
  required: ['code', 'limit', 'observed'],
}

const actual: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: boundedIdentifier,
    model: boundedIdentifier,
    durationMs: { type: 'integer', minimum: 0, maximum: 600_000 },
    toolCalls: { type: 'integer', minimum: 0, maximum: 32 },
  },
}

const repoPathDeclaration: JsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 1_024,
  pattern: '^(?!/)(?![A-Za-z]:)(?!.*\\\\)(?!.*[*?\\[\\]{}])(?!.*[\\u0000-\\u001F\\u007F])(?!.*//)(?!.*(?:^|/)\\.(?:/|$))(?!.*(?:^|/)\\.\\.(?:/|$)).+$',
}

const dagProfile: JsonSchema = profile
const dagConstraints: JsonSchema = constraints
const taskNode: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    nodeId: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[^\\u0000-\\u001F\\u007F\\u003A\\u0022\\\\]+$' },
    objective: { type: 'string', maxLength: 4_096, pattern: NO_NUL_PATTERN },
    profile: dagProfile,
    constraints: dagConstraints,
    readPaths: { type: 'array', maxItems: MAX_DAG_PATHS, items: repoPathDeclaration },
    writePaths: { type: 'array', maxItems: MAX_DAG_PATHS, items: repoPathDeclaration },
    dependsOn: { type: 'array', maxItems: MAX_DAG_DEPS, items: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[^\\u0000-\\u001F\\u007F\\u003A\\u0022\\\\]+$' } },
  },
  required: ['schemaVersion', 'nodeId', 'objective', 'profile', 'constraints', 'readPaths', 'writePaths', 'dependsOn'],
}

export const TASK_DAG_V1_JSON_SCHEMA: JsonSchema = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    rootTaskId: boundedIdentifier,
    nodes: { type: 'array', minItems: 1, maxItems: MAX_DAG_NODES, items: taskNode },
  },
  required: ['schemaVersion', 'rootTaskId', 'nodes'],
})

const parallelVerificationCommand: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: boundedIdentifier,
    args: { type: 'array', maxItems: MAX_VERIFICATION_ARGS, items: { type: 'string', maxLength: MAX_VERIFICATION_ARG_BYTES, pattern: NO_NUL_PATTERN } },
  },
  required: ['name', 'args'],
}

export const PARALLEL_VERIFICATION_POLICY_V1_JSON_SCHEMA: JsonSchema = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    scope: { type: 'string', enum: ['level', 'dag'] },
    commands: { type: 'array', maxItems: MAX_VERIFICATION_COMMANDS, items: parallelVerificationCommand },
  },
  required: ['schemaVersion', 'scope', 'commands'],
})

function derivedCounterInvariants(maximum: number, maxProperty: string, admittedProperty: string, remainingProperty: string): readonly JsonSchema[] {
  return Array.from({ length: maximum + 1 }, (_, maxValue) => ({
    if: {
      properties: { [maxProperty]: { const: maxValue } },
      required: [maxProperty],
    },
    then: {
      oneOf: Array.from({ length: maxValue + 1 }, (_, admittedValue) => ({
        properties: {
          [admittedProperty]: { const: admittedValue },
          [remainingProperty]: { const: maxValue - admittedValue },
        },
        required: [admittedProperty, remainingProperty],
      })),
    },
  }))
}

export const CAPABILITY_REQUEST_V1_JSON_SCHEMA: JsonSchema = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    target: { type: 'string', enum: ['root', 'worker'] },
    taskId: boundedIdentifier,
    objective: boundedNonEmptyText,
    profile,
    constraints,
    workspaceFingerprint: boundedIdentifier,
    repoRevision: boundedIdentifier,
    affinity: {
      type: 'object',
      additionalProperties: false,
      properties: {
        workerId: boundedIdentifier,
        modelFamily: boundedIdentifier,
        snapshotId: boundedIdentifier,
      },
    },
    priorHandoff: handoff,
  },
  required: ['schemaVersion', 'target', 'taskId', 'objective', 'profile', 'constraints'],
})

export const ROUTE_DECISION_V1_JSON_SCHEMA: JsonSchema = route

export const SCHEDULE_DECISION_V1_JSON_SCHEMA: JsonSchema = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    mode: { type: 'string', enum: ['direct', 'single-worker'] },
    route,
    workerCount: { type: 'integer', enum: [0, 1] },
    source: { type: 'string', enum: ['scheduler', 'profile-fallback'] },
    policyVersion: boundedIdentifier,
    affinityKey: boundedIdentifier,
    explanationCode: boundedIdentifier,
  },
  required: ['schemaVersion', 'mode', 'route', 'workerCount', 'source', 'policyVersion'],
  allOf: [
    {
      if: {
        properties: { mode: { const: 'direct' } },
        required: ['mode'],
      },
      then: {
        properties: { workerCount: { const: 0 } },
        required: ['workerCount'],
      },
    },
    {
      if: {
        properties: { mode: { const: 'single-worker' } },
        required: ['mode'],
      },
      then: {
        properties: { workerCount: { const: 1 } },
        required: ['workerCount'],
      },
    },
  ],
})

export const BUDGET_VIEW_V1_JSON_SCHEMA: JsonSchema = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    maxWorkers: { type: 'integer', minimum: 0, maximum: MAX_DAG_NODES },
    admittedWorkers: { type: 'integer', minimum: 0, maximum: MAX_DAG_NODES },
    maxPluginToolActions: { type: 'integer', minimum: 0, maximum: 32 },
    admittedPluginToolActions: { type: 'integer', minimum: 0, maximum: 32 },
    remainingWorkers: { type: 'integer', minimum: 0, maximum: MAX_DAG_NODES },
    remainingPluginToolActions: { type: 'integer', minimum: 0, maximum: 32 },
  },
  required: ['maxWorkers', 'admittedWorkers', 'maxPluginToolActions', 'admittedPluginToolActions', 'remainingWorkers', 'remainingPluginToolActions'],
  allOf: [
    ...derivedCounterInvariants(MAX_DAG_NODES, 'maxWorkers', 'admittedWorkers', 'remainingWorkers'),
    ...derivedCounterInvariants(32, 'maxPluginToolActions', 'admittedPluginToolActions', 'remainingPluginToolActions'),
  ],
})

export const SCHEDULE_FEEDBACK_V1_JSON_SCHEMA: JsonSchema = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    requestId: boundedIdentifier,
    outcome: { type: 'string', enum: ['completed', 'blocked', 'failed', 'budget-rejected', 'verification-failed'] },
    handoff,
    verification: { type: 'array', maxItems: 128, items: verificationEvidence },
    budgetRejection,
    actual,
  },
  required: ['schemaVersion', 'requestId', 'outcome'],
  allOf: [
    {
      if: {
        properties: { outcome: { const: 'budget-rejected' } },
        required: ['outcome'],
      },
      then: { required: ['budgetRejection'] },
    },
    {
      if: {
        properties: { outcome: { enum: ['completed', 'blocked', 'failed', 'verification-failed'] } },
        required: ['outcome'],
      },
      then: { not: { required: ['budgetRejection'] } },
    },
  ],
})

export const SCHEDULE_SELECTED_V1_JSON_SCHEMA: JsonSchema = deepFreeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    target: { type: 'string', enum: ['root', 'worker'] },
    source: { type: 'string', enum: ['scheduler', 'profile-fallback'] },
    provider: boundedIdentifier,
    model: boundedIdentifier,
    maxTokens: { type: 'integer', minimum: 1, maximum: 128_000 },
    reasoningEffort: boundedIdentifier,
    promptProfile: boundedIdentifier,
    modelFamily: boundedIdentifier,
    policyVersion: boundedIdentifier,
    fanoutId: boundedIdentifier,
    nodeId: { type: 'string', minLength: 1, maxLength: 32, pattern: '^[^\\u0000-\\u001F\\u007F\\u003A\\u0022\\\\]+$' },
    requestId: boundedIdentifier,
  },
  required: ['schemaVersion', 'target', 'source', 'provider', 'model', 'maxTokens'],
  allOf: [
    {
      if: {
        properties: { target: { const: 'root' } },
        required: ['target'],
      },
      then: { not: { required: ['fanoutId'] } },
    },
    {
      if: { required: ['fanoutId'] },
      then: { required: ['fanoutId', 'nodeId', 'requestId'] },
    },
    {
      if: { required: ['nodeId'] },
      then: { required: ['fanoutId', 'nodeId', 'requestId'] },
    },
    {
      if: { required: ['requestId'] },
      then: { required: ['fanoutId', 'nodeId', 'requestId'] },
    },
  ],
})
