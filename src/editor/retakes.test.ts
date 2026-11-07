import { describe, expect, it } from 'vitest'
import recording from './__fixtures__/retakes-synthetic-legacy.json'
import corrected from './__fixtures__/retakes-synthetic-segmented.json'
import { findRetakeCandidates, type RetakeLine } from './retakes'

describe('semantic retake candidates', () => {
  it('uses independent corrected utterances to retain the fifth complete gardening take at62s',()=>{
    const groups=findRetakeCandidates(corrected)
    expect(groups.map(g=>g.confidence)).toEqual(['high','high','high'])
    expect(groups[0].attempts).toHaveLength(3)
    expect(groups[1].attempts).toHaveLength(5)
    expect(groups[1].keep.start).toBe(62)
    expect(groups[1].keep.timingWarnings).toBeUndefined()
    expect(groups[1].attempts[3].text).toContain('sprouting')
  })
  it('requires review across independently decoded incomplete utterances or low-confidence keeper words',()=>{
    const base:RetakeLine[]=[{start:0,end:1,text:'I am a student'},{start:2,end:3,text:'I am a student'},{start:4,end:5,text:'I am a student',utterance_id:'a'},{start:5.2,end:7,text:'selling my own assets and looking for work.',utterance_id:'b'}]
    expect(findRetakeCandidates(base)[0].keep.timingWarnings?.some(w=>w.code==='utterance_boundary')).toBe(true)
    expect(findRetakeCandidates(base)[0].confidence).toBe('review')
    const low=base.map(l=>({...l,utterance_id:'same',probability:l.start===4?0.2:0.95}))
    expect(findRetakeCandidates(low)[0].keep.timingWarnings?.some(w=>w.code==='low_asr_confidence')).toBe(true)
  })
  it('finds three repeated-attempt clusters but flags the ASR-stitched gardening continuation for review', () => {
    const groups = findRetakeCandidates(recording)
    expect(groups).toHaveLength(3)
    expect(groups.map(g => g.attempts.map(a => a.start))).toEqual([[0.5, 5, 12], [40, 44, 50, 56], [74, 86, 96, 106]])
    expect(groups.map(g => g.keep.start)).toEqual([12, 56, 106])
    expect(groups.map(g => g.keep.end)).toEqual([15.6, 68, 117])
    expect(groups.map(g=>g.confidence)).toEqual(['high','review','high'])
    expect(groups[1].keep.timingWarnings).toEqual(expect.arrayContaining([expect.objectContaining({code:'long_internal_gap',start:59.5,end:62}),expect.objectContaining({code:'implausible_word_duration',start:57.2,end:59.5})]))
    expect(groups[1].reason).toContain('segmented transcription/audio review')
    expect(groups[2].keep.text.match(/once a week/gi)).toHaveLength(2)
    // The next topic's orphaned "The" and all independent topic blocks remain.
    expect(groups[0].keep.text).not.toMatch(/The$/)
    for (const g of groups) expect(g.cut.endFrame).toBeLessThan(g.keep.start * 30)
    expect(groups[1].keep.text).toContain('own flower beds')
  })

  it('does not infer take continuity from a plausible grammatical suffix across stretched ASR words',()=>{
    const lines:RetakeLine[]=[{start:0,end:0.5,text:'I am a student'},{start:2,end:2.5,text:'I am a student'},{start:5,end:5.5,text:'I am a student'},{start:5.5,end:7.8,text:'selling'},{start:10.3,end:11.8,text:'my'},{start:11.8,end:13,text:'own assets and looking for work.'}]
    const [group]=findRetakeCandidates(lines)
    expect(group.confidence).toBe('review')
    expect(group.keep.text).toContain('own assets')
    expect(group.keep.timingWarnings?.some(w=>w.code==='long_internal_gap')).toBe(true)
    // Analysis preserves all unique continuation material; it never makes cuts.
    expect(lines.at(-1)?.text).toBe('own assets and looking for work.')
  })

  it('does not remove intentional internal repetition or separate repeated slogans', () => {
    const lines: RetakeLine[] = [
      { start: 0, end: 8, text: 'I commit to posting every single day and working towards the goal every single day.' },
      { start: 20, end: 24, text: 'The lesson is practice every single day.' },
      { start: 40, end: 44, text: 'Our promise is practice every single day.' },
    ]
    expect(findRetakeCandidates(lines)).toEqual([])
  })

  it('flags repeated complete sentences for review rather than automatic deletion', () => {
    const lines = [{ start: 0, end: 2, text: 'We can do this.' }, { start: 4, end: 6, text: 'We can do this.' }, { start: 8, end: 10, text: 'We can do this.' }]
    const [candidate] = findRetakeCandidates(lines)
    expect(candidate.confidence).toBe('review')
  })

  it('requires review when a broad restart cut would swallow an independent topic', () => {
    const lines = [
      { start: 0, end: 2, text: 'My goal is to' },
      { start: 6, end: 9, text: 'An independent explanation must survive.' },
      { start: 12, end: 14, text: 'My goal is to' },
      { start: 20, end: 24, text: 'My goal is to finish the useful project.' },
    ]
    expect(findRetakeCandidates(lines)[0].confidence).toBe('review')
  })

  it('does not label a final self-rejected attempt complete', () => {
    const lines = [{ start: 0, end: 3, text: 'My goal is to build something' }, { start: 5, end: 8, text: 'My goal is to build this no.' }]
    expect(findRetakeCandidates(lines)[0].confidence).toBe('review')
    const completeThenAbort = [{ start: 0, end: 3, text: 'My goal is to build something.' }, { start: 5, end: 8, text: 'My goal is to build this no.' }]
    expect(findRetakeCandidates(completeThenAbort)[0].keep.start).toBe(0)
  })

  it('respects non30fps frame bounds and returns stable IDs without mutating input', () => {
    const before = structuredClone(recording)
    const first = findRetakeCandidates(recording, { fps: 60 })
    expect(first[0].cut).toEqual({ startFrame: 22, endFrame: 712 })
    expect(first).toEqual(findRetakeCandidates(recording, { fps: 60 }))
    expect(recording).toEqual(before)
    expect(findRetakeCandidates([])).toEqual([])
  })
})
