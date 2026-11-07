import { dynamicTool, isStepCount, jsonSchema, streamText, type ModelMessage, type SystemModelMessage, type ToolSet } from 'ai'
import { COPILOT_INSTRUCTIONS, type AgentErrorCode, type AgentEvent, type AgentEventBody, type AgentRunRequest, type AgentUsage } from '../../../shared/ai'
import { IPC, type BridgeTool } from '../../../shared/integrations'
import { callEditorTool, editorTools, editorWindow } from '../editor-rpc'
import { forgetAttachments, readAttachment } from './attachments'
import { deleteHistory, readHistory, writeHistory } from './chats'
import { claudeEfforts, effortSettings, geminiEfforts, openaiEfforts, type ModelApi } from './effort'
import { forgetLocalSession, runLocal, stopLocal } from './local-agents'
import { languageModel, MissingKeyError } from './providers'
import { localTools, canonicalDirectArguments, retakeModelContext, localPhaseRequest, localPhaseInstructions, LocalToolFailureGuard, existingNativeEditingPlan, LocalNativeToolQueue, localFinishingPlan, LocalPreparationGate, requiredToolChoiceMiss, validateNativeArguments, LOCAL_INSTRUCTIONS, describeLocalTool, searchLocalTools, localHistory, isLocalRetryMessage, compactLocalMessages, valueAt, directLocalTools, newLocalProgress, recordLocalAction, pendingLocalTasks, localWireFrame, LocalNativeGuard, type NativeStateSnapshot } from './local-mode'
import { describeLocalPictures } from './local-vision'
import { writeJson } from '../paths'

/**
 * The Copilot's brain when it's a model the user brought a key for: an AI SDK
 * tool loop whose tools are the editor's own (the same ones Lumen serves over
 * MCP). Everything it does streams to the editor as it happens: each request
 * to the model, its thinking, the tool call it is writing, each tool's result.
 */

const histories = new Map<string, ModelMessage[]>()
const controllers = new Map<string, AbortController>()
const localResultCaches = new Map<string, Map<string, { tool: string; value: unknown }>>()
const MAX_STEPS = 40
/** The conversation is cut back to KEEP messages once it passes MAX — in one go, so the cached prefix stays put between cuts. */
const MAX_HISTORY = 80
const KEEP_HISTORY = 40
/** Tries after the provider is busy or the connection drops, and how long to wait before each. */
const RETRY_WAITS = [2, 6, 15]

export function emitAgent(e: AgentEvent) {
  editorWindow()?.webContents.send(IPC.aiEvent, e)
}

export async function startAgentRun(req: AgentRunRequest) {
  if (req.target.kind === 'local') {
    void runLocal(req, emitAgent).catch((err) => emitAgent({ runId: req.runId, type: 'error', code: 'failed', message: message(err) }))
    return
  }
  void runModel(req)
}

export function stopAgentRun(runId: string) {
  controllers.get(runId)?.abort()
  stopLocal(runId)
}

export function forgetConversation(conversationId: string) {
  localResultCaches.delete(conversationId)
  histories.delete(conversationId)
  deleteHistory(conversationId)
  forgetLocalSession(conversationId)
  forgetAttachments(conversationId)
}

/** What a conversation remembers: this session's turns, or those saved before a restart. */
function historyOf(conversationId: string) {
  let h = histories.get(conversationId)
  if (!h) {
    h = readHistory(conversationId) ?? []
    histories.set(conversationId, h)
  }
  return h
}

type Options = Record<string, Record<string, unknown>>
type ProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

/**
 * Asks reasoning models to show their thinking. Claude 4.6 and later think
 * adaptively and send nothing of it unless a summary is asked for (a long,
 * silent wait otherwise); OpenAI sends summaries and Gemini its thoughts only
 * when asked.
 */
export function thinkingOptions(api: ModelApi, modelId: string): Options {
  if (api === 'anthropic' && claudeEfforts(modelId).includes('max')) return { anthropic: { thinking: { type: 'adaptive', display: 'summarized' } } }
  if (api === 'openai' && openaiEfforts(modelId).length) return { openai: { reasoningSummary: 'auto' } }
  if (api === 'google' && geminiEfforts(modelId).length) return { google: { thinkingConfig: { includeThoughts: true } } }
  return {}
}

/** Merges provider options one provider deep (effort, thinking display and caching all live there). */
function mergeOptions(...all: (Options | undefined)[]) {
  const out: Options = {}
  for (const opts of all) for (const [provider, values] of Object.entries(opts ?? {})) out[provider] = { ...out[provider], ...values }
  return out
}

/** Zod's JSON Schema output carries a $schema key some providers reject. */
function cleanSchema(schema: Record<string, unknown>) {
  const { $schema: _unused, ...rest } = schema
  void _unused
  return { type: 'object', properties: {}, ...rest } as Parameters<typeof jsonSchema>[0]
}

// ─── Prompt caching ──────────────────────────────────────────────────────
//
// Every step of a turn sends the tools, the instructions and the whole
// conversation again. Providers bill a cached prefix at a fraction, as long as
// it is byte for byte what was sent before — so the tools go in a fixed order,
// the instructions never change within a chat, and what changes each turn (the
// playhead, the selection) rides in the user's message, after everything cached.
//
// Claude caches only up to marked points: the end of the instructions (which
// covers the tools before them) and the end of the conversation so far. OpenAI
// and Gemini cache by themselves; OpenAI routes a chat's requests to the same
// cache when they share a key.

type CacheControl = { type: 'ephemeral'; ttl?: '1h' }

/**
 * How long the tools and instructions stay cached. People stop and think
 * between requests: an hour (written at twice the price, read many times) on
 * Anthropic's own API, the five-minute default through gateways.
 */
const prefixCache = (provider: string): CacheControl => (provider === 'anthropic' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' })

/** The standing instructions, marked as the end of the cached prefix for Claude. */
export function systemPrompt(api: ModelApi, provider: string, instructions: string | undefined): string | SystemModelMessage[] {
  const text = instructions ? `${COPILOT_INSTRUCTIONS}\n\n${instructions}` : COPILOT_INSTRUCTIONS
  if (api !== 'anthropic') return text
  return [{ role: 'system', content: text, providerOptions: { anthropic: { cacheControl: prefixCache(provider) } } }]
}

function marked(m: ModelMessage): ModelMessage {
  return { ...m, providerOptions: { ...m.providerOptions, anthropic: { ...m.providerOptions?.anthropic, cacheControl: { type: 'ephemeral' } } } } as ModelMessage
}

/** A message without a cache mark from an earlier step (each step's messages build on the last step's). */
function unmarked(m: ModelMessage): ModelMessage {
  const anthropic = m.providerOptions?.anthropic as Record<string, unknown> | undefined
  if (!anthropic?.cacheControl) return m
  const { cacheControl: _mark, ...rest } = anthropic
  void _mark
  return { ...m, providerOptions: { ...m.providerOptions, anthropic: rest } } as ModelMessage
}

/**
 * Marks where Claude caches the conversation: the last message (each step then
 * reads everything before it from the cache) and the last message of earlier
 * turns (their stored form differs from what the turn itself sent, so it is
 * written once at the start of a turn and read by every step after). Only
 * those two: Claude takes four marks a request, and the instructions hold one.
 */
export function cacheMarks(messages: ModelMessage[], earlier: number): ModelMessage[] {
  const last = messages.length - 1
  return messages.map((m, i) => (i === last || (earlier > 0 && i === earlier - 1) ? marked(m) : unmarked(m)))
}

/** Cache settings on the request itself, per provider. */
function cacheOptions(api: ModelApi, modelId: string, conversationId: string): Options {
  if (api === 'openai') return { openai: { promptCacheKey: conversationId.slice(0, 64) } }
  // OpenRouter passes this through to Claude models, which cache automatically with it.
  if (api === 'openrouter' && modelId.startsWith('anthropic/')) return { openrouter: { cache_control: { type: 'ephemeral' } } }
  return {}
}

// ─── Attached files ──────────────────────────────────────────────────────
//
// A message's attachments are stored as markers and put back from disk for
// every request, so the history stays small and each turn sends the same bytes
// (which is what lets them be read from the cache).

const MARKER = /^\[\[lumen-attachment:(att_[0-9a-f]{12})\]\]$/
const marker = (id: string) => `[[lumen-attachment:${id}]]`

/** The user's turn as it's stored. */
export function userTurn(req: Pick<AgentRunRequest, 'prompt' | 'context' | 'attachments'>): ModelMessage {
  const text = req.context ? `${req.context}\n\n${req.prompt}` : req.prompt
  if (!req.attachments?.length) return { role: 'user', content: text }
  return { role: 'user', content: [...req.attachments.map((a) => ({ type: 'text' as const, text: marker(a.id) })), { type: 'text', text }] }
}

type UserPart = Exclude<Extract<ModelMessage, { role: 'user' }>['content'], string>[number]

function attachmentParts(conversationId: string, id: string, can: { vision: boolean; pdf: boolean }): UserPart[] {
  const found = readAttachment(conversationId, id)
  if (!found) return [{ type: 'text', text: '[An attached file that is no longer kept.]' }]
  const { meta, bytes } = found
  const label = `Attached file “${meta.name}” (${id})`
  if (meta.kind === 'text') return [{ type: 'text', text: `${label}:\n<file>\n${bytes.toString('utf8')}\n</file>` }]
  if (meta.kind === 'image') {
    if (!can.vision) return [{ type: 'text', text: `[${label}: a picture, which this model can’t see.]` }]
    return [{ type: 'text', text: `${label}:` }, { type: 'file', data: bytes, mediaType: meta.mime }]
  }
  if (!can.pdf) return [{ type: 'text', text: `[${label}: a PDF, which this model can’t open. Tell the user, and suggest a Claude, GPT or Gemini model, or pasting the text.]` }]
  return [{ type: 'text', text: `${label}:` }, { type: 'file', data: bytes, mediaType: 'application/pdf', filename: meta.name }]
}

/** Puts attached files back where their markers are, in the form this model takes. */
export function withAttachments(messages: ModelMessage[], conversationId: string, can: { vision: boolean; pdf: boolean }): ModelMessage[] {
  return messages.map((m) => {
    if (m.role !== 'user' || !Array.isArray(m.content) || !m.content.some((p) => p.type === 'text' && MARKER.test(p.text))) return m
    return {
      ...m,
      content: m.content.flatMap((part) => {
        const id = part.type === 'text' ? MARKER.exec(part.text)?.[1] : undefined
        return id ? attachmentParts(conversationId, id, can) : [part]
      }),
    }
  })
}

// ─── Pictures ────────────────────────────────────────────────────────────
//
// Tools like get_frame return images. Claude takes them inside the tool result;
// every other provider gets them as a message right after it (which all vision
// models accept). A model that turns out not to take images is remembered, and
// its tools' pictures become a short note instead.

interface Picture {
  data: string
  mimeType: string
}

interface ToolOutput {
  text: string
  pictures: number
}

const PICTURES_NOTE = 'The pictures from the tools you just called:'
const FOLLOWS_NOTE = '[The picture follows in the next message.]'
const DROPPED_NOTE = '[picture — not kept]'
/** "provider:model" pairs that rejected images. */
const textOnly = new Set<string>()
/** "provider:model" pairs that rejected an effort setting. */
const noEffort = new Set<string>()

function isPictureMessage(m: ModelMessage) {
  return m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'text' && m.content[0].text === PICTURES_NOTE
}

const isImageType = (mediaType: unknown) => typeof mediaType === 'string' && mediaType.startsWith('image')

/** Replaces tool pictures with a note — for the stored history, and for a model that can't see. */
function stripPictures(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        ...m,
        content: m.content.map((part) => {
          if (part.type !== 'tool-result') return part
          // The picture message that followed isn't kept either.
          if (part.output.type === 'text') return part.output.value.includes(FOLLOWS_NOTE) ? { ...part, output: { ...part.output, value: part.output.value.replace(FOLLOWS_NOTE, DROPPED_NOTE) } } : part
          if (part.output.type !== 'content') return part
          const value = part.output.value.map((v) =>
            (v.type === 'file' || v.type === 'image-data' || v.type === 'file-data') && isImageType(v.mediaType) ? { type: 'text' as const, text: DROPPED_NOTE } : v,
          )
          return { ...part, output: { ...part.output, value } }
        }),
      }
    }
    if (m.role === 'user' && Array.isArray(m.content) && isPictureMessage(m)) return { ...m, content: m.content.filter((c) => c.type === 'text') }
    return m
  })
}

/** What's kept between turns: no tool pictures, and very long tool results cut down so the conversation stays affordable. */
function forHistory(messages: ModelMessage[]): ModelMessage[] {
  const LIMIT = 6000
  return stripPictures(messages).map((m) => {
    if (m.role !== 'tool') return m
    return {
      ...m,
      content: m.content.map((part) =>
        part.type === 'tool-result' && part.output.type === 'text' && part.output.value.length > LIMIT
          ? { ...part, output: { ...part.output, value: `${part.output.value.slice(0, LIMIT)}\n…[cut for length — call the tool again for the rest]` } }
          : part,
      ),
    }
  })
}

/**
 * Claude binds each thinking block to the exact conversation before it, and the
 * stored history is edited (pictures dropped, long results cut), so earlier
 * turns' thinking can't be replayed — it would be rejected. It only matters
 * within the turn that produced it, so it's left out of later turns.
 */
function stripReasoning(messages: ModelMessage[]): ModelMessage[] {
  return messages.flatMap((m) => {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) return [m]
    const content = m.content.filter((part) => part.type !== 'reasoning')
    return content.length ? [{ ...m, content }] : []
  })
}

/** A 400-ish error that says the model doesn't take image input. */
function isPictureRejection(err: unknown) {
  const code = status(err)
  if (code !== undefined && code !== 400 && code !== 415 && code !== 422) return false
  return /image|vision|multi-?modal|modalit/i.test(message(err))
}

/** A 400-ish error about the effort / reasoning / thinking setting. */
function isEffortRejection(err: unknown) {
  const code = status(err)
  if (code !== undefined && code !== 400 && code !== 422) return false
  return /effort|reasoning|thinking|budget/i.test(message(err))
}

/** The provider is busy, or the connection dropped: worth another try. */
export function isRetryable(err: unknown) {
  const code = status(err)
  if (code !== undefined) return code === 408 || code === 409 || code === 429 || code >= 500
  return /fetch failed|network|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|terminated|overloaded/i.test(message(err))
}

/** Rejects as soon as the run is stopped, whatever the work underneath is doing. */
function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work
  if (signal.aborted) return Promise.reject(new DOMException('Stopped.', 'AbortError'))
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new DOMException('Stopped.', 'AbortError'))
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

function buildTools(defs: BridgeTool[], runId: string, pictures: Map<string, Picture[]>, modes: () => { native: boolean; vision: boolean }, onSuccess?: (name:string,args:Record<string,unknown>,resultText:string)=>Promise<void>|void, before?: (name:string,args:Record<string,unknown>)=>Promise<void>|void): ToolSet {
  const tools: ToolSet = {}
  // In name order whatever order they were registered or connected in: the tool list opens every request, and a cached prefix has to match exactly.
  for (const def of [...defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    tools[def.name] = dynamicTool({
      description: def.description,
      inputSchema: jsonSchema(cleanSchema(def.inputSchema)),
      execute: async (input, { toolCallId, abortSignal }): Promise<ToolOutput> => {
        if(before) validateNativeArguments(def,(input??{}) as Record<string,unknown>)
        await before?.(def.name,(input??{}) as Record<string,unknown>)
        const res = await abortable(callEditorTool(def.name, (input ?? {}) as Record<string, unknown>, undefined, runId), abortSignal)
        const text = res.content.flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('\n')
        if (res.isError) throw new Error(text || 'The tool failed.')
        await onSuccess?.(def.name,(input??{}) as Record<string,unknown>,text)
        const pics = res.content.flatMap((c) => (c.type === 'image' ? [{ data: c.data, mimeType: c.mimeType }] : []))
        if (pics.length) pictures.set(toolCallId, pics)
        return { text, pictures: pics.length }
      },
      toModelOutput: ({ toolCallId, output }) => {
        const out = output as ToolOutput
        const pics = pictures.get(toolCallId) ?? []
        if (!pics.length) return { type: 'text', value: out.text }
        const { native, vision } = modes()
        if (!vision) return { type: 'text', value: `${out.text}\n\n[${pics.length} picture${pics.length > 1 ? 's' : ''} not shown — this model can’t see images.]` }
        if (!native) return { type: 'text', value: `${out.text}\n\n${FOLLOWS_NOTE}` }
        return {
          type: 'content',
          value: [{ type: 'text', text: out.text }, ...pics.map((p) => ({ type: 'file' as const, mediaType: p.mimeType, data: { type: 'data' as const, data: p.data } }))],
        }
      },
    })
  }
  return tools
}

/** Tool discovery keeps the complete local editor available without serializing
 * every large Zod patch schema into each request. Execution stays native.
 */
function buildLocalBroker(defs: BridgeTool[], runId: string, conversationId: string, pictures: Map<string, Picture[]>, prompt: string, emit: (event: AgentEventBody) => void, onSuccess:(name:string,args:Record<string,unknown>,resultText:string)=>Promise<void>|void,before:(name:string,args:Record<string,unknown>)=>Promise<void>|void): ToolSet {
  const byName = new Map(localTools(defs).map(t => [t.name, t]))
  let results = localResultCaches.get(conversationId)
  if (!results) { results = new Map(); localResultCaches.set(conversationId, results) }
  const cache = results
  const definition = (name: unknown) => {
    const def = byName.get(String(name))
    if (!def) throw new Error('Unknown or non-local tool. Use lumen_search_tools to find a native local editor capability.')
    return def
  }
  const textOutput = (value: unknown): ToolOutput => ({ text: JSON.stringify(value), pictures: 0 })
  const output = { toModelOutput: ({ output }: { output: unknown }) => ({ type: 'text' as const, value: (output as ToolOutput).text }) }
  return {
    lumen_search_tools: dynamicTool({
      description: 'Discover native LOCAL Lumen capabilities. Search words like caption, cut, zoom, audio, export, sequence, effects. No cloud tools. Use exact returned names.',
      inputSchema: jsonSchema({ type:'object', properties:{ query:{type:'string'} }, required:['query'], additionalProperties:false }),
      execute: async input => textOutput({ matches: searchLocalTools([...byName.values()], String((input as {query?:unknown}).query ?? '')), total_available: byName.size }),
      ...output,
    }),
    lumen_describe_tool: dynamicTool({
      description: 'Get a native tool description and exact argument schema before calling it. schema_path optionally selects nested fields (e.g. patch.text, patch.audio, patch.transform, items). Required fields remain mandatory.',
      inputSchema: jsonSchema({ type:'object', properties:{ name:{type:'string'}, schema_path:{type:'string'} }, required:['name'], additionalProperties:false }),
      execute: async input => { const a=input as {name:string;schema_path?:string}; return textOutput(describeLocalTool(definition(a.name),a.schema_path)) },
      ...output,
    }),
    lumen_call: dynamicTool({
      description: 'Execute one native Lumen tool, with arguments exactly matching its described schema. Real undoable editor changes; no hard-render shortcut. For a large result use result_id with lumen_read_result, never repeat a mutation. Transcription is forced local.',
      inputSchema: jsonSchema({ type:'object', properties:{ name:{type:'string'}, arguments:{type:'object',additionalProperties:true} }, required:['name','arguments'], additionalProperties:false }),
      execute: async (input,{toolCallId,abortSignal}) => {
        const a=input as {name:string;arguments:Record<string,unknown>}, def=definition(a.name)
        if (!a.arguments || Array.isArray(a.arguments) || typeof a.arguments!=='object') throw new Error('arguments must be an object matching the tool schema.')
        const args=def.name==='transcribe_media'?{...a.arguments,provider:'local'}:a.arguments
        validateNativeArguments(def,args)
        await before(def.name,args)
        const res=await abortable(callEditorTool(def.name,args,undefined,runId),abortSignal)
        let text=res.content.flatMap(c=>c.type==='text'?[c.text]:[]).join('\n')
        if(res.isError) throw new Error(text || 'Native tool failed.')
        const pics=res.content.flatMap(c=>c.type==='image'?[{data:c.data,mimeType:c.mimeType}]:[])
        let visionConfirmed=true
        if(pics.length) {
          pictures.set(toolCallId,pics)
          emit({type:'status',message:'Inspecting the actual rendered frames with local vision…'})
          try { text+='\n\nLOCAL VISION ANALYSIS:\n'+await describeLocalPictures(pics,`User request: ${prompt}\nNative tool: ${def.name}. Describe the actual frame(s), especially framing, caption readability, overlap, visual effects and any defects relevant to the requested edit. Do not assume edits happened outside these frames.`,abortSignal) }
          catch(err) { if(abortSignal?.aborted) throw err; visionConfirmed=false;text+='\n\nLocal visual analysis unavailable: '+message(err)+'. Images were returned to the editor; do not claim to have inspected them.' }
        }
        let value:unknown
        try { value=JSON.parse(text) } catch { value=text }
        cache.set(toolCallId,{tool:def.name,value})
        while(cache.size>60) cache.delete(cache.keys().next().value!)
        const encoded=JSON.stringify(value)
        if(visionConfirmed) await onSuccess(def.name,args,text)
        return textOutput(encoded.length<=6500?{result_id:toolCallId,native_tool:def.name,result:value}:{result_id:toolCallId,native_tool:def.name,total_chars:encoded.length,preview:encoded.slice(0,4500),note:'Large result cached. Use lumen_read_result with a path or offset to inspect exact details without re-executing.'})
      },
      ...output,
    }),
    lumen_read_result: dynamicTool({
      description: 'Read a cached native result without executing the tool again. path is a dot-separated JSON path, e.g. tracks.0.clips or clips. offset pages serialized text; limit up to 5000 characters.',
      inputSchema: jsonSchema({ type:'object', properties:{ result_id:{type:'string'}, path:{type:'string'}, offset:{type:'integer',minimum:0}, limit:{type:'integer',minimum:100,maximum:5000} }, required:['result_id'],additionalProperties:false }),
      execute: async input => {
        const a=input as {result_id:string;path?:string;offset?:number;limit?:number}, hit=cache.get(a.result_id)
        if(!hit) throw new Error('Result is no longer cached. Inspect fresh current state; do not repeat a mutation.')
        const value=a.path?valueAt(hit.value,a.path):hit.value, encoded=JSON.stringify(value), offset=Math.max(0,a.offset??0),limit=Math.max(100,Math.min(5000,a.limit??3500))
        return textOutput({result_id:a.result_id,native_tool:hit.tool,path:a.path??'',total_chars:encoded.length,offset,...(encoded.length<=limit&&offset===0?{result:value}:{text:encoded.slice(offset,offset+limit),next_offset:offset+limit<encoded.length?offset+limit:null})})
      },
      ...output,
    }),
  }
}

/** For providers without pictures in tool results: show the latest tool pictures as a message, dropping older ones. */
function withPictures(messages: ModelMessage[], pictures: Map<string, Picture[]>): ModelMessage[] | undefined {
  const last = messages[messages.length - 1]
  if (last?.role !== 'tool') return undefined
  const pics = last.content.flatMap((part) => (part.type === 'tool-result' ? (pictures.get(part.toolCallId) ?? []) : []))
  if (!pics.length) return undefined
  const earlier = messages.map((m) => (isPictureMessage(m) ? { role: 'user' as const, content: [{ type: 'text' as const, text: '[Earlier pictures — no longer attached.]' }] } : m))
  return [...earlier, { role: 'user', content: [{ type: 'text', text: PICTURES_NOTE }, ...pics.map((p) => ({ type: 'file' as const, data: p.data, mediaType: p.mimeType }))] }]
}

/** Keeps the conversation bounded, cutting only at a user turn so tool calls stay paired. */
export function trim(history: ModelMessage[]) {
  if (history.length <= MAX_HISTORY) return history
  let start = history.length - KEEP_HISTORY
  while (start < history.length && history[start].role !== 'user') start++
  return history.slice(start)
}

async function runModel(req: AgentRunRequest) {
  if (req.target.kind !== 'model') return
  const { runId } = req
  const controller = new AbortController()
  controllers.set(runId, controller)
  const emit = (e: AgentEventBody) => emitAgent({ runId, ...e })
  try {
    const { provider, model: modelId } = req.target
    const { model, api, vision: canSee, headers } = await languageModel(provider, modelId, req.conversationId)
    const key = `${provider}:${modelId}`
    // Claude-style APIs take pictures inside tool results; the rest get them in a message after.
    const native = api === 'anthropic'
    const pdf = api !== 'compatible'
    let vision = canSee !== false && !textOnly.has(key)
    let effort = req.target.effort && !noEffort.has(key) ? req.target.effort : undefined
    const pictures = new Map<string, Picture[]>()
    emit({ type: 'status', message: 'Getting the tools ready…' })
    const local = provider === 'ollama'
    const progress = newLocalProgress()
    const guard = new LocalNativeGuard(req.prompt)
    const inspectedClipIds=new Set<string>()
    const clipIds=(name:string,args:Record<string,unknown>)=>{
      if(name==='get_clip')return (Array.isArray(args.clip_ids)?args.clip_ids:[]).map(String)
      if(!/^(clip_|keyframe_|set_native_)/.test(name))return []
      return [...(Array.isArray(args.ids)?args.ids.map(String):[]),...['clipId','clip_id','id'].flatMap(k=>typeof args[k]==='string'?[String(args[k])]:[])]
    }
    const inspectClips=async(ids:string[],required=false)=>{
      for(let from=0;from<ids.length;from+=50){
        const res=await abortable(callEditorTool('get_clip',{clip_ids:ids.slice(from,from+50)},undefined,runId),controller.signal)
        const text=res.content.flatMap(c=>c.type==='text'?[c.text]:[]).join('\n')
        if(res.isError){if(required)throw new Error(text);continue}
        const data=JSON.parse(text) as {clips?:Record<string,unknown>[]}
        guard.addDetailedClips(data.clips??[])
      }
    }
    const pendingNative=()=>[...pendingLocalTasks(req.prompt,progress),...guard.pending()]
    const refreshNative=async(show=false)=>{
      const states:NativeStateSnapshot[]=[]
      for(const kind of ['video','text']) {
        let offset=0
        for(let page=0;page<(kind==='video'?100:1);page++){
          const args={kind,limit:30,offset},callId=`native-state-${Date.now()}-${kind}-${page}`
          if(show&&page===0)emit({type:'tool-start',callId,tool:'get_editing_state',input:args})
          const res=await abortable(callEditorTool('get_editing_state',args,undefined,runId),controller.signal)
          const text=res.content.flatMap(c=>c.type==='text'?[c.text]:[]).join('\n')
          if(res.isError)throw new Error('Cannot inspect native state: '+text)
          const state=JSON.parse(text) as NativeStateSnapshot&{next_offset?:number|null}
          states.push(state)
          if(show&&page===0)emit({type:'tool-end',callId,tool:'get_editing_state',ok:true,summary:`Fresh ${kind} state inspected`,output:clip(text)})
          if(state.next_offset===null||state.next_offset===undefined)break
          offset=state.next_offset
        }
      }
      const previous=guard.state?.timeline_id
      guard.update(states)
      if(previous&&previous!==guard.state?.timeline_id)inspectedClipIds.clear()
      const known=new Set((guard.state?.clips??[]).map(c=>c.id))
      await inspectClips([...inspectedClipIds].filter(id=>!known.has(id)))
    }
    let preparedSuccessfully=false
    let retakeSelection:ReturnType<typeof retakeModelContext>|undefined
    let retakeFindingText=''
    let transcriptSummaryText=''
    const confirmedNative=async(name:string,args:Record<string,unknown>,resultText:string)=>{
      let result:unknown;try{result=JSON.parse(resultText)}catch{result=undefined}
      if(name==='remove_pauses'&&result&&typeof result==='object'&&(result as {pauses_removed?:number}).pauses_removed===0)emit({type:'note',message:'No pauses met the requested threshold. No cuts were made; the timeline is unchanged.'})
      if(name==='export_video'){
        const status=result as {exported?:boolean;queued?:boolean;reason?:string}|undefined
        if(status?.exported===false||status?.queued===false){emit({type:'note',message:status.reason??'Export cancelled; no file was exported.'});controller.abort();throw new DOMException('Export cancelled.','AbortError')}
        if(status?.queued===true&&!/\bqueue\b/i.test(req.prompt))throw new Error('The export was only queued, not rendered. Explicit queue intent is required.')
      }
      // A refinement/removal of an existing title or caption is a requested
      // text edit too; completion must not force an unwanted replacement.
      if(/^(clip_|keyframe_|set_native_text_duration)/.test(name)){
        const ids=clipIds(name,args), roles=new Map((guard.state?.tracks??[]).map(t=>[t.id,t.role]))
        const targets=(guard.state?.clips??[]).filter(c=>ids.includes(c.id)&&c.kind==='text')
        if(name==='clip_add'&&args.kind==='text'){
          const role=roles.get(String(args.trackId??''));if(role==='titles')progress.completed.add('title');if(role==='captions')progress.completed.add('captions')
        }
        for(const c of targets){const role=roles.get(c.track_id??'');if(role==='titles')progress.completed.add('title');if(role==='captions')progress.completed.add('captions')}
      }
      for(const id of clipIds(name,args))inspectedClipIds.add(id)
      if(name==='clip_delete')for(const id of clipIds(name,args))inspectedClipIds.delete(id)
      if(name==='get_transcript'&&result&&typeof result==='object'&&Array.isArray((result as {lines?:unknown}).lines))transcriptSummaryText=((result as {lines:{text:string}[]}).lines.map(l=>l.text).join(' ')).slice(0,2500)
      if(name==='find_retakes'){retakeSelection=retakeModelContext(result);retakeFindingText=JSON.stringify(retakeSelection.finding)}
      if(name==='apply_retakes'){retakeFindingText='';retakeSelection=undefined}
      recordLocalAction(progress,name,args,result)
      await refreshNative()
      if(['set_native_transition','clip_setTransition'].includes(name)&&guard.pending().some(p=>p.includes('transition at ')))progress.completed.delete('transition')
      progress.verification=progress.mutation
      if(name==='prepare_native_short')preparedSuccessfully=true
    }
    const preparationGate=new LocalPreparationGate()
    const beforeNative=async(name:string,args:Record<string,unknown>)=>{
      const known=new Set((guard.state?.clips??[]).map(c=>c.id)),ids=name==='clip_add'?[]:clipIds(name,args).filter(id=>!known.has(id))
      if(ids.length){await inspectClips(ids,true);for(const id of ids)inspectedClipIds.add(id)}
      if(name==='find_retakes'&&retakeFindingText&&progress.completed.has('retake-review')&&!progress.completed.has('retakes'))throw new Error('Retake inspection is complete. Use apply_retakes with the existing finding ID and explicit keep decisions. Do not overwrite the findings by inspecting again.')
      if(name==='apply_retakes'&&retakeSelection)validateNativeArguments({name:'apply_retakes',description:'Eligible native retake choices',inputSchema:retakeSelection.inputSchema},args)
      guard.before(name,args)
      preparationGate.before(name,args)
    }
    if(local)await refreshNative(true)
    const defs = await editorTools()
    const direct = local ? directLocalTools(defs,req.prompt,guard.state) : []
    const tools = local ? {
      ...buildLocalBroker(defs,runId,req.conversationId,pictures,req.prompt,emit,confirmedNative,beforeNative),
      // Frequent, small-schema entry points need no discovery round trip.
      ...buildTools(direct,runId,pictures,()=>({native:false,vision:false}),confirmedNative,beforeNative),
    } : buildTools(defs, runId, pictures, () => ({ native, vision }))
    let fatalNativeError:Error|undefined
    let finishLiveJournal:(status:string,error?:string)=>void=()=>{}
    if(local){
      const queue=new LocalNativeToolQueue(),failures=new LocalToolFailureGuard()
      const liveEvents:Record<string,unknown>[]=[]
      const journal=(event:Record<string,unknown>)=>{liveEvents.push({at:new Date().toISOString(),...event});writeJson('local-agent-live-run.json',{runId,status:event.status,pending:pendingNative(),events:liveEvents.slice(-100),fatal_error:fatalNativeError?.message})}
      finishLiveJournal=(status,error)=>journal({status,error})
      journal({status:'started'})
      for(const [toolName,tool] of Object.entries(tools)){
        const execute=tool.execute
        if(execute)tool.execute=(input,options)=>queue.run(async()=>{
          if(fatalNativeError)throw fatalNativeError
          const canonical=canonicalDirectArguments(direct.find(d=>d.name===toolName),input)
          journal({status:'running',tool:toolName,args:JSON.stringify(canonical.args).slice(0,4000),...(canonical.discarded.length?{discarded_fields:canonical.discarded}:{})})
          try{const result=await execute(canonical.args,options);journal({status:'succeeded',tool:toolName,result:JSON.stringify(result).slice(0,6000)});return result}
          catch(error){const detail=message(error);fatalNativeError=failures.record(toolName,input,detail);journal({status:'failed',tool:toolName,error:detail.slice(0,2000)});throw fatalNativeError??error}
        },options.abortSignal)
      }
    }
    const system = local ? LOCAL_INSTRUCTIONS : systemPrompt(api, provider, req.instructions)
    if (local) { vision = false; emit({ type: 'note', message: `Local native editing: ${localTools(defs).length} editor tools available through on-demand discovery. Captions, cuts, keyframes and audio stay editable.` }) }

    const stored = historyOf(req.conversationId)
    const earlier = local ? localHistory(stored) : native ? stripReasoning(stored) : stored
    const user = userTurn(local ? { prompt: req.prompt, attachments: req.attachments } : req)
    // Steps already completed, carried into a retry so no tool runs twice.
    let carried: ModelMessage[] = []
    let completed: ModelMessage[] = []
    let wroteText = false
    let afterTool = false
    let lastFinish = ''
    const nativeNames = new Map<string,string>()
    const nativeInputs = new Map<string,Record<string,unknown>>()
    let emptyRetries=0,completionRetries=0
    let relaxedLocalToolChoice=false
    let localContext:Record<string,unknown>|undefined
    const rawFrames:unknown[]=[]
    let rawChars=0
    const usage: Required<Pick<AgentUsage, 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'cacheWriteTokens' | 'steps'>> = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, steps: 0 }
    const retried = { pictures: false, effort: false, busy: 0 }
    const carry = (steps: ModelMessage[]) => {
      const kept = stripPictures(steps)
      return native ? stripReasoning(kept) : kept
    }
    // A tool call's input as the model writes it: who it is for and how much has arrived.
    const writing = new Map<string, { tool: string; chars: number; told: number }>()

    for (;;) {
      try {
        const effortOpts = effortSettings(api, effort)
        const can = { vision, pdf }
        const result = streamText({
          model,
          ...(local ? { maxOutputTokens: 1536 } : {}),
          ...(local ? { includeRawChunks: true } : {}),
          system,
          messages: withAttachments([...earlier, user, ...carried], req.conversationId, can),
          tools,
          headers,
          ...effortOpts,
          providerOptions: mergeOptions(effortOpts.providerOptions as Options | undefined, thinkingOptions(api, modelId), cacheOptions(api, modelId, req.conversationId), local ? { ollama: { reasoningEffort: 'none' } } : undefined) as ProviderOptions,
          stopWhen: [isStepCount(MAX_STEPS),()=>local && progress.mutation>0 && pendingNative().length===0],
          // Retries are done here, where the chat can be told about them.
          maxRetries: 0,
          abortSignal: controller.signal,
          prepareStep: ({ messages, responseMessages }) => {
            completed = responseMessages as ModelMessage[]
            // Said before the request goes out: until the first word comes back, this is all there is to show.
            usage.steps++
            emit({ type: 'step', index: usage.steps })
            if (local) {
              const finish=localFinishingPlan(req.prompt,progress,preparedSuccessfully)
              const editing=existingNativeEditingPlan(req.prompt,guard.baseline,progress)
              const phaseTools=finish?.tools??editing
              if(retakeSelection&&tools.apply_retakes)tools.apply_retakes.inputSchema=jsonSchema(retakeSelection.inputSchema)
              const phaseSystem=phaseTools?localPhaseInstructions(phaseTools,phaseTools[0]==='clip_update'&&!pendingLocalTasks(req.prompt,progress).includes('captions')?'audio':undefined)+'\nUSER BRIEF (context; execute current stage only): '+req.prompt+'\nCOMPLETED TASKS: '+[...progress.completed].join(', ')+(transcriptSummaryText?'\nACTUAL EDITED TRANSCRIPT: '+transcriptSummaryText:''):system
              const step = { activeTools: (finish?.tools??editing??Object.keys(tools).filter(name=>name!=='prepare_native_short'||!preparationGate.started)).filter(name=>name in tools), toolChoice: pendingNative().length && !relaxedLocalToolChoice ? 'required' as const : 'auto' as const, system: phaseSystem+(editing?.length===1&&editing[0]==='apply_retakes'?'\nRETAKE INSPECTION IS COMPLETE. Decide from the cached actual wording below and CALL apply_retakes NOW with the existing finding_id and keep_attempt_ids containing actual attempt IDs only (for example rt_0_a2); no candidate_id fields. Do not inspect/find again or invent IDs. Preserve review-only/intentional repetitions. Empty keep_attempt_ids means intentionally keep all, not failure.\nACTUAL CACHED RETAKE FINDING:\n'+retakeFindingText:'')+(editing?'\nEXISTING EDITABLE TIMELINE: preserve its current cuts and work directly on it. Initial preparation is unavailable without explicit NEW sequence authorization. Native state was inspected automatically; avoid repeating identical state reads. Execute the directly available caption/audio/transition tools for the remaining actions.':'')+(finish?'\nINITIAL CONSTRUCTION IS DONE. Do not prepare, rebuild, discover tools or read invented result IDs. Finish the remaining request directly: get_transcript reviews the source, add_title adds the requested native title. Use get_editing_state/get_clip only for actual IDs/properties. Your next native tool is '+finish.next+'.':'')+'\nAUTHORITATIVE FRESH NATIVE STATE:\n'+guard.summary()+'\nREMAINING REQUEST POSTCONDITIONS:\n'+pendingNative().slice(0,8).join('\n'),messages: phaseTools?[{role:'user' as const,content:localPhaseRequest(phaseTools)}]:compactLocalMessages(messages,Math.max(4500,11000-JSON.stringify(direct).length)) }
              localContext={active_tools:step.activeTools,system_chars:step.system.length,messages_chars:JSON.stringify(step.messages).length,native_schema_chars:JSON.stringify(direct.filter(t=>step.activeTools.includes(t.name))).length}
              return step
            }
            const next = native || !vision ? undefined : withPictures(messages, pictures)
            if (!native) return next ? { messages: next } : undefined
            return { messages: cacheMarks(messages, earlier.length) }
          },
        })
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'raw':
              if(local && rawFrames.length<128 && rawChars<64000) {
                const frame=localWireFrame(part.rawValue), size=JSON.stringify(frame).length
                if(rawChars+size<=64000) {rawFrames.push(frame);rawChars+=size}
              }
              break
            case 'text-delta':
              if (!part.text) break
              emit({ type: 'text', delta: afterTool && wroteText ? `\n\n${part.text}` : part.text })
              wroteText = true
              afterTool = false
              break
            case 'reasoning-delta':
              if (part.text) emit({ type: 'reasoning', delta: part.text })
              break
            case 'reasoning-end':
              emit({ type: 'reasoning-end' })
              break
            case 'tool-input-start':
              writing.set(part.id, { tool: part.toolName, chars: 0, told: Date.now() })
              emit({ type: 'tool-input', callId: part.id, tool: part.toolName, chars: 0 })
              break
            case 'tool-input-delta': {
              const w = writing.get(part.id)
              if (!w) break
              w.chars += part.delta.length
              // A long composition arrives in hundreds of pieces: a few updates a second is plenty.
              if (Date.now() - w.told > 300) {
                w.told = Date.now()
                emit({ type: 'tool-input', callId: part.id, tool: w.tool, chars: w.chars })
              }
              break
            }
            case 'tool-call':
              afterTool = true
              writing.delete(part.toolCallId)
              if(local && part.toolName==='lumen_call') {
                const input=part.input as {name?:unknown;arguments?:unknown}
                const name=String(input.name??part.toolName)
                nativeNames.set(part.toolCallId,name)
                nativeInputs.set(part.toolCallId,(input.arguments??{}) as Record<string,unknown>)
                emit({type:'tool-start',callId:part.toolCallId,tool:name,input:input.arguments})
              } else {
                if(local) { nativeNames.set(part.toolCallId,part.toolName);nativeInputs.set(part.toolCallId,(part.input??{}) as Record<string,unknown>) }
                emit({ type: 'tool-start', callId: part.toolCallId, tool: part.toolName, input: part.input })
              }
              break
            case 'tool-result': {
              const text = (part.output as ToolOutput | undefined)?.text ?? (typeof part.output === 'string' ? part.output : JSON.stringify(part.output))
              emit({ type: 'tool-end', callId: part.toolCallId, tool: nativeNames.get(part.toolCallId) ?? part.toolName, ok: true, summary: brief(text), output: clip(text) })
              break
            }
            case 'tool-error':
              emit({ type: 'tool-end', callId: part.toolCallId, tool: nativeNames.get(part.toolCallId) ?? part.toolName, ok: false, summary: brief(message(part.error)), output: clip(message(part.error)) })
              if(fatalNativeError)throw fatalNativeError
              break
            case 'finish-step':
              usage.inputTokens += part.usage.inputTokens ?? 0
              usage.outputTokens += part.usage.outputTokens ?? 0
              usage.cachedTokens += part.usage.inputTokenDetails?.cacheReadTokens ?? 0
              usage.cacheWriteTokens += part.usage.inputTokenDetails?.cacheWriteTokens ?? 0
              lastFinish = part.finishReason
              break
            case 'abort':
              throw new DOMException('Stopped.', 'AbortError')
            case 'error':
              throw part.error
          }
        }
        // Every step's messages — tool calls and results included — so later turns remember what was looked up.
        const steps = (await result.responseMessages) as ModelMessage[]
        if(local) {
          writeJson('local-agent-last-run.json',{runId,request_context:localContext,lastFinish,steps:usage.steps,parsed_messages:steps.length,native_names:[...nativeNames.values()],pending:pendingNative(),raw:rawFrames})
          if(!steps.length && !wroteText) {
            if(emptyRetries++<1 && usage.steps<MAX_STEPS) {
              emit({type:'note',message:'The local model returned no usable text or commands. Retrying once with the direct native tools.'})
              carried=[...carried,{role:'user',content:'Your last response contained no usable text or tool calls. Use the directly available native editing tools to fulfill the request, or explain the exact error. Do not silently finish.'}]
              continue
            }
            throw new Error('The local model returned no usable response after a retry. No completion is claimed. Diagnostic: local-agent-last-run.json.')
          }
          const pending=pendingNative()
          if(lastFinish!=='tool-calls' && pending.length) {
            if(completionRetries++<2 && usage.steps<MAX_STEPS) {
              emit({type:'note',message:'Completing requested native edits: '+pending.join(', ')+'.'})
              carried=[...carried,...steps,{role:'user',content:`The original request is NOT complete. Still missing verified native actions: ${pending.join(', ')}. Complete these now using the direct native tools; do not offer them as future steps. Then inspect affected clips/state after the last edit. If truly impossible, identify the exact failed capability.`}]
              continue
            }
            throw new Error('Native editing remains incomplete: '+pending.join(', ')+'. Completed operations are preserved; inspect the failed/missing steps before continuing.')
          }
          if(progress.mutation>0 && !pending.length) emit({type:'text',delta:(wroteText?'\n\n':'')+'The requested native changes are applied and verified on the current Lumen timeline. The changes remain editable.'})
        }
        const historyMessages = [...stored, user, ...carried, ...steps]
        const next = trim(forHistory(local ? historyMessages.filter(m=>!isLocalRetryMessage(m)) : historyMessages))
        histories.set(req.conversationId, next)
        writeHistory(req.conversationId, next)
        if (lastFinish === 'tool-calls' && !(local&&progress.mutation>0&&!pendingNative().length)) emit({ type: 'note', message: `Stopped after ${MAX_STEPS} steps. Say “continue” to resume from the native project and confirmed tool results.` })
        finishLiveJournal('complete')
        emit({ type: 'done', usage })
        return
      } catch (err) {
        if (controller.signal.aborted) {finishLiveJournal('cancelled');throw err}
        if (local && !relaxedLocalToolChoice && requiredToolChoiceMiss(err) && usage.steps < MAX_STEPS) {
          relaxedLocalToolChoice=true
          carried=carry([...carried,...completed])
          completed=[]
          await refreshNative()
          writeJson('local-agent-last-run.json',{runId,request_context:localContext,lastFinish,steps:usage.steps,pending:pendingNative(),required_tool_fallback:true,raw:rawFrames})
          emit({type:'note',message:'Ollama returned text instead of the required command. Retrying with automatic tool selection; actual native edits are still required and verified.'})
          carried.push({role:'user',content:'The previous response contained no executable native tool call. Use the available structured tools to complete the current request. Previously confirmed operations must not be repeated. Text claiming an edit is not an edit.'})
          continue
        }
        if (vision && !retried.pictures && isPictureRejection(err)) {
          // The model can't take images: remember that and carry on from the steps already done.
          retried.pictures = true
          textOnly.add(key)
          vision = false
          carried = carry([...carried, ...completed])
          completed = []
          emit({ type: 'note', message: 'This model can’t look at images — carrying on without them.' })
          continue
        }
        if (effort && !retried.effort && isEffortRejection(err)) {
          // The model turned the effort setting down: remember that and carry on at its default.
          retried.effort = true
          noEffort.add(key)
          effort = undefined
          carried = carry([...carried, ...completed])
          completed = []
          emit({ type: 'note', message: 'This model doesn’t take that effort setting — carrying on with its default.' })
          continue
        }
        if (retried.busy < RETRY_WAITS.length && isRetryable(err)) {
          // Busy or cut off: wait, then carry on from the steps already done (no tool runs twice).
          const wait = RETRY_WAITS[retried.busy++]
          carried = carry([...carried, ...completed])
          completed = []
          emit({ type: 'note', message: `${status(err) === 429 ? 'The provider is rate-limiting requests' : 'The provider didn’t answer'} (${brief(friendly(err)).slice(0, 90)}). Trying again in ${wait} s — try ${retried.busy} of ${RETRY_WAITS.length}.` })
          await abortable(new Promise((r) => setTimeout(r, wait * 1000)), controller.signal)
          continue
        }
        finishLiveJournal('failed',message(err))
        if(local)writeJson('local-agent-last-run.json',{runId,request_context:localContext,lastFinish,steps:usage.steps,native_names:[...nativeNames.values()],pending:pendingNative(),error:message(err),raw:rawFrames})
        throw err
      }
    }
  } catch (err) {
    if (controller.signal.aborted) emit({ type: 'error', code: 'cancelled', message: 'Stopped.' })
    else emit({ type: 'error', code: classify(err), message: friendly(err) })
  } finally {
    controllers.delete(runId)
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function brief(value: unknown) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
}

/** A tool's result as the chat shows it when a step is opened: enough to follow, not megabytes. */
function clip(text: string) {
  const LIMIT = 4000
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}\n… (${text.length - LIMIT} more characters)` : text
}

function status(err: unknown): number | undefined {
  const e = err as { statusCode?: number; status?: number; cause?: { statusCode?: number } }
  return e?.statusCode ?? e?.status ?? e?.cause?.statusCode
}

function classify(err: unknown): AgentErrorCode {
  if (err instanceof MissingKeyError) return 'no-key'
  const code = status(err)
  if (code === 401 || code === 403) return 'auth'
  if (code === 429) return 'rate-limit'
  return 'failed'
}

function friendly(err: unknown) {
  const code = status(err)
  if (code === 401 || code === 403) return 'The provider rejected the API key. Update it in Integrations › AI models.'
  if (code === 429) return 'The provider is rate-limiting requests right now — try again in a moment.'
  if (code === 404) return `The provider doesn’t know that model. Pick another one. (${message(err)})`
  return message(err)
}
