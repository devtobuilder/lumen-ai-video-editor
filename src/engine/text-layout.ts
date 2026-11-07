/** Render-only text fitting. Stored text, font size and placement stay editable. */
export function safeTextWidth(canvasWidth: number, offsetX = 0, scale = 1): number {
  const half = canvasWidth * 0.45
  // An intentionally offscreen title should keep its position, not collapse.
  const available = Math.abs(offsetX) < half ? (half - Math.abs(offsetX)) * 2 : half * 2
  return Math.max(1, available / Math.max(0.001, Math.abs(scale)))
}

/** Layout is based on stored geometry. Animation/keyframes transform the
 * finished box; they must never re-wrap its paragraphs from frame to frame. */
export function stableTextWidth(canvasWidth:number,base:{x:number;scale:number}):number {
  return safeTextWidth(canvasWidth,base.x,base.scale)
}

/** Wrap an overflowing paragraph into two balanced lines, then shrink only if
 * that still exceeds the available width. Explicit line breaks are preserved.
 * `measure` must include the actual font, weight and letter spacing.
 */
export function fitTextLines(content: string, measure: (line: string) => number, maxWidth: number, padding = 0) {
  const available = Math.max(1, maxWidth - padding * 2)
  const lines = content.split('\n').flatMap(line => {
    if (measure(line) <= available) return [line]
    const words = line.trim().split(/\s+/)
    if (words.length < 2) return [line]
    let best = [line]
    let widest = Infinity
    for (let i = 1; i < words.length; i++) {
      const candidate = [words.slice(0, i).join(' '), words.slice(i).join(' ')]
      const width = Math.max(...candidate.map(measure))
      if (width < widest) { widest = width; best = candidate }
    }
    return best
  })
  const widths = lines.map(measure)
  const width = Math.max(1, ...widths) + padding * 2
  const scale = Math.min(1, Math.max(1, maxWidth) / width)
  return { lines, widths, scale, width: width * scale }
}
