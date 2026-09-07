import type { ParallelVerificationPolicyV1 } from './types.js'
import { MAX_SCHEDULING_IDENTIFIER_BYTES } from './parse.js'
import { utf8ByteLength } from './parallel-paths.js'

export const MAX_VERIFICATION_COMMANDS = 4
export const MAX_VERIFICATION_ARGS = 8
export const MAX_VERIFICATION_ARG_BYTES = 256

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
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty identifier')
  if (value.includes('\0')) fail(path, 'must not contain a NUL byte')
  if (utf8ByteLength(value) > MAX_SCHEDULING_IDENTIFIER_BYTES) fail(path, `must not exceed ${MAX_SCHEDULING_IDENTIFIER_BYTES} UTF-8 bytes`)
  return value
}

function boundedArgument(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (value.includes('\0')) fail(path, 'must not contain a NUL byte')
  if (utf8ByteLength(value) > MAX_VERIFICATION_ARG_BYTES) fail(path, `must not exceed ${MAX_VERIFICATION_ARG_BYTES} UTF-8 bytes`)
  return value
}

function parseCommand(value: unknown, index: number): ParallelVerificationPolicyV1['commands'][number] {
  const path = `parallel.verification.commands[${index}]`
  const command = exactRecord(value, path, ['name', 'args'])
  const args = required(command, 'args', path)
  if (!Array.isArray(args)) fail(`${path}.args`, 'must be an array')
  if (args.length > MAX_VERIFICATION_ARGS) fail(`${path}.args`, `must not contain more than ${MAX_VERIFICATION_ARGS} items`)
  return {
    name: boundedIdentifier(required(command, 'name', path), `${path}.name`),
    args: args.map((arg, argIndex) => boundedArgument(arg, `${path}.args[${argIndex}]`)),
  }
}

export function parseParallelVerificationPolicyV1(value: unknown): ParallelVerificationPolicyV1 {
  assertJsonValue(value, 'parallel.verification')
  const policy = exactRecord(value, 'parallel.verification', ['schemaVersion', 'scope', 'commands'])
  if (policy.schemaVersion !== 1 || (policy.scope !== 'level' && policy.scope !== 'dag')) fail('parallel.verification', 'is invalid')
  const commands = required(policy, 'commands', 'parallel.verification')
  if (!Array.isArray(commands)) fail('parallel.verification.commands', 'must be an array')
  if (commands.length > MAX_VERIFICATION_COMMANDS) fail('parallel.verification.commands', `must not contain more than ${MAX_VERIFICATION_COMMANDS} items`)
  return deepFreeze({
    schemaVersion: 1,
    scope: policy.scope,
    commands: commands.map(parseCommand),
  })
}
