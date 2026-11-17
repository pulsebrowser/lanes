/** The `Verified:` commit line (0.6.1): read by verified-guard.mjs (the gate) and lane-report.mjs (the counts). */

// The line at a line start, after a quote, or after an escaped newline (`printf '...\n...'`); its value ends at the
// end of the line, a quote or an escaped newline.
const LINE = /(?:^|[\n"']|\\n)[ \t]*Verified:[ \t]*((?:(?!\\n)[^\n"'])*)/g

/** Split on commas outside brackets. */
function items(value) {
  const out = []
  let depth = 0
  let cur = ''
  for (const c of value) {
    if (c === '(') depth++
    if (c === ')' && depth > 0) depth--
    if (c === ',' && depth === 0) { out.push(cur); cur = '' } else cur += c
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * The Verified line of a message: { kinds } when it is usable, { error } when not. With several lines, the last one.
 * lane-report.mjs reads commits with the same rule.
 */
export function parseVerified(message, kinds) {
  const found = [...String(message).matchAll(LINE)]
  if (!found.length) return { error: 'no Verified: line' }
  const value = found[found.length - 1][1].trim()
  const parts = items(value)
  if (!parts.length) return { error: 'the Verified: line is empty' }
  const seen = []
  for (const p of parts) {
    const m = /^([a-z][\w-]*)\s*(.*)$/i.exec(p)
    const kind = m?.[1].toLowerCase()
    if (!kind || !kinds.includes(kind)) return { error: `"${p.slice(0, 40)}" is not one of: ${kinds.join(', ')}` }
    if (kind === 'none' && !m[2].replace(/[()\s:.,-]/g, '')) return { error: '"none" needs its reason, for example: Verified: none (docs only)' }
    if (!seen.includes(kind)) seen.push(kind)
  }
  if (seen.includes('none') && seen.length > 1) return { error: '"none" cannot go with another kind' }
  return { kinds: seen }
}
