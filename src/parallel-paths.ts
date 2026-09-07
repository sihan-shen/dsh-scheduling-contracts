export const MAX_PARALLEL_WORKERS = 8
export const MAX_DAG_NODES = 16
export const MAX_DAG_LEVELS = 4
export const MAX_DAG_PATHS = 32
export const MAX_DAG_DEPS = 8
export const MAX_DAG_CHANGED_FILES = 16
export const MAX_AGGREGATE_PATH_BYTES = 1_024
export const MAX_DAG_ID_ORDINAL = 999
export const MAX_PARALLEL_WORKER_REF_BYTES = 34
export const MAX_PARALLEL_WORKER_TASK_BYTES = 16_384
export const MAX_PARALLEL_WORKER_ROUTE_FIELD_BYTES = 256
export const MAX_PARALLEL_WORKER_TOOL_COUNT = 16
export const MAX_PARALLEL_WORKER_TOOL_BYTES = 256

export type RepoFilePath = string & { readonly __repoFilePath: unique symbol }
export type RepoDirectoryPrefix = string & { readonly __repoDirectoryPrefix: unique symbol }
export type RepoPathDeclaration = RepoFilePath | RepoDirectoryPrefix

const NODE_ID_PATTERN = /^[^\u0000-\u001F\u007F\u003A\u0022\u005C]+$/u
const GLOB_PATTERN = /[*?\[\]{}]/u
const textEncoder = new TextEncoder()

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}

export function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false
      index += 1
    } else if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false
    }
  }
  return true
}

export function parseNodeId(value: unknown, path = 'nodeId'): string {
  if (typeof value !== 'string' || value.length === 0 || !isWellFormedUnicode(value) || !NODE_ID_PATTERN.test(value)) {
    throw new TypeError(`${path} does not match the nodeId grammar`)
  }
  if (utf8ByteLength(value) > 32) throw new TypeError(`${path} must not exceed 32 UTF-8 bytes`)
  return value
}

export function parseRepoPathDeclaration(value: unknown, path = 'path'): RepoPathDeclaration {
  if (typeof value !== 'string' || value.length === 0 || !isWellFormedUnicode(value)) {
    throw new TypeError(`${path} does not match the repository path grammar`)
  }
  if (
    value.startsWith('/')
    || /^[A-Za-z]:/u.test(value)
    || value.includes('\\')
    || GLOB_PATTERN.test(value)
    || /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new TypeError(`${path} does not match the repository path grammar`)
  }

  const directory = value.endsWith('/')
  const segments = (directory ? value.slice(0, -1) : value).split('/')
  if (segments.length === 0 || segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new TypeError(`${path} does not match the repository path grammar`)
  }
  if (utf8ByteLength(value) > MAX_AGGREGATE_PATH_BYTES) {
    throw new TypeError(`${path} must not exceed ${MAX_AGGREGATE_PATH_BYTES} UTF-8 bytes`)
  }
  return value as RepoPathDeclaration
}

export function parseRepoFilePath(value: unknown, path = 'path'): RepoFilePath {
  const parsed = parseRepoPathDeclaration(value, path)
  if (parsed.endsWith('/')) throw new TypeError(`${path} must name a file`)
  return parsed as RepoFilePath
}

export function repoPathContains(owner: RepoPathDeclaration, file: RepoFilePath): boolean {
  return owner.endsWith('/') ? file.startsWith(owner) : owner === file
}
