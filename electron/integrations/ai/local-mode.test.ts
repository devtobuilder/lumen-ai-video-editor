import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import { localTools, retakeModelContext, canonicalDirectArguments, localPhaseInstructions, LocalToolFailureGuard, allowsNativePreparation, existingNativeEditingPlan, LocalNativeToolQueue, localFinishingPlan, LocalPreparationGate, requiredToolChoiceMiss, validateNativeArguments, describeLocalTool, schemaAt, localHistory, compactLocalMessages, valueAt, searchLocalTools, directLocalTools, requestedLocalTasks, newLocalProgress, recordLocalAction, pendingLocalTasks, localWireFrame, LocalNativeGuard, type NativeStateSnapshot } from './local-mode'
// Resolve the real command registry at test runtime without pulling renderer
// aliases into the separate Electron TypeScript program.
const commandModulePath='../../../src/editor/commands'
const {toolDefinitions}=await import(commandModulePath)

const tool=(name:string,description=name,inputSchema:Record<string,unknown>={type:'object',properties:{}})=>({name,description,inputSchema})
describe('Local native editor access',()=>{
  it('offers only high-confidence retake IDs and canonicalizes truly parameterless direct operations',()=>{
    const context=retakeModelContext({finding_id:'actual',candidates:[{id:'good',confidence:'high',attempts:[{id:'good_a',start:0,end:1,text:'Complete.'}]},{id:'review',confidence:'review',reason:'Uncertain',attempts:[{id:'review_a',start:2,end:3,text:'Maybe.'}]}]})
    expect(JSON.stringify(context.finding)).not.toContain('review_a')
    expect(()=>validateNativeArguments(tool('apply_retakes','',context.inputSchema),{finding_id:'actual',keep_attempt_ids:['review_a']})).toThrow()
    expect(()=>validateNativeArguments(tool('apply_retakes','',context.inputSchema),{finding_id:'actual',keep_attempt_ids:['good_a']})).not.toThrow()
    expect(canonicalDirectArguments(tool('enhance_local_voice'),{clip_id:'invented',force:true})).toEqual({args:{},discarded:['clip_id','force']})
    expect(canonicalDirectArguments(tool('selected','',{type:'object',properties:{clip_ids:{type:'array'}}}),{wrong:1}).args).toEqual({wrong:1})
  })
  it('gives restricted phases compact actionable instructions instead of unavailable workflow catalogs',()=>{
    const phase=localPhaseInstructions(['find_retakes'])
    expect(phase).toContain('call find_retakes with empty arguments')
    expect(phase).not.toContain('prepare_native_short')
    expect(phase).not.toContain('lumen_search_tools')
    expect(phase.length).toBeLessThan(1500)
    expect(localHistory([{role:'user',content:'The previous response contained no executable native tool call. Use available tools.'},{role:'user',content:'Keep my original cuts.'}])).toEqual([{role:'user',content:'Keep my original cuts.'}])
  })
  it('uses only actual keep attempt IDs for direct retake decisions and halts repeated invalid calls',()=>{
    const schema=directLocalTools([tool('apply_retakes')],'Remove repeated takes.')[0].inputSchema
    expect(Object.keys(schema.properties as object)).toEqual(['finding_id','keep_attempt_ids'])
    const failure=new LocalToolFailureGuard(),args={finding_id:'f',keep_attempt_ids:['wrong']}
    expect(failure.record('apply_retakes',args,'Unknown ID')).toBeUndefined()
    expect(failure.record('apply_retakes',args,'Unknown ID')?.message).toContain('Stopped repeated invalid native call')
    expect(failure.record('apply_retakes',{finding_id:'f',keep_attempt_ids:['valid']},'Different issue')).toBeUndefined()
  })
  it('separates retake candidate inspection from explicit model-selected native cuts',()=>{
    const prompt='Remove abandoned retakes and repeated phrases while preserving meaning.'
    expect(requestedLocalTasks(prompt)).toEqual(['retake-review','retakes'])
    const p=newLocalProgress();recordLocalAction(p,'find_retakes',{}, {actionable_count:3})
    expect(p.mutation).toBe(0);expect(pendingLocalTasks(prompt,p)).toEqual(['retakes'])
    expect(existingNativeEditingPlan(prompt,{clips:[{id:'source',kind:'video',start:0,duration:300}]},p)).toEqual(['apply_retakes'])
    recordLocalAction(p,'apply_retakes',{}, {applied:true});recordLocalAction(p,'get_editing_state',{})
    expect(pendingLocalTasks(prompt,p)).toEqual([]);expect(p.mutation).toBe(1)
    const none=newLocalProgress();recordLocalAction(none,'find_retakes',{}, {actionable_count:0})
    expect(pendingLocalTasks(prompt,none)).toEqual([]);expect(none.mutation).toBe(0)
  })
  it('requires native pause edits for natural speaking-gap requests and never treats inspection as a generic edit',()=>{
    const prompt="There's a lot of gaps in speaking, fix those"
    expect(requestedLocalTasks(prompt)).toEqual(['cuts'])
    expect(directLocalTools([tool('remove_pauses')],prompt).map(t=>t.name)).toContain('remove_pauses')
    const pauseDef=tool('remove_pauses','',{type:'object',properties:{clip_ids:{type:'array',items:{type:'string'}},min_gap_seconds:{type:'number',minimum:0.2,maximum:5}},additionalProperties:false})
    expect(Object.keys(directLocalTools([pauseDef],prompt)[0].inputSchema.properties as object)).toEqual([])
    expect(Object.keys(directLocalTools([pauseDef],'Remove pauses in the selected clips.')[0].inputSchema.properties as object)).toContain('clip_ids')
    const zero=newLocalProgress();recordLocalAction(zero,'remove_pauses',{}, {pauses_removed:0,seconds_saved:0})
    expect(pendingLocalTasks(prompt,zero)).toEqual([]);expect(zero.mutation).toBe(0)
    const p=newLocalProgress();recordLocalAction(p,'get_editing_state',{})
    expect(pendingLocalTasks(prompt,p)).toContain('cuts')
    expect(pendingLocalTasks('Fix the awkward framing please.',p)).toContain('a native editing action; inspecting state alone does not apply the requested edit')
    expect(pendingLocalTasks('How do I fix the framing?',p)).toEqual([])
    expect(pendingLocalTasks('Show me how to edit this.',p)).toEqual([])
    expect(pendingLocalTasks('Do not edit anything. Describe the timeline.',p)).toEqual([])
    recordLocalAction(p,'remove_pauses',{});recordLocalAction(p,'get_editing_state',{})
    expect(pendingLocalTasks(prompt,p)).toEqual([])
  })
  it('applies and verifies requested dissolves at every existing cut instead of forcing the first boundary',()=>{
    const guard=new LocalNativeGuard('Use smooth 0.2-second dissolve transitions at existing cuts.')
    const state:NativeStateSnapshot={timeline_id:'cuts',settings:{fps:30},clips:Array.from({length:6},(_,i)=>({id:`v${i}`,kind:'video',track_id:'main',start:i*100,duration:100}))}
    guard.update([state]);expect(guard.pending()).toHaveLength(5)
    for(let i=1;i<6;i++){
      expect(()=>guard.before('set_native_transition',{clip_id:`v${i}`,kind:'dissolve',duration_seconds:0.2})).not.toThrow()
      state.clips![i].transitionIn={kind:'dissolve',duration:6};guard.update([state])
      expect(guard.pending()).toHaveLength(5-i)
    }
  })
  it('edits an existing six-cut timeline directly and never rebuilds it without new sequence authorization',()=>{
    const state:NativeStateSnapshot={timeline_id:'sixcuts',clips:Array.from({length:6},(_,i)=>({id:`shot${i}`,kind:'video',start:i*180,duration:180,inPoint:382+i*240,asset_id:'original'}))}
    const prompt='Add attractive captions, smooth dissolve transitions and improve my mic quality.'
    const defs=[...toolDefinitions(),tool('prepare_native_short'),tool('add_captions','Native captions',{type:'object',properties:{style:{type:'string',enum:['clean','bold','word','boxed']},max_words:{type:'number',minimum:1,maximum:16},size:{type:'number'}},additionalProperties:false}),tool('get_transcript'),tool('enhance_local_voice'),tool('set_native_transition')]
    const direct=directLocalTools(defs,prompt,state).map(t=>t.name)
    expect(direct).toEqual(expect.arrayContaining(['add_captions','get_transcript','enhance_local_voice','set_native_transition']))
    expect(direct).not.toContain('prepare_native_short')
    const captionSchema=directLocalTools(defs,prompt,state).find(t=>t.name==='add_captions')!.inputSchema;expect(Object.keys(captionSchema.properties as object)).toEqual(['style'])
    const guard=new LocalNativeGuard(prompt);guard.update([state])
    expect(()=>guard.before('prepare_native_short',{asset_id:'original'})).toThrow('already contains native edits')
    expect(allowsNativePreparation('Create a new sequence from the recording.',state)).toBe(true)
    expect(allowsNativePreparation('Do not create a new sequence or add titles.',state)).toBe(false)
    const actual='Edit this EXISTING timeline: add bold animated captions, improve microphone quality with strong local fan-noise suppression, and use smooth short 0.2-second dissolve transitions at the existing cuts. Preserve all six cuts, linked voice timing and this timeline. Do not create a new sequence or add titles. Do not export.'
    expect(existingNativeEditingPlan(actual,state,newLocalProgress())).toEqual(['add_captions'])
    const plan=existingNativeEditingPlan(prompt,state,newLocalProgress())!
    expect(plan).toEqual(['add_captions'])
    const progress=newLocalProgress();recordLocalAction(progress,'add_captions',{});recordLocalAction(progress,'set_native_transition',{});expect(existingNativeEditingPlan(prompt,state,progress)).toContain('enhance_local_voice')
    expect(plan.some(n=>n.startsWith('lumen_'))).toBe(false)
  })
  it('serializes dependent preparation, transcript and title calls and releases after errors/cancellation',async()=>{
    const queue=new LocalNativeToolQueue(),events:string[]=[]
    let release!:()=>void
    const prepared=new Promise<void>(resolve=>{release=resolve})
    const first=queue.run(async()=>{events.push('prepare:start');await prepared;events.push('prepare:done')})
    const transcript=queue.run(()=>{events.push('transcript')})
    const title=queue.run(()=>{events.push('title')})
    await Promise.resolve();expect(events).toEqual(['prepare:start'])
    release();await Promise.all([first,transcript,title])
    expect(events).toEqual(['prepare:start','prepare:done','transcript','title'])
    await expect(queue.run(()=>{throw new Error('native failed')})).rejects.toThrow('native failed')
    const cancelled=new AbortController();cancelled.abort()
    await expect(queue.run(()=>{events.push('must not run')},cancelled.signal)).rejects.toMatchObject({name:'AbortError'})
    await queue.run(()=>events.push('after failure and cancel'))
    expect(events).not.toContain('must not run')
    expect(events.at(-1)).toBe('after failure and cancel')
  })
  it('exposes explicit local microphone enhancement without replacing initial default voice cleanup',()=>{
    const defs=[tool('enhance_local_voice'),tool('prepare_native_short'),tool('clip_replaceAsset'),tool('timeline_restoreSourceGap')]
    expect(localTools(defs)).toHaveLength(4)
    expect(requestedLocalTasks('Fix my microphone quality and make the voice cleaner.')).toContain('audio')
    expect(directLocalTools(defs,'Fix my microphone quality.').map(t=>t.name)).toContain('enhance_local_voice')
    expect(directLocalTools(defs,'Create a short from this recording with clean voice audio.').map(t=>t.name)).not.toContain('enhance_local_voice')
    const p=newLocalProgress();recordLocalAction(p,'enhance_local_voice',{});recordLocalAction(p,'get_editing_state',{})
    expect(pendingLocalTasks('Improve my mic quality.',p)).toEqual([])
  })
  it('does not rebuild an asset after an SDK retry and still requires the missing native title/transcript',async()=>{
    const gate=new LocalPreparationGate(),progress=newLocalProgress(),args={asset_id:'original',punch_in:true,remove_pauses:true,clean_audio:true}
    let preparations=0
    const execute=async(name:string,input:Record<string,unknown>)=>{gate.before(name,input);if(name==='prepare_native_short')preparations++;recordLocalAction(progress,name,input)}
    await execute('prepare_native_short',args)
    // Same gate is retained when the SDK required-tool choice fails and retries.
    await expect(execute('prepare_native_short',args)).rejects.toThrow('already started')
    expect(preparations).toBe(1)
    const plan=localFinishingPlan('Create captions with zoom. Add a title. Review the transcript.',progress,true)
    expect(plan?.next).toBe('get_transcript');expect(plan?.tools).not.toContain('lumen_call');expect(plan?.tools).not.toContain('prepare_native_short')
    expect(gate.started).toBe(true)
    const prompt='Create a short with captions and zoom. Add a title. Review the transcript.'
    expect(pendingLocalTasks(prompt,progress)).toEqual(expect.arrayContaining(['title','transcript']))
    await execute('add_title',{text:'Native title'})
    await execute('get_transcript',{asset_id:'original'})
    expect(localFinishingPlan(prompt,progress,true)).toBeUndefined()
    await execute('get_editing_state',{})
    expect(pendingLocalTasks(prompt,progress)).toEqual([])
    // Reserve synchronously before invoking renderer so parallel duplicated calls fail too.
    const parallel=new LocalPreparationGate();parallel.before('prepare_native_short',args)
    expect(()=>parallel.before('prepare_native_short',args)).toThrow('already started')
  })
  it('recognizes a required tool-choice miss without treating other model or tool errors as recoverable',()=>{
    expect(requiredToolChoiceMiss({name:'AI_ToolChoiceViolationError',toolChoice:{type:'required'}})).toBe(true)
    expect(requiredToolChoiceMiss(new Error('Model response did not contain a tool call even though tool choice was required.'))).toBe(true)
    expect(requiredToolChoiceMiss({name:'AI_ToolChoiceViolationError',toolChoice:{type:'tool'}})).toBe(false)
    expect(requiredToolChoiceMiss(new Error('Invalid native clip id'))).toBe(false)
    expect(requiredToolChoiceMiss(null)).toBe(false)
    expect(pendingLocalTasks('Add a title',newLocalProgress())).toContain('title')
  })
  it('validates broker fields, nested unknown keys and native export enums before renderer execution',()=>{
    const def=tool('export_video','',{type:'object',properties:{file_name:{type:'string'},resolution:{type:'integer',enum:[1080,720]},codec:{type:'string',enum:['avc','hevc']},quality:{type:'integer',minimum:10,maximum:100}},additionalProperties:false})
    expect(()=>validateNativeArguments(def,{filename:'bad.mp4',width:1080,export_type:'video'})).toThrow('Unrecognized keys')
    expect(()=>validateNativeArguments(def,{file_name:'good.mp4',resolution:1080,codec:'avc',quality:80})).not.toThrow()
    expect(()=>validateNativeArguments(def,{codec:'h264'})).toThrow('codec')
    expect(()=>validateNativeArguments(tool('native','',{type:'object',properties:{patch:{type:'object',properties:{x:{type:'number'}},additionalProperties:false}},required:['patch'],additionalProperties:false}),{patch:{typo:1}})).toThrow('patch')
    expect(requestedLocalTasks('Export the current timeline as MP4.')).toEqual(['export'])
    expect(requestedLocalTasks('Do not render or export yet.')).toEqual([])
    expect(directLocalTools([def],'Export the current timeline as MP4.').map(t=>t.name)).toContain('export_video')
    const progress=newLocalProgress();recordLocalAction(progress,'export_video',{}, {exported:false});expect(pendingLocalTasks('Export the current timeline as MP4.',progress)).toContain('export');recordLocalAction(progress,'export_video',{}, {exported:true})
    expect(pendingLocalTasks('Export the current timeline as MP4.',progress)).toEqual([])
  })
  it('rejects wrong caption IDs, invented zoom endpoints and seconds treated as frames before mutation',()=>{
    const prompt='On the current native timeline, change the first caption to Meet Robin. Reduce the existing punch-in endpoint scale to 1.04. Add a 0.2-second dissolve at the existing jump cut and a native top title GARDEN JOURNAL for 2 seconds. Keep this same timeline.'
    const guard=new LocalNativeGuard(prompt)
    const state:NativeStateSnapshot={timeline_id:'native1',settings:{fps:30},tracks:[{id:'captions',role:'captions'},{id:'titles',role:'titles'},{id:'main',role:'main'}],clips:[{id:'c1',kind:'text',track_id:'captions',start:0,duration:30,text:'Hey my name'},{id:'v1',kind:'video',track_id:'main',start:0,duration:1099,keyframes:{}},{id:'v2',kind:'video',track_id:'main',start:1099,duration:99,keyframes:{scale:[{frame:0,value:1,easing:'cubic-in-out'},{frame:98,value:1.088,easing:'cubic-in-out'}]}}]}
    guard.update([state])
    expect(()=>guard.before('clip_update',{ids:['v1'],patch:{text:{content:'Meet Robin'}}})).toThrow('not text')
    expect(()=>guard.before('keyframe_set',{clipId:'v1',prop:'scale',frame:10,value:1.04})).toThrow('existing multi-keyframe')
    expect(()=>guard.before('keyframe_set',{clipId:'v2',prop:'scale',frame:10,value:1.04})).toThrow('frame 98')
    expect(()=>guard.before('clip_setTransition',{id:'v2',transition:{kind:'dissolve',duration:15}})).toThrow('6 frames')
    expect(()=>guard.before('add_title',{text:'GARDEN JOURNAL',position:'top',duration_seconds:2,track_id:'captions'})).toThrow('titles-role')
    expect(()=>guard.before('set_native_zoom_endpoint',{clip_id:'v2',scale:1.04})).not.toThrow()
    expect(()=>guard.before('set_native_transition',{clip_id:'v2',kind:'dissolve',duration_seconds:0.2})).not.toThrow()
    expect(()=>guard.before('prepare_native_short',{asset_id:'raw'})).toThrow('same timeline')
    expect(guard.pending()).toHaveLength(4)
    const updated=JSON.parse(JSON.stringify(state)) as NativeStateSnapshot
    updated.clips![0].text='Meet Robin'
    updated.clips![2].keyframes!.scale[1].value=1.04
    updated.clips![2].transitionIn={kind:'dissolve',duration:6}
    updated.clips!.push({id:'t1',kind:'text',track_id:'titles',start:0,duration:60,text:'GARDEN JOURNAL',transform:{y:-600}})
    guard.update([updated])
    expect(guard.pending()).toEqual([])
    updated.clips![2].transitionIn!.duration=15
    guard.update([updated])
    expect(guard.pending().join(' ')).toContain('6 frames')
  })
  it('can incorporate a caption beyond the first state page and retain its original value for follow-ups',()=>{
    const guard=new LocalNativeGuard('Change the last caption color.')
    guard.update([{timeline_id:'long',settings:{fps:30},tracks:[{id:'caps',role:'captions'}],clips:[{id:'first',kind:'text',track_id:'caps',start:0,duration:30,text:'First'}]}])
    guard.addDetailedClips([{id:'caption_500',kind:'text',trackId:'caps',start:15000,duration:30,text:{content:'Last'}}])
    expect(()=>guard.before('clip_update',{ids:['caption_500'],patch:{text:{color:'#ffff00'}}})).not.toThrow()
    expect(guard.state?.clips?.find(c=>c.id==='caption_500')?.text).toBe('Last')
    expect(guard.baseline?.clips?.find(c=>c.id==='caption_500')?.text).toBe('Last')
    guard.addDetailedClips([{id:'caption_500',kind:'text',trackId:'caps',start:15000,duration:30,text:{content:'Revised'}}])
    expect(guard.state?.clips?.find(c=>c.id==='caption_500')?.text).toBe('Revised')
    expect(guard.baseline?.clips?.find(c=>c.id==='caption_500')?.text).toBe('Last')
  })
  it('retains bounded response diagnostics without request bodies or authentication headers',()=>{
    const raw={headers:{authorization:'Bearer SECRET'},request:{api_key:'SECRET'},choices:[{index:0,delta:{content:'done',tool_calls:[{index:0,type:'function',function:{name:'clip_update',arguments:'x'.repeat(10000)}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:100,api_key:'SECRET'}}
    const frame=localWireFrame(raw)
    expect(JSON.stringify(frame)).not.toContain('SECRET')
    expect(JSON.stringify(frame)).not.toContain('authorization')
    expect(JSON.stringify(frame)).toContain('clip_update')
    expect(JSON.stringify(frame).length).toBeLessThan(3000)
  })
  it('promotes real caption, zoom and transition schemas without the giant patch catalog',()=>{
    const defs=toolDefinitions()
    const prompt='Change the first caption to Meet Robin, reduce an existing punch-in keyframe endpoint to 1.04, add a 0.2 second dissolve transition and add the title GARDEN JOURNAL.'
    const core=directLocalTools(defs,prompt)
    expect(core.map(t=>t.name)).toEqual(expect.arrayContaining(['clip_update','keyframe_set','clip_setTransition']))
    const update=core.find(t=>t.name==='clip_update')!
    const patch=schemaAt(update.inputSchema,'patch') as {properties:Record<string,unknown>}
    expect(Object.keys(patch.properties)).toEqual(expect.arrayContaining(['text','transform']))
    expect(patch.properties.masks).toBeUndefined()
    expect(JSON.stringify(core).length).toBeLessThanOrEqual(8200)
    expect(localTools(defs).find(t=>t.name==='clip_update')!.inputSchema).not.toEqual(update.inputSchema)
  })
  it('does not declare a prepared short complete before requested title, transcript inspection and verification',()=>{
    const prompt='Create a native short with animated bold captions, subtle punch-in keyframes and voice cleanup. Remove long pauses and inspect the transcript for mistakes. Add a native title.'
    const progress=newLocalProgress()
    recordLocalAction(progress,'prepare_native_short',{})
    expect(pendingLocalTasks(prompt,progress)).toEqual(expect.arrayContaining(['title','transcript','verification of the final native changes']))
    recordLocalAction(progress,'get_transcript',{})
    recordLocalAction(progress,'add_title',{text:'GARDEN JOURNAL'})
    expect(pendingLocalTasks(prompt,progress)).toEqual(['verification of the final native changes'])
    recordLocalAction(progress,'get_editing_state',{})
    expect(pendingLocalTasks(prompt,progress)).toEqual([])
  })
  it('does not force a title or transition explicitly ruled out',()=>{
    expect(requestedLocalTasks('Make a short. No title. No transitions. Do not export.')).not.toContain('title')
    expect(requestedLocalTasks('Make captions without a title or transitions.')).not.toContain('title')
    expect(requestedLocalTasks('Use clean jump cuts, no flashy transitions.')).not.toContain('transition')
    expect(requestedLocalTasks('Restore the removed pause. Keep existing captions, title, zoom and dissolve.')).toEqual(['restore'])
    expect(requestedLocalTasks('Keep the title position but change the first caption to Meet Robin.')).toEqual(['captions'])
    expect(requestedLocalTasks('Select the first caption.')).toEqual([])
    expect(requestedLocalTasks('Show the title and zoom keyframes.')).toEqual([])
    expect(requestedLocalTasks('Restore the omitted 1.1 seconds of original source between the two video shots. Preserve Meet Robin, the GARDEN JOURNAL title, the reduced zoom and the dissolve. Insert time across all tracks so captions stay synchronized, then fill that interval from the original recording. Keep the same timeline and verify the native properties. Do not export.')).toEqual(['restore'])
  })
  it('requires fresh verification after a subsequent caption or zoom correction',()=>{
    const p=newLocalProgress()
    recordLocalAction(p,'clip_update',{ids:['caption1'],patch:{text:{content:'Meet Robin'}}})
    recordLocalAction(p,'get_clip',{clip_id:'caption1'})
    expect(pendingLocalTasks('Change the first caption to Meet Robin',p)).toEqual([])
    recordLocalAction(p,'keyframe_set',{clipId:'video1',property:'scale',frame:30,value:1.04})
    expect(pendingLocalTasks('Reduce the existing zoom to 1.04',p)).toContain('verification of the final native changes')
  })
  it('exposes native editing and perception but blocks flattened shortcut, paid/cloud/web and external MCP',()=>{
    const names=['get_editing_state','prepare_native_short','clip_update','keyframe_set','clip_trim','timeline_insertRange','get_frame','render_blender_script','edit_local_short','web_search','generate_image','generate_music','external_mcp_upload']
    expect(localTools(names.map(n=>tool(n))).map(t=>t.name)).toEqual(names.slice(0,8))
  })
  it('discovers appropriate tools and exposes exact nested patch schema',()=>{
    const defs=[tool('clip_update','Change caption text and style'),tool('keyframe_set','Camera zoom keyframe'),tool('clip_trim','Trim a cut')]
    expect(searchLocalTools(defs,'caption text')[0].name).toBe('clip_update')
    const schema={type:'object',properties:{ids:{type:'array',items:{type:'string'}},patch:{type:'object',properties:{text:{type:'object',properties:{content:{type:'string'}}},audio:{type:'object',properties:{denoise:{type:'boolean'}}}}}},required:['ids','patch']}
    expect(schemaAt(schema,'patch.text')).toEqual(schema.properties.patch.properties.text)
    expect(describeLocalTool(tool('clip_update','',schema),'patch.audio').schema).toEqual(schema.properties.patch.properties.audio)
    expect(()=>schemaAt(schema,'patch.imaginary')).toThrow('No schema')
  })
  it('keeps follow-up operation IDs and user references without orphaned tool messages',()=>{
    const messages:ModelMessage[]=[{role:'user',content:'Add a caption saying Hello'},{role:'assistant',content:[{type:'tool-call',toolCallId:'a',toolName:'lumen_call',input:{name:'add_title',arguments:{text:'Hello'}}}]},{role:'tool',content:[{type:'tool-result',toolCallId:'a',toolName:'lumen_call',output:{type:'text',value:'{"result":{"clip_id":"caption_17"}}'}}]},{role:'assistant',content:'Added the caption.'}]
    const compact=localHistory(messages)
    expect(JSON.stringify(compact)).not.toContain('caption_17')
    expect(JSON.stringify(compact)).toContain('Hello')
    expect(compact.some(m=>m.role==='tool')).toBe(false)
    expect(JSON.stringify(compact)).not.toContain('Called ')
  })
  it('does not teach fake tool calls or persist internal retry prompts as user briefs',()=>{
    const compact=localHistory([{role:'user',content:'Keep edits native.'},{role:'assistant',content:'Called prepare_native_short: {"asset_id":"asset1"}'},{role:'user',content:'The original request is NOT complete. Still missing verified native actions: transcript.'},{role:'user',content:'Your last response contained no usable text or tool calls. Retry.'}])
    expect(compact).toEqual([{role:'user',content:'Keep edits native.'}])
    expect(requestedLocalTasks('Review the source transcript. Tighten remaining pauses. Keep existing zoom and transitions.')).toEqual(['cuts','transcript'])
    expect(requestedLocalTasks('Review the source transcript for unmistakable abandoned false starts or repeated takes. Tighten remaining pauses longer than 0.6 seconds with native pause removal. Remove only clear mistakes while preserving meaning. Preserve the existing caption wording, GARDEN JOURNAL title, 1.04 zoom and short dissolve. Keep this same editable timeline. Do not export.')).toEqual(['cuts','transcript','retake-review','retakes'])
    const profile=directLocalTools([...toolDefinitions(),tool('get_transcript'),tool('remove_pauses'),tool('prepare_native_short'),tool('add_title'),tool('set_native_zoom_endpoint'),tool('set_native_transition')],'Review the source transcript for unmistakable abandoned false starts or repeated takes. Tighten remaining pauses longer than 0.6 seconds with native pause removal. Remove only clear mistakes while preserving meaning. Preserve the existing caption wording, GARDEN JOURNAL title, 1.04 zoom and short dissolve. Keep this same editable timeline. Do not export.').map(t=>t.name)
    expect(profile).toEqual(expect.arrayContaining(['get_transcript','remove_pauses','timeline_removeRange']))
    for(const name of ['prepare_native_short','add_title','set_native_zoom_endpoint','set_native_transition','clip_update'])expect(profile).not.toContain(name)
  })
  it('bounds long in-turn context and keeps assistant/tool pairs together',()=>{
    const messages:ModelMessage[]=[{role:'user',content:'Make native edits'}]
    for(let i=0;i<20;i++) messages.push({role:'assistant',content:[{type:'tool-call',toolCallId:`c${i}`,toolName:'lumen_call',input:{name:'get_clip',arguments:{clip_id:`clip_${i}`}}}]},{role:'tool',content:[{type:'tool-result',toolCallId:`c${i}`,toolName:'lumen_call',output:{type:'text',value:JSON.stringify({id:`clip_${i}`,data:'x'.repeat(6000)})}}]})
    const compact=compactLocalMessages(messages,14000)
    expect(JSON.stringify(compact).length).toBeLessThan(14000)
    const ids=new Set(compact.flatMap(m=>Array.isArray(m.content)?m.content.filter(p=>p.type==='tool-call').map(p=>(p as {toolCallId:string}).toolCallId):[]))
    for(const m of compact) if(m.role==='tool') for(const p of m.content) if(p.type==='tool-result') expect(ids.has(p.toolCallId)).toBe(true)
    expect(JSON.stringify(compact)).toContain('clip_19')
  })
  it('retains the creative brief even after a long sequence of native operations',()=>{
    const messages:ModelMessage[]=[{role:'user',content:'Use yellow captions and restrained zooms.'}]
    for(let i=0;i<30;i++) messages.push({role:'assistant',content:`Confirmed operation ${i} `+'x'.repeat(1000)})
    const history=localHistory(messages)
    expect(JSON.stringify(history)).toContain('Use yellow captions and restrained zooms.')
    expect(JSON.stringify(history)).not.toContain('Confirmed operation 29')
    expect(JSON.stringify(history).length).toBeLessThan(6500)
  })
  it('reads cached result paths without requiring another mutating call',()=>{
    expect(valueAt({tracks:[{clips:[{id:'clip_2'}]}]},'tracks.0.clips.0.id')).toBe('clip_2')
    expect(()=>valueAt({},'missing')).toThrow()
  })
})


















 it('routes de-essing and sharp S sound edit prompts to local voice enhancement',()=>{
   for(const prompt of ["Fix sharp S sounds in my voice", "The s sounds are harsh; soften them", "De-ess the dialogue", "Reduce sibilance"]){
     expect(requestedLocalTasks(prompt)).toContain('audio')
     expect(existingNativeEditingPlan(prompt,{clips:[{id:'v',kind:'video',start:0,duration:90}],tracks:[],media:[]} as NativeStateSnapshot,newLocalProgress())).toEqual(['enhance_local_voice'])
   }
   expect(requestedLocalTasks('Explain de-essing')).not.toContain('audio')
   expect(requestedLocalTasks('Do not de-ess the audio')).not.toContain('audio')
   expect(requestedLocalTasks('Make sharp cuts')).not.toContain('audio')
 })
