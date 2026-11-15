import { getTranslatableText } from '@/entrypoints/main/dom'
import { resolveAutoTranslationTarget } from '@/entrypoints/main/translationTarget/collect'
import { detectlang } from '@/entrypoints/utils/common'
declare const __REVIEW_BUILD__: object

Object.assign(window, { readReadingReviewExecution: (settings: { to: string; bidirectionalTranslation?: boolean; bidirectionalTarget?: string }) => {
  // Smart-mode diagnostic of the pinned source's language policy, without importing WXT storage.
  const state = (window as any).__readingReview
  state.execution = state.nodes.map((node: Element) => {
    const text = getTranslatableText(node)
    const sourceLang = detectlang(text.replace(/[\s\u3000]+/g, ' ').trim())
    const targetLang = settings.bidirectionalTranslation && settings.bidirectionalTarget && settings.bidirectionalTarget !== settings.to
      ? sourceLang === settings.to ? settings.bidirectionalTarget : settings.to : settings.to
    return { supported: node instanceof HTMLElement, connected: node.isConnected, hasText: Boolean(text.trim()),
      namespace: node.namespaceURI, sourceLang, targetLang, shouldTranslate: sourceLang !== targetLang }
  })
  return state.execution
}, collectReadingReview: () => {
  const state = (window as any).__readingReview
  const started = performance.now()
  const result = resolveAutoTranslationTarget('smart')
  const recordTarget = (node: Element, index: number) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
    const textIds: string[] = []
    let textNode: Node | null
    while ((textNode = walker.nextNode())) {
      const id = state.refs.get(textNode)
      if (id && getTranslatableText(textNode).trim()) textIds.push(id)
    }
    const decision = result.decisions.find(decision => decision.target === node)
    return { id: 'target-' + index, tag: node.localName, elementId: node.getAttribute('data-ot-review-node'), text: getTranslatableText(node).replace(/\s+/g, ' ').trim(), textIds, source: decision?.source ?? 'runtime-observed', reasons: decision?.reasons ?? [] }
  }
  const targets = result.nodes.map(recordTarget)
  state.nodes = result.nodes
  state.recordTarget = recordTarget
  return { build: __REVIEW_BUILD__, elapsedMs: performance.now() - started, stats: result.stats, targets }
} })
