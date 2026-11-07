/** Native editable workflows. No rendered media is produced or imported here. */
import { toast } from 'sonner'
import { getProject, dispatch, useEditor } from '@/editor/store'
import { type CommandName, type CommandInput } from '@/editor/commands'
import { placeAsset } from '@/editor/placement'
import { allSequences, openSequenceId } from '@/editor/sequences'
import { clipEnd, projectDuration } from '@/editor/ops'
import { addCaptions, removePauses } from '@/editor/smart'
import { useUI } from '@/editor/ui-store'
import { playback } from '@/editor/playback'
import { transcribeMedia } from '@/project/transcribe'
import { bool, num, obj, oneOf, str, type AgentTool } from './kit'

function native<N extends CommandName>(name: N, input: CommandInput<N>) {
  const result = dispatch(name, input, { source: 'ai' })
  if (!result.ok) throw new Error(result.error)
  return result.result
}

export const LOCAL_SHORT_TOOLS: AgentTool[] = [
  {
    name: 'restore_native_source_gap',
    description: 'Restore the omitted original-source interval between adjacent forward normal-speed shots from the SAME video asset. Choose the second shot. Inserts time across every track and extends the first source shot, preserving caption/title wording, zoom keys and transitions. One undoable native operation; no render. Errors if there is no omitted source range or affected tracks are locked.',
    inputSchema: obj({ clip_id: str('Second original-source video shot at the cut') }, ['clip_id']),
    run: async a => {
      const fps = getProject().settings.fps
      const result = native('timeline.restoreSourceGap', { clipId: String(a.clip_id) }) as { restored_frames: number; clip_ids: string[] }
      return { ...result, restored_seconds: result.restored_frames / fps, duration_seconds: projectDuration(getProject()) / fps, editable: true }
    },
  },
  {
    name: 'set_native_text_duration',
    description: 'Change an existing native title/caption length in SECONDS, preserving its start and wording. Converts using actual fps. Returns actual duration and any neighbouring-clip limit. Does not move source footage.',
    inputSchema: obj({ clip_id: str('Existing text title or caption id'), duration_seconds: num('Desired duration in seconds', { minimum: 0.01, maximum: 600 }) }, ['clip_id', 'duration_seconds']),
    run: async a => {
      const p = getProject(), c = p.clips[String(a.clip_id)]
      if (!c || c.kind !== 'text') throw new Error('Choose an existing text title or caption clip.')
      const frames = Math.max(1, Math.round(Number(a.duration_seconds) * p.settings.fps))
      native('clip.trim', { id: c.id, edge: 'end', frame: c.start + frames, ripple: false })
      const applied = getProject().clips[c.id]
      return { clip_id: c.id, duration_frames: applied.duration, duration_seconds: applied.duration / p.settings.fps, limited: applied.duration !== frames }
    },
  },
  {
    name: 'set_native_zoom_endpoint',
    description: 'Revise the LAST existing scale keyframe of a native clip. Preserves its frame, easing and every other keyframe. Inspect video clips first to choose the clip with an existing zoom. Does not create a new animation.',
    inputSchema: obj({ clip_id: str('Clip with existing scale keyframes'), scale: num('Exact endpoint scale, e.g. 1.04', { minimum: 0.05, maximum: 10 }) }, ['clip_id', 'scale']),
    run: async a => {
      const c = getProject().clips[String(a.clip_id)]
      const keys = c?.keyframes.scale
      if (!c || !keys || keys.length < 2) throw new Error('Choose the clip with an existing animated zoom (at least two scale keys). Inspect get_editing_state kind video.')
      const last = keys.reduce((x, y) => x.frame > y.frame ? x : y)
      native('keyframe.set', { clipId: c.id, prop: 'scale', frame: last.frame, value: Number(a.scale), easing: last.easing })
      return { clip_id: c.id, keyframes: getProject().clips[c.id].keyframes.scale }
    },
  },
  {
    name: 'set_native_transition',
    description: 'Set a native transition into the chosen clip at an existing adjacent cut. Supply duration in SECONDS; the editor converts to integer frames at the actual timeline fps. Returns actual applied seconds/frames, including any available-handle limit.',
    inputSchema: obj({ clip_id: str('The SECOND clip at the cut, with a preceding adjacent clip on the same track'), kind: oneOf('Native transition', ['dissolve', 'dip', 'flash', 'slide', 'push', 'zoom', 'wipe', 'blur', 'cube', 'flip', 'door', 'swing', 'page', 'warp', 'shatter', 'spin']), duration_seconds: num('Exact desired duration in seconds, e.g. 0.2', { minimum: 0.01, maximum: 10 }) }, ['clip_id', 'kind', 'duration_seconds']),
    run: async a => {
      const p = getProject(), c = p.clips[String(a.clip_id)]
      if (!c || !Object.values(p.clips).some(prev => prev.id !== c.id && prev.trackId === c.trackId && clipEnd(prev) === c.start)) throw new Error('Choose the second clip at an existing adjacent cut; the first clip has no incoming jump cut.')
      const frames = Math.max(1, Math.round(Number(a.duration_seconds) * p.settings.fps))
      native('clip.setTransition', { id: c.id, transition: { kind: a.kind as NonNullable<typeof c.transitionIn>['kind'], duration: frames } })
      const applied = getProject().clips[c.id].transitionIn!
      return { clip_id: c.id, transition: applied, duration_seconds: applied.duration / p.settings.fps, requested_frames: frames, limited: applied.duration !== frames }
    },
  },
  {
    name: 'get_editing_state',
    description: 'Compact live native timeline state with stable clip/asset ids, editable caption text, zoom keys, audio and transition data. Use before editing and verify changes afterward. Filter kind/text and paginate for long projects. Times include frames and seconds.',
    inputSchema: obj({ kind: oneOf('Optional clip kind filter', ['video', 'audio', 'text', 'image', 'adjustment']), query: str('Match clip name or caption text'), offset: num('Page offset', { minimum: 0 }), limit: num('Page size, maximum 30', { minimum: 1, maximum: 30 }) }),
    run: async a => {
      const p = getProject(), fps = p.settings.fps
      const filter = String(a.query ?? '').toLowerCase()
      const clips = Object.values(p.clips).filter(c => (!a.kind || c.kind === a.kind) && (!filter || `${c.name} ${c.text?.content ?? ''}`.toLowerCase().includes(filter))).sort((a, b) => a.start - b.start)
      const offset = Math.max(0, Number(a.offset) || 0), limit = Math.min(30, Math.max(1, Number(a.limit) || 12))
      return {
        project: p.name, timeline_id: openSequenceId(p), timelines: allSequences(p).map(s => ({ id: s.id, name: s.name })),
        settings: p.settings, duration_seconds: projectDuration(p) / fps, selected_clip_ids: useUI.getState().selection,
        media: Object.values(p.assets).map(x => ({ id: x.id, name: x.name, kind: x.kind, duration: x.duration, transcript_words: x.transcript?.length ?? 0 })),
        tracks: p.tracks.map(t => ({ id: t.id, name: t.name, kind: t.kind, role: t.role, locked: t.locked })),
        total_matching_clips: clips.length, offset, next_offset: offset + limit < clips.length ? offset + limit : null,
        clips: clips.slice(offset, offset + limit).map(c => ({ id: c.id, name: c.name, kind: c.kind, track_id: c.trackId, group_id: c.groupId, asset_id: c.assetId, start: c.start, duration: c.duration, inPoint: c.inPoint, from_seconds: c.start / fps, to_seconds: clipEnd(c) / fps, ...(c.text ? { text: c.text.content, text_color: c.text.color, text_size: c.text.size } : {}), transform: c.transform, keyframes: c.keyframes, audio: c.audio, effects: c.effects, transitionIn: c.transitionIn })),
      }
    },
  },
  {
    name: 'prepare_native_short',
    description: 'Create a fully EDITABLE native 1080x1920 Lumen timeline from an imported original video: local CUDA Whisper attached to source, optional native pause removal, animated caption TEXT CLIPS, zoom KEYFRAMES and editable audio cleanup. No MP4, FFmpeg rendering or flattened import. Original timelines remain intact. Follow-up edits use granular native tools on this timeline. Does not semantically delete retakes: inspect transcript and native ranges for that. Export only when asked.',
    inputSchema: obj({ asset_id: str('Original imported video asset id'), remove_pauses: bool('Cut clear silent gaps, default true'), min_gap_seconds: num('Minimum pause length, default 0.6', { minimum: 0.2, maximum: 5 }), caption_style: oneOf('Native caption style, default bold; word emphasizes individual words', ['clean', 'bold', 'word', 'boxed']), punch_in: bool('Add editable subtle push-in keys, default true'), clean_audio: bool('Enable editable native denoise/enhance, default true') }, ['asset_id']),
    run: async (a, ctx) => {
      const source = getProject().assets[String(a.asset_id)]
      if (!source || source.kind !== 'video' || source.source.type !== 'file' || source.source.missing) throw new Error('Choose an imported original video asset.')
      const note = toast.loading('Building an editable native short…', { description: 'Transcribing the original media locally.', duration: Infinity })
      try {
        if (!source.transcript?.length) await transcribeMedia(source.id, { using: 'local', signal: ctx?.signal, onProgress: p => ctx?.progress?.(`CUDA transcription ${Math.round(p * 100)}%`) })
        if (ctx?.signal?.aborted) throw new Error('Stopped.')
        const seq = `native_${crypto.randomUUID()}`
        native('sequence.create', { id: seq, name: `Native edit · ${source.name} · ${new Date().toLocaleTimeString()}`, settings: { width: 1080, height: 1920, fps: 30 }, open: true })
        const first = placeAsset(source.id, 0, { source: 'ai' })
        if (!first) throw new Error('Could not place the source recording.')
        let removed = { removed: 0, seconds: 0 }
        if (a.remove_pauses !== false) {
          ctx?.progress?.('Removing pauses using native ripple cuts…')
          removed = await removePauses({ minGap: Number(a.min_gap_seconds) || 0.6 })
          if (openSequenceId(getProject()) !== seq) throw new Error('The active timeline changed. Switch back before continuing.')
        }
        if (ctx?.signal?.aborted) throw new Error('Stopped.')
        const video = Object.values(getProject().clips).filter(c => c.kind === 'video' && c.assetId === source.id).sort((a, b) => a.start - b.start)
        let voiceIds: string[] = []
        useEditor.getState().transaction('Native audio and camera moves', 'ai', () => {
          for (const [i, c] of video.entries()) {
            if (a.clean_audio !== false) native('clip.update', { ids: [c.id], patch: { audio: { enhance: true, denoise: true, fadeIn: 1, fadeOut: 1 } } })
            if (a.punch_in !== false && i % 3 === 1) native('clip.animate', { clipId: c.id, preset: 'push-in', intensity: 0.35 })
          }
          if (source.hasAudio !== false && video.length) voiceIds = native('clip.detachAudio', { ids: video.map(c => c.id) }) as string[]
        })
        ctx?.progress?.('Creating editable animated caption clips…')
        const style = ['clean', 'bold', 'word', 'boxed'].includes(String(a.caption_style)) ? a.caption_style as 'clean' | 'bold' | 'word' | 'boxed' : 'bold'
        const captions = addCaptions({ style, maxWords: style === 'word' ? 1 : 4, y: 440, source: 'ai' })
        // Initial construction may ripple. Hand the finished cut back in free
        // mode so the user's ordinary trims/deletes do not collapse the reel.
        const main = getProject().tracks.find(t => t.role === 'main')
        if (main) native('track.update', { id: main.id, patch: { magnetic: false } })
        playback.seek(0); useUI.getState().requestFit()
        toast.success('Native edit ready', { id: note, description: 'Captions, cuts, camera moves and audio remain editable. Nothing has been pre-rendered.' })
        return { timeline_id: seq, editable: true, prerendered: false, exported: false, magnetic: false, source_asset_id: source.id, video_clip_ids: video.map(c => c.id), voice_clip_ids: voiceIds, separate_voice_track: voiceIds.length > 0, captions_added: captions.added, captions_track_id: captions.trackId, pauses_removed: removed.removed, seconds_removed: removed.seconds, duration_seconds: projectDuration(getProject()) / 30, next: 'Voice audio is on linked audio clips. Magnetic mode is off for gap-preserving manual trims/deletes; explicit ripple remains available. Inspect get_editing_state/get_transcript. Refine with native tools; export only when requested.' }
      } catch (e) { toast.error('Native editing stopped', { id: note, description: e instanceof Error ? e.message : String(e) }); throw e }
    },
  },
]
