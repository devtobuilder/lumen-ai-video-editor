import { readFileSync } from 'node:fs'
import { parse, type Font } from 'opentype.js'
import { describe, expect, it } from 'vitest'
import { Box3, Euler, Vector3 } from 'three'
import { fitTextLines, safeTextWidth,stableTextWidth } from './text-layout'
import { fitProjectedText } from './three/text-fit'

const bytes = readFileSync(new URL('../../node_modules/@fontsource/geist/files/geist-latin-800-normal.woff', import.meta.url))
const font = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as Font
function measureFont(size: number, tracking = 0) {
  return (text: string) => {
    let width = 0
    let last: ReturnType<Font['charToGlyph']> | null = null
    for (const ch of text) {
      const glyph = font.charToGlyph(ch)
      if (last) width += font.getKerningValue(last, glyph) * size / font.unitsPerEm
      width += (glyph.advanceWidth ?? font.unitsPerEm / 2) * size / font.unitsPerEm + tracking * size
      last = glyph
    }
    return Math.max(0, width - (text.length ? tracking * size : 0))
  }
}

describe('native caption horizontal fitting', () => {
  it('keeps paragraph lines and base box stable during entrance zoom/pop and animated position changes',()=>{
    const content="LET'S BUILD THIS TOGETHER",measure=measureFont(59),base={x:0,scale:1}
    const correct=fitTextLines(content,measure,stableTextWidth(1080,base),59*0.12)
    expect(correct.lines).toHaveLength(1)
    // The old per-frame width changes this same caption to two lines at entry.
    expect(fitTextLines(content,measure,safeTextWidth(1080,-180,1.3),59*0.12).lines).toHaveLength(2)
    for(const animatedScale of [1.3,1.1,1,0.55]){
      const current=fitTextLines(content,measure,stableTextWidth(1080,base),59*0.12)
      expect(current.lines).toEqual(correct.lines)
      expect(current.width/animatedScale*animatedScale).toBeCloseTo(correct.width)
    }
    expect(stableTextWidth(1080,{x:0,scale:1.3})).toBeLessThan(stableTextWidth(1080,base))
  })
  it('fits a real long, bold outlined caption inside a vertical 1080 canvas', () => {
    const text = 'PRODUCTS, TECHNOLOGIES, AND OUR WAY OF LIFE'
    const size = 116
    const measure = measureFont(size, -0.02)
    const margin = Math.max(size * 0.12, size * 0.08)
    expect(measure(text)).toBeGreaterThan(1080)
    const fit = fitTextLines(text, measure, safeTextWidth(1080), margin)
    expect(fit.lines).toHaveLength(2)
    expect(fit.lines.join(' ')).toBe(text)
    expect(fit.scale).toBeGreaterThan(0)
    expect(fit.scale).toBeLessThanOrEqual(1)
    for (const line of fit.lines) expect((measure(line) + margin * 2) * fit.scale).toBeLessThanOrEqual(972.00001)
  })

  it('keeps an already fitting caption at its requested size and respects explicit lines', () => {
    const measure = measureFont(64)
    const fit = fitTextLines('HELLO ROBIN\nWELCOME', measure, safeTextWidth(1080), 64 * 0.12)
    expect(fit.lines).toEqual(['HELLO ROBIN', 'WELCOME'])
    expect(fit.scale).toBe(1)
  })

  it('shrinks an unbreakable token and accounts for an oversized outline or background', () => {
    const text = 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS'
    const measure = measureFont(160, 0.1)
    const fit = fitTextLines(text, measure, safeTextWidth(1080), 80)
    expect(fit.lines).toEqual([text])
    expect(fit.scale).toBeLessThan(1)
    expect((measure(text) + 160) * fit.scale).toBeCloseTo(972)
  })

  it('uses the same line breaks and fitting in preview and full-size export', () => {
    const text = 'PRODUCTS, TECHNOLOGIES, AND OUR WAY OF LIFE'
    const full = fitTextLines(text, measureFont(116, -0.02), safeTextWidth(1080), 116 * 0.12)
    const preview = fitTextLines(text, measureFont(58, -0.02), safeTextWidth(540), 58 * 0.12)
    expect(preview.lines).toEqual(full.lines)
    expect(preview.scale).toBeCloseTo(full.scale, 10)
    expect(preview.width * 2).toBeCloseTo(full.width, 8)
  })

  it('includes clip scaling and preserves a lower-third position inside the safe edges', () => {
    const scale = 1.25
    const offset = -216
    const measure = measureFont(116)
    const fit = fitTextLines('PRODUCTS, TECHNOLOGIES, AND OUR WAY OF LIFE', measure, safeTextWidth(1080, offset, scale), 116 * 0.12)
    const renderedWidth = fit.width * scale
    const center = 540 + offset
    expect(center - renderedWidth / 2).toBeGreaterThanOrEqual(54 - 1e-6)
    expect(center + renderedWidth / 2).toBeLessThanOrEqual(1026 + 1e-6)
  })
})

describe('extruded native title fitting', () => {
  it('keeps a long rotated extruded title inside horizontal margins under perspective', () => {
    const box = new Box3(new Vector3(-1800, -100, -30), new Vector3(1800, 100, 30))
    const p = Object.freeze({ x: 80, z: 500, scale: 1.2, rotation: 12, rotateX: 15, rotateY: 30 })
    const distance = 2600
    const fit = fitProjectedText(box, 1080, distance, p)
    expect(fit).toBeGreaterThan(0)
    expect(fit).toBeLessThan(1)
    const rotation = new Euler(-p.rotateX * Math.PI / 180, p.rotateY * Math.PI / 180, -p.rotation * Math.PI / 180, 'YXZ')
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const v = new Vector3(x, y, z).applyEuler(rotation).multiplyScalar(p.scale * fit)
      const screenX = 540 + (p.x + v.x) * distance / (distance - p.z - v.z)
      expect(screenX).toBeGreaterThanOrEqual(54 - 1e-6)
      expect(screenX).toBeLessThanOrEqual(1026 + 1e-6)
    }
  })

  it('does not enlarge or move an already fitting title', () => {
    const box = new Box3(new Vector3(-100, -20, -5), new Vector3(100, 20, 5))
    const p = Object.freeze({ x: 0, z: 0, scale: 1, rotation: 0, rotateX: 0, rotateY: 0 })
    expect(fitProjectedText(box, 1080, 2600, p)).toBe(1)
  })
})
