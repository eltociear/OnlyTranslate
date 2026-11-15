// Processing provenance only: a marker does not prove the request has completed.
// Count original text positions covered by marked hosts, never matching by text alone.
export function translationCoverage(targets, observation) {
  if (targets.length !== observation.items.length) throw new Error('实翻观察与原始目标数量不匹配')
  const covered = new Set(observation.unexpectedTargets.flatMap(target => target.textIds))
  observation.items.forEach((item, index) => {
    if (typeof item.attempted !== 'boolean') throw new Error('实翻观察缺少处理状态')
    if (item.attempted) for (const id of targets[index].textIds) covered.add(id)
  })
  const coveredTargets = targets.filter((target, index) => observation.items[index].attempted
    || (target.textIds.length > 0 && target.textIds.every(id => covered.has(id)))).length
  const directlyAttempted = observation.items.filter(item => item.attempted).length
  return { coveredTargets, completedByCoveringHost: coveredTargets - directlyAttempted,
    coverageComplete: targets.length > 0 && coveredTargets === targets.length }
}

// Terminal skips end observation; only translated source coverage qualifies a baseline.
export function assessTranslation(targets, observation, execution) {
  if(targets.length!==execution.length)throw new Error('执行条件与原始目标数量不匹配')
  const processed=translationCoverage(targets,observation)
  // A processed marker is set before requests finish, and retry requests can have no spinner.
  // Keep it as provenance only. Qualification requires actual completed translation evidence.
  const completed=item=>!item.pending&&!item.failed&&typeof item.translation==='string'&&Boolean(item.translation.trim())
  const covered=new Set(observation.unexpectedTargets.filter(completed).flatMap(t=>t.textIds))
  observation.items.forEach((item,i)=>{if(item.attempted&&completed(item))targets[i].textIds.forEach(id=>covered.add(id))})
  const outcomes=observation.items.map((item,i)=>{
    const target=targets[i],rule=execution[i]
    if(item.failed)return 'failed'
    if(item.pending)return 'pending'
    if(item.attempted&&completed(item))return 'translated'
    if(target.textIds.length&&target.textIds.every(id=>covered.has(id)))return 'covered-by-host'
    if(rule.supported===false)return 'unsupported-element'
    if(rule.shouldTranslate===false)return 'skipped-target-language'
    if(rule.hasText===false)return 'skipped-empty-text'
    if(item.connected===false||rule.connected===false)return 'detached-target'
    if(!target.textIds.length)return 'unanchored-target'
    if(item.attempted)return 'unverified-completion'
    return 'waiting'
  })
  const counts=Object.fromEntries([...new Set(outcomes)].map(name=>[name,outcomes.filter(value=>value===name).length]))
  const coveredTargets=(counts.translated||0)+(counts['covered-by-host']||0)
  const coverageComplete=targets.length>0&&coveredTargets===targets.length
  const waiting=(counts.waiting||0)+(counts.pending||0)+(counts['unverified-completion']||0)
  const settled=waiting===0&&observation.pending===0
  return {processedTargets:processed.coveredTargets,coveredTargets,completedByCoveringHost:counts['covered-by-host']||0,coverageComplete,outcomes,counts,waiting,settled,
    complete:coverageComplete&&settled&&observation.failures===0,
    skipped:(counts['skipped-target-language']||0)+(counts['skipped-empty-text']||0),unsupported:counts['unsupported-element']||0}
}
