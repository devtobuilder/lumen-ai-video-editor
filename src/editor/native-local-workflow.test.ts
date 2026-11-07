import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from './new-project'
import { clipsOnTrack } from './ops'
import { dispatch, getProject, useEditor } from './store'
import { layCaptions, timelineCues } from './subtitles'
import { propAt } from './keyframes'
import type { Asset } from './types'

const FPS = 30
const SOURCE = 'original_recording'
const track = () => getProject().tracks.find(t => t.role === 'main')!.id
const ai = { source: 'ai' as const }
const source: Asset = {
  id: SOURCE, name: 'Original.mov', kind: 'video', duration: 8,
  width: 1080, height: 1920, fps: FPS, hasAudio: true, addedAt: 0,
  source: { type: 'file', path: 'C:/recordings/Original.mov', url: 'lumen-media://file/Original.mov', fileName: 'Original.mov', mime: 'video/quicktime', size: 1 },
  transcript: [{ start: 0, end: 3, text: 'My name is Robin.' }, { start: 4, end: 8, text: 'Welcome to the garden.' }],
}

beforeEach(() => {
  useEditor.getState().loadProject(createEmptyProject('Native edit', { width: 1080, height: 1920, fps: FPS }))
  expect(dispatch('asset.add', { asset: structuredClone(source) }, ai).ok).toBe(true)
})

function constructNativeEdit() {
  const t = track()
  // One second of silence is omitted by referencing original source ranges.
  expect(dispatch('clip.add', { id: 'intro', trackId: t, kind: 'video', start: 0, duration: 90, assetId: SOURCE, inPoint: 0 }, ai).ok).toBe(true)
  expect(dispatch('clip.add', { id: 'message', trackId: t, kind: 'video', start: 90, duration: 120, assetId: SOURCE, inPoint: 120 }, ai).ok).toBe(true)
  const captions = layCaptions([
    { start: 0, end: 90, text: 'My name is Robin.' },
    { start: 90, end: 210, text: 'Welcome to the garden.' },
  ], { label: 'Animated captions', source: 'ai', style: 'bold', size: 64 })
  expect(dispatch('clip.animate', { clipId: 'message', preset: 'push-in', intensity: 0.7 }, ai).ok).toBe(true)
  expect(dispatch('clip.update', { ids: ['intro', 'message'], patch: { audio: { denoise: true, enhance: true, volume: -2 } } }, ai).ok).toBe(true)
  return captions.ids
}

describe('native local editing contract', () => {
  it('stores source cuts, caption layers, zoom keyframes and voice settings without any rendered media', () => {
    const captions = constructNativeEdit()
    const p = getProject()
    expect(Object.keys(p.assets)).toEqual([SOURCE])
    expect(clipsOnTrack(p, track()).map(c => [c.assetId, c.start, c.duration, c.inPoint])).toEqual([
      [SOURCE, 0, 90, 0], [SOURCE, 90, 120, 120],
    ])
    expect(captions).toHaveLength(2)
    expect(captions.every(id => p.clips[id].kind === 'text' && !p.clips[id].assetId)).toBe(true)
    expect(p.clips[captions[0]].animation.in.preset).toBe('pop')
    expect(p.clips.message.keyframes.scale!.length).toBeGreaterThan(1)
    expect(p.clips.message.audio).toMatchObject({ denoise: true, enhance: true, volume: -2 })
    const saved = JSON.parse(JSON.stringify(p))
    useEditor.getState().loadProject(saved)
    expect(timelineCues(getProject()).map(c => c.text)).toEqual(['My name is Robin.', 'Welcome to the garden.'])
    expect(getProject().clips.message.keyframes.scale).toEqual(p.clips.message.keyframes.scale)
  })

  it('changes one caption and reduces a zoom on the same source clips, with exact undo/redo', () => {
    const captions = constructNativeEdit()
    const beforeZoom = propAt(getProject().clips.message, 'scale', 119)
    expect(dispatch('clip.update', { ids: [captions[1]], patch: { text: { content: 'Welcome to Dev to Build!' } } }, ai).ok).toBe(true)
    expect(dispatch('keyframe.set', { clipId: 'message', prop: 'scale', frame: 119, value: 1.02, easing: 'sine-in-out' }, ai).ok).toBe(true)
    expect(propAt(getProject().clips.message, 'scale', 119)).toBeCloseTo(1.02)
    expect(propAt(getProject().clips.message, 'scale', 119)).toBeLessThan(beforeZoom)
    expect(timelineCues(getProject())[1].text).toBe('Welcome to Dev to Build!')
    expect(Object.keys(getProject().assets)).toEqual([SOURCE])
    useEditor.getState().undo()
    expect(propAt(getProject().clips.message, 'scale', 119)).toBeCloseTo(beforeZoom)
    expect(timelineCues(getProject())[1].text).toBe('Welcome to Dev to Build!')
    useEditor.getState().redo()
    expect(propAt(getProject().clips.message, 'scale', 119)).toBeCloseTo(1.02)
  })

  it('restores a removed source range while retaining the revised caption and zoom', () => {
    const captions = constructNativeEdit()
    dispatch('clip.update', { ids: [captions[1]], patch: { text: { content: 'Welcome to Dev to Build!' } } }, ai)
    dispatch('keyframe.set', { clipId: 'message', prop: 'scale', frame: 119, value: 1.02 }, ai)
    const before = JSON.stringify(getProject())
    useEditor.getState().transaction('Restore omitted second', 'ai', () => {
      expect(dispatch('clip.add', { id: 'restored', trackId: track(), kind: 'video', assetId: SOURCE, start: 90, duration: 30, inPoint: 90, mode: 'insert' }, ai).ok).toBe(true)
      // Native insert edits move the affected track; related captions must be
      // moved explicitly by the agent/batch to remain attached to their speech.
      expect(dispatch('clip.move', { moves: [{ id: captions[1], start: 120 }] }, ai).ok).toBe(true)
    })
    expect(clipsOnTrack(getProject(), track()).map(c => [c.start, c.duration, c.inPoint])).toEqual([[0, 90, 0], [90, 30, 90], [120, 120, 120]])
    expect(timelineCues(getProject())[1]).toEqual({ start: 4, end: 8, text: 'Welcome to Dev to Build!' })
    expect(propAt(getProject().clips.message, 'scale', 119)).toBeCloseTo(1.02)
    expect(Object.keys(getProject().assets)).toEqual([SOURCE])
    useEditor.getState().undo()
    expect(JSON.stringify(getProject())).toBe(before)
  })

  it('keeps grading, effects, transitions and master processing as independently revisable properties', () => {
    constructNativeEdit()
    expect(dispatch('clip.update', { ids: ['message'], patch: { color: { exposure: 4, contrast: 6, saturation: 3 } } }, ai).ok).toBe(true)
    expect(dispatch('effect.add', { ids: ['message'], kind: 'glow', amount: 8 }, ai).ok).toBe(true)
    expect(dispatch('clip.setTransition', { id: 'message', transition: { kind: 'dissolve', duration: 6 } }, ai).ok).toBe(true)
    expect(dispatch('mix.update', { target: 'master', patch: { compressor: { enabled: true, threshold: -18, ratio: 3 }, limiter: { enabled: true, ceiling: -1 } } }, ai).ok).toBe(true)
    const c = getProject().clips.message
    const effectId = c.effects[0].id
    expect(c.color).toMatchObject({ exposure: 4, contrast: 6, saturation: 3 })
    expect(c.transitionIn).toMatchObject({ kind: 'dissolve', duration: 6 })
    expect(getProject().master).toMatchObject({ compressor: { enabled: true, threshold: -18, ratio: 3 }, limiter: { enabled: true, ceiling: -1 } })
    expect(dispatch('effect.update', { clipId: 'message', effectId, patch: { amount: 3 } }, ai).ok).toBe(true)
    expect(dispatch('clip.setTransition', { id: 'message', transition: null }, ai).ok).toBe(true)
    expect(getProject().clips.message.effects[0]).toMatchObject({ id: effectId, kind: 'glow', amount: 3 })
    expect(getProject().clips.message.transitionIn).toBeNull()
    expect(Object.keys(getProject().assets)).toEqual([SOURCE])
  })
})
