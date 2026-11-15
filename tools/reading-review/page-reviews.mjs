import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hash, validId, readJson, coverage, compare, summarize } from './model.mjs'

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const pageReviewsDir = decisionsDir => resolve(decisionsDir, '../page-reviews')
export const pageReviewFile = (decisionsDir, pageId) => join(pageReviewsDir(decisionsDir), pageId + '.json')
const selectedHash = ids => hash(JSON.stringify([...ids].sort()))
const expectationHash = (ids, unconstrained) => hash(JSON.stringify([[...ids].sort(), [...unconstrained].sort()]))
const validIds = ids => Array.isArray(ids) && ids.every(validId) && new Set(ids).size === ids.length
export const snapshotInputHash = snapshot => hash(JSON.stringify(snapshot))

export function reviewContextHash(pageId, snapshotId, decisions, acceptedIssues) {
  const latest = new Map(decisions.filter(d => d.snapshotId === snapshotId).map(d => [d.blockId, d]))
  const labels = [...latest.values()].sort((a,b) => a.blockId.localeCompare(b.blockId))
  const issues = acceptedIssues.filter(i => i.pageId === pageId && i.snapshotId === snapshotId).sort((a,b) => a.id.localeCompare(b.id))
  return hash(JSON.stringify([labels, issues]))
}

export function validatePageReviews(history, pageId) {
  if (!Array.isArray(history)) throw new Error('无效整页确认记录：' + pageId)
  let revision = 0
  const ids = new Set()
  for (const r of history) {
    if (![1,2].includes(r.schemaVersion) || r.scope !== 'smart' || r.pageId !== pageId || ![r.id,r.pageId,r.snapshotId,r.runId].every(validId)
      || ids.has(r.id) || !Number.isInteger(r.revision) || r.revision <= revision
      || !['confirmed','revoked'].includes(r.status) || r.reviewer !== 'user'
      || !Number.isInteger(r.specification) || r.specification < 1
      || ![r.htmlHash,r.inputHash,r.contextHash,r.coverageHash,r.sourceHash,r.bundleHash].every(digest)
      || !Array.isArray(r.selectedTextIds) || !r.selectedTextIds.every(validId)
      || new Set(r.selectedTextIds).size !== r.selectedTextIds.length || selectedHash(r.selectedTextIds) !== r.coverageHash
      || typeof r.recordedAt !== 'string' || !Number.isFinite(Date.parse(r.recordedAt))) {
      throw new Error('整页确认缺少有效身份、原文覆盖或用户记录：' + pageId)
    }
    if (r.schemaVersion === 2 && (!validIds(r.observedSelectedTextIds) || !validIds(r.unconstrainedTextIds)
      || !digest(r.observedCoverageHash) || selectedHash(r.observedSelectedTextIds) !== r.observedCoverageHash
      || !digest(r.expectationHash) || expectationHash(r.selectedTextIds,r.unconstrainedTextIds) !== r.expectationHash)) {
      throw new Error('整页期望缺少有效的原始结果或约束记录：' + pageId)
    }
    revision = r.revision; ids.add(r.id)
  }
  return history
}

export const latestPageReviews = history => [...new Map(history.map(r => [r.snapshotId,r])).values()]

function composeExpectation(snapshot, observed, decisions) {
  const expected = new Set(observed), unconstrained = new Set()
  const known = new Set(snapshot.catalogue.texts.map(t=>t.id))
  const labels = [...new Map(decisions.filter(d=>d.snapshotId===snapshot.id).map(d=>[d.blockId,d])).values()]
  for (const decision of labels) {
    const block = snapshot.catalogue.blocks.find(b=>b.id===decision.blockId)
    if (!block || hash(block.text)!==decision.textHash || !Array.isArray(block.textIds) || !block.textIds.length
      || block.textIds.some(id=>!known.has(id))) throw new Error('人工标注的原文定位需要先复核')
    for (const id of block.textIds) {
      if (decision.verdict === 'translate') expected.add(id)
      else if (decision.verdict === 'exclude') expected.delete(id)
      else unconstrained.add(id)
    }
  }
  return {selectedTextIds:[...expected].sort(),unconstrainedTextIds:[...unconstrained].sort()}
}

// Shared by the UI and fresh build checks. V1 records retain their original exact coverage.
export function comparePageExpectation(review, snapshot, run, decisions = [], acceptedIssues = []) {
  const known = new Set(snapshot.catalogue.texts.map(t=>t.id))
  const expected = new Set(review.selectedTextIds), actual = coverage(run)
  if ([...expected,...actual].some(id=>!known.has(id))) throw new Error('整页期望含未知原文定位')
  const ignored = new Set(review.schemaVersion===2 ? review.unconstrainedTextIds : [])
  if (review.schemaVersion===2) {
    if ([...review.observedSelectedTextIds,...ignored].some(id=>!known.has(id))) throw new Error('整页期望含未知原始结果或约束定位')
    const composed = composeExpectation(snapshot,review.observedSelectedTextIds,decisions)
    if (expectationHash(composed.selectedTextIds,composed.unconstrainedTextIds)!==review.expectationHash) throw new Error('整页期望与保存时的人工标注不一致，请重新评审')
  }
  const addedTextIds = [...actual].filter(id=>!expected.has(id)&&!ignored.has(id))
  const removedTextIds = [...expected].filter(id=>!actual.has(id)&&!ignored.has(id))
  const added = new Set(addedTextIds), removed = new Set(removedTextIds)
  const compared = compare(snapshot,null,{...run,snapshotId:snapshot.id},decisions,acceptedIssues)
  const changes = compared.filter(b=>b.textIds.some(id=>added.has(id)||removed.has(id))).map(block=>({
    blockId:block.id,text:block.text,added:block.textIds.filter(id=>added.has(id)),removed:block.textIds.filter(id=>removed.has(id)),
    acceptedIssue:review.schemaVersion===2 ? block.acceptedIssue : null,
    blocking:review.schemaVersion!==2 || !block.acceptedIssue,
  }))
  return {addedTextIds,removedTextIds,changes,blockingChanges:changes.filter(b=>b.blocking),acceptedChanges:changes.filter(b=>!b.blocking)}
}

function inputs(snapshot, run, decisions, acceptedIssues, specification) {
  if (!snapshot || !run || run.status !== 'complete') throw new Error('请先运行当前版，获得有效的目标结果')
  if (run.snapshotId !== snapshot.id || run.pageId !== snapshot.pageId || !validId(run.id) || !digest(run.build?.sourceHash) || !digest(run.bundleHash)) throw new Error('当前结果缺少有效运行身份')
  if (!digest(snapshot.htmlHash) || !Array.isArray(snapshot.catalogue?.texts) || !snapshot.catalogue.texts.length) throw new Error('快照缺少可核对的原文索引')
  if (!validId(snapshot.id)||!validId(snapshot.pageId)||snapshot.catalogue.texts.some(t=>!validId(t.id)||typeof t.text!=='string')) throw new Error('快照原文身份无效')
  if (!Number.isInteger(specification) || specification < 1) throw new Error('缺少有效标注规范版本')
  const known = new Set(snapshot.catalogue.texts.map(t => t.id))
  if (known.size !== snapshot.catalogue.texts.length || !Array.isArray(run.targets)
    || run.targets.some(t => !Array.isArray(t.textIds) || !t.textIds.length || t.textIds.some(id => !known.has(id)))) {
    throw new Error('有目标无法定位到原文，不能确认整页')
  }
  const selectedTextIds = [...coverage(run)].sort()
  const labels=[...new Map(decisions.filter(d=>d.snapshotId===snapshot.id).map(d=>[d.blockId,d])).values()]
  if(labels.some(d=>!['translate','exclude','either','pending'].includes(d.verdict)||d.confirmed!==(d.verdict!=='pending')||d.reviewer!=='user'))throw new Error('人工标注记录无效，请先复核')
  for(const d of labels.filter(d=>d.confirmed)){
    const block=snapshot.catalogue.blocks.find(b=>b.id===d.blockId)
    if(d.specification!==specification||d.reviewer!=='user'||!block||hash(block.text)!==d.textHash)throw new Error('逐块裁决的规范或原文定位需要先复核')
  }
  const compared = compare(snapshot,null,run,decisions,acceptedIssues), summary = summarize(compared)
  return { selectedTextIds, sourceIds:known,inputHash:snapshotInputHash(snapshot), coverageHash:selectedHash(selectedTextIds),
    contextHash:reviewContextHash(snapshot.pageId,snapshot.id,decisions,acceptedIssues), summary, compared,
    expectation:composeExpectation(snapshot,selectedTextIds,decisions) }
}

export function pageReviewState({snapshot,run,history=[],decisions=[],acceptedIssues=[],specification}) {
  const latest = history.findLast(r => r.snapshotId === snapshot?.id)
  const active = latest?.status === 'confirmed' ? latest : null
  const result = {state:'unreviewed',label:'本页待评审',reason:'只标有问题的地方，完成评审后保存本次结果结合人工标注的整页期望',needsSave:true,
    canConfirm:false,canRevoke:Boolean(active),latestReviewId:latest?.id||null,review:active?{id:active.id,recordedAt:active.recordedAt,runId:active.runId,selectedCount:active.selectedTextIds.length}:null,
    addedTextIds:[],removedTextIds:[],validation:{state:'unavailable',label:'尚无有效识别结果',blockingBlocks:[],violations:0,acceptedIssues:0}}
  if (!active && latestPageReviews(history).some(r => r.status==='confirmed')) {
    result.state='needs-review';result.label='新快照待评审';result.reason='之前保存的整页期望属于其他快照，不会自动沿用'
  }
  if (latest?.status==='revoked') result.reason='已撤销本快照的整页评审，历史和人工标注仍保留'
  let current
  try { current=inputs(snapshot,run,decisions,acceptedIssues,specification) }
  catch(error){return {...result,state:active?'needs-review':'unavailable',label:active?'待运行校验':'暂不能完成评审',reason:error.message}}
  Object.assign(result,{inputHash:current.inputHash,coverageHash:current.coverageHash,contextHash:current.contextHash,canConfirm:true})
  let differences
  if (active) {
    result.state='needs-review';result.label='评审需更新'
    if (active.inputHash!==current.inputHash || active.htmlHash!==snapshot.htmlHash) {
      result.reason='原快照内容或元数据改变，请恢复原记录或另采新快照';result.canConfirm=false
    } else if(active.selectedTextIds.some(id=>!current.sourceIds.has(id))){
      result.reason='整页确认中的原文定位失效，请先恢复有效记录';result.canConfirm=false
    } else if (active.specification!==specification) result.reason='标注规范版本变化，请按新口径重新评审'
    else if (active.contextHash!==current.contextHash) result.reason='人工标注或已接受限制已更新，请重新完成本页评审'
    else {
      try {
        differences=comparePageExpectation(active,snapshot,run,decisions,acceptedIssues)
        result.addedTextIds=differences.addedTextIds;result.removedTextIds=differences.removedTextIds
        result.state='confirmed';result.label='本页评审已完成'
        const ignored=new Set(current.expectation.unconstrainedTextIds)
        result.needsSave=active.schemaVersion===1
          ? current.expectation.unconstrainedTextIds.length>0||selectedHash(current.expectation.selectedTextIds)!==active.coverageHash
          : expectationHash(current.expectation.selectedTextIds.filter(id=>!ignored.has(id)),current.expectation.unconstrainedTextIds)!==expectationHash(active.selectedTextIds.filter(id=>!ignored.has(id)),active.unconstrainedTextIds)
        result.reason='整页期望已保存；正确的地方无需逐项点击，算法结果另行校验'
      } catch(error){result.reason=error.message;result.canConfirm=false}
    }
  }
  const blockingBlocks=[...new Set([...current.compared.filter(b=>b.blockingViolation).map(b=>b.id),...(differences?.blockingChanges||[]).map(b=>b.blockId)])]
  const violations=new Set([...current.compared.filter(b=>b.violation).map(b=>b.id),...(differences?.changes||[]).map(b=>b.blockId)]).size
  result.validation={state:blockingBlocks.length?'violations':violations?'accepted-known-issues':'passed',
    label:blockingBlocks.length?`当前结果有 ${blockingBlocks.length} 处待修复（阻断正式构建）`:violations?'含已接受的已知限制，不阻断发布':active?'当前结果符合整页期望':'完成评审后启用整页期望校验',
    blockingBlocks,violations,acceptedIssues:violations-blockingBlocks.length}
  if(!active&&blockingBlocks.length)result.reason='可以完成评审并保存人工期望；待修复问题继续阻断正式构建'
  return result
}

export function createPageReview({snapshot,run,history=[],decisions=[],acceptedIssues=[],specification}) {
  const current=inputs(snapshot,run,decisions,acceptedIssues,specification)
  const state=pageReviewState({snapshot,run,history,decisions,acceptedIssues,specification})
  if (!state.canConfirm) throw new Error(state.reason)
  return {schemaVersion:2,scope:'smart',id:randomUUID(),revision:(history.at(-1)?.revision||0)+1,pageId:snapshot.pageId,snapshotId:snapshot.id,
    htmlHash:snapshot.htmlHash,inputHash:current.inputHash,contextHash:current.contextHash,coverageHash:selectedHash(current.expectation.selectedTextIds),
    ...current.expectation,observedSelectedTextIds:current.selectedTextIds,observedCoverageHash:current.coverageHash,
    expectationHash:expectationHash(current.expectation.selectedTextIds,current.expectation.unconstrainedTextIds),
    specification,runId:run.id,sourceHash:run.build.sourceHash,bundleHash:run.bundleHash,
    status:'confirmed',reviewer:'user',recordedAt:new Date().toISOString()}
}

export async function loadPageReviews(decisionsDir,pageId) {
  return validatePageReviews(await readJson(pageReviewFile(decisionsDir,pageId),[]),pageId)
}
