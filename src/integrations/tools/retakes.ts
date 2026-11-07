/** Transcript candidates are evidence, never authority to delete footage. */
import { findRetakeCandidates } from '@/editor/retakes'
import { clipEnd, projectDuration } from '@/editor/ops'
import { openSequenceId } from '@/editor/sequences'
import { timelineTranscript, untranscribed, voiceClips } from '@/editor/smart'
import { dispatch, getProject, rollbackTo, savepoint, useEditor } from '@/editor/store'
import { uid } from '@/lib/id'
import { transcribeMedia } from '@/project/transcribe'
import { obj, str, type AgentTool } from './kit'

type Candidate=ReturnType<typeof findRetakeCandidates>[number]
type Snapshot={id:string;fingerprint:string;candidates:Candidate[]}
const snapshots=new Map<string,Snapshot>()
const key=()=>`${getProject().id}:${openSequenceId(getProject())}`
const fingerprint=()=>JSON.stringify({sequence:openSequenceId(getProject()),settings:getProject().settings,tracks:getProject().tracks,clips:getProject().clips,assets:getProject().assets,markers:getProject().markers})

export const RETAKE_TOOLS:AgentTool[]=[{
  name:'find_retakes',
  description:'Inspect current timeline transcript for nearby abandoned or repeated takes. Automatically transcribes missing timeline media locally with CUDA Whisper first. Returns candidate groups with exact attempt IDs, wording, times, confidence, and suggested keep. No timeline cuts. The local model must decide which high-confidence candidate/attempt IDs to apply. Intentional or ambiguous repetitions remain review-only.',
  inputSchema:obj({}),
  run:async(_a,ctx)=>{
    const initial=getProject(),sequence=openSequenceId(initial),missing=untranscribed(initial)
    // Old full-window ASR can hide a restart inside a stretched single word.
    // Refresh only suspect legacy word timing; do not replace ordinary manual
    // phrase transcripts or already segmented, confidence-bearing results.
    for(const clip of voiceClips(initial)){
      const asset=clip.assetId?initial.assets[clip.assetId]:undefined,words=asset?.transcript??[]
      if(!asset||words.some(w=>w.utterance_id!==undefined))continue
      const suspect=words.some(w=>{
        const text=w.text.trim(),duration=w.end-w.start
        return !/\s/.test(text)&&(duration>=1.8||text.replace(/[^\p{L}]/gu,'').length<=3&&duration>=1.2)
      })
      if(suspect&&!missing.includes(asset.id))missing.push(asset.id)
    }
    const check=()=>{
      if(ctx?.signal?.aborted)throw new Error('Stopped.')
      if(getProject().id!==initial.id||openSequenceId(getProject())!==sequence)throw new Error('The active project or timeline changed during local transcription. Run find_retakes again on the intended timeline.')
    }
    for(const id of missing){
      check()
      ctx?.progress?.('Transcribing timeline media locally with CUDA Whisper…')
      await transcribeMedia(id,{using:'local',signal:ctx?.signal,onProgress:p=>ctx?.progress?.(`CUDA transcription ${Math.round(p*100)}%`)})
      check()
    }
    check()
    const p=getProject()
    const lines=timelineTranscript(p)
    // Word timestamps can start slightly after the audible consonant. Keep a
    // conservative head before the retained take; audio-based pause cleanup
    // can shorten silence later without losing the sentence's first word.
    const candidates=findRetakeCandidates(lines,{fps:p.settings.fps,padSeconds:0.24})
    const snapshot={id:uid('retakes'),fingerprint:fingerprint(),candidates}
    snapshots.set(key(),snapshot)
    while(snapshots.size>12)snapshots.delete(snapshots.keys().next().value!)
    const actionable=candidates.filter(c=>c.confidence==='high').length
    // The model chooses IDs from actual wording; native frame arithmetic stays
    // in the validated snapshot instead of consuming the local context window.
    const presented=candidates.map(c=>({id:c.id,confidence:c.confidence,reason:c.reason,keepId:c.keepId,keep_attempt_id:c.keepId,attempts:c.attempts.map(t=>({id:t.id,start:t.start,end:t.end,text:t.text,...(t.timingWarnings?.length?{timing_warnings:t.timingWarnings}:{})}))}))
    return {finding_id:snapshot.id,timeline_id:openSequenceId(p),candidate_count:candidates.length,actionable_count:actionable,candidates:presented,no_changes:actionable===0,note:actionable?'Choose candidate IDs and keep attempt IDs after reviewing actual wording. Review-confidence groups are not automatic cuts.':'No high-confidence repeated-take candidates found; no cuts applied. Any ambiguous repetitions are preserved for review.'}
  },
},{
  name:'apply_retakes',
  description:'Apply explicit local-model decisions from the latest find_retakes result to this SAME unchanged timeline. Each decision identifies a high-confidence candidate and the attempt to KEEP. Rejects stale findings, unknown IDs, ambiguous review-only groups and locked tracks. Removes only other attempts using native synchronized timeline ranges, preserving linked voice/captions in one undo step. Never guesses from prose.',
  inputSchema:obj({finding_id:str('Exact finding_id returned by find_retakes'),keep_attempt_ids:{type:'array',description:'Attempt IDs to KEEP, one per chosen group. Parent groups are resolved natively. Empty preserves all takes.',minItems:0,maxItems:100,items:str('Exact attempt id, e.g. rt_0_a2')},decisions:{type:'array',description:'Legacy explicit group/keep decisions; use keep_attempt_ids instead. Do not provide both.',minItems:0,maxItems:100,items:obj({candidate_id:str('Exact candidate id'),keep_attempt_id:str('Exact attempt id to preserve')},['candidate_id','keep_attempt_id'])}},['finding_id']),
  run:async a=>{
    const snapshot=snapshots.get(key())
    if(!snapshot||a.finding_id!==snapshot.id||snapshot.fingerprint!==fingerprint())throw new Error('Retake findings are stale or missing. Run find_retakes again on the current timeline before deciding.')
    if(a.keep_attempt_ids!==undefined&&a.decisions!==undefined)throw new Error('Provide keep_attempt_ids only, not both selection formats.')
    const decisions=Array.isArray(a.keep_attempt_ids)?a.keep_attempt_ids.map(id=>{
      const candidate=snapshot.candidates.find(c=>c.attempts.some(t=>t.id===id))
      if(!candidate)throw new Error('Unknown keep attempt ID. Choose an actual attempt from find_retakes.')
      return {candidate_id:candidate.id,keep_attempt_id:String(id)}
    }):a.decisions as {candidate_id:string;keep_attempt_id:string}[]
    if(!Array.isArray(decisions))throw new Error('Provide explicit candidate/keep attempt decisions.')
    if(!decisions.length){snapshots.delete(key());return {applied:false,reviewed:true,no_changes:true,candidates_applied:0,note:'The model explicitly chose to preserve every attempt after reviewing the candidates. No retake cuts applied.'}}
    const ranges:{start:number;end:number}[]=[],seen=new Set<string>()
    for(const decision of decisions){
      if(seen.has(decision.candidate_id))throw new Error('Duplicate candidate decision.')
      seen.add(decision.candidate_id)
      const candidate=snapshot.candidates.find(c=>c.id===decision.candidate_id)
      if(!candidate)throw new Error('Unknown retake candidate ID; use find_retakes results.')
      if(candidate.confidence!=='high')throw new Error('Ambiguous repetition is review-only. Keep it or manually select precise source cuts after reviewing the recording.')
      const kept=candidate.attempts.find(attempt=>attempt.id===decision.keep_attempt_id)
      if(!kept)throw new Error('Unknown keep attempt ID; use an actual attempt from this candidate.')
      if(kept.id===candidate.keepId)ranges.push({start:candidate.cut.startFrame,end:candidate.cut.endFrame})
      else for(const attempt of candidate.attempts)if(attempt.id!==kept.id)ranges.push({start:attempt.removalStartFrame,end:attempt.removalEndFrame})
    }
    const merged:{start:number;end:number}[]=[]
    for(const range of ranges.sort((a,b)=>a.start-b.start)){
      if(!Number.isInteger(range.start)||!Number.isInteger(range.end)||range.end<=range.start||range.start<0)throw new Error('Candidate has no valid safe native cut range.')
      const last=merged.at(-1);if(last&&range.start<=last.end)last.end=Math.max(last.end,range.end);else merged.push({...range})
    }
    // A different decision cannot delete another explicitly retained take.
    for(const decision of decisions){const c=snapshot.candidates.find(c=>c.id===decision.candidate_id)!,keep=c.attempts.find(t=>t.id===decision.keep_attempt_id)!,fps=getProject().settings.fps;for(const r of merged)if(r.start<Math.ceil(keep.end*fps)&&r.end>Math.floor(keep.start*fps))throw new Error('Selected cuts overlap an attempt requested to keep. Review these candidates separately.')}
    const locked=new Set(getProject().tracks.filter(t=>t.locked).map(t=>t.id)),first=merged[0]?.start??Infinity
    if(Object.values(getProject().clips).some(c=>locked.has(c.trackId)&&clipEnd(c)>first))throw new Error('Unlock affected tracks before synchronized retake editing.')
    const before=projectDuration(getProject())
    useEditor.getState().transaction('Remove selected repeated takes','ai',()=>{
      const mark=savepoint()
      try{for(const r of [...merged].reverse()){const result=dispatch('timeline.removeRange',{start:r.start,end:r.end},{source:'ai'});if(!result.ok)throw new Error(result.error)}}catch(error){if(mark)rollbackTo(mark);throw error}
    })
    snapshots.delete(key())
    return {applied:true,candidates_applied:decisions.length,ranges_removed:merged,seconds_saved:(before-projectDuration(getProject()))/getProject().settings.fps,editable:true,note:'Selected retake ranges removed natively. Retained attempts, linked voice and captions remain editable; undo restores this batch.'}
  },
}]
