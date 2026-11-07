/**
 * Typefaces: the built-in ones, plus fonts embedded in the project — imported
 * from a file or picked from those installed on this computer. Embedded fonts
 * are registered with the page under their own family name as they appear, so
 * titles draw with them on the canvas and extrude with them in 3D.
 */
import { FONTS } from '@/editor/defaults'
import type { FontId, FontRef, Project, ProjectFont,TextStyle } from '@/editor/types'

const registered = new Map<string, FontFace>()
const fileUrls = new Map<string, string>()
const loadingTextFonts=new Map<string,Promise<unknown>>()
const failedTextFonts=new Set<string>()

export function textFontCss(style:TextStyle,project:Pick<Project,'fonts'>,scale=1):string {
  return `${style.italic?'italic ':''}${style.weight} ${style.size*scale}px ${fontCss(style.font,project)}`
}

/** Do not expose fallback metrics while the actual requested face loads. */
export function textFontReady(project:Pick<Project,'fonts'>,style:TextStyle,scale=1):boolean {
  if(typeof document==='undefined'||!document.fonts)return true
  registerProjectFonts(project)
  const css=textFontCss(style,project,scale),sample=style.uppercase?style.content.toUpperCase():style.content
  const key=css+'|'+sample
  if(document.fonts.check(css,sample)||failedTextFonts.has(key))return true
  if(!loadingTextFonts.has(key))loadingTextFonts.set(key,document.fonts.load(css,sample).catch(error=>{
    failedTextFonts.add(key)
    console.warn('Requested text font failed to load; using the available fallback.',error)
  }))
  return false
}

/** Start face loads before awaiting readiness: fonts.ready alone may already
 * be resolved on a cold project that has not requested its caption fonts yet. */
export async function prepareTextFonts(project:Pick<Project,'fonts'|'clips'>,scale=1):Promise<void> {
  if(typeof document==='undefined'||!document.fonts)return
  const pending:Promise<unknown>[]=[]
  for(const clip of Object.values(project.clips))if(clip.kind==='text'&&clip.text&&!textFontReady(project,clip.text,scale)){
    const st=clip.text,sample=st.uppercase?st.content.toUpperCase():st.content
    const load=loadingTextFonts.get(textFontCss(st,project,scale)+'|'+sample)
    if(load)pending.push(load)
  }
  await Promise.all(pending)
  await document.fonts.ready
}

export const isCustomFont = (ref: FontRef): ref is `custom:${string}` => ref.startsWith('custom:')

/** The project font a reference points to, if it's one. */
export function projectFont(project: Pick<Project, 'fonts'> | undefined, ref: FontRef): ProjectFont | undefined {
  return isCustomFont(ref) ? project?.fonts?.[ref.slice('custom:'.length)] : undefined
}

/** The CSS font-family list for a font reference (missing project fonts fall back to the default). */
export function fontCss(ref: FontRef, project?: Pick<Project, 'fonts'>): string {
  if (isCustomFont(ref)) {
    const f = projectFont(project, ref)
    return f ? `"${f.family}", ${FONTS.sans.css}` : FONTS.sans.css
  }
  return (FONTS[ref as FontId] ?? FONTS.sans).css
}

export function fontLabel(ref: FontRef, project?: Pick<Project, 'fonts'>) {
  return isCustomFont(ref) ? (projectFont(project, ref)?.name ?? 'Missing font') : (FONTS[ref as FontId] ?? FONTS.sans).label
}

export function base64ToBytes(b64: string) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function bytesToBase64(bytes: Uint8Array) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Makes every font embedded in the project available to the page (once each). */
export function registerProjectFonts(project: Pick<Project, 'fonts'>) {
  for (const f of Object.values(project.fonts ?? {})) {
    if (registered.has(f.family)) continue
    try {
      const face = new FontFace(f.family, base64ToBytes(f.data))
      registered.set(f.family, face)
      document.fonts.add(face)
      void face.load().catch((err) => console.warn(`Couldn’t load the font ${f.name}`, err))
    } catch (err) {
      console.warn(`Couldn’t register the font ${f.name}`, err)
    }
  }
}

/** A URL to the font file itself (for 3D titles, which extrude real glyph outlines). */
export function fontFileUrl(project: Pick<Project, 'fonts'> | undefined, ref: FontRef): string | null {
  const f = projectFont(project, ref)
  if (!f) return null
  let url = fileUrls.get(f.id)
  if (!url) {
    url = URL.createObjectURL(new Blob([base64ToBytes(f.data)], { type: 'font/ttf' }))
    fileUrls.set(f.id, url)
  }
  return url
}

/** A family name no page font uses, for a font we're about to embed. */
export const uniqueFamily = (name: string, id: string) => `Lumen ${name.replace(/["\\]/g, '')} ${id.slice(-6)}`

// ─── Fonts on this computer ──────────────────────────────────────────────

export interface LocalFont {
  family: string
  fullName: string
  postscriptName: string
  style: string
  load: () => Promise<Blob>
}

interface FontData {
  family: string
  fullName: string
  postscriptName: string
  style: string
  blob(): Promise<Blob>
}

/** The fonts installed on this computer (Local Font Access), or null where the browser can't list them. */
export async function localFonts(): Promise<LocalFont[] | null> {
  const query = (window as unknown as { queryLocalFonts?: () => Promise<FontData[]> }).queryLocalFonts
  if (!query) return null
  try {
    const list = await query()
    return list.map((f) => ({ family: f.family, fullName: f.fullName, postscriptName: f.postscriptName, style: f.style, load: () => f.blob() }))
  } catch (err) {
    console.warn('Couldn’t list the fonts on this computer', err)
    return null
  }
}
