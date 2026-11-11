// Shared test setup (node:test). Every hook test runs against tests/fixtures/brain.json (owner Ada) unless it
// passes its own BRAIN_CONFIG, so a developer's own .claude/brain.json never changes a result.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.CLAUDE_PROJECT_DIR = ROOT
process.env.BRAIN_CONFIG = path.join(ROOT, 'tests', 'fixtures', 'brain.json')
delete process.env.CLAUDE_CODE_HOST_SESSION_ID
delete process.env.LANE_REGISTRY

/** The two matchers the tests use, in the shape they were first written in (vitest). */
export const expect = (value) => ({
  toBe: (want) => assert.equal(value, want),
  toContain: (part) => assert.ok(String(value).includes(part), `expected to contain ${JSON.stringify(part)}:\n${value}`),
  not: { toContain: (part) => assert.ok(!String(value).includes(part), `expected not to contain ${JSON.stringify(part)}`) },
})
