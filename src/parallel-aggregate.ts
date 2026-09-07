import type {
  HandoffV1,
  NodeOutcomeReasonV1,
  OwnershipViolationSummaryV1,
  ParallelAggregateV1,
  ParallelNodeResultV1,
  VerificationEvidenceV1,
  VerificationOutcomeV1,
} from './types.js'
import { parseScheduleFeedbackV1 } from './parse.js'
import {
  MAX_DAG_CHANGED_FILES,
  MAX_DAG_LEVELS,
  MAX_DAG_NODES,
  MAX_PARALLEL_WORKER_REF_BYTES,
  MAX_PARALLEL_WORKERS,
  isWellFormedUnicode,
  parseNodeId,
  parseRepoFilePath,
  utf8ByteLength,
} from './parallel-paths.js'
import { MAX_SCHEDULING_IDENTIFIER_BYTES, MAX_SCHEDULING_ITEMS } from './parse.js'
import {
  MAX_VERIFICATION_ARG_BYTES,
  MAX_VERIFICATION_ARGS,
  MAX_VERIFICATION_COMMANDS,
} from './parallel-verification.js'

export const MAX_AGGREGATE_PAYLOAD_BYTES = 131_072
export const MAX_AGGREGATE_VERIFICATION_TOTAL_BYTES = 49_152
export const MAX_AGGREGATE_VERIFICATION_METADATA_SERIALIZED_BYTES = 4_096
export const MAX_AGGREGATE_VERIFICATION_OUTPUT_BYTES = 8_192
export const MAX_AGGREGATE_VIOLATION_BYTES = 24_576
export const MAX_AGGREGATE_PROJECTED_HANDOFF_BYTES = 24_576
export const MAX_PARALLEL_WORKER_FINISHED_PAYLOAD_BYTES = 262_144
export const MAX_PARALLEL_STARTED_PAYLOAD_BYTES = 65_536
export const MAX_PARALLEL_WORKER_REQUESTED_PAYLOAD_BYTES = 262_144

const WORKER_REF_PATTERN = /^w:[0-9a-f]{32}$/u
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u
const BUDGET_REJECTED_MARKER = '[verification: budget-rejected]'
type RecordValue = Record<string, unknown>

function fail(path: string, message: string): never {
  throw new TypeError(`${path} ${message}`)
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function snapshotJsonValue(value: unknown, path: string, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value
    fail(path, 'must be a JSON value')
  }
  if (typeof value !== 'object') fail(path, 'must be a JSON value')
  if (seen.has(value)) fail(path, 'must be a JSON value')
  if (!Array.isArray(value) && !isPlainRecord(value)) fail(path, 'must be a JSON value')

  seen.add(value)
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Array.isArray(value)) {
      const snapshot: unknown[] = []
      const length = descriptors.length?.value
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) fail(`${path}.length`, 'must be a valid array length')
      for (const key of Reflect.ownKeys(descriptors)) {
        if (key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key))) {
          fail(path, 'must be a JSON value')
        }
        if (key !== 'length' && Number(key) >= length) fail(path, 'must be a JSON value')
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (descriptor === undefined) fail(`${path}[${index}]`, 'must be a JSON value')
        if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail(`${path}[${index}]`, 'must not be an accessor')
        snapshot.push(snapshotJsonValue(descriptor.value, `${path}[${index}]`, seen))
      }
      return snapshot
    }

    const snapshot = Object.create(null) as RecordValue
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') fail(path, 'must be a JSON value')
      const descriptor = descriptors[key]!
      if (!descriptor.enumerable) fail(`${path}.${key}`, 'must be JSON-serialized')
      if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) fail(`${path}.${key}`, 'must not be an accessor')
      snapshot[key] = snapshotJsonValue(descriptor.value, `${path}.${key}`, seen)
    }
    return snapshot
  } finally {
    seen.delete(value)
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  for (const child of Object.values(value as RecordValue)) deepFreeze(child)
  return Object.freeze(value)
}

function exactRecord(value: unknown, path: string, allowed: readonly string[]): RecordValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !isPlainRecord(value)) {
    fail(path, 'must be a plain object')
  }
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
  if (utf8ByteLength(value) > MAX_SCHEDULING_IDENTIFIER_BYTES) {
    fail(path, `must not exceed ${MAX_SCHEDULING_IDENTIFIER_BYTES} UTF-8 bytes`)
  }
  return value
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(path, `must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function parseWorkerRef(value: unknown, path: string): string {
  if (typeof value !== 'string' || utf8ByteLength(value) > MAX_PARALLEL_WORKER_REF_BYTES || !WORKER_REF_PATTERN.test(value)) {
    fail(path, 'must be w: followed by 32 lowercase hexadecimal characters')
  }
  return value
}

export function serializedPayloadBytes(value: unknown): number {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new TypeError('payload must be JSON-serializable')
  }
  if (serialized === undefined) throw new TypeError('payload must be JSON-serializable')
  return utf8ByteLength(serialized)
}

export function assertSerializedPayloadLimit(value: unknown, maximum: number, label: string): void {
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new TypeError('maximum must be a non-negative safe integer')
  if (typeof label !== 'string' || label.length === 0) throw new TypeError('label must be a non-empty string')
  const actual = serializedPayloadBytes(value)
  if (actual > maximum) throw new TypeError(`${label} serialized payload exceeds ${maximum} bytes`)
}

function parseNodeResult(value: unknown, index: number): ParallelNodeResultV1 {
  const path = `parallelAggregate.nodeResults[${index}]`
  const node = exactRecord(value, path, ['schemaVersion', 'nodeId', 'requestId', 'workerRef', 'status', 'reason'])
  if (node.schemaVersion !== 1) fail(`${path}.schemaVersion`, 'must be 1')
  const status = required(node, 'status', path)
  if (status !== 'completed' && status !== 'blocked' && status !== 'failed' && status !== 'ownership-violation' && status !== 'not-run') {
    fail(`${path}.status`, 'is unsupported')
  }
  const reason = required(node, 'reason', path)
  const hasWorkerRef = Object.prototype.hasOwnProperty.call(node, 'workerRef')
  const workerRef = hasWorkerRef ? parseWorkerRef(node.workerRef, `${path}.workerRef`) : undefined

  const valid =
    (status === 'completed' && reason === 'completed' && hasWorkerRef)
    || (status === 'blocked' && (reason === 'blocked-result' || reason === 'cancelled-after-start') && hasWorkerRef)
    || (status === 'failed' && reason === 'start-failed' && !hasWorkerRef)
    || (status === 'failed' && (reason === 'failed-result' || reason === 'handoff-payload-too-large') && hasWorkerRef)
    || (status === 'ownership-violation' && reason === 'violation' && hasWorkerRef)
    || (status === 'not-run'
      && (reason === 'dependency-not-run'
        || reason === 'zero-worker-constraint'
        || reason === 'no-route'
        || reason === 'tool-unauthorized'
        || reason === 'admission-rejected'
        || reason === 'level-verification-stopped'
        || reason === 'cancelled-before-start')
      && !hasWorkerRef)
  if (!valid) fail(path, 'has an inconsistent status/reason/workerRef combination')

  return {
    schemaVersion: 1,
    nodeId: parseNodeId(required(node, 'nodeId', path), `${path}.nodeId`),
    requestId: boundedIdentifier(required(node, 'requestId', path), `${path}.requestId`),
    ...(workerRef === undefined ? {} : { workerRef }),
    status,
    reason: reason as NodeOutcomeReasonV1,
  }
}

function parseOwnershipSummary(value: unknown, index: number): OwnershipViolationSummaryV1 {
  const path = `parallelAggregate.ownershipViolations[${index}]`
  const summary = exactRecord(value, path, ['nodeId', 'count', 'digest', 'samplePaths'])
  const count = boundedInteger(required(summary, 'count', path), `${path}.count`, 1, MAX_SCHEDULING_ITEMS)
  const digest = required(summary, 'digest', path)
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) fail(`${path}.digest`, 'must be a lowercase 64-hex digest')
  const samplePaths = required(summary, 'samplePaths', path)
  if (!Array.isArray(samplePaths)) fail(`${path}.samplePaths`, 'must be an array')
  if (samplePaths.length > Math.min(MAX_DAG_CHANGED_FILES, count)) {
    fail(`${path}.samplePaths`, `must not contain more than ${Math.min(MAX_DAG_CHANGED_FILES, count)} items`)
  }
  const parsedPaths = samplePaths.map((item, pathIndex) => parseRepoFilePath(item, `${path}.samplePaths[${pathIndex}]`))
  for (let pathIndex = 1; pathIndex < parsedPaths.length; pathIndex += 1) {
    if (parsedPaths[pathIndex - 1]! >= parsedPaths[pathIndex]!) fail(`${path}.samplePaths`, 'must be unique and lexically ordered')
  }
  return {
    nodeId: parseNodeId(required(summary, 'nodeId', path), `${path}.nodeId`),
    count,
    digest,
    samplePaths: parsedPaths,
  }
}

function assertUnique(results: readonly ParallelNodeResultV1[]): void {
  const nodeIds = new Set<string>()
  const requestIds = new Set<string>()
  const workerRefs = new Set<string>()
  for (const result of results) {
    if (nodeIds.has(result.nodeId)) fail('parallelAggregate.nodeResults', 'must have a unique nodeId per result')
    if (requestIds.has(result.requestId)) fail('parallelAggregate.nodeResults', 'must have a unique requestId per result')
    if (result.workerRef !== undefined && workerRefs.has(result.workerRef)) {
      fail('parallelAggregate.nodeResults', 'must have a unique workerRef per published result')
    }
    nodeIds.add(result.nodeId)
    requestIds.add(result.requestId)
    if (result.workerRef !== undefined) workerRefs.add(result.workerRef)
  }
}

function assertOwnershipSummaryBijection(
  results: readonly ParallelNodeResultV1[],
  summaries: readonly OwnershipViolationSummaryV1[],
): void {
  const violationNodeIds = new Set(results.filter(result => result.status === 'ownership-violation').map(result => result.nodeId))
  const summaryNodeIds = new Set<string>()
  let previousNodeId: string | undefined
  for (const summary of summaries) {
    if (previousNodeId !== undefined && previousNodeId >= summary.nodeId) {
      fail('parallelAggregate.ownershipViolations', 'must be unique and lexically ordered by nodeId')
    }
    if (!violationNodeIds.has(summary.nodeId)) fail('parallelAggregate.ownershipViolations', 'must reference only ownership-violation nodes')
    summaryNodeIds.add(summary.nodeId)
    previousNodeId = summary.nodeId
  }
  if (summaryNodeIds.size !== violationNodeIds.size) {
    fail('parallelAggregate.ownershipViolations', 'must contain exactly one summary for each ownership-violation node')
  }
}

function parseVerificationEvidence(value: unknown, index: number): VerificationEvidenceV1 {
  const parsed = parseScheduleFeedbackV1({
    schemaVersion: 1,
    requestId: 'parallel-aggregate-verification',
    outcome: 'failed',
    handoff: {
      schemaVersion: 1,
      status: 'failed',
      summary: '',
      changedFiles: [],
      decisions: [],
      verification: [value],
      blockers: [],
    },
  }).handoff!.verification[0]!
  if (parsed.args.length > MAX_VERIFICATION_ARGS) {
    fail(`parallelAggregate.verification[${index}].args`, `must not contain more than ${MAX_VERIFICATION_ARGS} items`)
  }
  for (const [argIndex, argument] of parsed.args.entries()) {
    if (utf8ByteLength(argument) > MAX_VERIFICATION_ARG_BYTES) {
      fail(`parallelAggregate.verification[${index}].args[${argIndex}]`, `must not exceed ${MAX_VERIFICATION_ARG_BYTES} UTF-8 bytes`)
    }
  }
  const metadata = {
    schemaVersion: parsed.schemaVersion,
    commandName: parsed.commandName,
    args: parsed.args,
    exitCode: parsed.exitCode,
    status: parsed.status,
    durationMs: parsed.durationMs,
  }
  assertSerializedPayloadLimit(metadata, MAX_AGGREGATE_VERIFICATION_METADATA_SERIALIZED_BYTES, `parallelAggregate.verification[${index}] metadata`)
  if (utf8ByteLength(parsed.stdout) + utf8ByteLength(parsed.stderr) > MAX_AGGREGATE_VERIFICATION_OUTPUT_BYTES) {
    fail(`parallelAggregate.verification[${index}]`, `output must not exceed ${MAX_AGGREGATE_VERIFICATION_OUTPUT_BYTES} UTF-8 bytes`)
  }
  return parsed
}

function parseProjectedHandoff(value: unknown): HandoffV1 {
  assertSerializedPayloadLimit(value, MAX_AGGREGATE_PROJECTED_HANDOFF_BYTES, 'parallelAggregate.projectedHandoff')
  return parseScheduleFeedbackV1({
    schemaVersion: 1,
    requestId: 'parallel-aggregate-projected-handoff',
    outcome: 'completed',
    handoff: value,
  }).handoff!
}

function assertVerificationGrammar(
  outcome: VerificationOutcomeV1,
  verification: readonly VerificationEvidenceV1[] | undefined,
  nodeResults: readonly ParallelNodeResultV1[],
  projectedHandoff: HandoffV1,
): void {
  const hasAcceptedNode = nodeResults.some(result => result.status === 'completed')
  if (outcome === 'not-run-no-commands') {
    if (verification !== undefined) fail('parallelAggregate.verification', 'must be omitted when no commands ran')
    return
  }
  if (outcome === 'not-run-no-accepted-nodes') {
    if (hasAcceptedNode) fail('parallelAggregate.verificationOutcome', 'requires no accepted node')
    if (verification !== undefined) fail('parallelAggregate.verification', 'must be omitted when no accepted node exists')
    return
  }
  if (!hasAcceptedNode) fail('parallelAggregate.verificationOutcome', 'requires an accepted node')
  if (outcome === 'passed') {
    if (verification === undefined || verification.length === 0 || verification.some(item => item.status !== 'passed')) {
      fail('parallelAggregate.verification', 'must contain one or more passing records for passed outcome')
    }
    return
  }
  if (outcome === 'command-failed') {
    if (verification === undefined || verification.length === 0) {
      fail('parallelAggregate.verification', 'must contain a terminal non-passing record for command-failed outcome')
    }
    const finalIndex = verification.length - 1
    if (verification.slice(0, finalIndex).some(item => item.status !== 'passed') || verification[finalIndex]!.status === 'passed') {
      fail('parallelAggregate.verification', 'must be a stop-on-first-failure sequence')
    }
    return
  }
  if (verification !== undefined && (verification.length === 0 || verification.some(item => item.status !== 'passed'))) {
    fail('parallelAggregate.verification', 'must contain only earlier passing records for admission-rejected outcome')
  }
  if (!projectedHandoff.blockers.includes(BUDGET_REJECTED_MARKER)) {
    fail('parallelAggregate.projectedHandoff.blockers', `must include ${BUDGET_REJECTED_MARKER}`)
  }
}

export function deriveAggregateStatus(
  results: readonly ParallelNodeResultV1[],
  verification: VerificationOutcomeV1,
): ParallelAggregateV1['aggregateStatus'] {
  if (results.some(result => result.status === 'failed')) return 'failed'
  if (results.some(result => result.status === 'ownership-violation' || result.status === 'blocked' || result.status === 'not-run')) return 'blocked'
  if (verification === 'admission-rejected') return 'failed'
  if (verification === 'command-failed') return 'verification-failed'
  if (verification === 'not-run-no-accepted-nodes' || results.length === 0) return 'blocked'
  return 'completed'
}

export function parseParallelAggregateV1(value: unknown): ParallelAggregateV1 {
  const snapshot = snapshotJsonValue(value, 'parallelAggregate')
  assertSerializedPayloadLimit(snapshot, MAX_AGGREGATE_PAYLOAD_BYTES, 'parallel aggregate')
  const aggregate = exactRecord(snapshot, 'parallelAggregate', [
    'schemaVersion', 'dagId', 'scope', 'fanoutId', 'levelId', 'levelIndex', 'nodeResults', 'aggregateStatus',
    'verificationOutcome', 'verification', 'ownershipViolations', 'projectedHandoff', 'projectedHandoffTruncated',
  ])
  if (aggregate.schemaVersion !== 1) fail('parallelAggregate.schemaVersion', 'must be 1')
  const scope = required(aggregate, 'scope', 'parallelAggregate')
  if (scope !== 'level' && scope !== 'dag') fail('parallelAggregate.scope', 'is unsupported')
  const dagId = boundedIdentifier(required(aggregate, 'dagId', 'parallelAggregate'), 'parallelAggregate.dagId')
  const fanoutId = boundedIdentifier(required(aggregate, 'fanoutId', 'parallelAggregate'), 'parallelAggregate.fanoutId')

  let levelFields: Pick<ParallelAggregateV1, 'levelId' | 'levelIndex'> = {}
  if (scope === 'level') {
    const levelId = boundedIdentifier(required(aggregate, 'levelId', 'parallelAggregate'), 'parallelAggregate.levelId')
    const levelIndex = boundedInteger(required(aggregate, 'levelIndex', 'parallelAggregate'), 'parallelAggregate.levelIndex', 0, MAX_DAG_LEVELS - 1)
    if (fanoutId !== levelId) fail('parallelAggregate.fanoutId', 'must equal levelId for level scope')
    levelFields = { levelId, levelIndex }
  } else {
    if (Object.prototype.hasOwnProperty.call(aggregate, 'levelId') || Object.prototype.hasOwnProperty.call(aggregate, 'levelIndex')) {
      fail('parallelAggregate', 'must omit levelId and levelIndex for dag scope')
    }
    if (fanoutId !== `${dagId}:aggregate`) fail('parallelAggregate.fanoutId', 'must equal dagId + :aggregate for dag scope')
  }

  const nodeResultsValue = required(aggregate, 'nodeResults', 'parallelAggregate')
  if (!Array.isArray(nodeResultsValue)) fail('parallelAggregate.nodeResults', 'must be an array')
  const maximumNodes = scope === 'level' ? MAX_PARALLEL_WORKERS : MAX_DAG_NODES
  if (nodeResultsValue.length > maximumNodes) fail('parallelAggregate.nodeResults', `must not contain more than ${maximumNodes} items`)
  const nodeResults = nodeResultsValue.map(parseNodeResult)
  assertUnique(nodeResults)

  const ownershipValue = required(aggregate, 'ownershipViolations', 'parallelAggregate')
  if (!Array.isArray(ownershipValue)) fail('parallelAggregate.ownershipViolations', 'must be an array')
  assertSerializedPayloadLimit(ownershipValue, MAX_AGGREGATE_VIOLATION_BYTES, 'parallelAggregate.ownershipViolations')
  const ownershipViolations = ownershipValue.map(parseOwnershipSummary)
  assertOwnershipSummaryBijection(nodeResults, ownershipViolations)

  const projectedHandoff = parseProjectedHandoff(required(aggregate, 'projectedHandoff', 'parallelAggregate'))
  const verificationOutcome = required(aggregate, 'verificationOutcome', 'parallelAggregate')
  if (verificationOutcome !== 'not-run-no-commands'
    && verificationOutcome !== 'not-run-no-accepted-nodes'
    && verificationOutcome !== 'passed'
    && verificationOutcome !== 'command-failed'
    && verificationOutcome !== 'admission-rejected') {
    fail('parallelAggregate.verificationOutcome', 'is unsupported')
  }

  let verification: readonly VerificationEvidenceV1[] | undefined
  if (Object.prototype.hasOwnProperty.call(aggregate, 'verification')) {
    if (!Array.isArray(aggregate.verification)) fail('parallelAggregate.verification', 'must be an array')
    if (aggregate.verification.length > MAX_VERIFICATION_COMMANDS) {
      fail('parallelAggregate.verification', `must not contain more than ${MAX_VERIFICATION_COMMANDS} items`)
    }
    assertSerializedPayloadLimit(aggregate.verification, MAX_AGGREGATE_VERIFICATION_TOTAL_BYTES, 'parallelAggregate.verification')
    verification = aggregate.verification.map(parseVerificationEvidence)
  }
  assertVerificationGrammar(verificationOutcome, verification, nodeResults, projectedHandoff)

  const aggregateStatus = required(aggregate, 'aggregateStatus', 'parallelAggregate')
  if (aggregateStatus !== 'completed' && aggregateStatus !== 'blocked' && aggregateStatus !== 'failed' && aggregateStatus !== 'verification-failed') {
    fail('parallelAggregate.aggregateStatus', 'is unsupported')
  }
  if (deriveAggregateStatus(nodeResults, verificationOutcome) !== aggregateStatus) {
    throw new TypeError('aggregateStatus is inconsistent')
  }

  let projectedHandoffTruncated: true | undefined
  if (Object.prototype.hasOwnProperty.call(aggregate, 'projectedHandoffTruncated')) {
    if (aggregate.projectedHandoffTruncated !== true) fail('parallelAggregate.projectedHandoffTruncated', 'must be true when present')
    projectedHandoffTruncated = true
  }

  const parsed: ParallelAggregateV1 = deepFreeze({
    schemaVersion: 1,
    dagId,
    scope,
    fanoutId,
    ...levelFields,
    nodeResults,
    aggregateStatus,
    verificationOutcome,
    ...(verification === undefined ? {} : { verification }),
    ownershipViolations,
    projectedHandoff,
    ...(projectedHandoffTruncated === undefined ? {} : { projectedHandoffTruncated }),
  })
  if (parsed.verification !== undefined) {
    assertSerializedPayloadLimit(parsed.verification, MAX_AGGREGATE_VERIFICATION_TOTAL_BYTES, 'parallelAggregate.verification')
  }
  assertSerializedPayloadLimit(parsed.ownershipViolations, MAX_AGGREGATE_VIOLATION_BYTES, 'parallelAggregate.ownershipViolations')
  assertSerializedPayloadLimit(parsed.projectedHandoff, MAX_AGGREGATE_PROJECTED_HANDOFF_BYTES, 'parallelAggregate.projectedHandoff')
  assertSerializedPayloadLimit(parsed, MAX_AGGREGATE_PAYLOAD_BYTES, 'parallel aggregate')
  return parsed
}
