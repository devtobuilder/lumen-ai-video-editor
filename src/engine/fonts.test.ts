import {afterEach,expect,it,vi} from 'vitest'
import {createClip} from '@/editor/defaults'
import {createEmptyProject} from '@/editor/new-project'
import {textFontReady,prepareTextFonts} from './fonts'
afterEach(()=>vi.unstubAllGlobals())
it('starts the requested face before awaiting a previously resolved fonts.ready and hides fallback metrics',async()=>{
  let loaded=false,release!:(value:FontFace[])=>void
  const pending=new Promise<FontFace[]>(resolve=>{release=resolve})
  const load=vi.fn(()=>pending)
  vi.stubGlobal('document',{fonts:{check:()=>loaded,load,ready:Promise.resolve()}})
  const p=createEmptyProject('Cold font'),clip=createClip({kind:'text',trackId:p.tracks[0].id,start:0,duration:60,text:{content:'Cold font unique test'}})
  p.clips[clip.id]=clip
  expect(textFontReady(p,clip.text!)).toBe(false)
  expect(load).toHaveBeenCalledTimes(1)
  let finished=false
  const ready=prepareTextFonts(p).then(()=>{finished=true})
  await Promise.resolve();expect(finished).toBe(false)
  loaded=true;release([]);await ready
  expect(finished).toBe(true);expect(textFontReady(p,clip.text!)).toBe(true)
  expect(load).toHaveBeenCalledTimes(1)
})
