import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), stat: vi.fn(), read: vi.fn(), registered: true }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:fs', () => ({ default: { statSync: mocks.stat, readFileSync: mocks.read } }))
vi.mock('./editor-rpc', () => ({ editorWindow: () => null }))
vi.mock('./paths', () => ({
  fileUrl: (p: string) => p,
  mediaPath: (p: string) => mocks.registered ? p : null,
  readJson: () => ({ root: 'C:/local-engine' }),
  jobDir: (_name: string, id: string) => `C:/local-jobs/${id}`,
}))

import { cancelLocalShort, transcribeLocal } from './local-short'

function worker() {
  return Object.assign(new EventEmitter(), { pid: 12345, stdout: new EventEmitter(), stderr: new EventEmitter() })
}

describe('native CUDA transcript worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.registered = true
    mocks.stat.mockReturnValue({ isFile: () => true })
    mocks.read.mockReturnValue(JSON.stringify({ segments: [{ start: 0.1, end: 0.5, text: 'Hello' }] }))
  })

  it('rejects unregistered files without starting a process', async () => {
    mocks.registered = false
    await expect(transcribeLocal({ id: 'unregistered', source: 'C:/private.mov' })).rejects.toThrow('Import')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('waits for worker close before returning original-media word timings', async () => {
    const child = worker()
    mocks.spawn.mockReturnValue(child)
    let completed = false
    const result = transcribeLocal({ id: 'native-words', source: 'C:/recording.mov' }).then(v => { completed = true; return v })
    child.emit('exit', 0)
    await Promise.resolve()
    expect(completed).toBe(false)
    child.emit('close', 0)
    expect(await result).toEqual([{ start: 0.1, end: 0.5, text: 'Hello' }])
    const [, args, options] = mocks.spawn.mock.calls[0]
    expect(args[0]).toContain('native_whisper.py')
    expect(args).not.toContain('editor.py')
    expect(options.windowsHide).toBe(true)
    expect(options.shell).toBeUndefined()
  })

  it('cancels the CUDA worker process tree and surfaces failure', async () => {
    const child = worker()
    mocks.spawn.mockReturnValue(child)
    const result = transcribeLocal({ id: 'cancel-native', source: 'C:/recording.mov' })
    cancelLocalShort('cancel-native')
    expect(mocks.spawn).toHaveBeenLastCalledWith('taskkill', ['/pid', '12345', '/t', '/f'], expect.objectContaining({ windowsHide: true }))
    child.emit('close', 1)
    await expect(result).rejects.toThrow('stopped')
  })
})
