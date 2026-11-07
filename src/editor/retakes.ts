/** Conservative lexical retake candidates. Analysis only: never mutates a project. */
import type {TranscriptMetadata} from '../../shared/integrations'
export interface RetakeLine extends TranscriptMetadata { start: number; end: number; text: string; words?: ({ start: number; end: number; word: string }&TranscriptMetadata)[] }
export interface RetakeTimingWarning { code:'long_internal_gap'|'implausible_word_duration'|'utterance_boundary'|'low_asr_confidence'; start:number; end:number; detail:string }
export interface RetakeAttempt { id: string; start: number; end: number; text: string; removalStartFrame: number; removalEndFrame: number; timingWarnings?:RetakeTimingWarning[] }
export interface RetakeCandidate { id: string; confidence: 'high' | 'review'; reason: string; attempts: RetakeAttempt[]; keep: RetakeAttempt; keepId: string; cut: { startFrame: number; endFrame: number }; repeatedWords: number }
type Word = { start: number; end: number; text: string; normalized: string }&TranscriptMetadata
const normalize = (s: string) => s.toLowerCase().replace(/’/g,"'").replace(/\bi'm\b/g,'i am').replace(/\b(name|it|that|there|he|she|what|who|here)'s\b/g,'$1 is').replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g,' ').trim()
const unfinished = /^(and|or|of|to|the|a|an|despite|because|but|selling|building|approaching|no|nope)$/

export function findRetakeCandidates(lines: RetakeLine[], opts: { fps?: number; minRepeatedWords?: number; padSeconds?: number; maxAttemptGapSeconds?: number } = {}): RetakeCandidate[] {
  const fps = opts.fps ?? 30, pad = opts.padSeconds ?? 0.12, min = Math.max(3, opts.minRepeatedWords ?? 3), maxGap = opts.maxAttemptGapSeconds ?? 30
  if (!Number.isFinite(fps) || fps <= 0) return []
  const words: Word[] = []
  for (const line of lines) {
    if (!(line.end > line.start) || !Number.isFinite(line.start) || !Number.isFinite(line.end)) continue
    const {utterance_id,probability,avg_logprob,no_speech_prob}=line
    const meta={utterance_id,probability,avg_logprob,no_speech_prob}
    const tokens = line.words?.length ? line.words.map(w => ({...meta,...w,start: w.start, end: w.end, text: w.word })) : line.text.trim().split(/\s+/).map((text, i, all) => ({...meta,start: line.start + (line.end - line.start) * i / all.length, end: line.start + (line.end - line.start) * (i + 1) / all.length, text }))
    for (const token of tokens) if (normalize(token.text) && token.end > token.start) words.push({ ...token, normalized: normalize(token.text) })
  }
  words.sort((a, b) => a.start - b.start)
  // Only phrase openings qualify. Internal repeated slogans and parallel
  // clauses ("every single day") are not evidence of a recording restart.
  const blocks: { first: number; last: number }[] = []
  for (let i = 0; i < words.length; i++) {
    if (!i || words[i].start - words[i - 1].end >= 1 || words[i].utterance_id!==undefined&&words[i-1].utterance_id!==undefined&&words[i].utterance_id!==words[i-1].utterance_id) blocks.push({ first: i, last: i })
    else blocks[blocks.length - 1].last = i
  }
  const anchors = new Map<string, { block: number; at: number; count: number }[]>()
  for (const [bi, block] of blocks.entries()) for (let at = block.first; at <= Math.min(block.last, block.first + 2); at++) {
    // Only skip disposable lead-ins, not distinct sentence subjects. Otherwise
    // "The lesson is ..." and "Our promise is ..." become false restarts.
    if (words.slice(block.first, at).some(w => !/^(hey|hello|hi|well|uh|um|so|and|but)$/.test(w.normalized))) continue
    for (let count = min; count <= 8 && at + count - 1 <= block.last; count++) {
      const key = words.slice(at, at + count).map(w => w.normalized).join(' ')
      const entries = anchors.get(key) ?? []
      if (!entries.some(e => e.block === bi)) entries.push({ block: bi, at, count })
      anchors.set(key, entries)
    }
  }
  const groups: { starts: number[]; repeated: number }[] = []
  for (const entries of anchors.values()) {
    let run: typeof entries = []
    const flush = () => { if (run.length >= 2) groups.push({ starts: run.map(e => blocks[e.block].first), repeated: run[0].count }); run = [] }
    for (const entry of entries) {
      if (run.length && words[blocks[entry.block].first].start - words[blocks[run[run.length - 1].block].first].start > maxGap) flush()
      run.push(entry)
    }
    flush()
  }
  groups.sort((a, b) => b.starts.length - a.starts.length || b.repeated - a.repeated)
  const accepted: { starts: number[]; repeated: number }[] = []
  for (const group of groups) {
    if (accepted.some(old => group.starts.some(s => old.starts.includes(s)))) continue
    accepted.push(group)
  }
  accepted.sort((a, b) => a.starts[0] - b.starts[0])
  return accepted.map((group, index): RetakeCandidate => {
    const id = `rt_${index}`
    const attempts = group.starts.map((first, ai): RetakeAttempt => {
      const next = group.starts[ai + 1]
      let last = next === undefined ? words.length - 1 : next - 1
      // Retain continuation through shorter thinking gaps, but stop at the
      // next long topic boundary rather than swallowing independent content.
      for (let i = first + 1; i <= last; i++) if (words[i].start - words[i - 1].end >= 3.5) { last = i - 1; break }
      // A stray article before a long pause belongs to the following topic.
      if (last > first && /^(the|a|an)$/.test(words[last].normalized) && last + 1 < words.length && words[last + 1].start - words[last].end >= 3.5) last--
      const start = words[first].start, end = words[last].end
      const span=words.slice(first,last+1),timingWarnings:RetakeTimingWarning[]=[]
      for(const [wi,word] of span.entries()){
        const duration=word.end-word.start
        if(duration>=1.8||duration>=1.2&&word.normalized.length<=5)timingWarnings.push({code:'implausible_word_duration',start:word.start,end:word.end,detail:`ASR assigns ${duration.toFixed(2)}s to ${JSON.stringify(word.text)}; word boundaries may include silence or another attempt.`})
        const previous=span[wi-1]
        if(word.probability!==undefined&&word.probability<0.5||word.avg_logprob!==undefined&&word.avg_logprob< -1||word.no_speech_prob!==undefined&&word.no_speech_prob>0.6)timingWarnings.push({code:'low_asr_confidence',start:word.start,end:word.end,detail:'Low local-ASR confidence; verify this wording before using it to decide which take is complete.'})
        if(previous&&previous.utterance_id!==undefined&&word.utterance_id!==undefined&&previous.utterance_id!==word.utterance_id&&!/[.!?]["']?$/.test(previous.text))timingWarnings.push({code:'utterance_boundary',start:previous.end,end:word.start,detail:'Apparent continuation crosses separately decoded utterances without a completed sentence boundary. Audio or semantic review must establish continuity.'})
        if(previous&&word.start-previous.end>=1.5&&!/[.!?]["']?$/.test(previous.text))timingWarnings.push({code:'long_internal_gap',start:previous.end,end:word.start,detail:'Apparent sentence continuation crosses a long hesitation without a completed sentence boundary; it may belong to a different take.'})
      }
      return { id: `${id}_a${ai}`, start, end, text: span.map(w => w.text).join(' '), removalStartFrame: Math.max(0, Math.floor((start - pad) * fps)), removalEndFrame: Math.ceil(end * fps),...(timingWarnings.length?{timingWarnings}:{}) }
    })
    const final = attempts[attempts.length - 1]
    const isComplete = (attempt: RetakeAttempt) => {
      const lastWord = normalize(attempt.text.split(/\s+/).at(-1) ?? '')
      return !unfinished.test(lastWord) && (/[.!?]["']?$/.test(attempt.text) || attempt.text.trim().split(/\s+/).length >= group.repeated + 6)
    }
    const finalWords = final.text.trim().split(/\s+/).length
    const complete = isComplete(final)
    const keep = [...attempts].reverse().find(isComplete) ?? final
    const earlierAborted = attempts.slice(0, -1).some(a => /\b(no|nope)[.!?]?$/i.test(a.text) || !/[.!?]["']?$/.test(a.text))
    const interveningTopic = attempts.slice(0, -1).some((a, i) => words.some(w => w.start >= a.end && w.start < attempts[i + 1].start))
    const uncertainContinuation=Boolean(keep.timingWarnings?.length)
    const confidence = complete && earlierAborted && !interveningTopic && !uncertainContinuation && (group.starts.length >= 3 || finalWords > attempts[0].text.split(/\s+/).length) ? 'high' : 'review'
    // The default removes EARLIER attempts only, preserving the final take
    // and every subsequent topic. Alternative removals have explicit bounds.
    return { id, confidence, reason: uncertainContinuation?'The apparent keeper has unreliable word timing or crosses an unresolved hesitation. Grammar assembled from ASR text does not prove a single complete take. Preserve this group until segmented transcription/audio review or explicit user evidence resolves it.':confidence === 'high' ? 'Repeated nearby phrase openings with earlier abandoned attempts; retain the final complete continuation.' : 'Repeated opening is plausible, but completeness or intentional repetition needs review.', attempts, keep, keepId: keep.id, cut: { startFrame: attempts[0].removalStartFrame, endFrame: Math.max(attempts[0].removalStartFrame, Math.floor((keep.start - pad) * fps)) }, repeatedWords: group.repeated }
  })
}
