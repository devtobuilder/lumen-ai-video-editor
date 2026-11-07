import { expect, it, vi } from 'vitest'
vi.mock('@/project/media-import', () => ({ importMediaFiles: vi.fn() }))
vi.mock('@/lib/platform', () => ({ desktop: undefined }))
vi.mock('../store', () => ({ api: undefined }))
import { LOCAL_AUDIO_TOOLS } from './local-audio'
import { validateNativeArguments } from '../../../electron/integrations/ai/local-mode'

it('accepts absent or null optional selection as whole-track speech without accepting invalid selection values', () => {
  const tool = LOCAL_AUDIO_TOOLS[0]
  expect(() => validateNativeArguments(tool, { strength: 'balanced', level_voice: true })).not.toThrow()
  expect(() => validateNativeArguments(tool, { clip_ids: null, asset_id: null, strength: 'balanced', level_voice: true })).not.toThrow()
  expect(() => validateNativeArguments(tool, { clip_ids: 7 })).toThrow('clip_ids')
  expect(() => validateNativeArguments(tool, { strength: 'unknown' })).toThrow('strength')
})
