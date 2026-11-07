import { voiceClips } from './smart'
import { dispatch, getProject, rollbackTo, savepoint, useEditor } from './store'
import type { Asset, Clip, Project } from './types'

export interface VoiceEnhancementTarget {
  clipId: string
  sourceAssetId: string
  assetId: string
  start: number
  duration: number
  inPoint: number
}

export function originalVoiceAsset(project: Project, clip: Clip): Asset | undefined {
  return originalAsset(project, clip.assetId)
}

function originalAsset(project: Project, id?: string): Asset | undefined {
  const seen = new Set<string>()
  while (id && !seen.has(id)) {
    seen.add(id)
    const asset: Asset | undefined = project.assets[id]
    const original = asset?.provenance?.integration === 'local-audio' ? asset.provenance.params?.original_asset_id : undefined
    if (typeof original !== 'string') return asset
    id = original
  }
  return undefined
}

/** Resolve a selected video's existing linked sound before considering detachment. */
export function voiceEnhancementTargets(project: Project, clipIds?: string[], assetId?: string): VoiceEnhancementTarget[] {
  if (assetId && !project.assets[assetId]) throw new Error(`Speech asset ${assetId} no longer exists. Read the current timeline before retrying.`)
  // A previous enhanced asset is a valid source selector even after another
  // cleanup replaced it. Resolve its provenance just like the active clips.
  const sourceId = assetId ? originalAsset(project, assetId)?.id : undefined
  const requested = clipIds?.length ? clipIds.map(id => project.clips[id]) : assetId ? voiceClips(project).filter(c => originalVoiceAsset(project, c)?.id === sourceId) : voiceClips(project)
  const resolved = new Map<string, Clip>()
  for (const clip of requested) {
    if (!clip || (clip.kind !== 'video' && clip.kind !== 'audio')) throw new Error('Choose speech audio clips or video clips with sound.')
    if (clip.kind === 'video' && clip.audio.detached) {
      const sourceId = originalVoiceAsset(project, clip)?.id
      let linked = Object.values(project.clips).filter(c => c.kind === 'audio' && clip.groupId && c.groupId === clip.groupId && originalVoiceAsset(project, c)?.id === sourceId)
      if (!linked.length) {
        // Manual unlinking must not make a cut's separate microphone source
        // undiscoverable. Only use an unambiguous exact source/timing match.
        const aligned = Object.values(project.clips).filter(c => c.kind === 'audio' && originalVoiceAsset(project, c)?.id === sourceId && c.start === clip.start && c.duration === clip.duration && c.inPoint === clip.inPoint && c.speed === clip.speed && c.reverse === clip.reverse)
        if (aligned.length === 1) linked = aligned
      }
      if (!linked.length) throw new Error(`The video “${clip.name}” has detached sound but no matching linked audio clip. Choose its voice clip directly.`)
      for (const sound of linked) resolved.set(sound.id, sound)
    } else resolved.set(clip.id, clip)
  }
  return [...resolved.values()].map(c => {
    const source = originalVoiceAsset(project, c)
    if (!source || source.source.type !== 'file' || !source.source.path || source.hasAudio === false || c.sequenceId) throw new Error('Voice enhancement needs original audio/video files, not nested timelines or silent assets.')
    if (project.tracks.find(t => t.id === c.trackId)?.locked) throw new Error('Unlock the speech track before enhancing it.')
    return { clipId: c.id, sourceAssetId: source.id, assetId: c.assetId!, start: c.start, duration: c.duration, inPoint: c.inPoint }
  })
}

/** Swap only native audio clip references; video, groups, timing and keyframes survive. */
export function applyVoiceEnhancement(targets: VoiceEnhancementTarget[], replacements: Map<string, string>) {
  const p = getProject()
  for (const t of targets) {
    const c = p.clips[t.clipId]
    if (!c || c.assetId !== t.assetId || c.start !== t.start || c.duration !== t.duration || c.inPoint !== t.inPoint) throw new Error('The speech clips changed while processing. The WAV is ready, but rerun enhancement to apply it safely.')
    if (!replacements.has(t.sourceAssetId)) throw new Error('An enhanced source is missing.')
  }
  const audioIds: string[] = [], detached: string[] = []
  const groups = new Map<string, string[]>()
  const how = { source: 'ai' as const }
  useEditor.getState().transaction('Enhance local microphone audio', 'ai', () => {
    const mark = savepoint()
    try {
      for (const t of targets) {
        const clip = getProject().clips[t.clipId]
        let id = clip.id
        if (clip.kind === 'video') {
          const r = dispatch('clip.detachAudio', { ids: [id] }, how)
          if (!r.ok) throw new Error(r.error)
          id = (r.result as string[])[0]
          detached.push(clip.id)
        }
        audioIds.push(id)
        const assetId = replacements.get(t.sourceAssetId)!
        groups.set(assetId, [...(groups.get(assetId) ?? []), id])
      }
      for (const [assetId, ids] of groups) {
        const r = dispatch('clip.replaceAsset', { ids, assetId }, how)
        if (!r.ok) throw new Error(r.error)
      }
      // This source is already neurally cleaned and optionally leveled. Retain
      // user gain/fades/keyframes, but avoid running a second denoiser over it.
      const r = dispatch('clip.update', { ids: audioIds, patch: { audio: { denoise: false, enhance: false } } }, how)
      if (!r.ok) throw new Error(r.error)
    } catch (error) { if (mark) rollbackTo(mark); throw error }
  })
  return { audioIds, detachedVideoIds: detached }
}
