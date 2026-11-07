import { beforeEach, expect, it, vi } from 'vitest'
import { createEmptyProject } from '@/editor/new-project'
import { dispatch, getProject, useEditor } from '@/editor/store'
vi.mock('@/project/transcribe', () => ({ transcribeMedia: vi.fn() }))
vi.mock('@/editor/playback', () => ({ playback: { seek: vi.fn() } }))
import { LOCAL_SHORT_TOOLS } from './local-short'
const tool = (name: string) => LOCAL_SHORT_TOOLS.find(t => t.name === name)!
beforeEach(() => {
  useEditor.getState().loadProject(createEmptyProject('Precise edits', { width: 1080, height: 1920, fps: 30 }))
  const main = getProject().tracks.find(t => t.role === 'main')!.id
  dispatch('asset.add', { asset: { id: 'raw', name: 'Original', kind: 'video', duration: 30, addedAt: 0, source: { type: 'file', url: 'test', fileName: 'raw.mp4', mime: 'video/mp4', size: 1 } } })
  dispatch('clip.add', { id: 'first', trackId: main, kind: 'video', start: 0, duration: 300, assetId: 'raw' })
  dispatch('clip.add', { id: 'second', trackId: main, kind: 'video', start: 300, duration: 99, inPoint: 330, assetId: 'raw' })
  dispatch('keyframe.set', { clipId: 'second', prop: 'scale', frame: 0, value: 1, easing: 'cubic-in-out' })
  dispatch('keyframe.set', { clipId: 'second', prop: 'scale', frame: 98, value: 1.088, easing: 'cubic-in-out' })
})
it('changes the existing zoom endpoint while preserving its timing, easing and initial value', async () => {
  await tool('set_native_zoom_endpoint').run({ clip_id: 'second', scale: 1.04 })
  expect(getProject().clips.second.keyframes.scale).toEqual([{ frame: 0, value: 1, easing: 'cubic-in-out' }, { frame: 98, value: 1.04, easing: 'cubic-in-out' }])
  await expect(tool('set_native_zoom_endpoint').run({ clip_id: 'first', scale: 1.04 })).rejects.toThrow('existing animated zoom')
})
it('converts seconds using actual fps and rejects an incoming transition on the first clip', async () => {
  await tool('set_native_transition').run({ clip_id: 'second', kind: 'dissolve', duration_seconds: 0.2 })
  expect(getProject().clips.second.transitionIn).toEqual({ kind: 'dissolve', duration: 6 })
  await expect(tool('set_native_transition').run({ clip_id: 'first', kind: 'dissolve', duration_seconds: 0.2 })).rejects.toThrow('second clip')
})
it('revises a title duration in seconds without confusing duration with its absolute end time', async () => {
  const track = getProject().tracks.find(t => t.role === 'titles')!
  dispatch('clip.add', { id: 'title', trackId: track.id, kind: 'text', start: 150, duration: 120, patch: { text: { content: 'GARDEN JOURNAL' } } })
  await tool('set_native_text_duration').run({ clip_id: 'title', duration_seconds: 2 })
  expect(getProject().clips.title).toMatchObject({ start: 150, duration: 60, text: { content: 'GARDEN JOURNAL' } })
})
it('restores omitted source time while shifting captions and preserving revised native properties, in one undo', async () => {
  const detached = dispatch('clip.detachAudio', { ids: ['first', 'second'] }) as { ok: true; result: string[] }
  const track = getProject().tracks.find(t => t.role === 'titles')!
  dispatch('clip.add', { id: 'laterText', trackId: track.id, kind: 'text', start: 310, duration: 30, patch: { text: { content: 'Preserve this revision' } } })
  await tool('set_native_zoom_endpoint').run({ clip_id: 'second', scale: 1.04 })
  await tool('set_native_transition').run({ clip_id: 'second', kind: 'dissolve', duration_seconds: 0.2 })
  const before = JSON.stringify(getProject())
  await tool('restore_native_source_gap').run({ clip_id: 'second' })
  expect(getProject().clips.first.duration).toBe(330)
  expect(getProject().clips.second).toMatchObject({ start: 330, inPoint: 330, transitionIn: { kind: 'dissolve', duration: 6 } })
  expect(getProject().clips.second.keyframes.scale?.[1].value).toBe(1.04)
  expect(getProject().clips[detached.result[0]]).toMatchObject({ start: 0, duration: 330, inPoint: 0 })
  expect(getProject().clips[detached.result[1]]).toMatchObject({ start: 330, duration: 99, inPoint: 330 })
  expect(getProject().clips.laterText).toMatchObject({ start: 340, text: { content: 'Preserve this revision' } })
  useEditor.getState().undo()
  expect(JSON.stringify(getProject())).toBe(before)
})
it('prepares a short with linked voice clips on a separate audio track instead of keeping sound on the video clips', async () => {
  dispatch('asset.update', { id: 'raw', patch: { transcript: [{ start: 0, end: 1, text: 'Hello there.' }] } })
  const result = await tool('prepare_native_short').run({ asset_id: 'raw', remove_pauses: false }) as { voice_clip_ids: string[]; video_clip_ids: string[]; separate_voice_track: boolean }
  expect(result.separate_voice_track).toBe(true)
  expect(getProject().tracks.find(t => t.role === 'main')?.magnetic).toBe(false)
  expect(result.voice_clip_ids).toHaveLength(result.video_clip_ids.length)
  for (const [i, id] of result.video_clip_ids.entries()) {
    const video = getProject().clips[id], sound = getProject().clips[result.voice_clip_ids[i]]
    expect(video.audio.detached).toBe(true)
    expect(sound.kind).toBe('audio')
    expect(sound).toMatchObject({ start: video.start, duration: video.duration, inPoint: video.inPoint, groupId: video.groupId, audio: { enhance: true, denoise: true } })
    expect(sound.trackId).not.toBe(video.trackId)
  }
})
