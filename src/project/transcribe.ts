/**
 * Speech-to-text for media (captions, pause removal, search) and for voice
 * prompts. Uses whichever service the user has connected: ElevenLabs Scribe or
 * OpenAI Whisper — or Whisper running on this computer (see ./whisper).
 */
import { toast } from 'sonner'
import type { TranscriptSegment } from '@shared/integrations'
import { dispatch, getProject } from '@/editor/store'
import type { Asset } from '@/editor/types'
import { speechAudio } from '@/engine/audio-engine'
import { speechWav } from '@/engine/wav'
import { useAi } from '@/integrations/ai'
import { api, transcribeAsset as elevenJob, useIntegrations } from '@/integrations/store'
import { transcribeLocally } from './whisper'

export type Transcriber = 'elevenlabs' | 'openai' | 'local'

export const TRANSCRIBER_NAMES: Record<Transcriber, string> = {
  elevenlabs: 'ElevenLabs Scribe',
  openai: 'OpenAI Whisper',
  local: 'CUDA Whisper on this computer',
}

/** Services that can transcribe right now, best first. */
export function transcribers(): Transcriber[] {
  // Local-first is deliberate: merely having a connected key must never turn
  // a normal caption/transcript action into cloud inference.
  const out: Transcriber[] = ['local']
  if (useIntegrations.getState().elevenlabs?.configured) out.push('elevenlabs')
  if (useAi.getState().providers.openai?.configured) out.push('openai')
  return out
}

export const canTranscribe = (asset: Asset | undefined) =>
  Boolean(asset && asset.source.type === 'file' && !asset.source.missing && (asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio !== false)))

const inFlight = new Map<string, Promise<TranscriptSegment[]>>()

/** OpenAI takes ≤25 MB per request: send ~10-minute pieces and stitch the timings back together. */
async function withOpenAI(buffer: AudioBuffer, language?: string) {
  if (!api) throw new Error('Needs the desktop app.')
  const piece = 600
  const out: TranscriptSegment[] = []
  for (let from = 0; from < buffer.duration; from += piece) {
    const to = Math.min(buffer.duration, from + piece)
    const segs = await api.ai.transcribe(await speechWav(buffer, from, to), language)
    for (const s of segs) out.push({ start: s.start + from, end: s.end + from, text: s.text })
  }
  return out
}

async function withElevenLabs(asset: Asset, language?: string): Promise<TranscriptSegment[]> {
  const job = await elevenJob(asset.id, language)
  // The job attaches the transcript itself; wait for it.
  return new Promise((resolve, reject) => {
    const check = () => {
      const j = useIntegrations.getState().jobs[job.id]
      if (!j || j.status === 'running') return false
      unsub()
      if (j.status === 'done' && j.transcript) resolve(j.transcript)
      else reject(new Error(j.error ?? 'Transcription didn’t finish.'))
      return true
    }
    const unsub = useIntegrations.subscribe(() => void check())
    check()
  })
}

/**
 * Transcribes an asset and attaches the transcript (undoable). Resolves with the
 * phrases; concurrent requests for the same asset share one run.
 */
export function transcribeMedia(assetId: string, opts: { using?: Transcriber; language?: string; onProgress?: (p: number) => void; signal?: AbortSignal } = {}): Promise<TranscriptSegment[]> {
  const running = inFlight.get(assetId)
  if (running) return running
  const task = (async () => {
    const asset = getProject().assets[assetId]
    if (!canTranscribe(asset)) throw new Error('Only audio and video with sound can be transcribed.')
    const target = useAi.getState().target
    const using = target?.kind === 'model' && target.provider === 'ollama' ? 'local' : opts.using ?? transcribers()[0]
    if (opts.signal?.aborted) throw new DOMException('Stopped.', 'AbortError')
    if (using === 'elevenlabs') return await withElevenLabs(asset, opts.language)
    if (using === 'local' && api?.ai.transcribeLocal && asset.source.type === 'file' && asset.source.path) {
      const id = crypto.randomUUID()
      const off = api.ai.onLocalTranscriptionProgress(e => { if (e.id === id) opts.onProgress?.(e.progress) })
      const stop = () => void api?.ai.cancelLocalTranscription(id)
      opts.signal?.addEventListener('abort', stop, { once: true })
      try {
        const segments = await api.ai.transcribeLocal({ id, source: asset.source.path, language: opts.language })
        if (opts.signal?.aborted) throw new DOMException('Stopped.', 'AbortError')
        if (getProject().assets[assetId]) dispatch('asset.update', { id: assetId, patch: { transcript: segments } }, { source: 'ai', label: 'Add CUDA transcript' })
        return segments
      } finally { off(); opts.signal?.removeEventListener('abort', stop) }
    }
    // Long recordings arrive already mixed down to 16 kHz mono, streamed a minute at a time.
    const buffer = await speechAudio(asset)
    if (!buffer) throw new Error('This media has no sound to transcribe.')
    const segments = using === 'openai' ? await withOpenAI(buffer, opts.language) : await transcribeLocally(buffer, { language: opts.language, onProgress: opts.onProgress })
    if (getProject().assets[assetId]) {
      dispatch('asset.update', { id: assetId, patch: { transcript: segments } }, { source: 'ai', label: 'Add transcript' })
    }
    return segments
  })().finally(() => inFlight.delete(assetId))
  inFlight.set(assetId, task)
  return task
}

/** Transcribes every listed asset that lacks a transcript, with one progress toast. */
export async function ensureTranscripts(assetIds: string[]) {
  const todo = assetIds.filter((id) => !getProject().assets[id]?.transcript?.length && canTranscribe(getProject().assets[id]))
  if (!todo.length) return true
  const using = transcribers()[0]
  const controller = new AbortController()
  const id = toast.loading(`Transcribing ${todo.length === 1 ? getProject().assets[todo[0]].name : `${todo.length} clips`}…`, { description: TRANSCRIBER_NAMES[using], action: { label: 'Cancel', onClick: () => controller.abort() }, duration: Infinity })
  try {
    for (const [i, assetId] of todo.entries()) {
      await transcribeMedia(assetId, {
        using,
        signal: controller.signal,
        onProgress: (p) => toast.loading(`Transcribing… ${Math.round(((i + p) / todo.length) * 100)}%`, { id, description: TRANSCRIBER_NAMES[using] }),
      })
    }
    toast.success('Transcribed', { id, description: TRANSCRIBER_NAMES[using] })
    return true
  } catch (err) {
    toast.error('Transcription failed', { id, description: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/** Plain text of a short recording (voice prompts). */
export async function transcribeSpeech(buffer: AudioBuffer): Promise<string> {
  const using = transcribers().find((t) => t !== 'elevenlabs') ?? 'local'
  const segments = using === 'openai' ? await withOpenAI(buffer) : await transcribeLocally(buffer, {})
  return segments
    .map((s) => s.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}
