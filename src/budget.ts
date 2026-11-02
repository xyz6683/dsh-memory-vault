/** Token / character budget estimation for recall context injection. */

/**
 * Conservative CJK-aware token estimation: CJK characters count ~1.5
 * tokens each, everything else ~1 token per 4 characters.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const character of text) {
    if (/[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(character)) {
      cjk++
    } else {
      other++
    }
  }
  return cjk * 1.5 + other / 4
}

/** Clip text to at most `maxTokens` estimated tokens. */
export function clipTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false }
  let end = text.length
  while (end > 0 && estimateTokens(text.slice(0, end)) > maxTokens) {
    end = Math.max(0, Math.floor((end * 3) / 4))
  }
  if (end === 0) return { text: '', truncated: true }
  return { text: `${text.slice(0, end)}…`, truncated: true }
}

/** Clip text to at most `maxChars` characters. */
export function clipChars(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, Math.max(0, maxChars - 1))}…`
}
