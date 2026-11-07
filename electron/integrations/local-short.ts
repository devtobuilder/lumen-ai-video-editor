import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { IPC, type TranscriptSegment } from '../../shared/integrations'
import { editorWindow } from './editor-rpc'
import { fileUrl, jobDir, mediaPath, readJson } from './paths'

const active = new Map<string, ChildProcess>()
export function cancelLocalShort(id: string) {
  const child = active.get(id)
  if (child?.pid) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
}

/** Native transcript operation: a short-lived CUDA worker, never a render pipeline. */
export async function transcribeLocal(req: { id: string; source: string; language?: string }): Promise<TranscriptSegment[]> {
  if (!req || !/^[a-zA-Z0-9_-]{1,80}$/.test(req.id)) throw new Error('Invalid transcription job id.')
  if (typeof req.source !== 'string' || !mediaPath(fileUrl(req.source)) || !fs.statSync(req.source).isFile()) throw new Error('Import the media into Lumen first.')
  if (active.size) throw new Error('Another local CUDA job is running. Wait for it to finish.')
  const root = process.env.LUMEN_LOCAL_VIDEO_ROOT || readJson<{ root?: string }>('local-video-engine.json', {}).root
  if (!root) throw new Error('The local CUDA Whisper engine has not been configured.')
  const output = path.join(jobDir('whisper-native', req.id), 'transcript.json')
  const python = path.join(root, 'work', 'venv', 'Scripts', 'python.exe')
  const script = path.join(root, 'local-engine', 'native_whisper.py')
  const args = [script, req.source, '--out', output, '--language', req.language || 'en']
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
          const progress = JSON.parse(line) as { message: string; progress: number }
          editorWindow()?.webContents.send(IPC.localTranscribeProgress, { id: req.id, ...progress })
        } catch { /* Library logs are not progress messages. */ }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-5000) })
    child.once('error', err => { active.delete(req.id); reject(err) })
    child.once('close', code => {
      active.delete(req.id)
      if (code === 0) resolve()
      else reject(new Error(errors || 'CUDA transcription was stopped.'))
    })
  })
  const result = JSON.parse(fs.readFileSync(output, 'utf8')) as { segments?: TranscriptSegment[] }
  if (!Array.isArray(result.segments)) throw new Error('CUDA transcription returned no transcript.')
  return result.segments.filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && typeof s.text === 'string')
}

/** Deprecated flattened-render IPC. Use native editor tools instead. */
export async function localShort(_req: { id: string; source: string; prompt: string; music?: string }): Promise<{output:string;source_seconds:number;output_seconds:number;cuts:number;ranges:[number,number][];subtitles:string;title:string;punchIn:boolean}> {
  throw new Error('The legacy flattened renderer is not distributed. Use the native local editor tools to keep captions, cuts and audio editable.')
}
