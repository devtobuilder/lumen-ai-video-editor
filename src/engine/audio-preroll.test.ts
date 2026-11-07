import { beforeEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from '@/editor/new-project'
import { dispatch, getProject, useEditor } from '@/editor/store'
import { mixPrerollSeconds } from './audio-engine'

beforeEach(() => {
  useEditor.getState().loadProject(createEmptyProject('Block audio'))
  dispatch('asset.add', { asset: { id: 'voice', name: 'Voice', kind: 'audio', duration: 20, addedAt: 0, source: { type: 'file', url: 'voice.wav', mime: 'audio/wav', fileName: 'voice.wav', size: 1 } } })
})

const voiceTrack = () => getProject().tracks.find(t => t.name === 'Voice')!.id
const addVoice = (enhance: boolean) => {
  dispatch('clip.add', { id: 'speech', trackId: voiceTrack(), kind: 'audio', assetId: 'voice', start: 0, duration: 600, patch: { audio: { enhance } } })
}

describe('export mix block preroll', () => {
  it('warms up the voice enhancement compressor even with no bus processing', () => {
    addVoice(true)
    expect(mixPrerollSeconds(getProject(), 2)).toBe(1)
    expect(mixPrerollSeconds(getProject(), 0.25)).toBe(0.25)
    expect(mixPrerollSeconds(getProject(), 0)).toBe(0)
    dispatch('clip.update', { ids: ['speech'], patch: { audio: { enhance: false } } })
    expect(mixPrerollSeconds(getProject(), 2)).toBe(0)
    // Normalized exports need their final limiter warmed independently.
    expect(mixPrerollSeconds(getProject(), 2, -1)).toBe(1)
  })

  it('includes dynamics inside a nested timeline that is actually heard', () => {
    dispatch('sequence.create', { id: 'inner', name: 'Nested speech' })
    addVoice(false)
    dispatch('mix.update', { target: 'master', patch: { compressor: { enabled: true } } })
    dispatch('sequence.open', { id: 'seq_main' })
    dispatch('clip.add', { id: 'nest', trackId: voiceTrack(), kind: 'audio', sequenceId: 'inner', start: 0, duration: 600 })
    expect(mixPrerollSeconds(getProject(), 5)).toBe(1)
    dispatch('track.update', { id: voiceTrack(), patch: { muted: true } })
    expect(mixPrerollSeconds(getProject(), 5)).toBe(0)
  })
})
