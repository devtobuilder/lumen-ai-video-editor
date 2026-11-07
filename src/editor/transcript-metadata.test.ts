import {beforeEach,expect,it} from 'vitest'
import {createEmptyProject} from './new-project'
import {dispatch,getProject,useEditor} from './store'
import {timelineTranscript,protectTrustedWordRegions} from './smart'
import type {Asset,SpeechSegment} from './types'
const line:SpeechSegment={start:2,end:2.4,text:"I'm",utterance_id:'utterance_9',probability:0.95,avg_logprob:-0.17,no_speech_prob:0.0008}
const asset:Asset={id:'words',name:'Words',kind:'audio',duration:80,hasAudio:true,addedAt:0,source:{type:'file',url:'test',mime:'audio/wav',fileName:'test.wav',size:1},transcript:[line]}
beforeEach(()=>useEditor.getState().loadProject(createEmptyProject('Metadata')))
it('retains optional ASR fields through asset add/update and maps timing without changing confidence',()=>{
  expect(dispatch('asset.add',{asset}).ok).toBe(true)
  expect(getProject().assets.words.transcript?.[0]).toEqual(line)
  const updated={...line,utterance_id:9,probability:0.88}
  expect(dispatch('asset.update',{id:'words',patch:{transcript:[updated]}}).ok).toBe(true)
  const voice=getProject().tracks.find(t=>t.name==='Voice')!.id
  expect(dispatch('clip.add',{id:'voice',kind:'audio',assetId:'words',trackId:voice,start:60,duration:120,inPoint:30}).ok).toBe(true)
  expect(timelineTranscript(getProject())[0]).toEqual({...updated,start:3,end:3.4,clipId:'voice'})
  expect(dispatch('asset.update',{id:'words',patch:{transcript:[{start:2,end:2.4,text:'Legacy'}]}}).ok).toBe(true)
  expect(timelineTranscript(getProject())[0]).toEqual({start:3,end:3.4,text:'Legacy',clipId:'voice'})
  expect(dispatch('asset.update',{id:'words',patch:{transcript:[{...updated,probability:1.5}]}}).ok).toBe(false)
})
it('protects trusted quiet Hey/Im onsets while excluding legacy phantom and stretched uncertain words',()=>{
  const source={...asset,transcript:[{...line,start:12.582,end:12.942,text:'Hey'}, {...line,start:64.102,end:64.442}, {start:60.08,end:62.38,text:'selling'}, {...line,start:60.08,end:62.38,text:'selling'}, {...line,start:20,end:20.2,probability:0.4}, {...line,start:30,end:30.2,no_speech_prob:0.8}]}
  const measured:[number,number][]=[[12.733,13.5],[64.166,70]]
  expect(protectTrustedWordRegions(measured,source)).toEqual([[12.582,13.5],[64.102,70]])
  expect(measured).toEqual([[12.733,13.5],[64.166,70]])
})
