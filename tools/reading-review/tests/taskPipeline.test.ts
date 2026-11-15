import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Window } from 'happy-dom'
import { createJobQueue } from '../jobs.mjs'
import { command, buildCollector } from '../driver.mjs'
import { toolError } from '../errors.mjs'
import { inspectInputHTML, requireSnapshotInput } from '../inputs.mjs'
import { hash, paths, readJson, writeJson } from '../model.mjs'
import { startServer } from '../server.mjs'

const cleanups:(()=>Promise<unknown>)[]=[]
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close()})
async function fixture(execute:any){
  const root=await mkdtemp(join(tmpdir(),'review-pipeline-')),p=paths(root,join(root,'data'))
  cleanups.push(()=>rm(root,{recursive:true,force:true}))
  await mkdir(p.jobs,{recursive:true});await writeJson(p.manifest,{schemaVersion:1,pages:[{id:'sample',url:'https://example.org/article'}]})
  const queue=await createJobQueue(p,{execute});cleanups.push(async()=>queue.close())
  const snapshot=async(id:string,html='<html><body><p>Readable original article.</p></body></html>')=>{
    const s={schemaVersion:1,id,pageId:'sample',url:'https://example.org/article',htmlHash:hash(html),assets:[]}
    await writeJson(join(p.snapshots,'sample',id,'snapshot.json'),s)
    const {writeFile}=await import('node:fs/promises');await writeFile(join(p.snapshots,'sample',id,'source.html'),html)
    await writeJson(join(p.snapshots,'sample/latest.json'),{id});return s
  }
  const wait=async(...ids:string[])=>{
    const deadline=Date.now()+4000
    let jobs:any[]=[]
    while(Date.now()<deadline){
      jobs=await Promise.all(ids.map(id=>readJson(join(p.jobs,id+'.json'))))
      if(jobs.every(j=>!['queued','running'].includes(j.status)))return jobs
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    throw new Error('queue did not settle: '+JSON.stringify(jobs.map(job=>({id:job.id,status:job.status,message:job.message}))))
  }
  return {p,queue,snapshot,wait}
}

it('preserves the real CLI stdout error, warning stderr and command exit metadata',async()=>{
  const root=await mkdtemp(join(tmpdir(),'review-command-'));cleanups.push(()=>rm(root,{recursive:true,force:true}))
  const script="process.stdout.write('### Error\\nError: HTTP 404 article unavailable\\n');process.stderr.write('npm warn harmless configuration\\n');process.exit(1)"
  let failure:any
  try{await command(process.execPath,['-e',script],{logDirectory:root})}catch(error){failure=error}
  expect(failure.message).toContain('HTTP 404 article unavailable')
  expect(failure.details).toMatchObject({httpStatus:404,exitCode:1})
  expect(await readFile(failure.details.stdoutLog,'utf8')).toContain('HTTP 404')
  expect(await readFile(failure.details.stderrLog,'utf8')).toContain('npm warn')
  expect(await readJson(failure.details.commandLog)).toMatchObject({exitCode:1,signal:null})
})

it('does not use an old snapshot after a new capture fails, or execute dependent jobs',async()=>{
  const execute=vi.fn(async()=>{throw toolError('COMMAND_FAILED','HTTP 405',{httpStatus:405})})
  const f=await fixture(execute);await f.snapshot('old-valid')
  const parent=await f.queue.enqueue('capture','sample')
  const baseline=await f.queue.enqueue('baseline','sample',undefined,parent.id),candidate=await f.queue.enqueue('candidate','sample',undefined,parent.id)
  const result=await f.wait(parent.id,baseline.id,candidate.id)
  expect(result.map(j=>j.status)).toEqual(['failed','blocked','blocked'])
  expect(result[1].error).toMatchObject({code:'DEPENDENCY_BLOCKED',dependencyId:parent.id})
  expect(execute).toHaveBeenCalledTimes(1)
})

it('pins both downstream jobs to the successful capture result rather than a different latest pointer',async()=>{
  let f:Awaited<ReturnType<typeof fixture>>
  const execute=vi.fn(async(_:any,job:any)=>{
    if(job.type==='capture'){
      await f.snapshot('produced');await writeJson(join(f.p.snapshots,'sample/latest.json'),{id:'old-valid'})
      return {status:'complete',result:{snapshotId:'produced'}}
    }
    return {status:job.type==='baseline'?'limited':'complete',result:{snapshotId:job.snapshotId}}
  })
  f=await fixture(execute);await f.snapshot('old-valid')
  const parent=await f.queue.enqueue('capture','sample'),baseline=await f.queue.enqueue('baseline','sample',undefined,parent.id),candidate=await f.queue.enqueue('candidate','sample',undefined,parent.id)
  const result=await f.wait(parent.id,baseline.id,candidate.id)
  expect(result.map(j=>j.status)).toEqual(['complete','limited','complete'])
  expect(result.slice(1).map(j=>j.snapshotId)).toEqual(['produced','produced'])
})

it('retains a failed capture dependency on retry instead of reading an old snapshot',async()=>{
  const execute=vi.fn(async()=>{throw toolError('COMMAND_FAILED','HTTP 405')})
  const f=await fixture(execute);await f.snapshot('old-valid')
  const parent=await f.queue.enqueue('capture','sample')
  const child=await f.queue.enqueue('candidate','sample',undefined,parent.id)
  await f.wait(parent.id,child.id)
  const retry=await f.queue.retry(child.id)
  const [saved]=await f.wait(retry.id)
  expect(saved).toMatchObject({status:'blocked',dependsOn:parent.id,retryOf:child.id,error:{code:'DEPENDENCY_BLOCKED'}})
  expect(saved.snapshotId).toBeUndefined()
  expect(execute).toHaveBeenCalledTimes(1)
})

it('restores a successful capture binding after restart and refuses identity-free legacy retries',async()=>{
  const execute=vi.fn(async(_:any,job:any)=>({status:'complete',result:{snapshotId:job.snapshotId}}))
  const f=await fixture(execute);f.queue.close()
  await f.snapshot('produced');await f.snapshot('newer-latest')
  await writeJson(join(f.p.jobs,'capture.json'),{id:'capture',type:'capture',pageId:'sample',status:'complete',result:{snapshotId:'produced'}})
  await writeJson(join(f.p.jobs,'child.json'),{id:'child',type:'baseline',pageId:'sample',status:'queued',dependsOn:'capture'})
  await writeJson(join(f.p.jobs,'legacy.json'),{id:'legacy',type:'baseline',pageId:'sample',status:'failed'})
  const restored=await createJobQueue(f.p,{execute});cleanups.push(async()=>restored.close())
  expect(restored.jobs.get('child').status).toBe('interrupted')
  const retry=await restored.retry('child'),[saved]=await f.wait(retry.id)
  expect(saved).toMatchObject({status:'complete',snapshotId:'produced',dependsOn:'capture',retryOf:'child'})
  await expect(restored.retry('legacy')).rejects.toMatchObject({code:'MISSING_SNAPSHOT'})
  expect(execute).toHaveBeenCalledTimes(1)
})

it('blocks missing, corrupted and CAPTCHA inputs before running a worker',async()=>{
  const execute=vi.fn(),f=await fixture(execute)
  const missing=await f.queue.enqueue('baseline','sample','missing');expect((await f.wait(missing.id))[0].error.code).toBe('MISSING_SNAPSHOT')
  const s=await f.snapshot('captcha','<html><title>archive.li</title><body>One more step. Please complete the security check to access archive.li</body></html>')
  const captcha=await f.queue.enqueue('baseline','sample',s.id);expect((await f.wait(captcha.id))[0].status).toBe('blocked')
  await f.snapshot('broken');await writeJson(join(f.p.snapshots,'sample/broken/snapshot.json'),{...s,id:'broken',htmlHash:hash('different')})
  await expect(requireSnapshotInput(f.p,'sample','broken')).rejects.toMatchObject({code:'INVALID_SNAPSHOT'})
  expect(execute).not.toHaveBeenCalled()
})

it('checks CAPTCHA body text without treating an ordinary long article mentioning CAPTCHA as a challenge',()=>{
  expect(inspectInputHTML('<html><title>archive.li</title><body>Completing the CAPTCHA proves you are a human</body></html>','https://example.org')).toBeTruthy()
  expect(inspectInputHTML('<html><title>Article</title><body>'+('Complete prose. '.repeat(400))+'verify you are human</body></html>','https://example.org')).toBeNull()
})

it('builds and executes diagnostics without WXT storage and keeps source collection read-only',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'review-collector-'));cleanups.push(()=>rm(folder,{recursive:true,force:true}))
  const root=resolve(import.meta.dirname,'../../..')
  const bundle=await buildCollector({root},root,{kind:'test'},join(folder,'collector.js'))
  const window=new Window({url:'https://example.org'})
  cleanups.push(async()=>{await window.happyDOM.abort();window.close()})
  window.document.body.innerHTML='<p>这是中文内容，不需要再次翻译。</p><svg><text>Chart label</text></svg>'
  const nodes=[window.document.querySelector('p'),window.document.querySelector('text')]
  ;(window as any).__readingReview={nodes}
  const original=window.document.body.innerHTML
  window.eval(bundle)
  const result=(window as any).readReadingReviewExecution({to:'zh-Hans',bidirectionalTranslation:false})
  expect(result[0]).toMatchObject({supported:true,sourceLang:'zh-Hans',targetLang:'zh-Hans',shouldTranslate:false})
  expect(result[1]).toMatchObject({supported:false})
  expect(window.document.body.innerHTML).toBe(original)
})

it('exposes bounded task logs and skips blocked inputs in batch requests without inventing successful runs',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'review-task-api-')),p=paths(folder,join(folder,'data'))
  cleanups.push(()=>rm(folder,{recursive:true,force:true}))
  const pages=[{id:'http-error',url:'https://example.org/missing'},{id:'captcha',url:'https://example.org/challenge'},{id:'uncaptured',url:'https://example.org/new'}]
  await writeJson(p.manifest,{schemaVersion:1,pages})
  const job={id:'failed-capture',pageId:'http-error',type:'capture',requestedUrl:pages[0].url,status:'failed',createdAt:'2026-01-01',error:{code:'COMMAND_FAILED',httpStatus:404}}
  await writeJson(join(p.jobs,job.id+'.json'),job)
  await writeJson(join(p.jobs,'dependent.json'),{id:'dependent',pageId:'http-error',type:'candidate',dependsOn:job.id,status:'blocked',createdAt:'2026-01-01'})
  const html='<html><title>Just a moment...</title><body>Verify you are human</body></html>'
  await writeJson(join(p.snapshots,'captcha/s1/snapshot.json'),{id:'s1',pageId:'captcha',url:pages[1].url,htmlHash:hash(html),assets:[]})
  await writeJson(join(p.snapshots,'captcha/latest.json'),{id:'s1'})
  const {writeFile}=await import('node:fs/promises')
  await writeFile(join(p.snapshots,'captcha/s1/source.html'),html)
  await mkdir(join(p.jobs,job.id),{recursive:true})
  await writeFile(join(p.jobs,job.id,'stdout.log'),'x'.repeat(25000)+'<script>not executed</script>')
  await writeFile(join(p.jobs,job.id,'stderr.log'),'actual stderr')
  const app=await startServer({root:folder,dataRoot:p.data,port:0})
  cleanups.push(()=>app.close())
  const response=await fetch(app.base+'/api/pilot',{method:'POST',headers:{'Content-Type':'application/json','X-Reading-Review':'1'},body:'{}'})
  expect(response.status).toBe(202)
  const batch=await response.json()
  expect(batch.queued).toEqual([])
  expect(batch.skipped.map((item:any)=>item.pageId)).toEqual(['http-error','captcha','uncaptured'])
  const before=await readdir(p.jobs)
  for(const endpoint of ['/api/pilot','/api/candidate-all','/api/pilot','/api/candidate-all']){
    const again=await(await fetch(app.base+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Reading-Review':'1'},body:'{}'})).json()
    expect(again.queued).toEqual([])
    expect(again.skipped.map((item:any)=>item.pageId)).toEqual(['http-error','captcha','uncaptured'])
  }
  expect(await readdir(p.jobs)).toEqual(before)
  const log=await(await fetch(app.base+'/api/jobs/failed-capture/log')).json()
  expect(log).toMatchObject({error:{httpStatus:404},stderr:'actual stderr',truncatedTo:24000})
  expect(log.stdout).toHaveLength(24000)
  expect(log.stdout).toContain('<script>not executed</script>')
  expect((await fetch(app.base+'/api/jobs/unknown/log')).status).toBe(404)
  expect((await fetch(app.base+'/api/jobs/%2e%2e/log')).status).toBe(404)
  const retryResponse=await fetch(app.base+'/api/jobs/dependent/retry',{method:'POST',headers:{'Content-Type':'application/json','X-Reading-Review':'1'},body:JSON.stringify({snapshotId:'unrelated',dependsOn:'unrelated'})})
  expect(retryResponse.status).toBe(202)
  const retried=await retryResponse.json()
  expect(retried).toMatchObject({dependsOn:job.id,retryOf:'dependent'})
  for(let i=0;i<100;i++){
    const saved=await readJson(join(p.jobs,retried.id+'.json'))
    if(!['queued','running'].includes(saved.status)){expect(saved.status).toBe('blocked');expect(saved.snapshotId).toBeUndefined();break}
    if(i===99)throw new Error('retried dependency did not settle')
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  expect((await fetch(app.base+'/api/jobs/unknown/retry',{method:'POST',headers:{'Content-Type':'application/json','X-Reading-Review':'1'},body:'{}'})).status).toBe(400)
  expect((await readJson(join(p.jobs,job.id+'.json'))).status).toBe('failed')
})
