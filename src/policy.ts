import type { PermissionPolicy } from './schema.ts'

/**
 * Pattern format: `<ToolName>` or `<ToolName>(<arg-substring>)`.
 * Match logic:
 *   - tool name must equal the pattern's tool name (case-sensitive)
 *   - if the pattern has parens, the arg-substring must appear anywhere in
 *     the JSON-stringified tool_input
 *
 * Future: support glob/regex via a leading sigil (e.g. "Bash(re:^rm)").
 */
export function matchesPattern(pattern: string, toolName: string, toolInput: unknown): boolean {
  const parenIdx = pattern.indexOf('(')
  if (parenIdx === -1) {
    return pattern === toolName
  }
  const patternTool = pattern.slice(0, parenIdx)
  if (patternTool !== toolName) return false
  if (!pattern.endsWith(')')) return false
  const argSubstring = pattern.slice(parenIdx + 1, -1)
  if (argSubstring.length === 0) return true
  let serialized: string
  try {
    serialized = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput)
  } catch {
    return false
  }
  return serialized.includes(argSubstring)
}

export type PolicyDecision =
  | { kind: 'blocked'; pattern: string }
  | { kind: 'force_human'; pattern: string }
  | { kind: 'pass' }

export function evaluatePolicy(
  policy: PermissionPolicy,
  toolName: string,
  toolInput: unknown,
): PolicyDecision {
  for (const pattern of policy.blocked_outright) {
    if (matchesPattern(pattern, toolName, toolInput)) {
      return { kind: 'blocked', pattern }
    }
  }
  for (const pattern of policy.always_require_human) {
    if (matchesPattern(pattern, toolName, toolInput)) {
      return { kind: 'force_human', pattern }
    }
  }
  return { kind: 'pass' }
}
