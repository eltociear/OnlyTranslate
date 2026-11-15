// @vitest-environment node
import { expect, it } from 'vitest'
import { translationCoverage, assessTranslation } from '../completion.mjs'
import { execFileSync } from 'node:child_process'
import { createContext, runInContext } from 'node:vm'
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript'

it('accepts a marked parent that completely covers the original child targets', () => {
  expect(translationCoverage([{textIds:['t1']},{textIds:['t2','t3']}], {
    items:[{attempted:false},{attempted:false}], unexpectedTargets:[{textIds:['t1','t2','t3']}]
  })).toEqual({coveredTargets:2,completedByCoveringHost:2,coverageComplete:true})
})

it('keeps a partly covered child incomplete', () => {
  expect(translationCoverage([{textIds:['t1']},{textIds:['t2','t3']}], {
    items:[{attempted:true},{attempted:false}], unexpectedTargets:[{textIds:['t2']}]
  })).toEqual({coveredTargets:1,completedByCoveringHost:0,coverageComplete:false})
})

it('does not confuse repeated text at different original positions', () => {
  expect(translationCoverage([{textIds:['t1']},{textIds:['t2']}], {
    items:[{attempted:true},{attempted:false}], unexpectedTargets:[{textIds:['t1','t1']}]
  }).coverageComplete).toBe(false)
})

it('never qualifies an empty collection or an unmarked target without source anchors', () => {
  expect(translationCoverage([], {items:[],unexpectedTargets:[]}).coverageComplete).toBe(false)
  expect(translationCoverage([{textIds:[]}], {items:[{attempted:false}],unexpectedTargets:[{textIds:['unrelated']}]}).coverageComplete).toBe(false)
})

it('preserves directly processed targets that legitimately insert no translation', () => {
  expect(translationCoverage([{textIds:[]}], {items:[{attempted:true}],unexpectedTargets:[]}))
    .toEqual({coveredTargets:1,completedByCoveringHost:0,coverageComplete:true})
})

it('keeps a page incomplete when a covered child is accompanied by an unanchored unprocessed target', () => {
  expect(translationCoverage([{textIds:['t1']},{textIds:['t2']},{textIds:[]}], {
    items:[{attempted:true},{attempted:false},{attempted:false}], unexpectedTargets:[{textIds:['t2']}]
  })).toEqual({coveredTargets:2,completedByCoveringHost:1,coverageComplete:false})
})

it('rejects missing or misaligned observations', () => {
  expect(() => translationCoverage([{textIds:['t1']}], {items:[],unexpectedTargets:[]})).toThrow('数量不匹配')
  expect(() => translationCoverage([{textIds:['t1']}], {items:[{} as {attempted:boolean}],unexpectedTargets:[]})).toThrow('处理状态')
})

it('keeps LilLog unsupported targets and its unverified processed target out of completed coverage',()=>{
  const targets=Array.from({length:235},(_,i)=>({textIds:i<183?['t'+i]:[]}))
  const observation={items:targets.map((_,i)=>({attempted:i<183,translation:i<182?'译文':''})),unexpectedTargets:[],pending:0,failures:0}
  const execution=targets.map((_,i)=>({supported:i<183,shouldTranslate:true,hasText:true}))
  expect(assessTranslation(targets,observation,execution)).toMatchObject({processedTargets:183,coveredTargets:182,coverageComplete:false,settled:false,complete:false,skipped:0,unsupported:52,waiting:1})
})

it('records same-language skips as terminal non-success and keeps the raw denominator',()=>{
  const targets=[{textIds:['t1']},{textIds:['t2']}],observation={items:[{attempted:true,translation:'译文'},{attempted:false,translation:''}],unexpectedTargets:[],pending:0,failures:0}
  const result=assessTranslation(targets,observation,[{supported:true,shouldTranslate:true},{supported:true,shouldTranslate:false}])
  expect(result).toMatchObject({coveredTargets:1,settled:true,complete:false,skipped:1,unsupported:0})
  expect(result.outcomes).toEqual(['translated','skipped-target-language'])
})

it('does not finish while a supported English target or visible request is still pending',()=>{
  const targets=[{textIds:['t1']}],execution=[{supported:true,hasText:true,shouldTranslate:true}]
  expect(assessTranslation(targets,{items:[{attempted:false}],unexpectedTargets:[],pending:0,failures:0},execution)).toMatchObject({waiting:1,settled:false,complete:false})
  expect(assessTranslation(targets,{items:[{attempted:true,pending:true}],unexpectedTargets:[],pending:1,failures:0},execution)).toMatchObject({settled:false,complete:false})
})

it('does not let skips or failures qualify an empty or errored run',()=>{
  expect(assessTranslation([],{items:[],unexpectedTargets:[],pending:0,failures:0},[])).toMatchObject({settled:true,complete:false})
  expect(assessTranslation([{textIds:['t1']}],{items:[{attempted:true,failed:true}],unexpectedTargets:[],pending:0,failures:1},[{supported:true}])).toMatchObject({settled:true,complete:false,counts:{failed:1}})
})

it('requires completed translation evidence from covering hosts and keeps missing evidence unresolved',()=>{
  const targets=[{textIds:['t1']}],execution=[{supported:true,shouldTranslate:true,hasText:true}]
  const observation={items:[{attempted:false}],unexpectedTargets:[{textIds:['t1'],translation:''}],pending:0,failures:0}
  expect(assessTranslation(targets,observation,execution)).toMatchObject({coveredTargets:0,waiting:1,settled:false,complete:false})
  expect(assessTranslation(targets,{...observation,unexpectedTargets:[{textIds:['t1'],translation:'译文',pending:true}]},execution).complete).toBe(false)
  expect(assessTranslation(targets,{...observation,unexpectedTargets:[{textIds:['t1'],translation:'译文',failed:true}]},execution).complete).toBe(false)
  expect(assessTranslation(targets,{...observation,unexpectedTargets:[{textIds:['t1'],translation:'译文'}]},execution)).toMatchObject({coveredTargets:1,complete:true,counts:{'covered-by-host':1}})
})

it('does not count same-language or unsupported processed markers as completed translations',()=>{
  const targets=[{textIds:['t1']},{textIds:['t2']}]
  const result=assessTranslation(targets,{items:[{attempted:true,translation:''},{attempted:true,translation:''}],unexpectedTargets:[],pending:0,failures:0},[{supported:true,shouldTranslate:false},{supported:false,shouldTranslate:true}])
  expect(result).toMatchObject({coveredTargets:0,skipped:1,unsupported:1,complete:false})
})

it('keeps the pinned release protected-inline retry incomplete while its second request has no spinner',async()=>{
  const source=execFileSync('git',['show','65d20abd7af0aa55ae59ee57b515692bd941ca22:entrypoints/main/trans.ts'],{encoding:'utf8'})
  const start=source.indexOf('function bilingualTranslate('),end=source.indexOf('export function singleTranslate(',start)
  expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start)
  const code=transpileModule(source.slice(start,end),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.None}}).outputText
  let spinner=false,requests=0,finished=false,resolveRetry!:(value:string)=>void
  const context:any={Promise,setTimeout,getTranslatableText:()=> 'A scientific formula with protected content',captureTranslationAttempt:()=>({}),isFullPageTranslation:()=>false,
    getSmartInlineLinkResolver:()=>null,getCurrentTranslationScope:()=> 'smart',getTranslatableTextWithProtectedInline:()=>({text:'A scientific formula __ONLY_TRANSLATE_INLINE_0_token__',protectedInlines:[{}]}),
    getWebpageTranslationDirection:()=>({sourceLang:'en',targetLang:'zh-Hans',shouldTranslate:true}),insertLoadingSpinner:()=>{spinner=true;return{remove:()=>{spinner=false}}},
    getWebpagePromptContext:()=>null,translationState:{htmlSet:new Set()},translateText:()=>{requests++;return requests===1?Promise.resolve('malformed protected inline response'):new Promise(resolve=>{resolveRetry=resolve})},
    isTranslationAttemptCurrent:()=>true,renderTextWithProtectedInline:()=>null,bilingualAppendChild:()=>true,notifyDiagnosticVisible:()=>{},stopForInvalidatedExtensionContext:()=>false,isTranslationCancelledError:()=>false,
    insertFailedTip:()=>{throw new Error('unexpected failure')}}
  createContext(context);runInContext(code+'\nthis.subject=bilingualTranslate;',context)
  const pending=context.subject({},'<p>source</p>',{}).then(()=>{finished=true})
  try{
    await new Promise(resolve=>setImmediate(resolve))
    expect(requests).toBe(2);expect(spinner).toBe(false);expect(finished).toBe(false)
    const result=assessTranslation([{textIds:['t1']}],{items:[{attempted:true,translation:'',pending:spinner}],unexpectedTargets:[],pending:0,failures:0},[{supported:true,shouldTranslate:true,hasText:true}])
    expect(result).toMatchObject({coveredTargets:0,processedTargets:1,waiting:1,settled:false,complete:false,counts:{'unverified-completion':1}})
  }finally{resolveRetry('mock translated result');await pending}
})
