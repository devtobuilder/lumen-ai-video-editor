import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { IPC, type LocalVoiceEnhanceRequest, type LocalVoiceEnhanceResult } from '../../shared/integrations'
import { editorWindow } from './editor-rpc'
import { fileUrl, jobDir, mediaPath, readJson } from './paths'

const active = new Map<string, ChildProcess>()
let busy = false
let pendingId: string | undefined
const canceled = new Set<string>()
export function cancelLocalVoiceEnhancement(id: string) {
  if (pendingId === id) canceled.add(id)
  const child = active.get(id)
  if (child?.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
}

/** GPU neural audio-only processing. Original media is never overwritten. */
export async function enhanceLocalVoice(req: LocalVoiceEnhanceRequest): Promise<LocalVoiceEnhanceResult> {
  if (busy) throw new Error('A local voice enhancement is already running.')
  busy = true
  pendingId = req?.id
  try { return await performVoiceEnhancement(req) } finally { busy = false; pendingId = undefined; canceled.delete(req?.id) }
}

async function performVoiceEnhancement(req: LocalVoiceEnhanceRequest): Promise<LocalVoiceEnhanceResult> {
  if (!req || !/^[a-zA-Z0-9_-]{1,80}$/.test(req.id)) throw new Error('Invalid voice-enhancement job id.')
  if (typeof req.source !== 'string' || !mediaPath(fileUrl(req.source)) || !fs.statSync(req.source).isFile()) throw new Error('Import the source media into Lumen first.')
  if (!['gentle', 'balanced', 'strong'].includes(req.strength)) throw new Error('Choose gentle, balanced or strong noise reduction.')
  if (req.duration !== undefined && (!Number.isFinite(req.duration) || req.duration <= 0 || req.duration > 86400)) throw new Error('Invalid source duration.')
  if (active.size) throw new Error('A local voice enhancement is already running.')
  const root = process.env.LUMEN_LOCAL_VIDEO_ROOT || readJson<{ root?: string }>('local-video-engine.json', {}).root
  if (!root) throw new Error('The local voice engine has not been configured.')
  const output = path.join(jobDir('voice-enhance', req.id), 'processing')
  const python = path.join(root, 'work', 'venv', 'Scripts', 'python.exe')
  const script = path.join(root, 'local-engine', 'native_audio.py')
  const args = [script, req.source, '--outdir', output, '--strength', req.strength, req.levelVoice ? '--level-voice' : '--no-level-voice']
  if (req.duration !== undefined) args.push('--duration', String(req.duration))
  // Share the 10GB GPU sequentially with Ollama; never overlap model loads.
  try {
    const response = await fetch('http://127.0.0.1:11434/api/ps', { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('Cannot inspect local model memory.')
    const state = await response.json() as { models?: { name: string }[] }
    for (const model of state.models || []) {
      const unloaded = await fetch('http://127.0.0.1:11434/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.name, keep_alive: 0, stream: false }), signal: AbortSignal.timeout(30000) })
      if (!unloaded.ok) throw new Error('Could not release local model GPU memory.')
    }
  } catch (error) {
    // A stopped Ollama server has no resident model. Other failures must not
    // proceed to a potentially competing CUDA allocation.
    if (!(error instanceof TypeError && String(error.cause || error).includes('ECONNREFUSED'))) throw error
  }
  if (canceled.has(req.id)) throw new Error('Local voice enhancement was stopped.')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(python, args, { windowsHide: true, cwd: root, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    active.set(req.id, child)
    let errors = '', partial = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      partial += chunk.toString()
      const lines = partial.split(/\r?\n/)
      partial = lines.pop() || ''
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as { message: string; progress: number }
          editorWindow()?.webContents.send(IPC.localVoiceProgress, { id: req.id, ...event })
        } catch { /* Ignore ordinary library logging. */ }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-6000) })
    child.once('error', err => { active.delete(req.id); reject(err) })
    child.once('close', code => {
      active.delete(req.id)
      if (code === 0) resolve()
      else reject(new Error(errors || 'Local voice enhancement was stopped.'))
    })
  })
  const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8')) as LocalVoiceEnhanceResult
  const expected = path.join(output, 'enhanced.wav')
  // Python resolves Windows AppData junctions (including packaged Codex's
  // redirected Roaming directory). Compare file identities after resolving
  // junctions, then retain Lumen's media-root spelling for asset registration.
  const canonical = (file: string) => {
    const resolved = fs.realpathSync(file)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  const expectedStat = fs.statSync(expected, { bigint: true })
  const reportedStat = typeof report.output === 'string' ? fs.statSync(report.output, { bigint: true }) : null
  // MSIX filesystem redirection can leave realpath spellings different even
  // for the same NTFS file. Nonzero file IDs establish identity in that case.
  const sameFileId = reportedStat && expectedStat.ino !== 0n && expectedStat.ino === reportedStat.ino && expectedStat.dev === reportedStat.dev
  if (!reportedStat || (!sameFileId && canonical(report.output) !== canonical(expected)) || !expectedStat.isFile()) throw new Error('The voice engine returned an unexpected output file.')
  report.output = expected
  return report
}
