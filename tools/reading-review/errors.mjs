import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export function toolError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details })
}
export function errorRecord(error, stage) {
  return { code:typeof error.code==='string'?error.code:'TASK_FAILED', message:error.message||String(error), stage,
    ...error.details, stack:error.stack, recordedAt:new Date().toISOString() }
}
export function commandErrorMessage(stdout, stderr, fallback) {
  const match=/### Error\s*\r?\n([\s\S]*?)(?=\r?\n### |$)/.exec(stdout||'')
  return (match?.[1]?.trim() || (stderr||'').split(/\r?\n/).filter(line=>line&&!/^npm warn /i.test(line)).join('\n') || fallback).slice(0,6000)
}
export async function saveCommandLog(folder, name, args, result, startedAt) {
  if(!folder)return {}
  const directory=join(folder,Date.now()+'-'+randomUUID().slice(0,8))
  await mkdir(directory,{recursive:true})
  const stdoutLog=join(directory,'stdout.log'),stderrLog=join(directory,'stderr.log')
  await writeFile(stdoutLog,result.stdout||'');await writeFile(stderrLog,result.stderr||'')
  await writeFile(join(directory,'command.json'),JSON.stringify({name,args,startedAt,finishedAt:new Date().toISOString(),
    exitCode:typeof result.code==='number'?result.code:result.code||result.signal?null:0,spawnError:typeof result.code==='string'?result.code:null,
    signal:result.signal||null,killed:Boolean(result.killed),stdoutLog,stderrLog},null,2))
  return {commandLog:join(directory,'command.json'),stdoutLog,stderrLog}
}
