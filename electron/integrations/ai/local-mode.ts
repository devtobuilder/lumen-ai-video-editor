import type { ModelMessage } from 'ai'
import type { BridgeTool } from '../../../shared/integrations'
import { isLocalEditingTool } from '../../../shared/local-editing'
import { z } from 'zod'

export const localTools = (tools: BridgeTool[]) => tools.filter(t => isLocalEditingTool(t.name))
export function canonicalDirectArguments(def:BridgeTool|undefined,input:unknown):{args:unknown;discarded:string[]} {
  if(!def||def.inputSchema.type!=='object'||!def.inputSchema.properties||Object.keys(def.inputSchema.properties as object).length)return {args:input,discarded:[]}
  return {args:{},discarded:input&&typeof input==='object'?Object.keys(input):[]}
}
export function retakeModelContext(result:unknown):{finding:Record<string,unknown>;inputSchema:Record<string,unknown>} {
  const value=result as {finding_id?:string;candidates?:{id:string;confidence:string;reason?:string;attempts:{id:string;start:number;end:number;text:string}[];keepId?:string}[]}
  const high=(value.candidates??[]).filter(c=>c.confidence==='high')
  const eligible=high.flatMap(c=>c.attempts.map(a=>a.id))
  return {finding:{finding_id:value.finding_id,actionable_candidates:high,preserved_review_groups:(value.candidates??[]).filter(c=>c.confidence!=='high').map(c=>({reason:c.reason,preserved:true,attempts:c.attempts.map(a=>({start:a.start,end:a.end,text:a.text}))}))},inputSchema:{type:'object',properties:{finding_id:{type:'string',enum:[value.finding_id]},keep_attempt_ids:{type:'array',items:eligible.length?{type:'string',enum:eligible}:{type:'string',enum:[]},uniqueItems:true,description:'Only these high-confidence attempt IDs are eligible. Review-only groups remain untouched.'}},required:['finding_id','keep_attempt_ids'],additionalProperties:false}}
}
/** SDK parallel tool calls still have native timeline dependencies. */
export class LocalNativeToolQueue {
  private tail:Promise<void>=Promise.resolve()
  run<T>(work:()=>PromiseLike<T>|T,signal?:AbortSignal):Promise<T> {
    const next=this.tail.then(()=>{
      if(signal?.aborted)throw new DOMException('Stopped before queued native operation.','AbortError')
      return work()
    })
    this.tail=next.then(()=>undefined,()=>undefined)
    return next
  }
}
export class LocalToolFailureGuard {
  private failures=new Map<string,number>()
  record(name:string,args:unknown,error:string):Error|undefined {
    const key=name+JSON.stringify(args),count=(this.failures.get(key)??0)+1
    this.failures.set(key,count)
    if(count>=2)return new Error(`Stopped repeated invalid native call ${name} after ${count} identical attempts: ${error}. Completed timeline changes are preserved; inspect the live diagnostic before retrying.`)
  }
}
/** Per-request reservation survives model/SDK retries and parallel tool calls. */
export class LocalPreparationGate {
  private attempted=new Set<string>()
  before(name:string,args:Record<string,unknown>):void {
    if(name!=='prepare_native_short')return
    const asset=String(args.asset_id??'')
    if(this.attempted.has(asset))throw new Error('prepare_native_short was already started for this asset in this request. Do not rebuild the sequence. Inspect the current native state and finish remaining title/transcript/granular edits. If preparation failed, report its failure instead of retrying a possibly partial mutation.')
    this.attempted.add(asset)
  }
  get started():boolean{return this.attempted.size>0}
}
export function requiredToolChoiceMiss(error: unknown): boolean {
  const e = error as { name?: string; toolChoice?: { type?: string }; message?: string }
  return e?.name === 'AI_ToolChoiceViolationError' && e.toolChoice?.type === 'required'
    || e?.message === 'Model response did not contain a tool call even though tool choice was required.'
}
const nativeValidators=new WeakMap<object,z.ZodType>()
/** Validate generic broker arguments before any renderer action or dialog. */
export function validateNativeArguments(def:BridgeTool,args:Record<string,unknown>):void {
  let validator=nativeValidators.get(def.inputSchema)
  if(!validator){validator=z.fromJSONSchema(def.inputSchema);nativeValidators.set(def.inputSchema,validator)}
  const result=validator.safeParse(args)
  if(!result.success)throw new Error(`Invalid arguments for ${def.name}: ${result.error.issues.map(i=>`${i.path.join('.')||'arguments'}: ${i.message}`).join('; ')}. Inspect lumen_describe_tool for exact supported fields; unknown keys are not accepted.`)
}
export const LOCAL_INSTRUCTIONS = `You are the user's local Lumen video-editing agent. /no_think
For an existing zoom endpoint prefer set_native_zoom_endpoint(clip_id,scale); it preserves the real endpoint frame/easing. For transitions prefer set_native_transition(clip_id,kind,duration_seconds); its duration is in SECONDS and is converted using actual project fps. Opening titles belong on a titles-role track, never the captions track. The live snapshot and request postconditions are authoritative; do not guess IDs, endpoint frames or duration units.
For restoring a removed pause/source gap between adjacent shots of the same original media, prefer restore_native_source_gap on the following shot; it restores source time using synchronized native timeline edits and preserves overlays/keyframes. Preserve/keep requests do not authorize restyling or recreating those items.
Initial prepare_native_short uses normal local voice cleanup. For explicitly improving microphone quality, stronger noise suppression or dedicated voice enhancement, use enhance_local_voice: local DeepFilterNet inference creates enhanced audio while retaining editable original media and native linked audio clips. Inspect its result and audio state; do not claim that audio filters alone repair recording quality.
For whole-timeline speaking gaps use remove_pauses with only min_gap_seconds (or empty arguments for defaults). Omit clip_ids unless the user explicitly selects particular clips; automatic speech detection includes the correct detached/enhanced voice. If pauses_removed is zero, report no qualifying pauses were found and no cuts were applied; never claim changes or repeat the same operation just to force a mutation.
Retakes require semantic decisions: find_retakes inspects repeated attempts without editing. Read actual wording, choose complete attempts to KEEP, then apply_retakes with returned finding_id and keep_attempt_ids (an array of actual attempt IDs). The native tool resolves their parent candidates; never supply candidate IDs. Preserve intentional repetition and review-only groups. Pause removal is not retake removal. No qualifying candidates means no retake cuts; report this. Find and apply retakes before captions/pauses because edits invalidate findings.
Work on real editable timelines: captions as text clips, camera moves as keyframes, audio as clip/track properties, cuts referencing original media. Never render/import an MP4 as an editing shortcut. Export only when requested, after verifying the native project.
All native LOCAL editor tools are accessible through a compact broker. get_editing_state and prepare_native_short are also directly available as convenient entry points. lumen_search_tools finds other tools, lumen_describe_tool gives exact argument names (schema_path inspects nested patches), lumen_call executes a named native tool with an arguments object. lumen_read_result reads a result page/JSON path. Never repeat a mutation just to read its result. Native command validation and approval rules apply.
Begin editing requests with get_editing_state for compact current timeline state and stable clip IDs. get_clip/list_timelines/get_transcript provide detail. Resolve references like 'that caption' against conversation and current state, never invent IDs. For initial talking-head shorts, prepare_native_short constructs a native editable sequence using CUDA transcription, captions, pauses, keyframes and audio; inspect its schema. Later refinements use granular commands on CURRENT sequence, not a fresh whole-video pass. Examples: clip_update for caption text/style/audio/transform, keyframe_set/clip_animate for zooms, clip_trim/clip_split/timeline_removeRange for cuts, effect_add/clip_setTransition for effects, duck_music/mix_update for audio. Inspect schema/list_catalog rather than inventing values.
Complete EVERY explicitly requested item in this turn. prepare_native_short is a starting point: it does not add an opening title, inspect the transcript for semantic mistakes, add transitions, or verify subsequent changes. Do not offer those as 'next steps' when they were already requested. For changing an existing zoom use keyframe_set on its existing frame/property, not another animation. Inspect the affected clips after the final mutation. If something cannot be done, state the exact unresolved item instead of claiming the whole request succeeded.
After changes inspect affected clips/state and confirm requested values. Undo only your own work. Preserve timelines unless asked otherwise. Command times are integer frames at project fps; helpers may use seconds. Saves/exports can open native dialogs: tell user if one awaits them. Long tools may return call_id/job_id: poll rather than restarting.
No paid generation, cloud models, web uploads or external MCP. Blender scripts still require approval. Image tool results can include a LOCAL vision analysis; use its actual observations and uncertainty, never fabricate seeing frames. Historical summaries retain previous tool IDs; fresh state is authoritative. Keep replies concise; never claim success without tool confirmation.`

const shorten = (text: string, limit: number) => text.length > limit ? text.slice(0, limit) + `\n[${text.length-limit} characters omitted; inspect current state or cached result for details.]` : text

/** Small native schemas promoted for this request; the broker retains all others. */
export function allowsNativePreparation(prompt:string,state?:NativeStateSnapshot):boolean {
  const existing=(state?.clips??[]).some(c=>c.kind==='video'||c.kind==='text')
  if(!existing)return true
  // Authorization must be affirmative. "Do not create a new sequence" is a
  // preservation instruction, never permission to replace the open edit.
  return prompt.split(/[.!?;\n]/).some(clause=>{
    if(/\b(?:do not|don't|never|without|no)\b/i.test(clause))return false
    return /\b(?:create|make|build|prepare|start|open|use|want)\b[^.!?;\n]{0,60}\b(?:new|another|separate)\s+(?:native\s+|editable\s+)?(?:sequence|timeline|project)\b/i.test(clause)
  })
}

export function directLocalTools(defs: BridgeTool[], prompt: string,state?:NativeStateSnapshot): BridgeTool[] {
  const text=prompt.toLowerCase(), tasks=new Set(requestedLocalTasks(prompt)), wanted=new Set(['get_editing_state','get_clip'])
  const existing=/\b(?:current|existing|same)\b[^.!?]{0,40}\b(?:timeline|sequence|project|edit)\b/.test(text)
  const initial= /\b(?:create|make|prepare|build|turn|produce)\b[^.!?]{0,100}\b(?:short|shorts|reel|reels|tiktok|recording)\b/.test(text)||/\bprepare_native_short\b/.test(text)
  if(initial&&allowsNativePreparation(prompt,state)&&(!existing||/\bnew\s+(?:sequence|timeline)\b/.test(text))) wanted.add('prepare_native_short')
  if(tasks.has('title')) wanted.add('add_title')
  if(tasks.has('export')) wanted.add('export_video')
  if(tasks.has('audio')&&(!initial||existing||!allowsNativePreparation(prompt,state)||/\b(?:mic|microphone|stronger|deepfilternet)\b/.test(text)))wanted.add('enhance_local_voice')
  if(tasks.has('captions')){
    wanted.add('get_transcript')
    if(!(state?.clips??[]).some(c=>c.kind==='text'))wanted.add('add_captions')
  }
  if(/restore|bring back|put back|undo.*cut/.test(text))wanted.add('restore_native_source_gap')
  if((tasks.has('title')||tasks.has('captions'))&&/(?:title|caption|text)[^.!?]{0,50}(?:second|duration|\bsec\b)|(?:second|duration)[^.!?]{0,50}(?:title|caption|text)/.test(text))wanted.add('set_native_text_duration')
  if(/transcript|mistake|repeat|retake|filler|speech/.test(text)) wanted.add('get_transcript')
  if(tasks.has('zoom')) { wanted.add('set_native_zoom_endpoint');wanted.add('keyframe_set'); wanted.add('clip_animate') }
  if(tasks.has('transition')) {wanted.add('set_native_transition');wanted.add('clip_setTransition')}
  if(tasks.has('cuts')) wanted.add('remove_pauses')
  if(tasks.has('retake-review')||tasks.has('retakes')){wanted.add('find_retakes');wanted.add('apply_retakes')}
  if(/\b(?:remove|cut|trim)\b[^.!?]{0,80}\b(?:mistakes?|retakes?|repeats?|repeated|false starts?|filler)\b/.test(text))wanted.add('timeline_removeRange')
  const branches=new Set<string>()
  if(tasks.has('captions')||tasks.has('title')||/\b(?:font|style)\b/.test(text)) branches.add('text')
  if(/audio|voice|music|noise|volume|loud|clean|enhance/.test(text)) branches.add('audio')
  if(tasks.has('zoom')||/\b(?:position|center|crop)\b/.test(text)) branches.add('transform')
  if(/grade|warm|contrast|saturat|exposure|cinematic/.test(text)) branches.add('color')
  if(branches.size) wanted.add('clip_update')
  const selected=localTools(defs).filter(t=>wanted.has(t.name)).map(t=>{
    const inputSchema=JSON.parse(JSON.stringify(t.inputSchema)) as Record<string,unknown>
    if(t.name==='enhance_local_voice'&&!/\b(?:selected|specific|particular|clip_ids|clip_[a-z0-9]+|asset_[a-z0-9]+)\b/.test(text)){
      const fields=inputSchema.properties as Record<string,unknown>,keys=new Set<string>()
      if(/\b(?:strong|stronger|gentle|balanced|strength)\b/.test(text))keys.add('strength')
      if(/\b(?:level|leveling|levelling|loudness)\b/.test(text))keys.add('level_voice')
      inputSchema.properties=Object.fromEntries(Object.entries(fields).filter(([name])=>keys.has(name)))
    }
    if(t.name==='add_title'){
      const fields=inputSchema.properties as Record<string,unknown>,keys=new Set(['text'])
      if(/\b(?:top|bottom|center|lower.third)\b/.test(text))keys.add('position')
      if(/\btitle\b[^.!?]{0,70}\b\d+(?:\.\d+)?\s*seconds?/.test(text))keys.add('duration_seconds')
      inputSchema.properties={...Object.fromEntries(Object.entries(fields).filter(([name])=>keys.has(name))),at_seconds:{type:'number',enum:[0],description:'Opening title starts at zero seconds'}}
    }
    if(t.name==='get_transcript'&&!/\b(?:source|asset_id|original\s+transcript|asset_[a-z0-9]+)\b/.test(text))inputSchema.properties={}
    if(t.name==='clip_animate'&&state&&!(state.clips??[]).some(c=>c.kind==='video'&&(c.keyframes?.scale?.length??0)>=2)){
      const properties=inputSchema.properties as Record<string,unknown>
      inputSchema.properties={clipId:properties.clipId,preset:{type:'string',enum:['push-in']},intensity:properties.intensity}
    }
    if(t.name==='apply_retakes'){
      inputSchema.properties={finding_id:{type:'string',description:'Exact finding_id from find_retakes'},keep_attempt_ids:{type:'array',items:{type:'string'},description:'Actual attempt IDs to KEEP, e.g. rt_0_a2. Native code resolves parent candidates. Empty means preserve all without cuts.'}}
      inputSchema.required=['finding_id','keep_attempt_ids'];inputSchema.additionalProperties=false
    }
    if(t.name==='remove_pauses'&&!/\b(?:selected|selection|specific|particular|clip_ids|clip_[a-z0-9]+)\b/.test(text)){
      const fields=inputSchema.properties as Record<string,unknown>
      inputSchema.properties=Object.fromEntries(Object.entries(fields).filter(([name])=>name==='min_gap_seconds'))
      if(!/\b(?:pause|gap|silence)[^.!?]{0,40}\d+(?:\.\d+)?\s*seconds?|\d+(?:\.\d+)?\s*seconds?[^.!?]{0,40}(?:pause|gap|silence)/.test(text))inputSchema.properties={}
    }
    if(t.name==='add_captions'){
      const fields=inputSchema.properties as Record<string,unknown>,wantedFields=new Set(['style'])
      if(/\b(?:accent|hex|colou?r)\b/.test(text))wantedFields.add('accent')
      if(/\b(?:max_words|\d+\s+words?\s+(?:per|a|each)|words?\s+per\s+caption)\b/.test(text))wantedFields.add('max_words')
      if(/\b(?:size|pixels?|font\s+size)\b/.test(text))wantedFields.add('size')
      if(/\b(?:uppercase|lowercase|all\s+caps)\b/.test(text))wantedFields.add('uppercase')
      inputSchema.properties=Object.fromEntries(Object.entries(fields).filter(([name])=>wantedFields.has(name)))
    }
    if(t.name==='clip_update') {
      const props=inputSchema.properties as Record<string,unknown>, patch=props.patch as Record<string,unknown>,fields=patch.properties as Record<string,unknown>
      patch.properties=Object.fromEntries(Object.entries(fields).filter(([name])=>branches.has(name)))
      delete inputSchema.$schema
    }
    return {...t,description:(t.description??'').slice(0,420),inputSchema}
  })
  // Large exact patch schemas remain available on demand. Avoid rebuilding the
  // original 30k-token catalog by promoting only a bounded useful subset.
  while(JSON.stringify(selected).length>8200) {
    const index=selected.findIndex(t=>t.name==='clip_animate'&&!state)
    if(index>=0) selected.splice(index,1)
    else { const last=selected.findLastIndex(t=>!['get_editing_state','get_clip','prepare_native_short','clip_update','clip_animate','set_native_zoom_endpoint','set_native_transition','add_title','add_captions','enhance_local_voice','find_retakes','apply_retakes','remove_pauses','timeline_removeRange','get_transcript'].includes(t.name));if(last<0) break;selected.splice(last,1) }
  }
  return selected
}

export interface LocalProgress { completed:Set<string>; mutation:number; verification:number }
export const newLocalProgress=():LocalProgress=>({completed:new Set(),mutation:0,verification:0})

/** Qwen can emit EOS with an omnibus catalog of unavailable workflows. Give a
 * restricted stage only its actual responsibilities, schemas and fresh state. */
export function localPhaseInstructions(names:string[],task?:string):string {
  const active=new Set(names)
  const lines=["You are the user's fully local Lumen editor. Work on the current editable timeline. Use structured native tool calls; prose does not apply edits. Preserve existing source cuts and meaning. Do not create another sequence or export unless explicitly requested. Current phase tools: "+names.join(', ')+'. Finish this phase using their exact schemas before discussing later steps.']
  if(active.has('find_retakes'))lines.push('Current phase: call find_retakes with empty arguments to inspect actual repeated-take candidates. This is read-only. Do not rebuild the sequence. Later phases handle captions, pauses, audio, zoom and titles.')
  if(active.has('apply_retakes'))lines.push('Inspection is complete. Use the actual cached finding_id and keep_attempt_ids to choose complete high-confidence takes. Native code resolves parent groups. Preserve review-only and intentional repetitions. An empty array explicitly keeps all without cuts. Do not find again.')
  if(active.has('add_captions'))lines.push('Create editable speech captions with add_captions. They are native text clips, not an opening title. Use requested style and native defaults for unspecified controls; no video/track text patches.')
  if(active.has('remove_pauses'))lines.push('Tighten actual speech pauses with remove_pauses. Omit clip_ids for whole-timeline requests so native detection uses the correct linked voice. Zero pauses means report no qualifying cuts, never invent changes.')
  if(active.has('get_transcript'))lines.push('get_transcript without asset_id reads current edited speech. Inspect actual words when requested, then continue remaining direct actions.')
  if(active.has('add_title'))lines.push('add_title creates a separate native opening title; duration_seconds is seconds and the Titles track is distinct from captions. Use exact requested wording.')
  if(active.has('set_native_transition'))lines.push('Use set_native_transition on each requested adjacent incoming shot. duration_seconds is seconds, not frames. Do not add a transition to the first shot.')
  if(active.has('set_native_zoom_endpoint'))lines.push('Use set_native_zoom_endpoint for an existing punch-in; preserve its real last keyframe. keyframe_set uses clip-relative integer frames at project fps.')
  if(active.has('enhance_local_voice'))lines.push('enhance_local_voice performs local source-audio improvement while retaining linked editable voice. Apply once to requested speech; do not repeat completed enhancement.')
  if(active.has('clip_animate'))lines.push('Create a NEW native punch-in using clip_animate on an actual video clip with preset push-in (subtle intensity around0.3). Omit at/duration to animate the whole shot. This creates editable scale keyframes; do not use an existing-endpoint tool on an unanimated clip.')
  if(active.has('clip_update')&&task==='audio')lines.push('Current phase is ordinary voice cleanup: clip_update actual speech clip IDs with patch.audio.enhance true and patch.audio.denoise true. Preserve timing and caption text. This is native local processing; stronger microphone repair is a separate explicitly requested enhancement.')
  lines.push('Fresh native state and remaining postconditions below are authoritative. Do not invent clip IDs or tool results. Verify actual changed properties; if impossible, state the exact unresolved issue. No cloud APIs.')
  return lines.join('\n')
}
export function localPhaseRequest(names:string[]):string {
  return '[Local native stage] Execute the current native stage '+names.join(', ')+'. Use its structured tool now. Follow the original user brief in system context; other stages are separate. Do not repeat completed tasks.'
}

/** Existing edits need small, directly executable tool groups rather than discovery. */
export function existingNativeEditingPlan(prompt:string,state:NativeStateSnapshot|undefined,progress:LocalProgress):string[]|undefined {
  if(allowsNativePreparation(prompt,state))return
  const tasks=requestedLocalTasks(prompt).filter(t=>!progress.completed.has(t))
  if(!tasks.length||tasks.some(t=>!['title','captions','zoom','transition','cuts','audio','transcript','restore','export','retake-review','retakes'].includes(t)))return
  const names=new Set(['get_editing_state','get_clip'])
  const groups:Record<string,string[]>={'retake-review':['find_retakes'],retakes:['find_retakes','apply_retakes'],title:['add_title','clip_update','set_native_text_duration'],captions:['add_captions','get_transcript','clip_update','set_native_text_duration'],zoom:['set_native_zoom_endpoint','keyframe_set','clip_animate','clip_update'],transition:['set_native_transition','clip_setTransition'],cuts:['get_transcript','remove_pauses','timeline_removeRange'],audio:['enhance_local_voice','clip_update'],transcript:['get_transcript'],restore:['restore_native_source_gap'],export:['export_video']}
  const task=['retake-review','retakes','transcript','captions','cuts','zoom','transition','audio','title','restore','export'].find(t=>tasks.includes(t))!
  if(task==='retake-review')return ['find_retakes']
  if(task==='retakes'&&progress.completed.has('retake-review'))return ['apply_retakes']
  if(task==='transcript')return ['get_transcript']
  if(task==='captions'&&!(state?.clips??[]).some(c=>c.kind==='text'))return ['add_captions']
  if(task==='cuts')return ['remove_pauses']
  if(task==='zoom'&&!(state?.clips??[]).some(c=>c.kind==='video'&&(c.keyframes?.scale?.length??0)>=2))return ['clip_animate']
  if(task==='audio')return ['enhance_local_voice']
  if(task==='title')return ['add_title']
  for(const name of groups[task])names.add(name)
  return [...names]
}

/** After construction, finish small missing direct tasks without rediscovery. */
export function localFinishingPlan(prompt:string,progress:LocalProgress,prepared:boolean):{tools:string[];next:string}|undefined {
  if(!prepared)return
  const remaining=requestedLocalTasks(prompt).filter(t=>!progress.completed.has(t))
  if(!remaining.length||remaining.some(t=>t!=='title'&&t!=='transcript'))return
  const next=remaining.includes('transcript')?'get_transcript':'add_title'
  return {tools:[next],next}
}

export function requestedLocalTasks(prompt:string):string[] {
  const p=prompt.toLowerCase().replace(/(\d)\.(?=\d)/g,(_match,digit:string)=>digit+'_'), tasks:string[]=[]
  const readOnly=/^\s*(?:please\s+)?(?:select|find|show|inspect|review|read|list|describe|explain|what|which|where|how)\b/.test(p)&&!/\b(?:add|create|change|replace|reduce|increase|adjust|remove|correct|apply|tighten|trim|cut|restore|set|edit)\b/.test(p)
  const negative=(word:string)=>new RegExp(`\\b(?:no|without|do not|don't)\\s+(?:add(?:ing)?\\s+|use\\s+|an?\\s+)*(?:[a-z-]+\\s+){0,2}${word}\\b`).test(p)
  const preserveOnly=(word:string)=>new RegExp(`\\b(?:keep|preserve|retain|leave)\\b[^.!?;]{0,200}\\b(?:${word})\\b`).test(p)&&!new RegExp(`\\b(?:add|create|change|replace|reduce|increase|set|adjust|remove|edit|correct|use|apply)\\b[^.!?;]{0,100}\\b(?:${word})\\b`).test(p)
  const synchronizedCaptions=/\bcaptions?\s+(?:stay|remain)\s+(?:synchroni[sz]ed|unchanged|editable|revisable)/.test(p)&&!/\b(?:add|create|change|replace|remove|edit|correct|use|apply)\b[^.!?;]{0,80}\bcaptions?\b/.test(p)
  if(!readOnly&&/\btitle\b|headline|opening text/.test(p)&&!negative('title')&&!preserveOnly('title|headline|opening text')) tasks.push('title')
  if(!readOnly&&/caption/.test(p)&&!negative('captions?')&&!preserveOnly('captions?')&&!synchronizedCaptions) tasks.push('captions')
  if(!readOnly&&/zoom|punch.in|keyframe/.test(p)&&!negative('zoom')&&!preserveOnly('zoom|punch.in|keyframes?')) tasks.push('zoom')
  if(!readOnly&&/transition|dissolve|crossfade/.test(p)&&!negative('transitions?')&&!negative('dissolve')&&!preserveOnly('transitions?|dissolve|crossfade')) tasks.push('transition')
  if(/\b(?:remove|cut|trim|tighten)\b[^.!?]{0,40}(?:pause|silence|gap)|(?:pause|silence)[^.!?]{0,40}\b(?:remove|cut|trim|tighten)\b/.test(p)||nativeActionRequested(prompt)&&/\b(?:gaps?\s+(?:in|between)\s+(?:speaking|speech|talking|words)|(?:speaking|speech|talking)\s+gaps?|pauses?|silences?)\b/.test(p)&&/\b(?:fix|remove|reduce|shorten|tighten|close|cut|trim|eliminate)\b/.test(p)) tasks.push('cuts')
  if(/(?:voice|audio|mic|microphone)[^.!?]{0,45}(?:clean|enhance|denoise|improv|quality|better|noise)|(?:clean|enhance|denoise|improv|fix|better|noise)[^.!?]{0,45}(?:voice|audio|mic|microphone)/.test(p)&&!preserveOnly('voice|audio|mic|microphone')&&!negative('audio')&&!negative('voice')) tasks.push('audio')
  if(!readOnly&&!negative('de[- ]?ess(?:ing)?')&&!preserveOnly('voice|audio|sibilance')&&(/\b(?:de[- ]?ess(?:ing)?|sibilance|sibilants?)\b|(?:sharp|harsh|piercing)[^.!?]{0,35}(?:\bs\b|sounds?|consonants?)|(?:\bs\b|s[- ]?sounds?|consonants?)[^.!?]{0,35}(?:sharp|harsh|piercing)/.test(p))&&!tasks.includes('audio'))tasks.push('audio')
  if(/(?:inspect|review|check|read|find)[^.!?]{0,35}transcript|transcript[^.!?]{0,35}(?:mistake|repeat)/.test(p)) tasks.push('transcript')
  if(/\b(?:retakes?|false starts?|repeated (?:takes?|attempts?|phrases?)|abandoned (?:takes?|attempts?))\b/.test(p)&&!negative('retakes?')){
    tasks.push('retake-review')
    if(/\b(?:remove|cut|delete|fix|eliminate)\b/.test(p)&&!preserveOnly('retakes?|false starts?|repeated (?:takes?|attempts?|phrases?)'))tasks.push('retakes')
  }
  if(/(?:inspect|review|check|verify)[^.!?]{0,35}(?:frame|composition|readability|overlap)/.test(p)) tasks.push('visual')
  if(/\b(?:restore|bring back|put back)\b[^!?;\n]{0,120}\b(?:pause|gap|source|interval|cut)\b/.test(p))tasks.push('restore')
  if(/\b(?:export|render|save\s+(?:an?\s+)?mp4)\b/.test(p)&&!/\b(?:no|do not|don't|never)\s+(?:render\s+or\s+|export\s+or\s+)?(?:export|render)\b/.test(p))tasks.push('export')
  return tasks
}

/** Evidence follows successful native results, never the model's prose. */
export function recordLocalAction(progress:LocalProgress,name:string,args:Record<string,unknown>,result?:unknown) {
  const patch=args.patch as Record<string,unknown>|undefined
  if(name==='prepare_native_short') { progress.completed.add('captions');if(args.punch_in!==false) progress.completed.add('zoom');if(args.remove_pauses!==false) progress.completed.add('cuts');if(args.clean_audio!==false) progress.completed.add('audio') }
  if(name==='add_title') progress.completed.add('title')
  if(name==='set_native_text_duration'){progress.completed.add('title');progress.completed.add('captions')}
  if(name==='add_captions'||name==='import_subtitles'||name==='clip_update'&&patch?.text) progress.completed.add('captions')
  if(['keyframe_set','keyframe_remove','keyframe_clear','keyframe_move','set_native_zoom_endpoint','clip_animate'].includes(name)||name==='clip_update'&&patch?.transform) progress.completed.add('zoom')
  if(name==='clip_setTransition'||name==='set_native_transition') progress.completed.add('transition')
  if(['remove_pauses','clip_trim','clip_split','clip_roll','timeline_removeRange'].includes(name)) progress.completed.add('cuts')
  if(name==='clip_update'&&patch?.audio||name==='mix_update'||name==='duck_music'||name==='enhance_local_voice') progress.completed.add('audio')
  if(name==='get_transcript') progress.completed.add('transcript')
  if(name==='find_retakes'){
    progress.completed.add('retake-review')
    if(result&&typeof result==='object'&&(result as {actionable_count?:number}).actionable_count===0)progress.completed.add('retakes')
  }
  if(name==='apply_retakes'&&result&&typeof result==='object'&&((result as {applied?:boolean}).applied===true||(result as {reviewed?:boolean}).reviewed===true))progress.completed.add('retakes')
  if(name==='restore_native_source_gap'||name==='timeline_insertRange')progress.completed.add('restore')
  if(name==='export_video'&&result&&typeof result==='object'&&((result as {exported?:boolean}).exported===true||args.queue===true&&(result as {queued?:boolean}).queued===true))progress.completed.add('export')
  if(['get_frame','get_contact_sheet','get_media_frames','get_editor_screenshot'].includes(name)) progress.completed.add('visual')
  const read=/^(get_|find_|list_|analyze_|detect_|lumen_)/.test(name)||['seek','playback','save_project','export_video','use_skill','read_skill_file'].includes(name)
  const noPauses=name==='remove_pauses'&&typeof result==='object'&&result!==null&&(result as {pauses_removed?:number}).pauses_removed===0
  const noRetakes=name==='apply_retakes'&&typeof result==='object'&&result!==null&&(result as {no_changes?:boolean}).no_changes===true
  if(!read&&!noPauses&&!noRetakes) progress.mutation++
  if(['get_editing_state','get_clip','get_frame','get_contact_sheet','get_editor_screenshot','analyze_audio'].includes(name)) progress.verification=progress.mutation
}

export function pendingLocalTasks(prompt:string,progress:LocalProgress):string[] {
  const tasks=requestedLocalTasks(prompt)
  return [...tasks.filter(t=>!progress.completed.has(t)),...(!tasks.length&&nativeActionRequested(prompt)&&progress.mutation===0?['a native editing action; inspecting state alone does not apply the requested edit']:[]),...(progress.mutation>progress.verification?['verification of the final native changes']:[])]
}

/** Broad completion safeguard for action requests outside named edit categories. */
export function nativeActionRequested(prompt:string):boolean {
  const p=prompt.trim().toLowerCase()
  if(/^(?:what|why|how|explain|describe|can i|could i|show me how)\b/.test(p))return false
  return p.split(/[.!?;\n,]/).some(clause=>! /\b(?:do not|don't|never|no need to)\b/.test(clause)&&/\b(?:fix|edit|adjust|tighten|improve|remove|reduce|shorten|trim|cut|change|replace|add|apply|create|make|enhance|restore|reframe|crop|close|eliminate)\b/.test(clause))
}

/** Diagnostic response data only: never persist request bodies or HTTP headers. */
export function localWireFrame(raw:unknown):unknown {
  if(!raw || typeof raw!=='object') return {unparsed:String(raw).slice(0,1500)}
  const frame=raw as Record<string,unknown>
  const choices=Array.isArray(frame.choices)?frame.choices.slice(0,2).map(c=>{
    const choice=c as Record<string,unknown>, delta=(choice.delta??{}) as Record<string,unknown>
    const calls=Array.isArray(delta.tool_calls)?delta.tool_calls.slice(0,4).map(t=>{
      const call=t as Record<string,unknown>, fn=(call.function??{}) as Record<string,unknown>
      return {index:call.index,type:call.type,function:{name:fn.name,arguments:typeof fn.arguments==='string'?fn.arguments.slice(0,2500):fn.arguments}}
    }):undefined
    return {index:choice.index,finish_reason:choice.finish_reason,delta:{...(typeof delta.content==='string'?{content:delta.content.slice(0,2500)}:{}),...(typeof delta.reasoning_content==='string'?{reasoning_content:delta.reasoning_content.slice(0,1000)}:{}),...(calls?{tool_calls:calls}:{})}}
  }):[]
  return {choices,...(frame.usage&&typeof frame.usage==='object'?{usage:Object.fromEntries(Object.entries(frame.usage).filter(([,v])=>typeof v==='number'))}:{}),...(frame.error?{error:String(frame.error).slice(0,1000)}:{})}
}

interface NativeClipSnapshot {
  id:string;kind:string;track_id?:string;asset_id?:string;inPoint?:number;start:number;duration:number;text?:string;
  transform?:{y?:number};keyframes?:Record<string,{frame:number;value:number;easing?:string}[]>;
  transitionIn?:{kind:string;duration:number}|null
}
export interface NativeStateSnapshot {
  timeline_id?:string;settings?:{fps?:number};clips?:NativeClipSnapshot[];
  tracks?:{id:string;role?:string;name?:string}[];media?:unknown[];selected_clip_ids?:string[]
}

/** Structural guard uses fresh native data, not the model's claimed success. */
export class LocalNativeGuard {
  baseline?:NativeStateSnapshot
  state?:NativeStateSnapshot
  private restoredClipId?:string
  constructor(readonly prompt:string){}
  update(states:NativeStateSnapshot[]) {
    const ids=new Set(states.map(s=>s.timeline_id))
    if(ids.size>1) throw new Error('The timeline changed during native inspection. Inspect the current timeline before continuing.')
    const merged={...states[0],clips:[...new Map(states.flatMap(s=>s.clips??[]).map(c=>[c.id,c])).values()]}
    this.state=merged
    this.baseline??=JSON.parse(JSON.stringify(merged)) as NativeStateSnapshot
  }
  addDetailedClips(details:Record<string,unknown>[]) {
    const clips=details.filter(c=>typeof c.id==='string'&&typeof c.kind==='string').map(c=>({...c,track_id:c.track_id??c.trackId,asset_id:c.asset_id??c.assetId,text:typeof c.text==='object'&&c.text?(c.text as {content?:string}).content:c.text})) as unknown as NativeClipSnapshot[]
    if(this.state)this.state.clips=[...new Map([...(this.state.clips??[]),...clips].map(c=>[c.id,c])).values()]
    if(this.baseline?.timeline_id===this.state?.timeline_id&&this.baseline){
      const known=new Set((this.baseline.clips??[]).map(c=>c.id))
      this.baseline.clips=[...(this.baseline.clips??[]),...JSON.parse(JSON.stringify(clips.filter(c=>!known.has(c.id)))) as NativeClipSnapshot[]]
    }
  }
  private tracks(role:string){return new Set((this.state?.tracks??[]).filter(t=>t.role===role).map(t=>t.id))}
  private firstCaption(){
    const state=this.baseline?.clips?.length?this.baseline:this.state, tracks=new Set((state?.tracks??[]).filter(t=>t.role==='captions').map(t=>t.id))
    return [...(state?.clips??[])].filter(c=>c.kind==='text'&&tracks.has(c.track_id??'')).sort((a,b)=>a.start-b.start)[0]
  }
  private zooms(){return (this.baseline?.clips??this.state?.clips??[]).filter(c=>c.kind==='video'&&(c.keyframes?.scale?.length??0)>=2).map(c=>({clip:c,last:[...c.keyframes!.scale].sort((a,b)=>a.frame-b.frame).at(-1)!}))}
  private boundaries(){
    const clips=[...(this.baseline?.clips??this.state?.clips??[])].filter(c=>c.kind==='video').sort((a,b)=>a.start-b.start)
    return clips.filter((c,i)=>i>0&&clips[i-1].track_id===c.track_id&&clips[i-1].start+clips[i-1].duration===c.start)
  }
  expectations(){
    const p=this.prompt, fps=this.state?.settings?.fps??30
    const tasks=requestedLocalTasks(p)
    const caption=tasks.includes('captions')?/\bfirst\s+caption\s+to\s+(.+?)(?=[.!?\n]|$)/i.exec(p)?.[1]?.trim().replace(/^["'“”]+|["'“”]+$/g,''):undefined
    const existingZoom=tasks.includes('zoom')&&/existing[^.!?]{0,50}(?:zoom|punch|keyframe)|(?:zoom|punch|keyframe)[^.!?]{0,50}existing/i.test(p)
    const scaleMatch=/\b(?:endpoint(?:\s+scale)?|scale)\s+(?:to\s+)?(\d+(?:\.\d+)?)\b/i.exec(p)
    const transition=tasks.includes('transition')?/(\d+(?:\.\d+)?)\s*[- ]?\s*(?:second|sec|s)s?\b[^.!?]{0,20}\b(dissolve|crossfade|transition)/i.exec(p):null
    const title=tasks.includes('title')?/\btitle\s+(.+?)\s+for\s+(\d+(?:\.\d+)?)\s*(?:second|sec|s)s?\b/i.exec(p):null
    return {caption,captionId:this.firstCaption()?.id,existingZoom,scale:scaleMatch?Number(scaleMatch[1]):undefined,zoomTargets:this.zooms().map(x=>({clip_id:x.clip.id,frame:x.last.frame,easing:x.last.easing})),transitionFrames:transition?Math.round(Number(transition[1])*fps):undefined,transitionSeconds:transition?Number(transition[1]):undefined,transitionKind:transition&&/dissolve|crossfade/i.test(transition[2])?'dissolve':undefined,transitionClip:/\bexisting\s+(?:jump\s+)?cut\b/i.test(p)?this.boundaries()[0]?.id:undefined,transitionClips:(/\b(?:cuts|boundaries|transitions)\b/i.test(p)?this.boundaries():this.boundaries().slice(0,1)).map(c=>c.id),title:title?.[1]?.trim().replace(/^(?:to|reading|saying|called)\s+/i,'').replace(/^["'“”]+|["'“”]+$/g,''),titleFrames:title?Math.round(Number(title[2])*fps):undefined,titleSeconds:title?Number(title[2]):undefined,topTitle:/\btop\s+title\b|title[^.!?]{0,20}\btop\b/i.test(p),sameTimeline:/keep[^.!?]{0,20}(?:same|current)\s+timeline/i.test(p)}
  }
  before(name:string,args:Record<string,unknown>){
    if(name==='prepare_native_short'&&!allowsNativePreparation(this.prompt,this.baseline??this.state))throw new Error('This timeline already contains native edits. Continue on this same timeline with caption, transition and audio tools. Creating another sequence requires an explicit request for a new sequence or timeline.')
    if(name==='export_video'&&/\b(?:do not|don't|no)\s+(?:render(?:ing)?\s*(?:or|and)?\s*)?export\b|\bdo not\s+render\s+or\s+export\b/i.test(this.prompt))throw new Error('The user requested native editing without rendering/exporting. Keep the project editable.')
    const read=/^(get_|find_|list_|analyze_|detect_|lumen_)/.test(name)||['seek','playback','save_project','export_video','use_skill','read_skill_file'].includes(name)
    if(read)return
    if(!this.state)throw new Error('Fresh native editing state is required before changing the project.')
    const e=this.expectations(), clips=new Map((this.state.clips??[]).map(c=>[c.id,c])), patch=args.patch as Record<string,unknown>|undefined
    if(requestedLocalTasks(this.prompt).includes('restore')&&/\b(?:preserve|keep|retain)\b/i.test(this.prompt)){
      if(['add_title','add_captions','clip_animate','clip_setTransition','set_native_zoom_endpoint','set_native_transition','set_native_text_duration'].includes(name)||/^keyframe_/.test(name)||name==='clip_update'&&(patch?.text||patch?.transform||patch?.color||patch?.audio))throw new Error('This request restores source time while preserving existing titles, captions, zooms and transitions. Use restore_native_source_gap or synchronized native timeline/source edits; do not restyle or recreate preserved elements.')
    }
    if(name==='restore_native_source_gap')this.restoredClipId=String(args.clip_id??'')
    if(e.sameTimeline&&['sequence_create','sequence_open','prepare_native_short'].includes(name))throw new Error('The user requested keeping this same timeline. Use granular tools here, not a new sequence.')
    if(name==='clip_update'&&patch?.text){
      const ids=(args.ids??[]) as string[]
      for(const id of ids)if(clips.get(id)?.kind!=='text')throw new Error(`Clip ${id} is not text. Caption properties must target a native text clip.`)
      const content=(patch.text as {content?:unknown}).content
      if(content!==undefined&&e.caption&&e.captionId&&(ids.length!==1||ids[0]!==e.captionId))throw new Error(`The requested FIRST caption is ${e.captionId}. Do not change video clips or other captions.`)
      if(content!==undefined&&e.caption&&content!==e.caption)throw new Error(`The requested caption text is exactly ${JSON.stringify(e.caption)}.`)
    }
    if((name==='keyframe_set'||name==='set_native_zoom_endpoint')&&e.existingZoom){
      const id=String(args.clipId??args.clip_id??''),target=e.zoomTargets.find(t=>t.clip_id===id)
      if(!target)throw new Error('Choose the existing multi-keyframe punch-in, not an unanimated clip. Targets: '+JSON.stringify(e.zoomTargets))
      if(name==='keyframe_set'&&(args.prop!=='scale'||args.frame!==target.frame))throw new Error(`Existing scale endpoint is clip ${id}, frame ${target.frame}. Prefer set_native_zoom_endpoint.`)
      if(e.scale!==undefined&&Number(args.value??args.scale)!==e.scale)throw new Error(`Requested endpoint scale is ${e.scale}.`)
    }
    if(['clip_setTransition','set_native_transition'].includes(name)&&e.transitionFrames!==undefined){
      const transition=args.transition as {duration?:unknown;kind?:unknown}|undefined,id=String(args.id??args.clip_id??'')
      if(e.transitionClip&&id!==e.transitionClip)throw new Error(`The existing jump cut enters clip ${e.transitionClip}.`)
      const frames=name==='set_native_transition'?Math.round(Number(args.duration_seconds)*(this.state.settings?.fps??30)):transition?.duration
      if(frames!==e.transitionFrames)throw new Error(`Requested transition is ${e.transitionSeconds} seconds = ${e.transitionFrames} frames at ${this.state.settings?.fps}fps. Prefer set_native_transition with duration_seconds.`)
      if(e.transitionKind&&(transition?.kind??args.kind)!==e.transitionKind)throw new Error(`Requested transition kind is ${e.transitionKind}.`)
    }
    if(name==='add_title'){
      if(args.track_id&&!this.tracks('titles').has(String(args.track_id)))throw new Error('A title must use a titles-role track, not captions. Omit track_id to use the native Titles track.')
      if(e.title&&args.text!==e.title)throw new Error(`Requested title text is exactly ${JSON.stringify(e.title)}.`)
      if(e.titleSeconds!==undefined&&args.duration_seconds!==e.titleSeconds)throw new Error(`Title duration is ${e.titleSeconds} seconds; use duration_seconds.`)
      if(e.topTitle&&args.position!=='top')throw new Error('The user requested a TOP title. Set position to top.')
    }
    if(name==='set_native_text_duration'){
      const clip=clips.get(String(args.clip_id??''))
      if(clip?.kind!=='text')throw new Error('Text duration must target an existing caption/title text clip.')
      if(/title/i.test(this.prompt)&&!/caption/i.test(this.prompt)&&!this.tracks('titles').has(clip.track_id??''))throw new Error('The user requested the title duration; choose a text clip on a Titles track.')
    }
  }
  pending():string[]{
    if(!this.state)return ['fresh native project state']
    const e=this.expectations(), clips=this.state.clips??[], map=new Map(clips.map(c=>[c.id,c])), issues:string[]=[]
    if(e.sameTimeline&&this.baseline?.timeline_id!==this.state.timeline_id)issues.push('the original timeline must remain open')
    if(e.caption&&map.get(e.captionId??'')?.text!==e.caption)issues.push(`first caption ${e.captionId} must read ${JSON.stringify(e.caption)}`)
    if(e.existingZoom&&e.scale!==undefined){
      if(!e.zoomTargets.some(t=>map.get(t.clip_id)?.keyframes?.scale?.some(k=>k.frame===t.frame&&Math.abs(k.value-e.scale!)<1e-6)))issues.push(`existing scale endpoint must be ${e.scale} at its original clip/frame ${JSON.stringify(e.zoomTargets)}`)
    }
    if(e.transitionFrames!==undefined)for(const id of e.transitionClips){const actual=map.get(id)?.transitionIn;if(actual?.duration!==e.transitionFrames||e.transitionKind&&actual?.kind!==e.transitionKind)issues.push(`${e.transitionKind??'requested'} transition at ${id} must be ${e.transitionFrames} frames (${e.transitionSeconds}s)`)}
    if(e.title){const title=clips.find(c=>c.kind==='text'&&c.text===e.title&&this.tracks('titles').has(c.track_id??''));if(!title||title.duration!==e.titleFrames||e.topTitle&&!(Number(title.transform?.y)<0))issues.push(`native top title ${JSON.stringify(e.title)} on Titles track for ${e.titleFrames} frames`)}
    if(requestedLocalTasks(this.prompt).includes('restore')){
      const before=[...(this.baseline?.clips??[])].filter(c=>c.kind==='video').sort((a,b)=>a.start-b.start)
      const next=this.restoredClipId?before.find(c=>c.id===this.restoredClipId):before.find((c,i)=>i>0&&c.asset_id===before[i-1].asset_id&&c.track_id===before[i-1].track_id&&Number(c.inPoint)>Number(before[i-1].inPoint)+before[i-1].duration)
      const previous=next?before[before.indexOf(next)-1]:undefined
      if(next&&previous&&next.inPoint!==undefined&&previous.inPoint!==undefined){
        const gap=next.inPoint-previous.inPoint-previous.duration,cut=previous.start+previous.duration,sourceFrom=previous.inPoint+previous.duration
        let covered=cut
        for(const c of clips.filter(c=>c.kind==='video'&&c.track_id===next.track_id&&c.asset_id===next.asset_id&&c.inPoint!==undefined&&Math.abs(c.inPoint-c.start-(sourceFrom-cut))<0.01).sort((a,b)=>a.start-b.start)){
          if(c.start<=covered)covered=Math.max(covered,c.start+c.duration)
        }
        if(gap>0&&covered<cut+gap)issues.push(`restore the actual original source interval ${sourceFrom}–${next.inPoint} (${gap} frames) across the synchronized timeline`)
      }else issues.push('identify the actual omitted source gap before claiming it restored')
      if(/\b(?:preserve|keep|retain)\b/i.test(this.prompt))for(const old of this.baseline?.clips??[]){
        const current=map.get(old.id)
        if(old.kind==='text'&&current?.text!==old.text)issues.push(`preserve existing text on ${old.id}`)
        if(old.kind==='video'&&(JSON.stringify(current?.keyframes)!==JSON.stringify(old.keyframes)||JSON.stringify(current?.transitionIn)!==JSON.stringify(old.transitionIn)))issues.push(`preserve existing zoom/transition properties on ${old.id}`)
      }
    }
    return issues
  }
  summary(){
    const s=this.state, captions=this.tracks('captions')
    return shorten(JSON.stringify({timeline_id:s?.timeline_id,fps:s?.settings?.fps,tracks:s?.tracks,media:s?.media,video:(s?.clips??[]).filter(c=>c.kind==='video').map(c=>({id:c.id,start:c.start,duration:c.duration,keyframes:c.keyframes,transitionIn:c.transitionIn})),first_captions:(s?.clips??[]).filter(c=>c.kind==='text'&&captions.has(c.track_id??'')).sort((a,b)=>a.start-b.start).slice(0,3).map(c=>({id:c.id,text:c.text,start:c.start,duration:c.duration}))}),3800)
  }
}

export function schemaAt(schema: Record<string, unknown>, path = ''): unknown {
  let node: unknown = schema
  for (const key of path.split('.').filter(Boolean)) {
    if (!node || typeof node !== 'object') throw new Error(`No schema at ${path}`)
    const record = node as Record<string, unknown>
    node = (record.properties as Record<string, unknown> | undefined)?.[key] ?? record[key]
    if (node === undefined) throw new Error(`No schema at ${path}; inspect its parent first.`)
  }
  return node
}

function shallowSchema(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const s = value as Record<string, unknown>, out: Record<string, unknown> = {}
  for (const key of ['type','enum','const','required','minimum','maximum','minItems','maxItems','default','additionalProperties']) {
    if (s[key] !== undefined && (typeof s[key] !== 'object' || ['type','enum','required'].includes(key))) out[key] = s[key]
  }
  if (typeof s.description === 'string') out.description = shorten(s.description, 240)
  if (s.properties && typeof s.properties === 'object') {
    const props = s.properties as Record<string, unknown>
    if (depth >= 1) out.available_properties = Object.keys(props)
    else out.properties = Object.fromEntries(Object.entries(props).map(([key, v]) => [key, shallowSchema(v, depth+1)]))
  }
  if (s.items) out.items = depth >= 1 ? { note: 'Inspect schema_path ending in .items.' } : shallowSchema(s.items, depth+1)
  for (const key of ['anyOf','oneOf','allOf']) if (Array.isArray(s[key])) out[key] = (s[key] as unknown[]).map(v => shallowSchema(v, depth))
  return out
}

export function describeLocalTool(tool: BridgeTool, path = '') {
  const schema = schemaAt(tool.inputSchema, path), full = JSON.stringify(schema)
  return { name: tool.name, description: shorten(tool.description ?? '', 1100), schema_path: path || '(root)', schema: full.length <= 5500 ? schema : shallowSchema(schema), ...(full.length > 5500 ? { note: 'Nested schema summarized. Use schema_path, e.g. patch.text or patch.audio, for exact fields. Native validation still uses full original schema.' } : {}) }
}

export function searchLocalTools(defs: BridgeTool[], query: string) {
  const words = query.toLowerCase().split(/\W+/).filter(Boolean)
  return defs.map(tool => {
    const name = tool.name.toLowerCase(), body = (tool.description ?? '').toLowerCase()
    const score = words.reduce((n,w) => n+(name === w ? 12 : name.includes(w) ? 5 : body.includes(w) ? 1 : 0),0)
    return { tool, score }
  }).filter(x => !words.length || x.score>0).sort((a,b) => b.score-a.score || a.tool.name.localeCompare(b.tool.name)).slice(0,12).map(x => ({ name:x.tool.name, description:shorten(x.tool.description ?? '',260) }))
}

function messageText(m: ModelMessage): string {
  if (typeof m.content === 'string') return m.content
  return m.content.map(part => {
    if (part.type === 'text') return part.text
    if (part.type === 'tool-call') return ''
    if (part.type === 'tool-result') return `Confirmed native result (historical, inspect current state): ${JSON.stringify(part.output)}`
    return ''
  }).filter(Boolean).join('\n')
}

/** Retain real creative briefs only. Fresh native snapshots supply operation IDs.
 * Small local models imitate historical prose/results as fake tool execution. */
export function localHistory(messages: ModelMessage[]): ModelMessage[] {
  return messages.filter(m=>m.role==='user'&&!isLocalRetryMessage(m)).slice(-2).map(m=>({role:'user',content:shorten(messageText(m),1400)}))
}

/** Runtime repair instructions are never a user's creative brief on a later turn. */
export function isLocalRetryMessage(m:ModelMessage):boolean {
  return m.role==='user'&&/^(?:\[Local native stage\]|Your last response contained no usable text or tool calls\.|The original request is NOT complete\.|The previous response contained no executable native tool call\.)/.test(messageText(m))
}

/** Bound in-turn exchange, dropping complete call/result pairs rather than orphaning them. */
export function compactLocalMessages(messages: ModelMessage[], maxChars=14000): ModelMessage[] {
  const normalized = messages.map(m => {
    if(m.role==='assistant'&&Array.isArray(m.content)&&m.content.some(p=>p.type==='tool-call'))return {...m,content:m.content.filter(p=>p.type==='tool-call')} as ModelMessage
    if (m.role==='tool') return {...m,content:m.content.map(p => p.type==='tool-result' && p.output.type==='text' ? {...p,output:{type:'text' as const,value:shorten(p.output.value,p.toolName==='find_retakes'?8000:3600)}}:p)} as ModelMessage
    if (typeof m.content==='string') return {...m,content:shorten(m.content,6000)} as ModelMessage
    if (m.role==='user') {
      // Attachments precede the actual request. Reserve room for that final
      // request instead of allowing a pasted document to consume the context.
      let budget=6000
      const content=[...m.content].reverse().map(p=>{
        if(p.type!=='text') return p
        const text=shorten(p.text,Math.max(0,budget));budget=Math.max(0,budget-text.length)
        return {...p,text}
      }).reverse()
      return {...m,content} as ModelMessage
    }
    return m
  })
  if (JSON.stringify(normalized).length<=maxChars) return normalized
  let lastUser=normalized.length-1
  while(lastUser>0 && normalized[lastUser].role!=='user') lastUser--
  const history=localHistory(normalized.slice(0,lastUser)), current=normalized.slice(lastUser), groups:ModelMessage[][]=[]
  for(let i=1;i<current.length;i++) {
    const group=[current[i]]
    if(current[i].role==='assistant' && current[i+1]?.role==='tool') group.push(current[++i])
    groups.push(group)
  }
  const kept:ModelMessage[][]=[]; let budget=maxChars-JSON.stringify(current[0]??{}).length-1500
  for(const group of [...groups].reverse()) {
    const size=JSON.stringify(group).length
    if(size>budget) break
    kept.unshift(group);budget-=size
  }
  const note:ModelMessage[]=kept.length<groups.length?[{role:'assistant',content:'Earlier native tool steps completed in this turn. Results remain cached by result_id; inspect current state before dependent edits.'}]:[]
  return [...(JSON.stringify(history).length<budget?history:[]),...(current[0]?[current[0]]:[]),...note,...kept.flat()]
}

export function valueAt(value: unknown, path: string): unknown {
  let node=value
  for(const key of path.split('.').filter(Boolean)) {
    if(!node || typeof node!=='object' || !Object.hasOwn(node,key)) throw new Error(`No result at ${path}`)
    node=(node as Record<string,unknown>)[key]
  }
  return node
}
