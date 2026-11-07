import { toast } from 'sonner'
import { openSequenceId } from '@/editor/sequences'
import { dispatch, getProject } from '@/editor/store'
import { applyVoiceEnhancement, voiceEnhancementTargets } from '@/editor/voice-enhancement'
import { desktop } from '@/lib/platform'
import { importMediaFiles } from '@/project/media-import'
import { api } from '../store'
import { bool, list, obj, oneOf, str, type AgentTool } from './kit'

export const LOCAL_AUDIO_TOOLS: AgentTool[] = [{
  name: 'enhance_local_voice',
  description: 'Fix microphone noise locally with ClearVoice MossFormer2 48k neural speech restoration on the NVIDIA GPU, plus adaptive de-essing for sharp S/SH sounds, gradual fan-noise suppression and optional voice leveling/EQ. Processes AUDIO ONLY into a lossless WAV and swaps native linked voice audio clips; original video, cuts, source offsets, group links and captions remain editable. Existing detached audio is reused; otherwise sound is detached natively. Choose speech clip_ids (a selected video resolves its linked voice), or asset_id; omit both for audible speech on this timeline. Original media is retained and the swap is undoable. Not a cure for clipping or strong room echo.',
  inputSchema: obj({ clip_ids: { anyOf: [list('Speech audio/video clip ids', str('Clip id')), { type: 'null' }], description: 'Specific speech clips; omit or null to enhance all audible speech. Do not enumerate clips for a whole-track request.' }, asset_id: { anyOf: [str('Original speech asset id'), { type: 'null' }], description: 'One source asset; omit or null for all audible speech.' }, strength: oneOf('gentle preserves more ambience; balanced default; strong removes more noise but can sound processed', ['gentle', 'balanced', 'strong']), level_voice: bool('Also balance voice loudness and rumble; default true') }),
  run: async (args, ctx) => {
    if (!api || !desktop) throw new Error('Local voice enhancement needs Lumen desktop.')
    const before = getProject(), projectId = before.id, sequence = openSequenceId(before)
    const targets = voiceEnhancementTargets(before, Array.isArray(args.clip_ids) ? args.clip_ids.map(String) : undefined, typeof args.asset_id === 'string' ? args.asset_id : undefined)
    if (!targets.length) throw new Error('No audible speech clips were found. Select the microphone clips or import a recording first.')
    const strength = args.strength === 'gentle' || args.strength === 'strong' ? args.strength : 'balanced'
    const levelVoice = args.level_voice !== false
    const originals = [...new Set(targets.map(t => t.sourceAssetId))]
    const replacements = new Map<string, string>(), reports: unknown[] = []
    const note = toast.loading('Enhancing microphone audio locally…', { description: 'ClearVoice on the local NVIDIA GPU; original video stays unchanged.', duration: Infinity })
    try {
      for (const [index, sourceId] of originals.entries()) {
        const source = before.assets[sourceId]
        if (source.source.type !== 'file' || !source.source.path) throw new Error('Choose an original media file.')
        const id = crypto.randomUUID()
        const off = api.ai.onLocalVoiceProgress(e => {
          if (e.id !== id) return
          const message = `${index + 1}/${originals.length}: ${e.message}`
          ctx?.progress?.(message)
          toast.loading('Enhancing microphone audio locally…', { id: note, description: message, duration: Infinity })
        })
        const stop = () => void api?.ai.cancelLocalVoiceEnhancement(id)
        ctx?.signal?.addEventListener('abort', stop, { once: true })
        let result
        try {
          if (ctx?.signal?.aborted) throw new Error('Stopped.')
          result = await api.ai.enhanceLocalVoice({ id, source: source.source.path, strength, levelVoice, duration: source.duration })
        } finally { off(); ctx?.signal?.removeEventListener('abort', stop) }
        if (ctx?.signal?.aborted) throw new Error('Stopped.')
        if (getProject().id !== projectId || openSequenceId(getProject()) !== sequence) throw new Error('The open project or timeline changed. Enhancement finished, but the timeline was not modified.')
        const files = await desktop.files.register([result.output])
        const [asset] = await importMediaFiles(files)
        if (!asset) throw new Error('The enhanced WAV could not be imported: ' + result.output)
        const r = dispatch('asset.update', { id: asset.id, patch: { name: `${source.name} · enhanced voice`, transcript: source.transcript, provenance: { integration: 'local-audio', tool: 'enhance_local_voice', params: { original_asset_id: source.id, strength, level_voice: levelVoice, engine: result.engine } } } }, { source: 'ai', label: 'Keep original speech timing' })
        if (!r.ok) throw new Error(r.error)
        replacements.set(sourceId, asset.id)
        reports.push(result)
      }
      if (getProject().id !== projectId || openSequenceId(getProject()) !== sequence) throw new Error('The open timeline changed; the audio clips were not modified.')
      const applied = applyVoiceEnhancement(targets, replacements)
      toast.success('Microphone audio enhanced', { id: note, description: 'Native voice clips now use the cleaned WAV. Undo restores their original audio.' })
      return { enhanced: true, audio_clip_ids: applied.audioIds, detached_video_clip_ids: applied.detachedVideoIds, processed_audio_asset_ids: [...replacements.values()], reports, video_was_rendered: false, original_media_retained: true, note: 'Listen before exporting. Noise suppression cannot recover clipped speech or reliably remove strong room reverb.' }
    } catch (error) {
      toast.error('Voice enhancement did not finish', { id: note, description: error instanceof Error ? error.message : String(error) })
      throw error
    }
  },
}]
