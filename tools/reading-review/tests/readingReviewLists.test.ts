import { afterEach, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Window } from 'happy-dom'
import { build } from 'vite'
import { paginate, countJobs, sortJobs, renderPager } from '../ui/lists.mjs'

const cleanups:(()=>Promise<unknown>)[]=[]
afterEach(async()=>{for(const close of cleanups.splice(0).reverse())await close()})

it('makes every entry reachable across pages and clamps empty or shortened lists',()=>{
  const items=Array.from({length:57},(_,i)=>i)
  expect([1,2,3].flatMap(page=>paginate(items,page).items)).toEqual(items)
  expect(paginate(items,99)).toMatchObject({page:3,pageCount:3,start:41,end:57})
  expect(paginate([],99)).toMatchObject({page:1,pageCount:1,total:0,start:0,end:0,items:[]})
  expect(paginate(items,-1,NaN)).toMatchObject({page:1,pageSize:20})
})

it('counts terminal states as ended and retains queue order without mutating the input',()=>{
  const jobs=['limited','queued','failed','running','complete','blocked','interrupted','queued'].map((status,i)=>({id:String(i),status,createdAt:'2026-11-15T00:00:0'+i+'Z'}))
  expect(countJobs(jobs)).toEqual({running:1,queued:2,ended:5})
  expect(sortJobs(jobs).map(job=>job.id)).toEqual(['3','1','7','6','5','4','2','0'])
  expect(jobs[0].status).toBe('limited')
})

it('keeps pager controls and keyboard focus during unchanged polling updates',async()=>{
  const window=new Window();cleanups.push(async()=>{await window.happyDOM.abort();window.close()})
  const element=window.document.createElement('nav');window.document.body.append(element)
  renderPager(element,paginate(Array(42).fill(0)),'jobs')
  const select=element.querySelector('select')!;select.focus()
  renderPager(element,paginate(Array(42).fill(0)),'jobs')
  expect(element.querySelector('select')).toBe(select)
  expect(window.document.activeElement).toBe(select)
  renderPager(element,paginate(Array(43).fill(0)),'jobs')
  expect(window.document.activeElement).toBe(element.querySelector('select'))
})

it('paginates both real UI lists independently, preserves polling position, and resets filtered pages',async()=>{
  const ui=resolve(import.meta.dirname,'../ui'),window=new Window({url:'http://127.0.0.1:4188',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}})
  cleanups.push(async()=>{await window.happyDOM.abort();window.close()})
  window.document.write(await readFile(resolve(ui,'index.html'),'utf8'))
  let poll!:()=>Promise<void>
  const pages=Array.from({length:45},(_,i)=>({id:'page-'+i,name:'Sample '+i,type:'文章',snapshotId:'snapshot-'+i,inputState:{state:'valid',valid:true},pageReview:{state:i<3?'confirmed':'unreviewed'},summary:{confirmed:0}}))
  const pending=[{...pages[0],id:'blocked',inputState:{state:'blocked',valid:false,reason:'HTTP 405',label:'采集受阻'}},{...pages[0],id:'uncaptured',inputState:{state:'missing',valid:false,reason:'尚未采集',label:'待采集'}},...Array.from({length:23},(_,i)=>({...pages[0],id:'pending-'+i,inputState:{state:'missing',valid:false,reason:'尚未采集',label:'待采集'}}))]
  const jobs=Array.from({length:57},(_,i)=>({id:'job-'+i,pageId:pages[i%pages.length].id,type:'candidate',status:i===0?'running':i<5?'queued':i%2?'limited':'blocked',createdAt:new Date(i*1000).toISOString(),message:'status '+i}))
  const state={pages:[...pages,...pending],jobs,release:{tag:'test'},dataRoot:'isolated',decisionsRoot:'isolated'}
  window.fetch=async(url:any,options:any)=>{
    expect(String(url)).toBe('/api/state');expect(options?.method||'GET').toBe('GET')
    return {ok:true,json:async()=>state} as any
  }
  window.setInterval=((callback:any)=>{poll=callback;return 1}) as any
  const bundle:any=await build({configFile:false,logLevel:'silent',build:{write:false,copyPublicDir:false,target:'esnext',minify:false,lib:{entry:resolve(ui,'app.js'),formats:['es']}}})
  const output=Array.isArray(bundle)?bundle[0].output:bundle.output
  await window.eval('(async()=>{'+output.find((item:any)=>item.type==='chunk').code+'})()')
  const doc=window.document,click=(selector:string)=>(doc.querySelector(selector) as any).click()
  const change=(selector:string,value:string)=>{const select=doc.querySelector(selector) as any;select.value=value;select.dispatchEvent(new window.Event('change',{bubbles:true}))}
  expect(doc.querySelectorAll('#page-list tbody tr')).toHaveLength(20)
  expect(doc.querySelectorAll('#jobs .job')).toHaveLength(20)
  expect(doc.querySelector('#pages-panel')?.classList.contains('hidden')).toBe(false)
  expect(doc.querySelector('#jobs-panel')?.classList.contains('hidden')).toBe(true)
  expect(doc.querySelector('#pages-tab')?.getAttribute('aria-selected')).toBe('true')
  expect(doc.querySelector('#jobs-tab')?.getAttribute('tabindex')).toBe('-1')
  expect(doc.querySelector('#metrics .metric strong')?.textContent).toBe('45')
  expect(doc.querySelector('#pages-tab-count')?.textContent).toBe('45')
  expect(doc.querySelector('#pending-tab-count')?.textContent).toBe('25')
  expect(doc.querySelector('#page-list [data-page="blocked"]')).toBeNull()
  click('#pending-tab')
  expect(doc.querySelectorAll('#pending-list tr.sample')).toHaveLength(20)
  expect(doc.querySelector('#pending-list')?.textContent).toContain('HTTP 405')
  click('#pending-pagination [data-page-action="next"]')
  expect(doc.querySelectorAll('#pending-list tr.sample')).toHaveLength(5)
  click('#pages-tab')
  expect(doc.querySelector('#job-counts')?.textContent).toContain('运行中 1 项　排队 4 项　已结束 52 项　共 57 项')
  expect(doc.querySelector('#jobs-tab-count')?.textContent).toBe('运行 1 · 排队 4')
  click('#pages-pagination [data-page-action="next"]')
  expect(doc.querySelector('#page-list tr.sample')?.getAttribute('data-page')).toBe('page-20')
  expect(doc.querySelector('#jobs-pagination')?.textContent).toContain('第 1/3 页')
  click('#jobs-tab')
  expect(doc.querySelector('#pages-panel')?.classList.contains('hidden')).toBe(true)
  expect(doc.querySelector('#jobs-panel')?.classList.contains('hidden')).toBe(false)
  const visited:string[]=[]
  for(let page=1;page<=3;page++){
    change('#jobs-pagination [data-page-select]',String(page))
    visited.push(...Array.from(doc.querySelectorAll('[data-job-log]'),node=>node.getAttribute('data-job-log')!))
  }
  expect(new Set(visited).size).toBe(57)
  await poll()
  expect(doc.querySelector('#jobs-tab')?.getAttribute('aria-selected')).toBe('true')
  expect(doc.querySelector('#pages-pagination')?.textContent).toContain('第 2/3 页')
  expect(doc.querySelector('#jobs-pagination')?.textContent).toContain('第 3/3 页')
  click('#pages-tab')
  expect(doc.querySelector('#pages-pagination')?.textContent).toContain('第 2/3 页')
  change('#page-review-filter','confirmed')
  expect(doc.querySelectorAll('#page-list tr.sample')).toHaveLength(3)
  expect(doc.querySelector('#pages-pagination')?.textContent).toContain('第 1/1 页')
  click('#jobs-tab')
  expect(doc.querySelector('#jobs-pagination')?.textContent).toContain('第 3/3 页')
  change('#job-status-filter','queued')
  expect(doc.querySelectorAll('#jobs .job')).toHaveLength(4)
  expect(doc.querySelector('#job-counts')?.textContent).toContain('共 57 项')
  expect(doc.querySelector('#jobs-pagination')?.textContent).toContain('第 1/1 页')
  click('#pages-tab')
  expect((doc.querySelector('#page-review-filter') as any).value).toBe('confirmed')
  change('#page-review-filter','all');change('#pages-pagination [data-page-size]','50')
  expect(doc.querySelectorAll('#page-list tr.sample')).toHaveLength(45)
  click('#jobs-tab')
  expect((doc.querySelector('#job-status-filter') as any).value).toBe('queued')
  change('#job-status-filter','all');change('#jobs-pagination [data-page-size]','100')
  expect(doc.querySelectorAll('#jobs .job')).toHaveLength(57)
  jobs[0].status='complete';await poll()
  expect(doc.querySelector('#job-counts')?.textContent).toContain('运行中 0 项　排队 4 项　已结束 53 项')
  expect(doc.querySelector('#jobs-tab-count')?.textContent).toBe('运行 0 · 排队 4')
  const key=(tab:string,key:string)=>(doc.querySelector(tab) as any).dispatchEvent(new window.KeyboardEvent('keydown',{key,bubbles:true}))
  key('#jobs-tab','ArrowLeft')
  expect(doc.activeElement).toBe(doc.querySelector('#pending-tab'))
  key('#pending-tab','Home')
  expect(doc.activeElement).toBe(doc.querySelector('#pages-tab'))
  expect(doc.querySelector('#pages-tab')?.getAttribute('aria-selected')).toBe('true')
  key('#pages-tab','End');expect(doc.activeElement).toBe(doc.querySelector('#jobs-tab'))
  key('#jobs-tab','ArrowRight');expect(doc.activeElement).toBe(doc.querySelector('#pages-tab'))
  window.fetch=async(url:any,options:any)=>{
    if(String(url)==='/api/candidate-all'){expect(options.method).toBe('POST');return{ok:true,json:async()=>({queued:[jobs[1]],skipped:[]})} as any}
    expect(String(url)).toBe('/api/state');return{ok:true,json:async()=>state} as any
  }
  click('#compare-all');await new Promise(resolve=>setImmediate(resolve))
  expect(doc.querySelector('#jobs-tab')?.getAttribute('aria-selected')).toBe('true')
  expect(doc.querySelector('#jobs-panel')?.classList.contains('hidden')).toBe(false)
  click('#pending-tab')
  expect(doc.querySelector('#pending-pagination')?.textContent).toContain('第 2/2 页')
  pending[0].inputState.state='valid';pending[0].inputState.valid=true;await poll()
  expect(doc.querySelector('#metrics .metric strong')?.textContent).toBe('46')
  expect(doc.querySelector('#pending-tab-count')?.textContent).toBe('24')
  click('#pages-tab')
  expect(doc.querySelector('#page-list [data-page="blocked"]')).not.toBeNull()
})

it('shows blocked capture status instead of old scores and disables review and translation actions',async()=>{
  const ui=resolve(import.meta.dirname,'../ui'),window=new Window({url:'http://127.0.0.1:4188',settings:{disableCSSFileLoading:true,disableJavaScriptFileLoading:true}})
  cleanups.push(async()=>{await window.happyDOM.abort();window.close()})
  window.document.write(await readFile(resolve(ui,'index.html'),'utf8'))
  const inputState={state:'blocked',valid:false,label:'采集受阻',reason:'验证码页面，需要有效正文快照'}
  const page={id:'blocked-page',name:'Archived article',url:'https://example.org',snapshotId:'snapshot-1',type:'文章',inputState,before:null,after:null,summary:null,
    pageReview:{state:'blocked',label:'采集受阻',reason:inputState.reason,canConfirm:false,canRevoke:false,validation:{state:'unavailable',label:'快照无效，无法评测',blockingBlocks:[]}}}
  const detail={page,snapshotId:'snapshot-1',snapshot:{id:'snapshot-1',viewport:{width:1440}},snapshots:[{id:'snapshot-1'}],inputState,before:null,after:null,summary:null,blocks:[],decisions:[],pageReview:page.pageReview,
    runs:[{id:'old-candidate',kind:'candidate',status:'invalid',recordedStatus:'complete',build:{commit:'7adaf68'},createdAt:'2026-01-01',validation:{source:'snapshot-input',valid:false}}]}
  const requests:string[]=[]
  window.fetch=async(url:any,options:any)=>{
    expect(options?.method||'GET').toBe('GET');requests.push(String(url))
    return {ok:true,json:async()=>String(url)==='/api/state'?{pages:[page],jobs:[],release:{tag:'test'}}:detail} as any
  }
  window.setInterval=(()=>1) as any
  const bundle:any=await build({configFile:false,logLevel:'silent',build:{write:false,copyPublicDir:false,target:'esnext',minify:false,lib:{entry:resolve(ui,'app.js'),formats:['es']}}})
  const output=Array.isArray(bundle)?bundle[0].output:bundle.output
  await window.eval('(async()=>{'+output.find((item:any)=>item.type==='chunk').code+'})()')
  const doc=window.document
  expect(doc.querySelector('#page-list tr.sample')).toBeNull()
  expect(doc.querySelector('#pending-list')?.textContent).toContain('采集受阻')
  expect(doc.querySelector('#page-list .state-added')).toBeNull()
  expect(doc.querySelector('#metrics .metric strong')?.textContent).toBe('0')
  ;(doc.querySelector('#pending-tab') as any).click()
  ;(doc.querySelector('tr.sample') as any).click();await new Promise(resolve=>setImmediate(resolve))
  expect(doc.querySelector('#snapshot-input-status')?.classList.contains('hidden')).toBe(false)
  expect(doc.querySelector('#snapshot-input-reason')?.textContent).toContain('验证码')
  expect(doc.querySelector('#current-candidate')?.textContent).toBe('不可用（采集受阻）')
  expect(doc.querySelector('#review-metrics')?.textContent).toContain('不计评测成绩')
  expect((doc.querySelector('#confirm-page-review') as any).disabled).toBe(true)
  expect((doc.querySelector('[data-job="baseline"]') as any).disabled).toBe(true)
  expect((doc.querySelector('[data-job="candidate"]') as any).disabled).toBe(true)
  expect((doc.querySelector('[data-job="capture"]') as any).disabled).toBe(false)
  expect(doc.querySelector('#snapshot-preview-unavailable')?.classList.contains('hidden')).toBe(false)
  expect((doc.querySelector('#after-run option[value="old-candidate"]') as any).disabled).toBe(true)
  expect(doc.querySelector('#after-run')?.textContent).toContain('无效快照，不计成绩')
  ;(doc.querySelector('#confirm-page-review') as any).click()
  expect(requests.every(url=>url.startsWith('/api/state')||url.startsWith('/api/pages/'))).toBe(true)
})
