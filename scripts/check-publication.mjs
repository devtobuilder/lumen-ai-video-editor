/** Reject private runtime artifacts and user-profile paths before publication. */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
const root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim()
const staged=process.argv.includes('--staged')
const args=staged?['diff','--cached','--name-only','--diff-filter=ACMR','-z']:['ls-files','--cached','--others','--exclude-standard','-z']
const files=[...new Set(execFileSync('git',args,{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean))]
const blocked=[]
for(const name of files){
 const normalized=name.replaceAll('\\','/'),base=path.posix.basename(normalized)
 if(/^(work|outputs|publication|media|recordings|renders|exports|reports|logs|models|checkpoints|node_modules|dist|dist-electron|release)\//i.test(normalized)||/(^|\/)(\.venv|venv|__pycache__|\.ssh|\.aws|\.azure)\//i.test(normalized))blocked.push([name,'private runtime/build directory'])
 if(/\.(lumen|partial|dmp|sqlite\d*|db|mp4|mov|mkv|webm|avi|wav|mp3|m4a|flac|ogg|aac|srt|vtt|gguf|safetensors|onnx|pt|pth|ckpt|pem|key|p12|pfx|keystore|token|exe|dll|asar|zip)$/i.test(base))blocked.push([name,'private/generated/binary artifact type'])
 if((/^\.env(?:\.|$)/.test(base)&&!['.env.example','.env.sample'].includes(base))||/^(local-video-engine|local-profile|local-agent-.+|ai-providers|lumen-mcp|mcp-servers|secrets|credentials)\.json$/i.test(base)||/^(\.npmrc|\.pypirc|\.netrc|id_rsa.*|id_ed25519.*)$/i.test(base))blocked.push([name,'machine configuration or credential filename'])
 let bytes;try{if(!statSync(path.join(root,name)).isFile())continue;bytes=readFileSync(path.join(root,name))}catch{continue}
 if(bytes.includes(0))continue
 const text=bytes.toString('utf8'),flat=text.replaceAll('\\\\','\\')
 const matches=flat.matchAll(/(?:[A-Z]:[\\/](?:Users|Documents and Settings)[\\/]|(?<![\w@/])\/(?:Users|home)\/)([^\\/\s"'<>]+)/gi)
 for(const match of matches)if(!/^(?:example|user|username|you|test|public)$/i.test(match[1]))blocked.push([name,'literal personal user-profile path'])
 if(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text))blocked.push([name,'private key material'])
 if(base.endsWith('.json'))try{const data=JSON.parse(text);if(data?.format==='lumen-project'||data?.project?.clips&&data?.project?.assets)blocked.push([name,'private project content'])}catch{}
 if(/transcript.*\.json$/i.test(base)&&!normalized.includes('synthetic'))blocked.push([name,'unreviewed transcript data'])
}
if(blocked.length){for(const [file,reason] of blocked)console.error(`${file}: ${reason}`);process.exitCode=1}
else console.log(`Publication policy passed for ${files.length} source files. Run a redacted secret scan and review new fixture/media content separately.`)
