import type {
  CapabilityProfileV1,
  DagValidationLimitsV1,
  SchedulingConstraintsV1,
  TaskDagV1,
  TaskNodeV1,
} from './types.js'
import {
  MAX_DAG_DEPS,
  MAX_DAG_LEVELS,
  MAX_DAG_NODES,
  MAX_DAG_PATHS,
  MAX_PARALLEL_WORKERS,
  isWellFormedUnicode,
  parseNodeId,
  parseRepoPathDeclaration,
  utf8ByteLength,
} from './parallel-paths.js'
import {
  MAX_SCHEDULING_IDENTIFIER_BYTES,
  MAX_SCHEDULING_ITEMS,
  MAX_SCHEDULING_LATENCY_MS,
  MAX_SCHEDULING_OUTPUT_TOKENS,
} from './parse.js'

const MAX_DAG_OBJECTIVE_BYTES = 4_096
type RecordValue = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`)
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertJsonValue(value: unknown, path: string, seen = new WeakSet<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    fail(path, 'must be a JSON value')
  }
  if (typeof value !== 'object') fail(path, 'must be a JSON value')
  if (seen.has(value)) fail(path, 'must be a JSON value')
  if (!Array.isArray(value) && !isPlainRecord(value)) fail(path, 'must be a JSON value')

  seen.add(value)
  if (Array.isArray(value)) {
    for (const key of Reflect.ownKeys(value)) {
      if (key !== 'length' && (typeof key !== 'string' || !/^\d+$/u.test(key))) fail(path, 'must be a JSON value')
    }
    for (const [index, item] of value.entries()) assertJsonValue(item, `${path}[${index}]`, seen)
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') fail(path, 'must be a JSON value')
      assertJsonValue((value as RecordValue)[key], `${path}.${key}`, seen)
    }
  }
  seen.delete(value)
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as RecordValue)) deepFreeze(child)
  return Object.freeze(value)
}

function exactRecord(value: unknown, path: string, allowed: readonly string[]): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !isPlainRecord(value)) fail(path, 'must be a plain object')
  const record = value as RecordValue
  const allowedSet = new Set(allowed)
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !allowedSet.has(key)) fail(`${path}.${String(key)}`, 'is not allowed')
  }
  return record
}

function required(record: RecordValue, name: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, name)) fail(`${path}.${name}`, 'is required')
  return record[name]
}

function boundedIdentifier(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '' || !isWellFormedUnicode(value)) fail(path, 'must be a non-empty identifier')
  if (value.includes('\0')) fail(path, 'must not contain a NUL byte')
  if (utf8ByteLength(value) > MAX_SCHEDULING_IDENTIFIER_BYTES) fail(path, `must not exceed ${MAX_SCHEDULING_IDENTIFIER_BYTES} UTF-8 bytes`)
  return value
}

function boundedText(value: unknown, path: string, maximumBytes: number): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (value.includes('\0')) fail(path, 'must not contain a NUL byte')
  if (utf8ByteLength(value) > maximumBytes) fail(path, `must not exceed ${maximumBytes} UTF-8 bytes`)
  return value
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(path, `must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function boundedArray<T>(value: unknown, path: string, maxItems: number, item: (value: unknown, path: string) => T): readonly T[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (value.length > maxItems) fail(path, `must not contain more than ${maxItems} items`)
  return value.map((entry, index) => item(entry, `${path}[${index}]`))
}

function parseProfile(value: unknown, path: string): CapabilityProfileV1 {
  const profile = exactRecord(value, path, ['coding', 'reasoning', 'toolUse', 'repoContext', 'risk', 'difficulty'])
  const score = (name: keyof CapabilityProfileV1): number => {
    const entry = required(profile, name, path)
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0 || entry > 100) fail(`${path}.${name}`, 'must be a finite number between 0 and 100')
    return entry
  }
  return {
    coding: score('coding'),
    reasoning: score('reasoning'),
    toolUse: score('toolUse'),
    repoContext: score('repoContext'),
    risk: score('risk'),
    difficulty: score('difficulty'),
  }
}

function parseConstraints(value: unknown, path: string): SchedulingConstraintsV1 {
  const constraints = exactRecord(value, path, ['maxWorkers', 'maxOutputTokens', 'maxLatencyMs', 'allowPaidFallback', 'allowedProviders', 'requiredTools'])
  const allowPaidFallback = required(constraints, 'allowPaidFallback', path)
  if (typeof allowPaidFallback !== 'boolean') fail(`${path}.allowPaidFallback`, 'must be a boolean')
  return {
    maxWorkers: boundedInteger(required(constraints, 'maxWorkers', path), `${path}.maxWorkers`, 0, MAX_PARALLEL_WORKERS),
    maxOutputTokens: boundedInteger(required(constraints, 'maxOutputTokens', path), `${path}.maxOutputTokens`, 1, MAX_SCHEDULING_OUTPUT_TOKENS),
    maxLatencyMs: boundedInteger(required(constraints, 'maxLatencyMs', path), `${path}.maxLatencyMs`, 1, MAX_SCHEDULING_LATENCY_MS),
    allowPaidFallback,
    ...(Object.prototype.hasOwnProperty.call(constraints, 'allowedProviders')
      ? { allowedProviders: boundedArray(constraints.allowedProviders, `${path}.allowedProviders`, MAX_SCHEDULING_ITEMS, boundedIdentifier) }
      : {}),
    requiredTools: boundedArray(required(constraints, 'requiredTools', path), `${path}.requiredTools`, MAX_SCHEDULING_ITEMS, boundedIdentifier),
  }
}

function parseTaskNode(value: unknown, index: number): TaskNodeV1 {
  const path = `dag.nodes[${index}]`
  const node = exactRecord(value, path, ['schemaVersion', 'nodeId', 'objective', 'profile', 'constraints', 'readPaths', 'writePaths', 'dependsOn'])
  if (node.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must be 1')
  return {
    schemaVersion: 1,
    nodeId: parseNodeId(required(node, 'nodeId', path), `${path}.nodeId`),
    objective: boundedText(required(node, 'objective', path), `${path}.objective`, MAX_DAG_OBJECTIVE_BYTES),
    profile: parseProfile(required(node, 'profile', path), `${path}.profile`),
    constraints: parseConstraints(required(node, 'constraints', path), `${path}.constraints`),
    readPaths: boundedArray(required(node, 'readPaths', path), `${path}.readPaths`, MAX_DAG_PATHS, parseRepoPathDeclaration),
    writePaths: boundedArray(required(node, 'writePaths', path), `${path}.writePaths`, MAX_DAG_PATHS, parseRepoPathDeclaration),
    dependsOn: boundedArray(required(node, 'dependsOn', path), `${path}.dependsOn`, MAX_DAG_DEPS, parseNodeId),
  }
}

export function parseTaskDagV1(value: unknown): TaskDagV1 {
  assertJsonValue(value, 'dag')
  const dag = exactRecord(value, 'dag', ['schemaVersion', 'rootTaskId', 'nodes'])
  if (dag.schemaVersion !== 1 || !Array.isArray(dag.nodes) || dag.nodes.length === 0) throw new TypeError('dag must contain at least one node')
  if (dag.nodes.length > MAX_DAG_NODES) fail('dag.nodes', `must not contain more than ${MAX_DAG_NODES} items`)
  return deepFreeze({
    schemaVersion: 1,
    rootTaskId: boundedIdentifier(required(dag, 'rootTaskId', 'dag'), 'dag.rootTaskId'),
    nodes: dag.nodes.map(parseTaskNode),
  })
}

export function parseDagValidationLimitsV1(value: unknown): DagValidationLimitsV1 {
  assertJsonValue(value, 'dagValidationLimits')
  const limits = exactRecord(value, 'dagValidationLimits', ['schemaVersion', 'maxNodes', 'maxLevels', 'maxWidth', 'maxCumulativeWorkers'])
  if (limits.schemaVersion !== 1) fail('dagValidationLimits.schemaVersion', 'must be 1')
  return deepFreeze({
    schemaVersion: 1,
    maxNodes: boundedInteger(required(limits, 'maxNodes', 'dagValidationLimits'), 'dagValidationLimits.maxNodes', 0, MAX_DAG_NODES),
    maxLevels: boundedInteger(required(limits, 'maxLevels', 'dagValidationLimits'), 'dagValidationLimits.maxLevels', 0, MAX_DAG_LEVELS),
    maxWidth: boundedInteger(required(limits, 'maxWidth', 'dagValidationLimits'), 'dagValidationLimits.maxWidth', 0, MAX_PARALLEL_WORKERS),
    maxCumulativeWorkers: boundedInteger(required(limits, 'maxCumulativeWorkers', 'dagValidationLimits'), 'dagValidationLimits.maxCumulativeWorkers', 0, MAX_DAG_NODES),
  })
}
