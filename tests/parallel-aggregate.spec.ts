import { describe, expect, it } from 'vitest'
import {
  MAX_AGGREGATE_PAYLOAD_BYTES,
  MAX_AGGREGATE_PROJECTED_HANDOFF_BYTES,
  MAX_AGGREGATE_VERIFICATION_METADATA_SERIALIZED_BYTES,
  MAX_AGGREGATE_VERIFICATION_OUTPUT_BYTES,
  MAX_AGGREGATE_VERIFICATION_TOTAL_BYTES,
  MAX_AGGREGATE_VIOLATION_BYTES,
  assertSerializedPayloadLimit,
  deriveAggregateStatus,
  parseParallelAggregateV1,
  serializedPayloadBytes,
} from '../src/index.ts'

const WORKER_REF = `w:${'a'.repeat(32)}`
const textEncoder = new TextEncoder()

const passedEvidence = {
  schemaVersion: 1,
  commandName: 'typecheck',
  args: [],
  exitCode: 0,
  status: 'passed',
  stdout: '',
  stderr: '',
  truncated: false,
  durationMs: 10,
} as const

const failedEvidence = {
  ...passedEvidence,
  exitCode: 1,
  status: 'failed',
} as const

function projectedHandoff(
  status: 'completed' | 'blocked' | 'failed' = 'completed',
  blockers: readonly string[] = [],
) {
  return {
    schemaVersion: 1,
    status,
    summary: status === 'failed' ? '[verification: failed]' : 'Parallel work complete.',
    changedFiles: [],
    decisions: [],
    verification: [],
    blockers,
  }
}

function aggregate(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    dagId: 'root:dag:1',
    scope: 'dag',
    fanoutId: 'root:dag:1:aggregate',
    nodeResults: [{
      schemaVersion: 1,
      nodeId: 'a',
      requestId: 'root:dag:1:node:a',
      workerRef: WORKER_REF,
      status: 'completed',
      reason: 'completed',
    }],
    aggregateStatus: 'completed',
    verificationOutcome: 'not-run-no-commands',
    ownershipViolations: [],
    projectedHandoff: projectedHandoff(),
    ...overrides,
  }
}

function completed(nodeId: string, workerRef = WORKER_REF) {
  return {
    schemaVersion: 1,
    nodeId,
    requestId: `root:dag:1:node:${nodeId}`,
    workerRef,
    status: 'completed',
    reason: 'completed',
  } as const
}

function notRun(nodeId: string, reason = 'dependency-not-run') {
  return {
    schemaVersion: 1,
    nodeId,
    requestId: `root:dag:1:node:${nodeId}`,
    status: 'not-run',
    reason,
  } as const
}

function violated(nodeId: string, workerRef = WORKER_REF) {
  return {
    schemaVersion: 1,
    nodeId,
    requestId: `root:dag:1:node:${nodeId}`,
    workerRef,
    status: 'ownership-violation',
    reason: 'violation',
  } as const
}

function nativeSerializedBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength
}

interface VerificationMetadataInput {
  readonly schemaVersion: 1
  readonly commandName: string
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly status: 'passed' | 'failed' | 'timed-out' | 'spawn-error'
  readonly durationMs: number
}

function verificationMetadata(evidence: VerificationMetadataInput) {
  return {
    schemaVersion: evidence.schemaVersion,
    commandName: evidence.commandName,
    args: evidence.args,
    exitCode: evidence.exitCode,
    status: evidence.status,
    durationMs: evidence.durationMs,
  }
}

function evidenceWithMetadataBytes(target: number) {
  const args = Array.from({ length: 8 }, () => '')
  const evidence = { ...passedEvidence, commandName: 'm', args }
  let remaining = target - nativeSerializedBytes(verificationMetadata(evidence))

  for (let index = 0; index < args.length && remaining >= 2; index += 1) {
    const escapedBytes = Math.min(256, Math.floor(remaining / 2))
    args[index] = '\n'.repeat(escapedBytes)
    remaining -= escapedBytes * 2
  }
  if (remaining === 1) {
    const index = args.findIndex(argument => argument.length < 256)
    if (index < 0) throw new Error('metadata fixture has no one-byte capacity')
    args[index] += 'x'
    remaining -= 1
  }
  if (remaining !== 0 || nativeSerializedBytes(verificationMetadata(evidence)) !== target) {
    throw new Error(`could not construct ${target}-byte metadata fixture`)
  }
  return evidence
}

function verificationSectionWithBytes(target: number) {
  const verification = Array.from({ length: 4 }, (_, index) => ({
    ...passedEvidence,
    commandName: `check-${index}`,
    stdout: '',
  }))
  let remaining = target - nativeSerializedBytes(verification)

  for (const evidence of verification) {
    const escapedBytes = Math.min(MAX_AGGREGATE_VERIFICATION_OUTPUT_BYTES, Math.floor(remaining / 2))
    evidence.stdout = '\n'.repeat(escapedBytes)
    remaining -= escapedBytes * 2
  }
  if (remaining === 1) {
    const evidence = verification.find(item => item.stdout.length < MAX_AGGREGATE_VERIFICATION_OUTPUT_BYTES)
    if (evidence === undefined) throw new Error('verification fixture has no one-byte capacity')
    evidence.stdout += 'x'
    remaining -= 1
  }
  if (remaining !== 0 || nativeSerializedBytes(verification) !== target) {
    throw new Error(`could not construct ${target}-byte verification fixture`)
  }
  return verification
}

function ownershipSectionWithBytes(target: number) {
  const ownershipViolations = Array.from({ length: 16 }, (_, nodeIndex) => ({
    nodeId: `n${nodeIndex.toString().padStart(2, '0')}`,
    count: 128,
    digest: nodeIndex.toString(16).padStart(64, '0'),
    samplePaths: Array.from({ length: 16 }, (_, pathIndex) =>
      `n${nodeIndex.toString().padStart(2, '0')}/p${pathIndex.toString().padStart(2, '0')}`),
  }))
  let remaining = target - nativeSerializedBytes(ownershipViolations)

  for (const summary of ownershipViolations) {
    for (let index = 0; index < summary.samplePaths.length && remaining > 0; index += 1) {
      const capacity = 1_024 - textEncoder.encode(summary.samplePaths[index]!).byteLength
      const added = Math.min(capacity, remaining)
      summary.samplePaths[index] += 'x'.repeat(added)
      remaining -= added
    }
  }
  if (remaining !== 0 || nativeSerializedBytes(ownershipViolations) !== target) {
    throw new Error(`could not construct ${target}-byte ownership fixture`)
  }
  const nodeResults = ownershipViolations.map((summary, index) =>
    violated(summary.nodeId, `w:${index.toString(16).padStart(32, '0')}`))
  return { nodeResults, ownershipViolations }
}

function projectedHandoffWithBytes(target: number) {
  const handoff = {
    ...projectedHandoff(),
    summary: 'x'.repeat(16_384),
    decisions: [] as string[],
  }
  const remaining = target - nativeSerializedBytes(handoff)
  handoff.decisions.push('x'.repeat(remaining - 2))
  if (nativeSerializedBytes(handoff) !== target) throw new Error(`could not construct ${target}-byte Handoff fixture`)
  return handoff
}

describe('parseParallelAggregateV1', () => {
  it.each([
    [{ status: 'completed', reason: 'completed', workerRef: WORKER_REF }, 'completed', true],
    [{ status: 'blocked', reason: 'cancelled-after-start', workerRef: WORKER_REF }, 'blocked', true],
    [{ status: 'failed', reason: 'start-failed' }, 'failed', true],
    [{ status: 'not-run', reason: 'dependency-not-run' }, 'blocked', true],
    [{ status: 'completed', reason: 'completed' }, 'completed', false],
    [{ status: 'not-run', reason: 'dependency-not-run', workerRef: WORKER_REF }, 'blocked', false],
  ] as const)('enforces status/reason/workerRef %#', (fields, aggregateStatus, accepted) => {
    const parse = () => parseParallelAggregateV1(aggregate({
      nodeResults: [{ schemaVersion: 1, nodeId: 'a', requestId: 'root:dag:1:node:a', ...fields }],
      aggregateStatus,
      projectedHandoff: projectedHandoff(aggregateStatus),
    }))

    if (accepted) expect(parse()).toBeDefined()
    else expect(parse).toThrow()
  })

  it.each([
    ['not-run-no-commands', undefined, 'completed', []],
    ['passed', [passedEvidence], 'completed', []],
    ['command-failed', [passedEvidence, failedEvidence], 'verification-failed', []],
    ['admission-rejected', [passedEvidence], 'failed', ['[verification: budget-rejected]']],
  ] as const)('accepts canonical verification sequence %s', (verificationOutcome, verification, aggregateStatus, blockers) => {
    expect(parseParallelAggregateV1(aggregate({
      verificationOutcome,
      ...(verification === undefined ? {} : { verification }),
      aggregateStatus,
      projectedHandoff: projectedHandoff(aggregateStatus === 'verification-failed' ? 'failed' : aggregateStatus, blockers),
    }))).toBeDefined()
  })

  it('rejects evidence after the terminal non-passing command', () => {
    expect(() => parseParallelAggregateV1(aggregate({
      verificationOutcome: 'command-failed',
      verification: [failedEvidence, passedEvidence],
      aggregateStatus: 'verification-failed',
      projectedHandoff: projectedHandoff('failed'),
    }))).toThrow()
  })

  it('returns a detached deeply frozen projection', () => {
    const input = aggregate({ verificationOutcome: 'passed', verification: [passedEvidence] })
    const parsed = parseParallelAggregateV1(input)

    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    expect(parsed.nodeResults).not.toBe(input.nodeResults)
    expect(parsed.projectedHandoff).not.toBe(input.projectedHandoff)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.nodeResults)).toBe(true)
    expect(Object.isFrozen(parsed.nodeResults[0])).toBe(true)
    expect(Object.isFrozen(parsed.verification?.[0])).toBe(true)
    expect(Object.isFrozen(parsed.projectedHandoff)).toBe(true)
  })

  it.each([
    ['duplicate nodeId', [completed('a'), { ...completed('a'), requestId: 'root:dag:1:node:other', workerRef: `w:${'b'.repeat(32)}` }], /unique nodeId/u],
    ['duplicate requestId', [completed('a'), { ...completed('b'), requestId: 'root:dag:1:node:a', workerRef: `w:${'b'.repeat(32)}` }], /unique requestId/u],
    ['duplicate workerRef', [completed('a'), completed('b')], /unique workerRef/u],
  ])('rejects %s', (_label, nodeResults, message) => {
    expect(() => parseParallelAggregateV1(aggregate({ nodeResults }))).toThrow(message)
  })

  it('enforces the ownership-summary bijection and canonical summary shape', () => {
    expect(() => parseParallelAggregateV1(aggregate({
      nodeResults: [violated('a')],
      aggregateStatus: 'blocked',
      projectedHandoff: projectedHandoff('blocked'),
      ownershipViolations: [],
    }))).toThrow(/ownership/u)

    expect(parseParallelAggregateV1(aggregate({
      nodeResults: [violated('a')],
      aggregateStatus: 'blocked',
      projectedHandoff: projectedHandoff('blocked'),
      ownershipViolations: [{ nodeId: 'a', count: 1, digest: 'b'.repeat(64), samplePaths: ['src/a.ts'] }],
    }))).toBeDefined()

    expect(() => parseParallelAggregateV1(aggregate({
      ownershipViolations: [{ nodeId: 'a', count: 1, digest: 'B'.repeat(64), samplePaths: [] }],
    }))).toThrow(/ownership/u)
  })

  it('enforces scope-specific level fields and node limits', () => {
    expect(parseParallelAggregateV1(aggregate({
      scope: 'level',
      fanoutId: 'root:dag:1:level:0',
      levelId: 'root:dag:1:level:0',
      levelIndex: 0,
    }))).toBeDefined()
    expect(() => parseParallelAggregateV1(aggregate({ scope: 'level' }))).toThrow()
    expect(() => parseParallelAggregateV1(aggregate({ levelId: 'root:dag:1:level:0', levelIndex: 0 }))).toThrow()
    expect(() => parseParallelAggregateV1(aggregate({
      scope: 'level',
      fanoutId: 'root:dag:1:level:0',
      levelId: 'root:dag:1:level:0',
      levelIndex: 0,
      nodeResults: Array.from({ length: 9 }, (_, index) => completed(`n${index}`, `w:${index.toString(16).padStart(32, '0')}`)),
    }))).toThrow()
  })

  it('enforces the no-accepted-node and admission-rejection verification forms', () => {
    expect(parseParallelAggregateV1(aggregate({
      nodeResults: [notRun('a')],
      aggregateStatus: 'blocked',
      verificationOutcome: 'not-run-no-accepted-nodes',
      projectedHandoff: projectedHandoff('blocked'),
    }))).toBeDefined()
    expect(() => parseParallelAggregateV1(aggregate({
      verificationOutcome: 'not-run-no-accepted-nodes',
      aggregateStatus: 'blocked',
      projectedHandoff: projectedHandoff('blocked'),
    }))).toThrow()
    expect(() => parseParallelAggregateV1(aggregate({
      verificationOutcome: 'admission-rejected',
      aggregateStatus: 'failed',
      projectedHandoff: projectedHandoff('failed'),
    }))).toThrow(/budget-rejected/u)
    expect(() => parseParallelAggregateV1(aggregate({
      verificationOutcome: 'passed',
      verification: [],
    }))).toThrow()
  })

  it.each([
    ['argument count', Array.from({ length: 9 }, () => 'arg')],
    ['argument bytes', ['x'.repeat(257)]],
  ])('rejects aggregate verification evidence over the parallel %s bound', (_label, args) => {
    expect(() => parseParallelAggregateV1(aggregate({
      verificationOutcome: 'passed',
      verification: [{ ...passedEvidence, args }],
    }))).toThrow()
  })

  it('rejects unknown fields and malformed JSON values', () => {
    expect(() => parseParallelAggregateV1(aggregate({ extra: true }))).toThrow()
    expect(() => parseParallelAggregateV1(aggregate({ projectedHandoffTruncated: false }))).toThrow()
    expect(() => parseParallelAggregateV1(aggregate({ nodeResults: [completed('\ud800')] }))).toThrow()
  })

  it('rejects accessor-bearing evidence before a later value can exceed measured budgets', () => {
    const verification = Array.from({ length: 4 }, (_, index) => {
      let reads = 0
      return {
        ...passedEvidence,
        commandName: `check-${index}`,
        get stdout() {
          reads += 1
          return reads <= 4 ? '' : '\n'.repeat(MAX_AGGREGATE_VERIFICATION_OUTPUT_BYTES)
        },
      }
    })

    expect(() => parseParallelAggregateV1(aggregate({
      verificationOutcome: 'passed',
      verification,
    }))).toThrow(/accessor/u)
  })

  it('enforces the verification metadata exact and one-over serialized boundary with escaped content', () => {
    const exact = evidenceWithMetadataBytes(MAX_AGGREGATE_VERIFICATION_METADATA_SERIALIZED_BYTES)
    const over = evidenceWithMetadataBytes(MAX_AGGREGATE_VERIFICATION_METADATA_SERIALIZED_BYTES + 1)

    expect(nativeSerializedBytes(verificationMetadata(exact))).toBe(MAX_AGGREGATE_VERIFICATION_METADATA_SERIALIZED_BYTES)
    expect(parseParallelAggregateV1(aggregate({ verificationOutcome: 'passed', verification: [exact] }))).toBeDefined()
    expect(() => parseParallelAggregateV1(aggregate({ verificationOutcome: 'passed', verification: [over] }))).toThrow(/metadata/u)
  })

  it('enforces the per-command output exact and one-over UTF-8 byte boundary', () => {
    const exactOutput = `${'界'.repeat(2_730)}aa`
    const exact = { ...passedEvidence, stdout: exactOutput }
    const over = { ...passedEvidence, stdout: `${exactOutput}b` }

    expect(textEncoder.encode(exactOutput).byteLength).toBe(MAX_AGGREGATE_VERIFICATION_OUTPUT_BYTES)
    expect(parseParallelAggregateV1(aggregate({ verificationOutcome: 'passed', verification: [exact] }))).toBeDefined()
    expect(() => parseParallelAggregateV1(aggregate({ verificationOutcome: 'passed', verification: [over] }))).toThrow(/output/u)
  })

  it('enforces the total verification section exact and one-over serialized boundary with escaped output', () => {
    const exact = verificationSectionWithBytes(MAX_AGGREGATE_VERIFICATION_TOTAL_BYTES)
    const over = verificationSectionWithBytes(MAX_AGGREGATE_VERIFICATION_TOTAL_BYTES + 1)

    expect(nativeSerializedBytes(exact)).toBe(MAX_AGGREGATE_VERIFICATION_TOTAL_BYTES)
    expect(parseParallelAggregateV1(aggregate({ verificationOutcome: 'passed', verification: exact }))).toBeDefined()
    expect(() => parseParallelAggregateV1(aggregate({ verificationOutcome: 'passed', verification: over }))).toThrow(/verification/u)
  })

  it('enforces the ownership section exact and one-over serialized boundary', () => {
    const exact = ownershipSectionWithBytes(MAX_AGGREGATE_VIOLATION_BYTES)
    const over = ownershipSectionWithBytes(MAX_AGGREGATE_VIOLATION_BYTES + 1)

    expect(nativeSerializedBytes(exact.ownershipViolations)).toBe(MAX_AGGREGATE_VIOLATION_BYTES)
    expect(parseParallelAggregateV1(aggregate({
      ...exact,
      aggregateStatus: 'blocked',
      projectedHandoff: projectedHandoff('blocked'),
    }))).toBeDefined()
    expect(() => parseParallelAggregateV1(aggregate({
      ...over,
      aggregateStatus: 'blocked',
      projectedHandoff: projectedHandoff('blocked'),
    }))).toThrow(/ownershipViolations/u)
  })

  it('enforces the projected Handoff exact and one-over serialized boundary', () => {
    const exact = projectedHandoffWithBytes(MAX_AGGREGATE_PROJECTED_HANDOFF_BYTES)
    const over = projectedHandoffWithBytes(MAX_AGGREGATE_PROJECTED_HANDOFF_BYTES + 1)

    expect(nativeSerializedBytes(exact)).toBe(MAX_AGGREGATE_PROJECTED_HANDOFF_BYTES)
    expect(parseParallelAggregateV1(aggregate({ projectedHandoff: exact }))).toBeDefined()
    expect(() => parseParallelAggregateV1(aggregate({ projectedHandoff: over }))).toThrow(/projectedHandoff/u)
  })
})

describe('aggregate status and payload measurement', () => {
  it('measures serialized UTF-8 bytes at the exact aggregate boundary', () => {
    expect(serializedPayloadBytes('x'.repeat(131_070))).toBe(MAX_AGGREGATE_PAYLOAD_BYTES)
    expect(() => assertSerializedPayloadLimit('x'.repeat(131_070), MAX_AGGREGATE_PAYLOAD_BYTES, 'aggregate')).not.toThrow()
    expect(() => assertSerializedPayloadLimit('x'.repeat(131_071), MAX_AGGREGATE_PAYLOAD_BYTES, 'aggregate')).toThrow(/aggregate/u)
  })

  it('measures JSON escaping and multibyte UTF-8 rather than string length', () => {
    expect(serializedPayloadBytes('\n')).toBe(4)
    expect(serializedPayloadBytes('界')).toBe(5)
  })

  it('derives aggregate status in normative precedence order', () => {
    expect(deriveAggregateStatus([notRun('a', 'zero-worker-constraint')], 'not-run-no-accepted-nodes')).toBe('blocked')
    expect(deriveAggregateStatus([completed('a')], 'admission-rejected')).toBe('failed')
    expect(deriveAggregateStatus([completed('a')], 'command-failed')).toBe('verification-failed')
    expect(deriveAggregateStatus([completed('a')], 'not-run-no-commands')).toBe('completed')
    expect(deriveAggregateStatus([], 'not-run-no-commands')).toBe('blocked')
  })

  it('rejects an aggregate whose stored status is not derivable', () => {
    expect(() => parseParallelAggregateV1(aggregate({ aggregateStatus: 'blocked' }))).toThrow(/aggregateStatus is inconsistent/u)
  })
})
