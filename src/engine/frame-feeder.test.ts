import {describe,it,expect,vi,beforeEach} from 'vitest'
const state=vi.hoisted(()=>({drawn:[] as unknown[],events:[] as string[],live:0,max:0,release:undefined as undefined|(()=>void)}))
vi.mock('./compositor',()=>({mediaDrawnAt:()=>state.drawn,clipSourceTime:()=>0,renderFrame:vi.fn()}))
vi.mock('./decode',()=>({framesAt:vi.fn(),VideoReader:class {
 constructor(private url:string){state.events.push('open:'+url);state.live++;state.max=Math.max(state.max,state.live)}
 async frameAt(){return {width:1,height:1}}
 async dispose(){state.events.push('closing:'+this.url);if(state.release)await new Promise<void>(resolve=>{const prior=state.release;state.release=()=>{prior?.();resolve()}});state.live--;state.events.push('closed:'+this.url)}
}}))
import {FrameFeeder} from './stills'
import type {Project} from '@/editor/types'
function draw(ids:string[]){state.drawn=ids.map(id=>({key:id,local:0,clip:{assetId:id},view:{settings:{fps:30},assets:{[id]:{kind:'video',source:{type:'file',url:id}}}}}))}
beforeEach(()=>{state.drawn=[];state.events=[];state.live=0;state.max=0;state.release=undefined})
describe('FrameFeeder decoder lifecycle',()=>{
 it('bounds decoder resources across 38 short cuts instead of retaining all clips',async()=>{
  const feeder=new FrameFeeder({} as Project,1080,1920)
  for(let i=0;i<38;i++){draw(['cut'+i]);await feeder.prepare(i)}
  expect(state.max).toBe(1);expect(state.live).toBe(1)
  await feeder.dispose();expect(state.live).toBe(0)
 })
 it('awaits inactive cleanup before opening replacements, retaining simultaneous overlap',async()=>{
  const feeder=new FrameFeeder({} as Project,1080,1920)
  draw(['a','b']);await feeder.prepare(0)
  state.release=()=>{};draw(['b','c']);const pending=feeder.prepare(1)
  await Promise.resolve();expect(state.events).not.toContain('open:c')
  state.release?.();state.release=undefined;await pending
  expect(state.events.filter(x=>x==='open:b')).toHaveLength(1)
  expect(state.events.indexOf('closed:a')).toBeLessThan(state.events.indexOf('open:c'))
  expect(state.max).toBe(2);await feeder.dispose();expect(state.live).toBe(0)
 })
 it('closes all readers on empty frames and clears stale frame references',async()=>{
  const feeder=new FrameFeeder({} as Project,1080,1920)
  draw(['a']);await feeder.prepare(0);expect(feeder.frame('a')).toBeTruthy()
  draw([]);await feeder.prepare(1);expect(feeder.frame('a')).toBeNull();expect(state.live).toBe(0)
 })
})
