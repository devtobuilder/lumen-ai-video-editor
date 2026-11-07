import { EventEmitter } from 'node:events'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), stat: vi.fn(), read: vi.fn(), realpath: vi.fn(), registered: true }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs', () => ({ default: { statSync: mocks.stat, readFileSync: mocks.read, realpathSync: mocks.realpath } }))
vi.mock('./editor-rpc', () => ({ editorWindow: () => null }))
vi.mock('./paths', () => ({
  fileUrl: (p: string) => p,
  mediaPath: (p: string) => mocks.registered ? p : null,
  readJson: () => ({ root: 'C:/local-engine' }),
  jobDir: (_name: string, id: string) => `C:/local-jobs/${id}`,
}))

import { cancelLocalVoiceEnhancement, enhanceLocalVoice } from './local-audio'

function worker() { return Object.assign(new EventEmitter(), { pid: 23456, stdout: new EventEmitter(), stderr: new EventEmitter() }) }

describe('local neural voice worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) }))
    mocks.registered = true
    mocks.stat.mockReturnValue({ isFile: () => true, ino: 0n, dev: 0n })
    mocks.realpath.mockImplementation((file: string) => path.resolve(file))
    mocks.read.mockImplementation((file: string) => JSON.stringify({ output: path.join(path.dirname(file), 'enhanced.wav'), engine: 'DeepFilterNet CPU' }))
  })

  it('rejects unregistered source media without starting a process', async () => {
    mocks.registered = false
    await expect(enhanceLocalVoice({ id: 'private', source: 'C:/private.mov', strength: 'balanced', levelVoice: true })).rejects.toThrow('Import')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('reserves the GPU job before unloading models and rejects concurrent requests', async () => {
    const child = worker(); mocks.spawn.mockReturnValue(child)
    let release!: () => void
    const unloading = new Promise<void>(resolve => { release = resolve })
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ models: [{ name: 'local-editor' }] }) })
      .mockImplementationOnce(async () => { await unloading; return { ok: true } })
    vi.stubGlobal('fetch', fetcher)
    const first = enhanceLocalVoice({ id: 'gpu-first', source: 'C:/mic.mov', strength: 'balanced', levelVoice: true })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
    expect(mocks.spawn).not.toHaveBeenCalled()
    await expect(enhanceLocalVoice({ id: 'gpu-second', source: 'C:/mic.mov', strength: 'balanced', levelVoice: true })).rejects.toThrow('already running')
    release()
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled())
    child.emit('close', 0)
    await first
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ model: 'local-editor', keep_alive: 0 })
  })

  it('honors cancellation while GPU memory is being released', async () => {
    let release!: () => void
    const unloading = new Promise<void>(resolve => { release = resolve })
    const fetcher = vi.fn().mockImplementation(async () => { await unloading; return { ok: true, json: async () => ({ models: [] }) } })
    vi.stubGlobal('fetch', fetcher)
    const result = enhanceLocalVoice({ id: 'cancel-loading', source: 'C:/mic.mov', strength: 'balanced', levelVoice: true })
    cancelLocalVoiceEnhancement('cancel-loading')
    release()
    await expect(result).rejects.toThrow('stopped')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('uses the audio-only worker with bounded options and waits until close', async () => {
    const child = worker(); mocks.spawn.mockReturnValue(child)
    let done = false
    const result = enhanceLocalVoice({ id: 'voice', source: 'C:/mic.mov', strength: 'gentle', levelVoice: false, duration: 4 }).then(r => { done = true; return r })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled()); child.emit('exit', 0); await Promise.resolve(); expect(done).toBe(false)
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled()); child.emit('close', 0)
    expect((await result).output).toBe(path.join('C:/local-jobs/voice', 'processing', 'enhanced.wav'))
    const [, args, options] = mocks.spawn.mock.calls[0]
    expect(args[0]).toContain('native_audio.py')
    expect(args).toContain('--no-level-voice')
    expect(options.shell).toBeUndefined()
    expect(options.windowsHide).toBe(true)
  })

  it('cancels only the active voice worker process tree', async () => {
    const child = worker(); mocks.spawn.mockReturnValue(child)
    const result = enhanceLocalVoice({ id: 'cancel-voice', source: 'C:/mic.mov', strength: 'strong', levelVoice: true })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled()); cancelLocalVoiceEnhancement('cancel-voice')
    expect(mocks.spawn).toHaveBeenLastCalledWith('taskkill', ['/pid', '23456', '/t', '/f'], expect.objectContaining({ windowsHide: true }))
    child.emit('close', 1)
    await expect(result).rejects.toThrow('stopped')
  })

  it('accepts a junction-resolved worker path but returns the registered media-root path', async () => {
    const child = worker(); mocks.spawn.mockReturnValue(child)
    mocks.read.mockReturnValue(JSON.stringify({ output: 'C:/redirected/enhanced.wav' }))
    mocks.realpath.mockReturnValue('C:/redirected/enhanced.wav')
    const result = enhanceLocalVoice({ id: 'junction', source: 'C:/mic.mov', strength: 'balanced', levelVoice: true })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled()); child.emit('close', 0)
    expect((await result).output).toBe(path.join('C:/local-jobs/junction', 'processing', 'enhanced.wav'))
  })

  it('rejects a worker report pointing outside its generated audio file', async () => {
    const child = worker(); mocks.spawn.mockReturnValue(child)
    mocks.read.mockReturnValue(JSON.stringify({ output: 'C:/elsewhere/private.wav' }))
    const result = enhanceLocalVoice({ id: 'wrong-output', source: 'C:/mic.mov', strength: 'balanced', levelVoice: true })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled()); child.emit('close', 0)
    await expect(result).rejects.toThrow('unexpected output file')
  })

  it('accepts MSIX redirected spellings with the same nonzero file identity', async () => {
    const child = worker(); mocks.spawn.mockReturnValue(child)
    mocks.read.mockReturnValue(JSON.stringify({ output: 'C:/msix-redirected/enhanced.wav' }))
    mocks.stat.mockReturnValue({ isFile: () => true, ino: 12345n, dev: 77n })
    const result = enhanceLocalVoice({ id: 'msix', source: 'C:/mic.mov', strength: 'balanced', levelVoice: true })
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled()); child.emit('close', 0)
    expect((await result).output).toBe(path.join('C:/local-jobs/msix', 'processing', 'enhanced.wav'))
  })
})
