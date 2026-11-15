import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { finished } from 'node:stream/promises'
import { mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { readJson, writeJson, validId } from './model.mjs'
import { errorRecord, toolError } from './errors.mjs'
import { requireSnapshotInput } from './inputs.mjs'

async function runWorker(p,job,signal) {
  const folder=join(p.jobs,job.id);await mkdir(folder,{recursive:true})
  const stdoutLog=join(folder,'stdout.log'),stderrLog=join(folder,'stderr.log')
  const child=spawn(process.execPath,[fileURLToPath(new URL('./worker.mjs',import.meta.url)),job.type,job.pageId,job.id,...(job.snapshotId?[job.snapshotId]:[])],{
    cwd:p.root,env:{...process.env,ONLYTRANSLATE_REVIEW_DATA:p.data,ONLYTRANSLATE_REVIEW_JOB_LOG:join(folder,'commands')},signal,windowsHide:true,stdio:['ignore','pipe','pipe']})
  const streams=[createWriteStream(stdoutLog),createWriteStream(stderrLog)]
  const logs=streams.map(stream=>finished(stream).catch(error=>{child.kill();return error}))
  child.stdout.pipe(streams[0]);child.stderr.pipe(streams[1])
  const exit=await new Promise(resolve=>{child.once('error',error=>{streams.forEach(s=>s.end());resolve({error})});child.once('exit',(code,signal)=>resolve({code,signal}))})
  const errors=await Promise.all(logs)
  if(errors.some(Boolean))throw toolError('LOG_WRITE_FAILED','任务日志写入失败',{stdoutLog,stderrLog})
  if(exit.error)throw exit.error
  const saved=await readJson(join(p.jobs,job.id+'.json'))
  if(saved.status==='running')throw toolError('WORKER_EXITED','任务进程退出但未保存终态',{exitCode:exit.code,signal:exit.signal,stdoutLog,stderrLog})
  if(exit.code!==0&&['complete','limited'].includes(saved.status))throw toolError('WORKER_EXITED','任务进程异常退出',{exitCode:exit.code,signal:exit.signal,stdoutLog,stderrLog})
  return {...saved,stdoutLog,stderrLog}
}

export async function createJobQueue(p,{execute=runWorker}={}) {
  const jobs=new Map(),queue=[]
  let busy=false,closed=false,controller=null
  for(const file of (await readdir(p.jobs)).filter(f=>f.endsWith('.json'))){
    const job=await readJson(join(p.jobs,file))
    if(['running','queued'].includes(job.status)){job.status='interrupted';job.message='服务已重启，请手动重试';job.finishedAt=new Date().toISOString();await writeJson(join(p.jobs,file),job)}
    jobs.set(job.id,job)
  }
  const save=async job=>{jobs.set(job.id,job);await writeJson(join(p.jobs,job.id+'.json'),job)}
  async function drain() {
    if(busy||closed)return
    busy=true
    try{while(queue.length&&!closed){
      const job=jobs.get(queue.shift())
      try{
        if(job.dependsOn){
          const parent=await readJson(join(p.jobs,job.dependsOn+'.json'))
          if(parent.status!=='complete'||!validId(parent.result?.snapshotId))throw toolError('DEPENDENCY_BLOCKED','上一步采集未成功，已跳过后续任务',{dependencyId:parent.id,dependencyStatus:parent.status})
          job.snapshotId=parent.result.snapshotId
        }
        if(job.type!=='capture'){
          if(!job.snapshotId)job.snapshotId=(await readJson(join(p.snapshots,job.pageId,'latest.json'),null))?.id
          await requireSnapshotInput(p,job.pageId,job.snapshotId)
        }
        if(closed)throw toolError('INTERRUPTED','服务已停止，请手动重试')
        Object.assign(job,{status:'running',message:'开始执行',startedAt:new Date().toISOString(),lastProgressAt:new Date().toISOString()})
        await save(job)
        controller=new AbortController()
        const result=await execute(p,job,controller.signal)
        await save({...job,...result,finishedAt:result?.finishedAt||new Date().toISOString()})
      }catch(error){
        const blocked=['DEPENDENCY_BLOCKED','MISSING_SNAPSHOT','INPUT_BLOCKED','INVALID_SNAPSHOT','INPUT_INTERACTION_REQUIRED'].includes(error.code)
        await save({...job,status:closed?'interrupted':blocked?'blocked':'failed',message:closed?'服务已停止，请手动重试':error.message,error:errorRecord(error,job.type),finishedAt:new Date().toISOString()})
      }finally{controller=null}
    }}finally{busy=false}
  }
  async function enqueue(type,pageId,snapshotId,dependsOn,retryOf) {
    if(!['capture','baseline','candidate'].includes(type)||!validId(pageId))throw new Error('未知任务类型或页面')
    if(snapshotId&&!validId(snapshotId))throw new Error('无效快照')
    const page=(await readJson(p.manifest)).pages.find(page=>page.id===pageId)
    if(!page)throw new Error('样本不存在')
    if(dependsOn){const parent=jobs.get(dependsOn);if(!parent||parent.type!=='capture'||parent.pageId!==pageId)throw new Error('采集依赖无效')}
    const existing=[...jobs.values()].find(j=>j.type===type&&j.pageId===pageId&&['running','queued'].includes(j.status)
      &&(snapshotId?(j.snapshotId||jobs.get(j.dependsOn)?.result?.snapshotId)===snapshotId:dependsOn?j.dependsOn===dependsOn:!j.dependsOn))
    if(existing)return existing
    const job={id:randomUUID(),type,pageId,requestedUrl:page.url,...(snapshotId?{snapshotId}:{}),...(dependsOn?{dependsOn}:{}),...(retryOf?{retryOf}:{}),status:'queued',message:dependsOn?'等待前置采集':'等待运行',createdAt:new Date().toISOString()}
    await save(job);queue.push(job.id);setImmediate(()=>drain().catch(console.error));return job
  }
  async function retry(id) {
    if(!validId(id)||!jobs.has(id))throw new Error('任务不存在')
    const original=await readJson(join(p.jobs,id+'.json'))
    if(['queued','running'].includes(original.status))return original
    if(!['failed','blocked','limited','interrupted'].includes(original.status))throw new Error('该任务无需重试')
    const snapshotId=original.snapshotId||original.result?.snapshotId
    if(original.type!=='capture'&&!original.dependsOn&&!validId(snapshotId))throw toolError('MISSING_SNAPSHOT','原任务没有记录快照身份，请明确选择页面快照后重新运行')
    return enqueue(original.type,original.pageId,snapshotId,original.dependsOn,id)
  }
  return {jobs,enqueue,retry,close:()=>{closed=true;controller?.abort()}}
}
