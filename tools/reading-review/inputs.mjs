import { Window } from 'happy-dom'
import { join } from 'node:path'
import { readJson, validId } from './model.mjs'
import { replayPayload } from './replay.mjs'
import { toolError } from './errors.mjs'

// Serializable so live capture and frozen-input preflight use the same checks.
export function pageInputIssue(title, bodyText) {
  if (/^(?:just a moment|access denied|attention required|request for access|verify (?:you|your))/i.test(title||'')) return '访问验证或拒绝页面'
  if ((bodyText||'').length<4000 && /please complete the security check|completing the captcha proves|verify you are (?:a )?human|checking your browser|验证您是真人|请完成.*验证码/i.test(bodyText||'')) return '验证码页面'
  return null
}
export function inspectInputHTML(html,url) {
  const clean=html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi,'').replace(/<link\b[^>]*>/gi,'')
  const window=new Window({url,settings:{disableCSSFileLoading:true,disableJavaScriptEvaluation:true,disableJavaScriptFileLoading:true}})
  try {
    window.document.write(clean)
    window.document.querySelectorAll('style,noscript,template').forEach(n=>n.remove())
    return pageInputIssue(window.document.title,window.document.body.textContent||'')
  } finally { window.close() }
}
export async function requireSnapshotInput(p,pageId,snapshotId) {
  if(!validId(pageId)||!validId(snapshotId))throw toolError('MISSING_SNAPSHOT','尚无有效快照，请先采集页面')
  try {
    const snapshot=await readJson(join(p.snapshots,pageId,snapshotId,'snapshot.json'))
    if(snapshot.id!==snapshotId||snapshot.pageId!==pageId)throw new Error('快照身份不匹配')
    const validation=await readJson(join(p.snapshots,pageId,snapshotId,'validation.json'),null)
    if(validation?.valid===false)throw toolError('INPUT_BLOCKED',validation.reason||'快照已标记为无效')
    const payload=await replayPayload(p,pageId,snapshot,'')
    const issue=inspectInputHTML(payload.html,snapshot.url)
    if(issue)throw toolError('INPUT_BLOCKED',issue+'，需要有效正文快照',{snapshotId})
    return snapshot
  } catch(error) {
    if(error.code==='INPUT_BLOCKED')throw error
    throw toolError(error.code==='ENOENT'?'MISSING_SNAPSHOT':'INVALID_SNAPSHOT',error.message,{snapshotId})
  }
}
