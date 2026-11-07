import { beforeEach, expect, it } from 'vitest'
import { createEmptyProject } from './new-project'
import { dispatch, getProject, useEditor } from './store'
import { addCaptions } from './smart'

beforeEach(() => {
  useEditor.getState().loadProject(createEmptyProject('Words', { width: 1080, height: 1920, fps: 30 }))
  dispatch('asset.add', { asset: { id: 'speech', name: 'Original', kind: 'video', duration: 6, addedAt: 0, source: { type: 'file', url: 'test', fileName: 'original.mp4', mime: 'video/mp4', size: 1 }, transcript: [{ start: 0, end: 0.3, text: 'Hello' }, { start: 0.3, end: 0.6, text: 'from' }, { start: 0.6, end: 1, text: 'Robin.' }, { start: 2, end: 2.4, text: 'Welcome' }, { start: 2.4, end: 2.8, text: 'back.' }] } })
  dispatch('clip.add', { id: 'video', trackId: getProject().tracks.find(t => t.role === 'main')!.id, kind: 'video', start: 0, duration: 180, assetId: 'speech' })
})
it('groups true word timestamps into native multiword captions without bridging a pause', () => {
  addCaptions({ style: 'bold', maxWords: 4 })
  const caps = Object.values(getProject().clips).filter(c => c.kind === 'text').sort((a, b) => a.start - b.start)
  expect(caps.map(c => c.text!.content)).toEqual(['Hello from Robin.', 'Welcome back.'])
  expect(caps[0].duration).toBe(30)
  expect(caps[1].start).toBe(60)
  expect(caps[0].animation.in.preset).toBe('pop')
})
it('keeps one-word timing when word style is requested', () => {
  addCaptions({ style: 'word', maxWords: 1 })
  expect(Object.values(getProject().clips).filter(c => c.kind === 'text')).toHaveLength(5)
})
it('rejects a caption edit targeting a video instead of silently accepting a useless text property', () => {
  const before = JSON.stringify(getProject())
  expect(() => dispatch('clip.update', { ids: ['video'], patch: { text: { content: 'Meet Robin' } } })).toThrow('not a text caption/title')
  expect(JSON.stringify(getProject())).toBe(before)
})
it('inserts time across original footage, captions and markers together', () => {
  addCaptions({ style: 'bold', maxWords: 4 })
  dispatch('marker.add', { frame: 60, label: 'Later' })
  expect(dispatch('timeline.insertRange', { at: 30, duration: 15 }).ok).toBe(true)
  const later = Object.values(getProject().clips).find(c => c.text?.content === 'Welcome back.')!
  expect(later.start).toBe(75)
  expect(getProject().markers[0].frame).toBe(75)
  useEditor.getState().undo()
  expect(Object.values(getProject().clips).find(c => c.id === later.id)!.start).toBe(60)
})
