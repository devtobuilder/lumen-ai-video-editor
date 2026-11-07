import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject } from '@/editor/new-project'
import { dispatch, getProject, useEditor } from '@/editor/store'

vi.mock('@/lib/platform', () => ({ desktop: undefined, platform: { isElectron: false, isMac: false }, primary: 'Ctrl' }))
vi.mock('@/engine/graphics-report', () => ({ graphicsReport: vi.fn() }))
vi.mock('@/engine/export', () => ({ canAlpha: vi.fn(), CODECS_FOR: {}, codecSupport: vi.fn(), ExportCancelled: class extends Error {}, exportRunning: vi.fn(), FORMAT_INFO: {}, runExport: vi.fn() }))
vi.mock('@/engine/render-queue', () => ({ queueExport: vi.fn() }))
vi.mock('@/project/session', () => ({ saveProject: vi.fn(), saveProjectAs: vi.fn(), useSession: { getState: () => ({ path: null }) } }))
vi.mock('@/editor/playback', () => ({ playback: { seek: vi.fn(), pause: vi.fn() }, usePlayback: { getState: () => ({ frame: 0 }) } }))

import { CONTROL_TOOLS } from './control'
const addTitle = CONTROL_TOOLS.find(t => t.name === 'add_title')!

beforeEach(() => useEditor.getState().loadProject(createEmptyProject('Title timing')))

describe('add_title exact placement', () => {
  it('rejects a collision at explicit zero without moving or adding any clips/history', async () => {
    const track = dispatch('track.add', { kind: 'video', role: 'captions', name: 'Captions', index: 0 })
    if (!track.ok) throw new Error(track.error)
    dispatch('clip.add', { id: 'caption', trackId: track.result as string, kind: 'text', start: 0, duration: 1143, patch: { text: { content: 'Existing caption' } } })
    const before = JSON.stringify(getProject())
    const steps = useEditor.getState().past.length
    await expect(addTitle.run({ text: 'Opening title', at_seconds: 0, duration_seconds: 3, track_id: track.result })).rejects.toThrow('That track is occupied at 0 seconds')
    expect(JSON.stringify(getProject())).toBe(before)
    expect(useEditor.getState().past).toHaveLength(steps)
    const result = await addTitle.run({ text: 'Opening title', at_seconds: 0, duration_seconds: 3 }) as { clip_id: string; start_seconds: number }
    expect(result.start_seconds).toBe(0)
    expect(getProject().clips[result.clip_id].start).toBe(0)
    expect(getProject().clips.caption.text!.content).toBe('Existing caption')
  })

  it('does not insert a title into the magnetic footage track', async () => {
    const main = getProject().tracks.find(t => t.role === 'main')!
    dispatch('clip.add', { id: 'footage', trackId: main.id, kind: 'video', start: 0, duration: 300 })
    const before = JSON.stringify(getProject())
    await expect(addTitle.run({ text: 'Title', at_seconds: 0, track_id: main.id })).rejects.toThrow('main footage track')
    expect(JSON.stringify(getProject())).toBe(before)
  })
})
