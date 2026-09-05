/**
 * The receipt template — `ARCHITECTURE.md § 9`.
 *
 * > *"The canonical receipt is one serialisation in `packages/domain/receipts`.
 * > The UI renders it, the API returns it, and the PDF is produced by headless
 * > Chromium rendering the **same** template. One source, three surfaces, one
 * > `content_hash` (`INV-29`)."*
 *
 * That sentence is the whole design, and this file is the "same template" in it.
 * It is a pure function from an artifact's canonical document to HTML: the UI
 * renders this markup, and Chromium prints *this same markup* to PDF. Neither
 * surface has its own layout, its own field list or its own formatting, so
 * `INV-29`'s *"they cannot disagree"* is a property of the call graph rather
 * than of anybody's discipline.
 *
 * ## What is hashed, and what is not
 *
 * `content_hash` is the hash of the **canonical serialisation** — never of the
 * PDF bytes, and never of this HTML. The receipt is the document; the PDF is a
 * rendering of it. That distinction is what makes `INV-48`'s write-once
 * guarantee mean something durable: the identity of a receipt survives a change
 * of typeface, of paper size, or of Chromium version, because none of those
 * touch what was hashed.
 *
 * It also means the PDF's own bytes need not be reproducible, and they are not:
 * Chromium stamps `/CreationDate` into every document it prints. That is fine.
 * The PDF is generated **once** and written **once** (`INV-48`), and what makes
 * two people holding two copies able to agree is the `content_hash` printed on
 * the page, not a byte comparison of the files.
 *
 * ## What is deterministic
 *
 * This function. Same document, same bytes of HTML, every time — no clock, no
 * locale lookup, no random ordering. So the property worth testing lives here,
 * one level above the PDF: the *template render* is reproducible, and the two
 * surfaces are provably rendering the identical string.
 */
import { formatMoney, isCurrencyCode, type Money } from '@inrsettle/money'
import type { ArtifactKind, CanonicalValue } from './artifact.js'

/* ── Escaping ───────────────────────────────────────────────────────────── */

/**
 * Every value in a receipt is attacker-influenced somewhere upstream — a
 * beneficiary's display name is typed by a customer, a provider's return reason
 * is typed by a provider. This runs over all of them, without exception, and
 * there is no "trusted" path that skips it.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* ── Field presentation ─────────────────────────────────────────────────── */

/** `credited_at` → `Credited at`. The document's own field names, made legible. */
export function humanLabel(key: string): string {
  const spaced = key.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/**
 * A money object inside the canonical document, if that is what this is.
 *
 * The document stores money as `{currency, minor_units}` with the units as a
 * decimal string (`INV-04`). Recognising the shape lets the template render
 * `₹50,00,000.00` instead of two unlabelled rows — and it uses the money
 * package's own formatter, so the receipt groups digits the same way every
 * other surface does.
 */
function asMoney(value: CanonicalValue): Money | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, CanonicalValue>
  const currency = record['currency']
  const units = record['minor_units']
  if (typeof currency !== 'string' || !isCurrencyCode(currency)) return null
  if (typeof units !== 'string' && typeof units !== 'bigint') return null
  try {
    return { currency, minorUnits: BigInt(units) }
  } catch {
    return null
  }
}

/** Fields whose value is rendered verbatim in a monospace face. */
const HASH_FIELDS = new Set([
  'content_hash', 'receipt_content_hash', 'source_content_hash', 'authorized_terms_hash',
])

/** Fields the reader does not need and the plumbing does. */
const SUPPRESSED = new Set(['artifact', 'schema', 'workspace_id', 'environment'])

function renderValue(key: string, value: CanonicalValue, depth: number): string {
  if (value === null) return `<span class="empty">&mdash;</span>`

  const asMoneyValue = asMoney(value)
  if (asMoneyValue) {
    // Indian grouping for INR, international for everything else — the money
    // package's own rule, not a second opinion about it.
    const format = asMoneyValue.currency === 'INR' ? 'indian' : 'international'
    return `<span class="money">${escapeHtml(formatMoney(asMoneyValue, { format }))}</span>`
  }

  if (typeof value === 'bigint') return escapeHtml(value.toString())
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (typeof value === 'number') return escapeHtml(String(value))
  if (typeof value === 'string') {
    const cls = HASH_FIELDS.has(key) ? 'mono wrap' : 'value'
    return `<span class="${cls}">${escapeHtml(value)}</span>`
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="empty">None</span>`
    return `<div class="nested">${value
      .map((item, i) => renderRow(String(i + 1), item, depth + 1))
      .join('')}</div>`
  }

  const entries = Object.entries(value as Record<string, CanonicalValue>)
  return `<div class="nested">${entries
    .map(([k, v]) => renderRow(k, v, depth + 1))
    .join('')}</div>`
}

function renderRow(key: string, value: CanonicalValue, depth: number): string {
  const nested = value !== null && typeof value === 'object'
  return (
    `<div class="row${nested ? ' row-block' : ''}" data-field="${escapeHtml(key)}">` +
    `<div class="label">${escapeHtml(humanLabel(key))}</div>` +
    `<div class="field">${renderValue(key, value, depth)}</div>` +
    `</div>`
  )
}

/* ── The document ───────────────────────────────────────────────────────── */

const TITLES: Readonly<Record<ArtifactKind, string>> = {
  settlement_receipt: 'Settlement receipt',
  return_notice: 'Return notice',
  receipt_composite: 'Settlement receipt and return notices',
}

/**
 * Print-oriented CSS.
 *
 * Self-contained on purpose: no font file, no stylesheet link, no image. A
 * template with an external reference is a template whose rendering depends on
 * a network fetch succeeding at print time, and a receipt that renders
 * differently because a CDN was slow is a receipt nobody can rely on. The
 * fallback stack is system fonts, which every platform has.
 */
const STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 40px;
  font: 10.5px/1.55 -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color: #16181d; background: #fff;
}
header { border-bottom: 2px solid #16181d; padding-bottom: 12px; margin-bottom: 20px; }
h1 { margin: 0; font-size: 17px; letter-spacing: -0.01em; }
.subject { margin-top: 4px; font-size: 11px; color: #5a6070; }
.row { display: flex; gap: 16px; padding: 4px 0; align-items: baseline; }
.row-block { display: block; padding-top: 10px; }
.label { flex: 0 0 190px; color: #5a6070; }
.row-block > .label {
  flex: none; font-weight: 600; color: #16181d; text-transform: uppercase;
  font-size: 9px; letter-spacing: 0.07em; margin-bottom: 4px;
  border-bottom: 1px solid #e3e6ec; padding-bottom: 4px;
}
.field { flex: 1 1 auto; min-width: 0; }
.nested { margin-left: 0; }
.nested .label { flex-basis: 174px; }
.money { font-variant-numeric: tabular-nums; font-weight: 600; }
.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 9.5px; }
.wrap { overflow-wrap: anywhere; }
.empty { color: #9aa1b1; }
footer {
  margin-top: 24px; padding-top: 12px; border-top: 1px solid #e3e6ec;
  font-size: 9.5px; color: #5a6070;
}
footer .mono { display: block; margin-top: 3px; color: #16181d; }
@page { size: A4; margin: 14mm; }
@media print { body { padding: 0; } }
`

/**
 * Render an artifact's canonical document as the receipt template.
 *
 * `contentHash` is printed on the document it is the hash *of*. That is what
 * lets a person holding the paper check it against the API's answer — which is
 * the practical content of `INV-29`, and the reason the hash belongs on the page
 * rather than only in a database column.
 */
export function renderReceiptTemplate(
  artifact: { kind: ArtifactKind; document: Record<string, CanonicalValue> },
  contentHash: string,
): string {
  const doc = artifact.document
  const subject = typeof doc['settlement_id'] === 'string' ? doc['settlement_id'] : ''
  const rows = Object.entries(doc)
    .filter(([key]) => !SUPPRESSED.has(key))
    .map(([key, value]) => renderRow(key, value, 0))
    .join('')

  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    `<title>${escapeHtml(TITLES[artifact.kind])}</title>` +
    `<style>${STYLE}</style></head><body>` +
    `<header><h1>${escapeHtml(TITLES[artifact.kind])}</h1>` +
    (subject ? `<div class="subject">Settlement ${escapeHtml(subject)}</div>` : '') +
    '</header>' +
    `<main>${rows}</main>` +
    '<footer>This document is identified by the hash of its canonical serialisation.' +
    `<span class="mono">${escapeHtml(contentHash)}</span></footer>` +
    '</body></html>'
  )
}
