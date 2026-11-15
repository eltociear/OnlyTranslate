export function paginate(items,page=1,pageSize=20) {
  const size=[10,20,50,100].includes(Number(pageSize))?Number(pageSize):20
  const total=items.length,pageCount=Math.max(1,Math.ceil(total/size))
  const current=Math.max(1,Math.min(pageCount,Number.isInteger(Number(page))?Number(page):1))
  const offset=(current-1)*size
  return {items:items.slice(offset,offset+size),page:current,pageSize:size,total,pageCount,start:total?offset+1:0,end:Math.min(offset+size,total)}
}

export const jobGroup=status=>status==='running'?'running':status==='queued'?'queued':'ended'
export const isEvaluationPage=page=>page.inputState?.state==='valid'
export function countJobs(jobs) {
  const counts={running:0,queued:0,ended:0}
  for(const job of jobs)counts[jobGroup(job.status)]++
  return counts
}
export function sortJobs(jobs) {
  const rank=job=>job.status==='running'?0:job.status==='queued'?1:2
  return [...jobs].sort((a,b)=>rank(a)-rank(b)||(rank(a)<2
    ?String(a.createdAt||'').localeCompare(String(b.createdAt||''))
    :String(b.finishedAt||b.createdAt||'').localeCompare(String(a.finishedAt||a.createdAt||'')))||String(a.id).localeCompare(String(b.id)))
}

export function renderPager(element,list,kind) {
  const key=JSON.stringify([list.total,list.page,list.pageSize])
  if(element.dataset.pagination===key)return
  const active=element.ownerDocument.activeElement
  const focus=element.contains(active)?active.hasAttribute('data-page-size')?'[data-page-size]':active.hasAttribute('data-page-select')?'[data-page-select]':`[data-page-action="${active.getAttribute('data-page-action')}"]`:null
  const label=kind==='pages'?'网页测试集':kind==='pending'?'采集受阻／待整理':'任务列表'
  const button=(text,action,page,disabled)=>`<button data-page-list="${kind}" data-page-action="${action}" data-page-number="${page}" ${disabled?'disabled':''}>${text}</button>`
  element.innerHTML=`<span class="muted" role="status">共 ${list.total} 项 · 当前 ${list.start}–${list.end} 项 · 第 ${list.page}/${list.pageCount} 页</span><div class="pagination-controls"><label>每页 <select data-page-size="${kind}" aria-label="${label}每页条数">${[10,20,50,100].map(size=>`<option ${size===list.pageSize?'selected':''}>${size}</option>`).join('')}</select> 项</label>${button('首页','first',1,list.page===1)}${button('上一页','previous',list.page-1,list.page===1)}<label>第 <select data-page-select="${kind}" aria-label="${label}页码">${Array.from({length:list.pageCount},(_,i)=>`<option ${i+1===list.page?'selected':''}>${i+1}</option>`).join('')}</select> 页</label>${button('下一页','next',list.page+1,list.page===list.pageCount)}${button('末页','last',list.pageCount,list.page===list.pageCount)}</div>`
  element.dataset.pagination=key
  if(focus){const replacement=element.querySelector(focus);if(replacement&&!replacement.disabled)replacement.focus()}
}
