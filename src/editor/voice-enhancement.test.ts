import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from './new-project'
import { dispatch, getProject, useEditor } from './store'
import { applyVoiceEnhancement, voiceEnhancementTargets } from './voice-enhancement'
import type { Asset } from './types'

const how = { source: 'ai' as const }
const original: Asset = { id: 'original', name: 'Mic.mov', kind: 'video', duration: 10, hasAudio: true, addedAt: 0,
  source: { type: 'file', path: 'C:/Mic.mov', url: 'lumen-media://file/Mic.mov', mime: 'video/quicktime', fileName: 'Mic.mov', size: 1 },
  transcript: [{ start: 1, end: 2, text: 'Meet Robin' }] }
const enhanced: Asset = { ...original, id: 'enhanced', name: 'Enhanced.wav', kind: 'audio', provenance: { integration: 'local-audio', tool: 'enhance_local_voice', params: { original_asset_id: 'original' } } }

beforeEach(() => {
  useEditor.getState().loadProject(createEmptyProject('Voice edit', { fps: 30 }))
  dispatch('asset.add', { asset: structuredClone(original) }, how)
  dispatch('asset.add', { asset: structuredClone(enhanced) }, how)
  const track = getProject().tracks.find(t => t.role === 'main')!.id
  expect(dispatch('clip.add', { id: 'shot', trackId: track, kind: 'video', assetId: original.id, start: 0, duration: 90, inPoint: 30, patch: { audio: { volume: -2 } } }, how).ok).toBe(true)
})

describe('native voice enhancement graph', () => {
  it('finds separate enhanced speech after a user unlinks picture and sound', () => {
    const applied = applyVoiceEnhancement(voiceEnhancementTargets(getProject(), ['shot']), new Map([['original', 'enhanced']]))
    expect(dispatch('clip.ungroup', { ids: ['shot', ...applied.audioIds] }, how).ok).toBe(true)
    expect(voiceEnhancementTargets(getProject(), ['shot']).map(t => t.clipId)).toEqual(applied.audioIds)
    expect(getProject().clips.shot.groupId).toBeUndefined()
  })
  it('resolves an enhanced asset selector to the active linked speech after repeated cleanup', () => {
    applyVoiceEnhancement(voiceEnhancementTargets(getProject(), ['shot']), new Map([['original', 'enhanced']]))
    const first = voiceEnhancementTargets(getProject(), undefined, 'enhanced')
    expect(first).toHaveLength(1)
    expect(first[0].sourceAssetId).toBe('original')
    const next: Asset = { ...enhanced, id: 'next', provenance: { integration: 'local-audio', tool: 'enhance_local_voice', params: { original_asset_id: 'enhanced' } } }
    dispatch('asset.add', { asset: next }, how)
    applyVoiceEnhancement(first, new Map([['original', 'next']]))
    expect(voiceEnhancementTargets(getProject(), undefined, 'enhanced').map(t => t.sourceAssetId)).toEqual(['original'])
    expect(voiceEnhancementTargets(getProject(), undefined, 'next').map(t => t.sourceAssetId)).toEqual(['original'])
    expect(() => voiceEnhancementTargets(getProject(), undefined, 'missing')).toThrow('no longer exists')
  })
  it('detaches an old video-only edit then swaps only its linked audio source, undoably', () => {
    const targets = voiceEnhancementTargets(getProject(), ['shot'])
    const before = structuredClone(getProject().clips.shot)
    const result = applyVoiceEnhancement(targets, new Map([['original', 'enhanced']]))
    const picture = getProject().clips.shot, sound = getProject().clips[result.audioIds[0]]
    expect(picture.assetId).toBe('original')
    expect(picture.audio.detached).toBe(true)
    expect(sound.kind).toBe('audio')
    expect(sound.assetId).toBe('enhanced')
    expect(sound.groupId).toBe(picture.groupId)
    expect([sound.start, sound.duration, sound.inPoint]).toEqual([before.start, before.duration, before.inPoint])
    expect(sound.audio.volume).toBe(-2)
    useEditor.getState().undo()
    expect(getProject().clips.shot).toEqual(before)
    expect(Object.values(getProject().clips).filter(c => c.kind === 'audio')).toHaveLength(0)
  })

  it('reuses existing detached voice and preserves group, fades, volume/speed keyframes', () => {
    const detach = dispatch('clip.detachAudio', { ids: ['shot'] }, how)
    expect(detach.ok).toBe(true)
    if (!detach.ok) return
    const voice = (detach.result as string[])[0]
    dispatch('keyframe.set', { clipId: voice, prop: 'volume', frame: 12, value: -5 }, how)
    dispatch('clip.update', { ids: [voice], patch: { audio: { fadeIn: 4, fadeOut: 6 } } }, how)
    const before = structuredClone(getProject().clips[voice])
    const targets = voiceEnhancementTargets(getProject(), ['shot', voice])
    expect(targets).toHaveLength(1)
    const result = applyVoiceEnhancement(targets, new Map([['original', 'enhanced']]))
    expect(result.audioIds).toEqual([voice])
    expect(result.detachedVideoIds).toEqual([])
    const after = getProject().clips[voice]
    expect(after.groupId).toBe(before.groupId)
    expect(after.keyframes).toEqual(before.keyframes)
    expect(after.audio.fadeIn).toBe(4)
    expect(after.audio.fadeOut).toBe(6)
    expect(Object.values(getProject().clips).filter(c => c.kind === 'audio')).toHaveLength(1)
    expect(voiceEnhancementTargets(getProject(), ['shot'])[0].sourceAssetId).toBe('original')
  })

  it('rejects too-short replacement media without changing the video/audio graph', () => {
    const targets = voiceEnhancementTargets(getProject(), ['shot'])
    dispatch('asset.update', { id: 'enhanced', patch: { duration: 1 } }, how)
    const before = structuredClone(getProject().clips)
    expect(() => applyVoiceEnhancement(targets, new Map([['original', 'enhanced']]))).toThrow('shorter')
    expect(getProject().clips).toEqual(before)
  })

  it('rejects reattachment of an enhanced separate source without doubling audio', () => {
    applyVoiceEnhancement(voiceEnhancementTargets(getProject(), ['shot']), new Map([['original', 'enhanced']]))
    const before = structuredClone(getProject().clips)
    const result = dispatch('clip.reattachAudio', { ids: ['shot'] }, how)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('different source')
    expect(getProject().clips).toEqual(before)
    expect(getProject().clips.shot.audio.detached).toBe(true)
  })
})
