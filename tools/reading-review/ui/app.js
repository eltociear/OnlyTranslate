import {STORAGE_KEY,readDrafts,groupDrafts,editDraft,clearSubmitted} from './drafts.mjs'
const $ = selector => document.querySelector(selector)
const escape = text => String(text ?? '').replace(/[&<>"']/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))
const labels={added:'新版新增',removed:'新版减少',changed:'部分变化',same:'共同选中',unselected:'均未选中'}
const verdictLabels={translate:'该翻',exclude:'不该翻',either:'都可以',pending:'待定'}
let state,detail,pageId,selectedId,verdict='pending',dirty=false,lastJobs='',toastTimer,saving=false,historicalComparison=false,reviewSaving=false,completing=false
let drafts=readDrafts(localStorage)
async function api(path,data){const response=await fetch(path,data?{method:'POST',headers:{'Content-Type':'application/json','X-Reading-Review':'1'},body:JSON.stringify(data)}:{});const result=await response.json();if(!response.ok){const error=new Error(result.error||'请求失败');error.status=response.status;throw error;}return result}
function toast(text){$('#toast').textContent=text;$('#toast').style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').style.display='none',5000)}
function statusBadge(status){return `<span class="badge ${status==='complete'?'good':['failed','interrupted'].includes(status)?'error':['running','limited','blocked'].includes(status)?'warn':''}">${({complete:'完成',running:'运行中',queued:'排队',failed:'失败',interrupted:'中断',blocked:'已跳过',limited:'受限结束'})[status]||'尚未运行'}</span>`}

function currentDrafts(){return pageId&&detail?.snapshot?groupDrafts(drafts,pageId,detail.snapshot.id):{}}
function pageDraftCount(id){return Object.entries(drafts).reduce((n,[key,items])=>{try{return n+(JSON.parse(key)[0]===id?Object.keys(items).length:0)}catch{return n}},0)}
function persistDrafts(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(drafts))}catch{toast('浏览器暂存空间不足，请先统一保存；此时刷新可能丢失草稿。')}}
function renderDraftState(){renderPageReview();const group=currentDrafts(),count=Object.keys(group).length;dirty=count>0;$('#draft-count').textContent=count?'已暂存 '+count+' 项，尚未正式保存':'没有待保存修改';$('#save-decisions').textContent=saving?'正在保存…':'仅保存标注'+(count?'（'+count+'项）':'');$('#save-decisions').disabled=saving||!count;document.querySelectorAll('[data-verdict]').forEach(button=>button.disabled=saving);$('#note').disabled=saving;$('#discard-draft').disabled=saving||!group[selectedId];if(selectedId){const block=detail.blocks.find(b=>b.id===selectedId);$('#saved-state').textContent=group[selectedId]?'已暂存，切换文字也会保留':block?.decision?(block.decision.confirmed?'已保存 · 修改会保留历史':'已保存待定记录'):'沿用本次结果，无需单独标注'}}
function stageDecision(){if(!selectedId||saving)return;const block=detail.blocks.find(b=>b.id===selectedId);drafts=editDraft(drafts,pageId,detail.snapshot.id,block,verdict,$('#note').value);persistDrafts();renderDraftState();renderVerdict();renderBlocks()}
async function saveAllDecisions(){const submitted=Object.values(currentDrafts());if(!submitted.length||saving)return;const savedPage=pageId,snapshotId=detail.snapshot.id;saving=true;renderDraftState();try{const result=await api('/api/decisions/'+savedPage,{decisions:submitted});drafts=clearSubmitted(drafts,savedPage,snapshotId,submitted,result.decisions);persistDrafts();if(pageId===savedPage&&detail.snapshot?.id===snapshotId){await loadDetail();if(selectedId)selectBlock(selectedId)}toast('已统一保存 '+result.saved+' 项人工标注');await refresh()}catch(error){if(error.status===409&&pageId===savedPage&&detail.snapshot?.id===snapshotId){await loadDetail();if(selectedId)selectBlock(selectedId)}throw error}finally{saving=false;renderDraftState()}}

function renderPageReview(){
  const review=detail?.pageReview,hasDrafts=Object.keys(currentDrafts()).length>0
  const button=$('#confirm-page-review'),revoke=$('#revoke-page-review')
  $('#page-review-status').textContent=review?.label||'本页待评审'
  $('#page-review-status').className='badge '+(review?.state==='confirmed'?'good':review?.state==='needs-review'?'warn':'')
  $('#page-review-hint').textContent=hasDrafts?'点击完成评审时会先保存这些修改，再合成整页期望':historicalComparison?'请恢复默认对比，再完成本页评审':review?.reason||'先采集页面并运行当前版'
  $('#page-review-validation').textContent=review?.validation?.label||'尚无有效识别结果'
  $('#page-review-validation').className='badge '+(review?.validation?.state==='violations'?'error':review?.validation?.state==='accepted-known-issues'?'warn':'')
  $('#page-review-date').textContent=review?.review?'评审完成于 '+new Date(review.review.recordedAt).toLocaleString('zh-CN'):''
  button.textContent=reviewSaving||completing?'正在保存…':review?.state==='confirmed'?(review.needsSave||hasDrafts?'更新本页期望':'本页评审已完成'):'完成本页评审'
  button.disabled=reviewSaving||completing||saving||historicalComparison||!review?.canConfirm||(!hasDrafts&&review?.state==='confirmed'&&!review.needsSave)
  revoke.classList.toggle('hidden',!review?.canRevoke);revoke.disabled=reviewSaving||completing||saving||hasDrafts||historicalComparison
}
async function savePageReview(status){
  if(reviewSaving||saving||Object.keys(currentDrafts()).length||historicalComparison)return
  const savedPage=pageId,snapshotId=detail.snapshot.id,r=detail.pageReview
  reviewSaving=true;renderPageReview()
  try{
    await api('/api/page-reviews/'+savedPage,{status,snapshotId,runId:detail.after?.id,expectedReviewId:r.latestReviewId,inputHash:r.inputHash,coverageHash:r.coverageHash,contextHash:r.contextHash})
    if(pageId===savedPage&&detail.snapshot?.id===snapshotId)await loadDetail()
    await refresh();toast(status==='confirmed'?'本页评审已完成，整页期望已保存；待修复问题仍会校验':'已撤销整页评审，人工标注与历史保留')
  }catch(error){if(error.status===409&&pageId===savedPage)await loadDetail();throw error}
  finally{reviewSaving=false;renderPageReview()}
}
async function completePageReview(){
  if(completing||reviewSaving||saving||historicalComparison)return
  const savedPage=pageId,snapshotId=detail.snapshot?.id,runId=detail.after?.id
  completing=true;renderPageReview()
  try{
    if(Object.keys(currentDrafts()).length)await saveAllDecisions()
    if(pageId!==savedPage||detail.snapshot?.id!==snapshotId)throw new Error('原页标注已保存，请返回该页完成评审')
    if(detail.after?.id!==runId)throw new Error('识别结果已更新，请查看新结果后重新完成评审')
    await savePageReview('confirmed')
  }finally{completing=false;renderPageReview()}
}
function pageReviewBadge(review){return `<button class="badge ${review?.state==='confirmed'?'good':review?.state==='needs-review'?'warn':''}" title="${escape(review?.reason||'进入本页，只标问题后完成评审')}">${escape(review?.label||'本页待评审')}</button>`}
function matchesPageReviewFilter(page){const filter=$('#page-review-filter').value,status=page.pageReview?.state;return filter==='all'||filter==='pending'&&status!=='confirmed'||filter==='confirmed'&&status==='confirmed'||filter==='needs-review'&&status==='needs-review'}

async function refresh(){
  state=await api('/api/state')
  $('#release-label').textContent=state.release.tag+' 发布基线'
  const totals=state.pages.reduce((r,p)=>({snap:r.snap+!!p.snapshotId,base:r.base+!!p.before,changes:r.changes+(p.summary?.added||0)+(p.summary?.removed||0),confirmed:r.confirmed+(p.summary?.confirmed||0)}),{snap:0,base:0,changes:0,confirmed:0})
  $('#metrics').innerHTML=[['已收录页面',state.pages.length,`${totals.snap} 页已采集`],['发布版实翻',totals.base,'仅统计完整完成的基线'],['文字块变化',totals.changes,'新增与减少尚不代表对错'],['已完成评审',state.pages.filter(p=>p.pageReview?.state==='confirmed').length,'已保存人工标注 '+totals.confirmed+' 处，构建继续校验']].map(([label,n,note])=>`<div class="metric"><span>${label}</span><strong>${n}</strong><span>${note}</span></div>`).join('')
  $('#page-list').innerHTML=`<table><thead><tr><th>页面 / 来源</th><th>类型</th><th>快照</th><th>发布版实翻</th><th title="相对发布版基线：斜杠前是当前版新增选中的原文块数，斜杠后是当前版不再选中的原文块数。变化不代表对错。">候选差异<br><span>新增 / 减少（原文块）</span></th><th>人工评审<br><span>评审进度 / 当前结果</span></th></tr></thead><tbody>${state.pages.filter(matchesPageReviewFilter).map(page=>`<tr class="sample" data-page="${page.id}"><td><strong>${escape(page.name)}</strong><small>${escape(page.source)}</small></td><td><span class="badge">${escape(page.type)}</span></td><td>${page.snapshotId?'已采集'+(page.resourceWarnings?' · 有资源缺失':''):'待采集'}</td><td>${page.before?`<span class="badge good">${page.before.translation.inserted} 条译文</span>`:'待运行'}</td><td>${page.after?`<span class="state-added">+${page.summary.added}</span> / <span class="state-removed">−${page.summary.removed}</span>`:'待运行'}</td><td>${pageReviewBadge(page.pageReview)}<small>人工标注 ${page.summary?.confirmed||0} 处</small><small class="${page.pageReview?.validation?.state==='violations'?'state-removed':''}">${escape(page.pageReview?.validation?.label||'')}</small>${pageDraftCount(page.id)?` <span class="badge draft">${pageDraftCount(page.id)} 项待保存</span>`:''}</td></tr>`).join('')}</tbody></table>`
  $('#jobs').innerHTML=state.jobs.length?[...state.jobs].sort((a,b)=>{const rank=j=>j.status==='running'?0:j.status==='queued'?1:2;return rank(a)-rank(b)||(rank(a)<2?a.createdAt.localeCompare(b.createdAt):(b.finishedAt||b.createdAt).localeCompare(a.finishedAt||a.createdAt))}).slice(0,20).map(job=>`<div class="job">${statusBadge(job.status)}<span class="job-name">${escape(state.pages.find(p=>p.id===job.pageId)?.name||job.pageId)} · ${({capture:'采集',baseline:'发布实翻',candidate:'当前版'})[job.type]}</span><span class="message" title="${escape(job.message)}">${escape(job.message.slice(0,300))}${job.lastProgressAt?'<small>最后进展 '+new Date(job.lastProgressAt).toLocaleTimeString('zh-CN')+'</small>':''}</span><button data-job-log="${job.id}">日志</button>${['failed','interrupted','blocked','limited'].includes(job.status)?`<button data-retry="${job.id}">重试</button>`:''}</div>`).join(''):'<div class="empty">运行首批页面，或打开一个样本分别执行采集、发布版实翻和当前版识别。</div>'
  $('#data-path').textContent='页面与运行：'+state.dataRoot+' ｜ 正式裁决：'+state.decisionsRoot
  const current=JSON.stringify(state.jobs.filter(j=>j.pageId===pageId).map(j=>[j.id,j.status]))
  if(pageId&&lastJobs&&current!==lastJobs&&!dirty)await loadDetail()
  lastJobs=current
}
function query(){const q=new URLSearchParams();if($('#snapshot-run').value)q.set('snapshot',$('#snapshot-run').value);if(historicalComparison){if($('#before-run').value)q.set('before',$('#before-run').value);if($('#after-run').value)q.set('after',$('#after-run').value);}return q}
async function openPage(id){pageId=id;selectedId=null;dirty=false;historicalComparison=false;$('#run-history').classList.add('hidden');$('#history-toggle').setAttribute('aria-expanded','false');$('#overview').classList.add('hidden');$('#review').classList.remove('hidden');$('#decision-editor').classList.add('hidden');history.replaceState(null,'','#'+id);await loadDetail(false)}
function runName(run){return `${run.build.tag||run.build.commit?.slice(0,7)||'当前版'} · ${new Date(run.createdAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}${run.status==='invalid'?' · 无效回放':run.status!=='complete'?' · 未完成':''}`}
async function loadDetail(preserve=true){
  const q=preserve?query():new URLSearchParams();detail=await api('/api/pages/'+pageId+'?'+q)
  $('#page-title').textContent=detail.page.name;$('#page-url').textContent=detail.page.url;$('#page-url').href=detail.page.url
  $('#snapshot-run').innerHTML=(detail.snapshots||[detail.snapshot]).filter(Boolean).map(s=>`<option value="${s.id}" ${s.id===detail.snapshot?.id?'selected':''}>${s.createdAt?new Date(s.createdAt).toLocaleString('zh-CN'):'当前快照'}${s.state==='focused'?' · 关注状态':''}</option>`).join('')
  for(const [selector,kind,chosen]of[['#before-run','baseline',detail.before],['#after-run','candidate',detail.after]])$(selector).innerHTML=(chosen?'':'<option value="">暂无有效结果</option>')+detail.runs.filter(run=>run.kind===kind).map(run=>`<option value="${run.id}" ${chosen?.id===run.id?'selected':''} ${run.status!=='complete'?'disabled':''}>${escape(runName(run))}</option>`).join('')
  $('#current-baseline').textContent=detail.before?(detail.before.build.tag||detail.before.build.commit?.slice(0,7)||'发布版'):'尚未运行';
  $('#current-baseline').title=detail.before?runName(detail.before):'';
  $('#current-candidate').textContent=detail.after?(detail.after.build.tag||detail.after.build.commit?.slice(0,7)||'当前版'):'尚未运行';
  $('#current-candidate').title=detail.after?runName(detail.after):'';
  $('#candidate-kind').textContent=historicalComparison?'历史测试记录':'当前测试版';
  $('#history-toggle').textContent='历史记录（'+detail.runs.length+'）';$('#history-toggle').disabled=!detail.runs.length;
  $('#restore-default').disabled=!historicalComparison;
  $('#pin-baseline').disabled=!detail.before||detail.before.kind!=='baseline'||detail.before.id===detail.baselineSelection?.baselineRunId;
  const s=detail.summary;$('#review-metrics').innerHTML=`<span>新增 <strong>${s.added}</strong></span><span>减少 <strong>${s.removed}</strong></span><span>疑似漏译 <strong>${s.suspected}</strong></span><span>人工标注 <strong>${s.confirmed}</strong> 处</span><span>与标注不一致 <strong>${s.violations}</strong> 处</span><span>已接受的已知限制 <strong>${s.acceptedIssues}</strong></span><span>待修复 <strong>${detail.pageReview.validation.blockingBlocks.length}</strong> 处</span>`
  $('#run-status').textContent=!detail.before?'请先运行发布版实翻':!detail.after?'请运行当前版后比较':(historicalComparison?'正在查看历史对比':'固定发布版基线 → 最新有效测试结果')
  if(!detail.snapshot)toast('这个样本尚未采集，点击“重新采集”开始。')
  renderBlocks();renderDraftState();updatePreview()
}
function filteredBlocks(){const filter=$('#filter').value,search=$('#search').value.toLowerCase();return(detail?.blocks||[]).filter(b=>(!search||b.text.toLowerCase().includes(search))&&(filter==='all'||filter==='page-review'&&b.pageReviewChanged||filter==='changes'&&(b.added.length||b.removed.length)||filter==='suspected'&&b.suspected||filter==='violations'&&b.repairNeeded||filter==='confirmed'&&b.decision||filter==='drafts'&&currentDrafts()[b.id]))}
function renderBlocks(){const blocks=filteredBlocks(),group=currentDrafts();$('#block-count').textContent=blocks.length;$('#block-list').innerHTML=blocks.length?blocks.map(block=>`<button class="block ${block.id===selectedId?'selected':''}" data-block="${block.id}"><span class="block-meta"><span class="state-${block.state}">${labels[block.state]}</span>${block.pageReviewChanged?'<span class="badge warn">与整页期望不一致</span>':''}${block.acceptedIssue?'<span class="badge warn">已接受 · 不阻断</span>':block.repairNeeded?'<span class="badge error">待修复</span>':''}${group[block.id]?`<span class="badge draft">待保存 · ${verdictLabels[group[block.id].verdict]}</span>`:block.decision?`<span class="badge ${block.decision.confirmed?'good':''}">${verdictLabels[block.decision.verdict]}</span>`:''}<span>${escape(block.tag)}</span></span><span class="excerpt">${escape(block.text)}</span></button>`).join(''):'<div class="empty">这个筛选下没有文字块。<br>可切换“全部文字”，或直接点击左侧页面补标。</div>'}
function fitPreview(){if(!detail?.snapshot)return;const frame=$('#preview');frame.style.width=$('#view-mode').value==='source-wide'?(detail.snapshot.viewport?.width||1440)+'px':'100%';frame.style.height='100%';frame.style.transform='none';frame.style.zoom='1'}
function updatePreview(){if(!detail?.snapshot){$('#preview').src='about:blank';return}const mode=$('#view-mode').value,q=query();q.set('snapshot',detail.snapshot.id);const image=mode.endsWith('-image');$('#preview').classList.toggle('hidden',image);$('#screenshot').classList.toggle('hidden',!image);$('.frame-wrap').style.overflow=image||mode==='source-wide'?'auto':'hidden';if(image)$('#screenshot').src='/image/'+pageId+'/'+(mode==='original-image'?'original':'translated')+'?'+q;else{if(mode==='translated')q.set('translated','1');$('#preview').src='/preview/'+pageId+'?'+q;fitPreview()}}
function selectBlock(id){const block=detail.blocks.find(b=>b.id===id);if(!block)return;selectedId=id;const choice=currentDrafts()[id]||block.decision;verdict=choice?.verdict||'pending';$('#decision-editor').classList.remove('hidden');$('#selected-text').textContent=block.text+(block.acceptedIssue?'\n\n已接受的已知限制（不阻断发布）：'+block.acceptedIssue.reason+' 修改并保存裁决后，需要重新确认豁免。':'');$('#note').value=choice?.note||'';renderVerdict();renderBlocks();renderDraftState();$('#preview').contentWindow.postMessage({kind:'reading-review-focus',id},'*')}
function renderVerdict(){document.querySelectorAll('[data-verdict]').forEach(button=>button.classList.toggle('chosen',button.dataset.verdict===verdict))}
document.addEventListener('click',async event=>{try{
 const page=event.target.closest('[data-page]');if(page)return await openPage(page.dataset.page)
 const block=event.target.closest('[data-block]');if(block)return selectBlock(block.dataset.block)
 const choice=event.target.closest('[data-verdict]');if(choice){verdict=choice.dataset.verdict;stageDecision();return}
 const task=event.target.closest('[data-job]');if(task){await api('/api/jobs',{type:task.dataset.job,pageId,...(task.dataset.job!=='capture'&&detail.snapshot?{snapshotId:detail.snapshot.id}:{})});toast('任务已加入队列');return await refresh()}
 const log=event.target.closest('[data-job-log]');if(log){const result=await api('/api/jobs/'+log.dataset.jobLog+'/log');$('#job-log-panel').classList.remove('hidden');$('#job-log-text').textContent=JSON.stringify(result,null,2);return}
 const retry=event.target.closest('[data-retry]');if(retry){await api('/api/jobs/'+retry.dataset.retry+'/retry',{});return await refresh()}
}catch(error){toast(error.message)}})
$('#close-job-log').onclick=()=>$('#job-log-panel').classList.add('hidden');
$('#back').onclick=()=>{pageId=null;dirty=false;$('#review').classList.add('hidden');$('#overview').classList.remove('hidden');history.replaceState(null,'','/');refresh().catch(e=>toast(e.message))}
$('#add-toggle').onclick=()=>$('#add-form').classList.toggle('hidden')
$('#new-page').onsubmit=async event=>{event.preventDefault();try{const result=await api('/api/pages',Object.fromEntries(new FormData(event.target)));event.target.reset();$('#add-form').classList.add('hidden');await refresh();await openPage(result.id)}catch(error){toast(error.message)}}
$('#pilot').onclick=async()=>{try{const jobs=await api('/api/pilot',{});toast('已排队 '+jobs.queued.length+' 项；受限输入跳过 '+jobs.skipped.length+' 页');await refresh()}catch(error){toast(error.message)}}
$('#compare-all').onclick=async()=>{try{const result=await api('/api/candidate-all',{});toast(`已排队 ${result.queued.length} 页，未采集跳过 ${result.skipped.length} 页`);await refresh()}catch(error){toast(error.message)}}
$('#page-review-filter').onchange=()=>refresh().catch(error=>toast(error.message));
$('#confirm-page-review').onclick=()=>completePageReview().catch(error=>toast(error.message));
$('#revoke-page-review').onclick=()=>savePageReview('revoked').catch(error=>toast(error.message));
$('#filter').onchange=renderBlocks;$('#search').oninput=renderBlocks;$('#view-mode').onchange=updatePreview
for(const selector of ['#before-run','#after-run'])$(selector).onchange=()=>{historicalComparison=true;loadDetail().catch(error=>toast(error.message))}
$('#snapshot-run').onchange=()=>{historicalComparison=false;dirty=false;selectedId=null;$('#decision-editor').classList.add('hidden');$('#before-run').value='';$('#after-run').value='';loadDetail().catch(error=>toast(error.message))}
$('#history-toggle').onclick=()=>{const open=$('#run-history').classList.toggle('hidden')===false;$('#history-toggle').setAttribute('aria-expanded',String(open));if(!open&&historicalComparison){historicalComparison=false;loadDetail().catch(error=>toast(error.message))}};
$('#restore-default').onclick=()=>{historicalComparison=false;loadDetail().catch(error=>toast(error.message))};
$('#pin-baseline').onclick=async()=>{try{await api('/api/baseline-selection/'+pageId,{snapshotId:detail.snapshot.id,runId:detail.before.id});historicalComparison=false;await loadDetail();toast('已固定发布版基线，历史和裁决均保留')}catch(error){toast(error.message)}};
$('#discard-draft').onclick=()=>{const item=currentDrafts()[selectedId];if(!item||saving)return;drafts=clearSubmitted(drafts,pageId,detail.snapshot.id,[item]);persistDrafts();selectBlock(selectedId)};
$('#note').oninput=stageDecision;$('#save-decisions').onclick=()=>saveAllDecisions().catch(error=>toast(error.message))
window.addEventListener('message',event=>{if(event.source===$('#preview').contentWindow&&event.data?.kind==='reading-review-select')selectBlock(event.data.id)})
document.addEventListener('keydown',event=>{if(!pageId)return;if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();saveAllDecisions().catch(e=>toast(e.message));return}if(/input|textarea|select/i.test(event.target.tagName))return;if(selectedId&&['1','2','3','4'].includes(event.key)){verdict=['translate','exclude','either','pending'][Number(event.key)-1];stageDecision()}if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();saveAllDecisions().catch(e=>toast(e.message))}if(['j','k'].includes(event.key)){const blocks=filteredBlocks(),i=blocks.findIndex(b=>b.id===selectedId),next=blocks[i+(event.key==='j'?1:-1)];if(next)selectBlock(next.id)}})
await refresh().catch(error=>toast(error.message));if(location.hash&&state?.pages.some(p=>p.id===location.hash.slice(1)))await openPage(location.hash.slice(1))
new ResizeObserver(fitPreview).observe($('.frame-wrap'))
setInterval(()=>refresh().catch(error=>toast(error.message)),2500)
