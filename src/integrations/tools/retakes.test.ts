import {beforeEach,expect,it,vi} from 'vitest'
vi.mock('@/project/transcribe',()=>({transcribeMedia:vi.fn()}))
import {transcribeMedia} from '@/project/transcribe'
import {createEmptyProject} from '@/editor/new-project'
import {dispatch,getProject,useEditor} from '@/editor/store'
import {RETAKE_TOOLS} from './retakes'
const tool=(name:string)=>RETAKE_TOOLS.find(t=>t.name===name)!
beforeEach(()=>{
  vi.mocked(transcribeMedia).mockReset()
  useEditor.getState().loadProject(createEmptyProject('Retakes',{width:1080,height:1920,fps:30}))
  const main=getProject().tracks.find(t=>t.role==='main')!.id
  dispatch('track.update',{id:main,patch:{magnetic:false}})
  dispatch('asset.add',{asset:{id:'raw',name:'Speech',kind:'video',duration:12,hasAudio:true,addedAt:0,source:{type:'file',url:'test',mime:'video/mp4',fileName:'test.mp4',size:1},transcript:[{start:0.5,end:1.5,text:'I am a software'},{start:3,end:4.5,text:'I am a software student'},{start:6,end:10,text:'I am a software student building useful things every day.'}]}})
  dispatch('clip.add',{id:'video',kind:'video',assetId:'raw',trackId:main,start:0,duration:360})
  dispatch('clip.detachAudio',{ids:['video']})
  const caps=(dispatch('track.add',{kind:'video',name:'Captions',role:'captions'}) as {result:string}).result
  dispatch('clip.add',{id:'caption',kind:'text',trackId:caps,start:180,duration:60,patch:{text:{content:'Keep this wording'}}})
})
it('automatically transcribes fresh timeline media locally before retake review and reuses the cache',async()=>{
  const transcript=getProject().assets.raw.transcript!
  dispatch('asset.update',{id:'raw',patch:{transcript:[]}})
  const controller=new AbortController(),progress=vi.fn()
  vi.mocked(transcribeMedia).mockImplementation(async(id,opts)=>{
    opts?.onProgress?.(0.5)
    dispatch('asset.update',{id,patch:{transcript}})
    return transcript
  })
  const found=await tool('find_retakes').run({},{signal:controller.signal,progress}) as {actionable_count:number}
  expect(found.actionable_count).toBeGreaterThan(0)
  expect(transcribeMedia).toHaveBeenCalledOnce()
  expect(transcribeMedia).toHaveBeenCalledWith('raw',expect.objectContaining({using:'local',signal:controller.signal,onProgress:expect.any(Function)}))
  expect(progress).toHaveBeenCalledWith('CUDA transcription 50%')
  await tool('find_retakes').run({})
  expect(transcribeMedia).toHaveBeenCalledOnce()
})
it('rejects project changes while local transcription is pending before publishing findings',async()=>{
  dispatch('asset.update',{id:'raw',patch:{transcript:[]}})
  vi.mocked(transcribeMedia).mockImplementation(async()=>{
    useEditor.getState().loadProject(createEmptyProject('Different project'))
    return []
  })
  await expect(tool('find_retakes').run({})).rejects.toThrow('active project or timeline changed')
})
it('requires explicit kept attempt decisions and removes earlier takes with linked voice/captions in one undo',async()=>{
  const before=JSON.stringify(getProject())
  const found=await tool('find_retakes').run({}) as {finding_id:string;candidates:{id:string;keepId:string;confidence:string}[]}
  expect(JSON.stringify(getProject())).toBe(before)
  const candidate=found.candidates.find(c=>c.confidence==='high')!
  expect(candidate).toBeDefined()
  const history=useEditor.getState().past.length
  const applied=await tool('apply_retakes').run({finding_id:found.finding_id,keep_attempt_ids:[candidate.keepId]}) as {applied:boolean;seconds_saved:number}
  expect(applied.applied).toBe(true);expect(applied.seconds_saved).toBeGreaterThan(4)
  expect(getProject().clips.caption.text?.content).toBe('Keep this wording')
  expect(getProject().clips.caption.start).toBeLessThan(60)
  const video=Object.values(getProject().clips).filter(c=>c.kind==='video'),audio=Object.values(getProject().clips).filter(c=>c.kind==='audio')
  expect(audio.map(c=>[c.start,c.duration,c.inPoint])).toEqual(video.map(c=>[c.start,c.duration,c.inPoint]))
  expect(useEditor.getState().past.length).toBe(history+1)
  useEditor.getState().undo();expect(JSON.stringify(getProject())).toBe(before)
})
it('rejects stale findings and invented keep IDs before any native mutation',async()=>{
  const found=await tool('find_retakes').run({}) as {finding_id:string;candidates:{id:string;keepId:string}[]}
  const before=JSON.stringify(getProject())
  await expect(tool('apply_retakes').run({finding_id:found.finding_id,keep_attempt_ids:['invented']})).rejects.toThrow('Unknown keep')
  await expect(tool('apply_retakes').run({finding_id:found.finding_id,decisions:[{candidate_id:found.candidates[0].id,keep_attempt_id:'invented'}]})).rejects.toThrow('Unknown keep')
  expect(JSON.stringify(getProject())).toBe(before)
  dispatch('clip.update',{ids:['caption'],patch:{text:{content:'User changed this'}}})
  await expect(tool('apply_retakes').run({finding_id:found.finding_id,decisions:[{candidate_id:found.candidates[0].id,keep_attempt_id:found.candidates[0].keepId}]})).rejects.toThrow('stale')
})
