import { describe, expect, it } from 'vitest'
import {
  parseNodeId,
  parseRepoFilePath,
  parseRepoPathDeclaration,
  repoPathContains,
} from '../src/index.ts'

describe('parallel repository path and identifier grammar', () => {
  it.each([
    ['src/a.ts', 'src/a.ts', true],
    ['src/', 'src/a.ts', true],
    ['src/a.ts', 'src/a.tsx', false],
    ['src/', 'source/a.ts', false],
  ])('applies lexical case-sensitive containment %s -> %s', (owner, file, expected) => {
    expect(repoPathContains(parseRepoPathDeclaration(owner), parseRepoFilePath(file))).toBe(expected)
  })

  it.each(['', '/abs.ts', 'C:/abs.ts', '\\\\server\\file', 'a\\b.ts', 'a/./b.ts', 'a/../b.ts', 'a//b.ts', 'a/*.ts', 'a/'])
    ('rejects invalid RepoFilePath %j', value => expect(() => parseRepoFilePath(value)).toThrow())

  it('accepts 1024 UTF-8 bytes and rejects 1025', () => {
    expect(parseRepoFilePath(`a/${'x'.repeat(1022)}`)).toHaveLength(1024)
    expect(() => parseRepoFilePath(`a/${'x'.repeat(1023)}`)).toThrow(/1024 UTF-8 bytes/u)
  })

  it.each(['bad:id', 'bad"id', 'bad\\id', 'bad\u0000id', 'bad\u007fid', '\ud800'])
    ('rejects the exact forbidden nodeId code points in %j', value => expect(() => parseNodeId(value)).toThrow())
  it('accepts allowed punctuation and the 32-byte nodeId boundary', () => {
    expect(parseNodeId('a_b-c.d!')).toBe('a_b-c.d!')
    expect(parseNodeId('n'.repeat(32))).toBe('n'.repeat(32))
    expect(() => parseNodeId('n'.repeat(33))).toThrow(/32 UTF-8 bytes/u)
  })
})
