import { describe, expect, it, vi } from 'vitest'
import { createEmptyProject } from '@/editor/new-project'

const { abort, progress } = vi.hoisted(() => ({ abort: vi.fn(async () => {}), progress: vi.fn() }))
vi.mock('@/lib/platform', () => ({ desktop: { export: { abort, progress } } }))
vi.mock('@/editor/playback', () => ({ playback: { pause: vi.fn() } }))
vi.mock('./compositor', () => ({ renderFrame: vi.fn() }))
vi.mock('./audio-engine', () => ({ prepareAudio: vi.fn(), renderMix: vi.fn() }))
vi.mock('./decode', () => ({ collectHeld: () => [] }))
vi.mock('./media', () => ({ withVideoFrames: vi.fn() }))
vi.mock('./stills', () => ({ FrameFeeder: class {} }))

import { exportRunning, runExport } from './export'

describe('native export lifecycle', () => {
  it('releases the output handle when an empty timeline is rejected before rendering', async () => {
    await expect(runExport(
      createEmptyProject('Empty'),
      { format: 'mp4', codec: 'avc', width: 1080, height: 1920, fps: 30, quality: 72, hardware: true },
      { id: 'empty-export', path: 'empty.mp4' },
      vi.fn(), new AbortController().signal,
    )).rejects.toThrow('The timeline is empty')
    expect(abort).toHaveBeenCalledWith('empty-export')
    expect(exportRunning()).toBe(false)
  })
})
