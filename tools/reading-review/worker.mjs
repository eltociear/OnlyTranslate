import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { paths, readJson, writeJson, hash, validId } from './model.mjs'
import { browserConfig, openBrowser, runBrowser, closeBrowser, command, buildCollector, fingerprintSources } from './driver.mjs'
import { installCatalogue } from './catalogue.mjs'
import { replayPayload as loadReplayPayload, replayCode } from './replay.mjs'
import { saveCapturedSnapshot, saveBaselineRun } from './archive.mjs'
import { prepareReleaseInputs } from './release.mjs'
import { assessTranslation } from './completion.mjs'
import { pageInputIssue, requireSnapshotInput } from './inputs.mjs'
import { toolError, errorRecord } from './errors.mjs'
import { extensionRoot } from './adapters/onlytranslate.mjs'

const root = extensionRoot
const p = paths(root)
const completionRuleHash = hash(await readFile(new URL('./completion.mjs', import.meta.url)))
const [action, pageId, jobId, requestedSnapshot] = process.argv.slice(2)
if (!['capture', 'baseline', 'candidate'].includes(action) || !validId(pageId) || !validId(jobId)) throw new Error('无效任务')
if(requestedSnapshot&&!validId(requestedSnapshot))throw new Error('无效快照编号')
const jobPath = join(p.jobs, jobId + '.json')
process.env.ONLYTRANSLATE_REVIEW_JOB_LOG ||= join(p.jobs,jobId,'commands')
let phase=action
const progress = async (message,details={}) => { console.log(message); const job = await readJson(jobPath);phase=details.phase||phase;const now=new Date().toISOString(); await writeJson(jobPath, { ...job, ...details,phase,message,updatedAt:now,lastProgressAt:message!==job.message?now:job.lastProgressAt }) }
const pageInfo = (await readJson(p.manifest)).pages.find(page=>page.id === pageId)
if (!pageInfo) throw new Error('样本不存在')

async function capturePage() {
  const browser = await browserConfig(p, null, 'capture')
  await openBrowser(browser)
  try {
    await progress('正在加载页面、滚动并归档资源')
    const screenshot = join(p.data, 'capture-' + jobId + '.png')
    const captured = await runBrowser(browser, `async page => {
      const tab = await page.context().newPage(), assets = new Map(), tasks = [];
      let bytes = 0, omitted = 0;
      tab.on('response', response => {
        if (!['stylesheet','image','font'].includes(response.request().resourceType()) || !response.ok()) return;
        tasks.push((async()=>{try { const body=await response.body(); if(body.length>6000000 || bytes+body.length>35000000){omitted++;return;} bytes+=body.length; assets.set(response.url(),{url:response.url(),type:response.headers()['content-type']||'application/octet-stream',body:body.toString('base64')}); }catch{omitted++;}})());
      });
      try {
        const response=await tab.goto(${JSON.stringify(pageInfo.url)},{waitUntil:'domcontentloaded',timeout:45000});
        if(!response?.ok()) throw new Error('HTTP '+response?.status());
        await tab.locator(${JSON.stringify(pageInfo.ready || 'body')}).first().waitFor({state:'visible',timeout:20000});
        const title=await tab.title(),issue=(${pageInputIssue.toString()})(title,await tab.locator('body').innerText());if(issue)throw new Error('INPUT_BLOCKED: '+issue);
        await tab.waitForTimeout(1200);
        let bottom=false;
        for(let i=0;i<160;i++){bottom=await tab.evaluate(()=>{if(scrollY+innerHeight>=document.documentElement.scrollHeight-3)return true;scrollBy(0,innerHeight*.8);return false;}); if(bottom)break;await tab.waitForTimeout(120);}
        if(!bottom)throw new Error('未到达页面底部，快照不完整');
        ${pageInfo.focus ? `await tab.locator(${JSON.stringify(pageInfo.focus)}).scrollIntoViewIfNeeded({timeout:15000});await tab.waitForTimeout(1200);` : 'await tab.evaluate(()=>scrollTo(0,0));'}
        let previous='',stable=0;
        for(let i=0;i<30;i++){const state=await tab.evaluate(()=>JSON.stringify([document.body.innerText.length,document.documentElement.scrollHeight]));stable=state===previous?stable+1:0;previous=state;if(stable>=4)break;await tab.waitForTimeout(400);}
        if(stable<4)throw new Error('页面尚未稳定');
        const catalogue=await tab.evaluate(${installCatalogue.toString()});
        const html=await tab.content(), scrollY=await tab.evaluate(()=>window.scrollY);
        await tab.screenshot({path:${JSON.stringify(screenshot)},fullPage:true,animations:'disabled',timeout:30000});
        await Promise.all(tasks);
        return {html,catalogue,title,url:tab.url(),scrollY,viewport:tab.viewportSize(),assets:[...assets.values()],omitted,focused:${Boolean(pageInfo.focus)}};
      }finally{await tab.close();}
    }`)
    const snapshot = await saveCapturedSnapshot(p, pageInfo, captured, screenshot)
    await progress(`快照已保存：${snapshot.catalogue.blocks.length} 个文字块，${snapshot.assets.length} 项资源`)
    return { snapshotId: snapshot.id, pageId }
  } finally { await closeBrowser(browser) }
}

const replayPayload=(snapshot,bundle)=>loadReplayPayload(p,pageId,snapshot,bundle)

async function prepareRelease() {
  const inputs = await prepareReleaseInputs(p)
  const bundle = await buildCollector(p, inputs.source, inputs.build, join(inputs.folder, 'collector.js'))
  return { ...inputs, bundle }
}

async function baseline(snapshot) {
  await progress('核验发布包并准备发布版识别采集器',{phase:'prepare-release'})
  const {release,extension,build,bundle}=await prepareRelease()
  const browser=await browserConfig(p,extension)
  await openBrowser(browser)
  const runId='release-'+Date.now()+'-'+randomUUID().slice(0,6),runFolder=join(p.runs,pageId,runId)
  await mkdir(runFolder,{recursive:true})
  try{
    const payload=await replayPayload(snapshot,bundle)
    await progress('回放有效快照并检查翻译按钮',{phase:'replay'})
    const initial=await runBrowser(browser,`async page=>{
      const ctx=page.context();const worker=ctx.serviceWorkers().find(w=>w.url().startsWith('chrome-extension:'))||await ctx.waitForEvent('serviceworker',{timeout:15000});
      const settings=${JSON.stringify(release.settings)};
      const actual=await worker.evaluate(async settings=>{const data=await chrome.storage.local.get('config');const previous=typeof data.config==='string'?JSON.parse(data.config):{};const config={...previous,...settings};await chrome.storage.local.set({config:JSON.stringify(config)});return {version:chrome.runtime.getManifest().version,settings:{from:config.from,to:config.to,bidirectionalTranslation:Boolean(config.bidirectionalTranslation),bidirectionalTarget:config.bidirectionalTarget||''}};},settings);
      if('v'+actual.version!==${JSON.stringify(release.tag)})throw new Error('运行中的扩展版本不一致');
      ${replayCode(payload)}
      const result=await page.evaluate(()=>window.collectReadingReview());
      const execution=await page.evaluate(settings=>window.readReadingReviewExecution(settings),actual.settings);
      await page.getByTestId('floating-ball-trigger').waitFor({state:'visible',timeout:20000});
      try{await page.getByTestId('floating-ball-trigger').click({trial:true,timeout:5000});await page.getByTestId('floating-ball-trigger').click({timeout:5000});}
      catch(error){throw new Error('INPUT_INTERACTION_REQUIRED: 翻译按钮被遮挡或不可点击。'+error.message);}
      await page.waitForTimeout(1500);
      return {...result,execution,executionSettings:actual.settings,actualVersion:actual.version};
    }`)
    let observation,assessment,stable=0,signature='',stopReason='deadline'
    const started=Date.now();let lastProgress=started
    while(Date.now()-started<240000){
      observation=await runBrowser(browser,`async page=>{
        await page.waitForTimeout(1000);
        return await page.evaluate(()=>{
          const state=window.__readingReview;
          const items=state.nodes.map((node,index)=>({id:'target-'+index,attempted:node.hasAttribute('data-fr-translated'),connected:node.isConnected,
            pending:Boolean(node.querySelector('.only-translate-loading')),failed:node.matches('.only-translate-failure')||Boolean(node.querySelector('.only-translate-failure,.only-translate-retry-wrapper')),
            translation:[...node.querySelectorAll('.only-translate-bilingual-text')].map(n=>n.textContent).join('\\n')}));
          const hosts=[...document.querySelectorAll('[data-fr-translated="true"]')];
          const unexpectedTargets=hosts.filter(node=>!state.nodes.includes(node)).map((node,index)=>({...state.recordTarget(node,state.nodes.length+index),
            pending:Boolean(node.querySelector('.only-translate-loading')),failed:node.matches('.only-translate-failure')||Boolean(node.querySelector('.only-translate-failure,.only-translate-retry-wrapper')),
            translation:[...node.querySelectorAll('.only-translate-bilingual-text')].map(n=>n.textContent).join('\\n')}));
          return {items,unexpectedTargets,unexpectedHosts:unexpectedTargets.length,actualHosts:hosts.length,pending:document.querySelectorAll('.only-translate-loading').length,failures:document.querySelectorAll('.only-translate-failure,.only-translate-retry-wrapper').length,inserted:document.querySelectorAll('.only-translate-bilingual-text').length,attempted:items.filter(i=>i.attempted).length};
        });
      }`)
      assessment=assessTranslation(initial.targets,observation,initial.execution)
      const next=JSON.stringify([assessment.counts,assessment.coveredTargets,observation.pending,observation.failures,observation.inserted])
      if(next!==signature){signature=next;lastProgress=Date.now()}
      stable=assessment.settled?stable+1:0
      await progress(`译文覆盖 ${assessment.coveredTargets}/${initial.targets.length}，已处理 ${assessment.processedTargets}，译文 ${observation.inserted}，待核实 ${assessment.counts['unverified-completion']||0}，跳过 ${assessment.skipped}，不支持 ${assessment.unsupported}，等待 ${assessment.waiting}，处理中 ${observation.pending}，失败 ${observation.failures}`,
        {phase:'translate',progress:{covered:assessment.coveredTargets,processed:assessment.processedTargets,unverified:assessment.counts['unverified-completion']||0,expected:initial.targets.length,inserted:observation.inserted,skipped:assessment.skipped,unsupported:assessment.unsupported,waiting:assessment.waiting,pending:observation.pending,failures:observation.failures}})
      if(stable>=3){stopReason=assessment.complete?'complete':observation.failures?'translation-failures':'limited';break}
      if(observation.pending===0&&Date.now()-lastProgress>=30000){stopReason='no-progress';break}
    }
    const complete=stable>=3&&assessment.complete
    const sourceTexts=new Map(snapshot.catalogue.texts.map(text=>[text.id,text.text]))
    const observedTargets=observation.unexpectedTargets.filter(target=>target.textIds.length).map(target=>({...target,text:target.textIds.map(id=>sourceTexts.get(id)||'').join(' '),observedText:target.text}))
    const result={schemaVersion:1,id:runId,pageId,snapshotId:snapshot.id,createdAt:new Date().toISOString(),kind:'baseline',build:initial.build,bundleHash:hash(bundle),status:complete?'complete':'incomplete',actualVersion:initial.actualVersion,
      targets:[...initial.targets.map((target,i)=>({...target,...observation.items[i],execution:initial.execution[i],translationStatus:assessment.outcomes[i]})),...observedTargets],elapsedMs:initial.elapsedMs,stats:initial.stats,
      translation:{service:release.settings.service,targetLanguage:release.settings.to,executionSettings:initial.executionSettings,elapsedMs:Date.now()-started,expected:initial.targets.length,actualHosts:observation.actualHosts,unexpectedHosts:observation.unexpectedHosts,attempted:observation.attempted,...assessment,
        executionSettled:stable>=3,stopReason,completionRule:'translation-evidence-v3',completionRuleHash,inserted:observation.inserted,pending:observation.pending,failures:observation.failures,complete}}
    await saveBaselineRun(runFolder,result,async()=>{
      const html=await runBrowser(browser,'async page=>({html:await page.content()})')
      await writeFile(join(runFolder,'translated.html'),html.html)
      await progress('保存实翻页面及全页截图，目标和译文记录已落盘',{phase:'archive'})
      try{await runBrowser(browser,`async page=>{await page.screenshot({path:${JSON.stringify(join(runFolder,'translated.png'))},fullPage:true,animations:'disabled',timeout:60000});return true;}`)}
      catch(error){throw toolError('ARTIFACT_FAILED','全页实翻截图失败，目标及译文已保留：'+error.message,{cause:errorRecord(error,'screenshot'),result:{runId,pageId,snapshotId:snapshot.id}})}
    })
    const reference={runId,pageId,snapshotId:snapshot.id}
    if(!complete&&stopReason!=='limited')throw toolError('TRANSLATION_INCOMPLETE',`实翻未完整完成（${stopReason}），已保留结果；覆盖 ${assessment.coveredTargets}/${initial.targets.length}`,{stage:'translate',result:reference})
    return {...reference,...(!complete?{limited:true,message:`观测已结束：覆盖 ${assessment.coveredTargets}/${initial.targets.length}，跳过 ${assessment.skipped}，不支持 ${assessment.unsupported}；不是合格实翻基线`}:{})}
  }finally{await closeBrowser(browser)}
}

async function candidate(snapshot) {
  await progress('构建当前源码的识别采集器，不修改识别算法')
  const commit=(await command('git',['rev-parse','HEAD'],{cwd:root})).trim(), diff=await command('git',['diff','HEAD','--','entrypoints'],{cwd:root})
  const sourceHash=await fingerprintSources(root)
  const build={kind:'candidate',commit,sourceDiffHash:hash(diff),sourceHash}
  const file=join(root,'output/reading-review-build/candidate/collector.js'),bundle=await buildCollector(p,root,build,file)
  const browser=await browserConfig(p);await openBrowser(browser)
  try{
    const payload=await replayPayload(snapshot,bundle)
    const result=await runBrowser(browser,`async page=>{${replayCode(payload)}return await page.evaluate(()=>window.collectReadingReview());}`)
    const id='candidate-'+Date.now()+'-'+randomUUID().slice(0,6)
    await writeJson(join(p.runs,pageId,id,'run.json'),{schemaVersion:1,id,pageId,snapshotId:snapshot.id,kind:'candidate',createdAt:new Date().toISOString(),status:'complete',bundleHash:hash(bundle),...result})
    return {runId:id,pageId,snapshotId:snapshot.id}
  }finally{await closeBrowser(browser)}
}

try {
  await mkdir(p.jobs,{recursive:true})
  let result
  if(action==='capture') result=await capturePage()
  else {
    const latest=requestedSnapshot?{id:requestedSnapshot}:await readJson(join(p.snapshots,pageId,'latest.json'))
    const snapshot=await requireSnapshotInput(p,pageId,latest.id)
    result=action==='baseline'?await baseline(snapshot):await candidate(snapshot)
  }
  await writeJson(jobPath,{...await readJson(jobPath),status:result.limited?'limited':'complete',message:result.message||'完成',result,finishedAt:new Date().toISOString()})
}catch(error){
  console.error(error.stack)
  const record=errorRecord(error,phase);await writeJson(join(p.jobs,jobId,'error.json'),record)
  const blocked=['MISSING_SNAPSHOT','INVALID_SNAPSHOT','INPUT_BLOCKED','INPUT_INTERACTION_REQUIRED'].includes(error.code)
  await writeJson(jobPath,{...await readJson(jobPath),status:blocked?'blocked':'failed',message:error.message,error:record,...(error.details?.result?{result:error.details.result}:{}),finishedAt:new Date().toISOString()})
  process.exitCode=1
}
