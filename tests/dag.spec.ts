import { describe, expect, it } from 'vitest'
import {
  MAX_DAG_DEPS,
  MAX_DAG_NODES,
  MAX_DAG_PATHS,
  TASK_DAG_V1_JSON_SCHEMA,
  parseTaskDagV1,
} from '../src/index.ts'

const profile = {
  coding: 50,
  reasoning: 50,
  toolUse: 50,
  repoContext: 50,
  risk: 50,
  difficulty: 50,
} as const

const constraints = {
  maxWorkers: 1,
  maxOutputTokens: 32_000,
  maxLatencyMs: 60_000,
  allowPaidFallback: false,
  requiredTools: [],
} as const

function node(nodeId: string, dependsOn: readonly string[] = []) {
  return {
    schemaVersion: 1,
    nodeId,
    objective: `Work on ${nodeId}.`,
    profile,
    constraints,
    readPaths: ['src/'],
    writePaths: [`src/${nodeId}.ts`],
    dependsOn,
  }
}

describe('parseTaskDagV1', () => {
  it('returns a detached deeply frozen DAG while leaving semantic defects for validation', () => {
    const input = { schemaVersion: 1, rootTaskId: 'root-1', nodes: [node('a', ['missing']), node('a')] }
    const parsed = parseTaskDagV1(input)

    expect(parsed.nodes.map(item => item.nodeId)).toEqual(['a', 'a'])
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.nodes)).toBe(true)
    expect(Object.isFrozen(parsed.nodes[0]?.profile)).toBe(true)
    expect(Object.isFrozen(parsed.nodes[0]?.constraints)).toBe(true)
    expect(Object.isFrozen(parsed.nodes[0]?.writePaths)).toBe(true)
    expect(parsed.nodes[0]).not.toBe(input.nodes[0])
    expect(parsed.nodes[0]?.writePaths).not.toBe(input.nodes[0]?.writePaths)

    input.nodes[0]!.writePaths.push('mutated.ts')
    expect(parsed.nodes[0]?.writePaths).toEqual(['src/a.ts'])
  })

  it('rejects a malformed Unicode rootTaskId', () => {
    expect(() => parseTaskDagV1({ schemaVersion: 1, rootTaskId: '\ud800', nodes: [node('a')] })).toThrow()
  })

  it.each([
    { schemaVersion: 1, rootTaskId: 'root-1', nodes: [], label: 'empty DAG' },
    { schemaVersion: 1, rootTaskId: 'root-1', nodes: [node('a')], extra: true, label: 'unknown key' },
    { schemaVersion: 1, rootTaskId: 'root-1', nodes: [{ ...node('a'), objective: 'x'.repeat(4097) }], label: 'objective bytes' },
    { schemaVersion: 1, rootTaskId: 'root-1', nodes: [{ ...node('a'), dependsOn: Array.from({ length: MAX_DAG_DEPS + 1 }, (_, i) => `n${i}`) }], label: 'dependency count' },
    { schemaVersion: 1, rootTaskId: 'root-1', nodes: [{ ...node('a'), readPaths: Array.from({ length: MAX_DAG_PATHS + 1 }, (_, i) => `r/${i}.ts`) }], label: 'path count' },
    { schemaVersion: 1, rootTaskId: 'root-1', nodes: Array.from({ length: MAX_DAG_NODES + 1 }, (_, i) => node(`n${i}`)), label: 'node count' },
  ])('rejects structural violation $label', ({ label: _label, ...value }) => expect(() => parseTaskDagV1(value)).toThrow())

  it('exports a closed, deeply frozen literal schema', () => {
    expect(TASK_DAG_V1_JSON_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false })
    expect(Object.isFrozen(TASK_DAG_V1_JSON_SCHEMA)).toBe(true)
    expect(Object.isFrozen(TASK_DAG_V1_JSON_SCHEMA.properties?.nodes)).toBe(true)
  })
})
