/**
 * PDF rendering by headless Chromium — `ARCHITECTURE.md § 9`.
 *
 * > *"the PDF is produced by headless Chromium rendering the **same** template.
 * > One source, three surfaces, one `content_hash`."*
 *
 * This adapter is the "headless Chromium" half of that sentence, and it is
 * deliberately thin. It does not know what a receipt is, what fields it has or
 * how they are laid out — it takes the HTML the shared template produced and
 * prints it. Every decision about *what the document says* lives in
 * `renderReceiptTemplate`, which the UI calls too; anything this file decided
 * for itself would be a second opinion about the receipt, and a second opinion
 * is exactly what `INV-29` forbids.
 *
 * ## Why the PDF's bytes are not the receipt's identity
 *
 * Chromium stamps `/CreationDate` into every document it prints, so two
 * renderings of one receipt differ. That is not a problem to be engineered
 * around, because **the PDF is not what is hashed**. `content_hash` is the hash
 * of the canonical serialisation; the PDF is a rendering of the document that
 * hash identifies, and it carries that hash printed on the page.
 *
 * What `INV-48` requires of the PDF is therefore *generate-once, write-once* —
 * not *reproducible*. The object key is derived from the artifact's own id, the
 * store's only write is `putIfAbsent`, the row carrying the key is immutable,
 * and in a deployment the bucket policy denies overwrite on the prefix. Four
 * layers, none of which ever needed byte equality to work.
 *
 * ## Why the browser is reused
 *
 * A launch is one to two seconds; a page is a few milliseconds. Launching per
 * receipt would make issuing one artifact slower than settling the settlement it
 * belongs to. The instance is created lazily on first use and closed explicitly,
 * so a process that never issues a receipt never starts a browser.
 */
import { chromium, type Browser } from 'playwright-core'
import { renderReceiptTemplate, type ArtifactKind, type CanonicalValue } from '@inrsettle/domain'

export interface PdfRendererOptions {
  /**
   * Where the pinned Chromium lives. Supplied rather than discovered, because a
   * renderer that searched the filesystem for *a* browser would produce
   * documents whose layout depended on whatever it happened to find.
   */
  readonly executablePath?: string
  /**
   * Sandbox flags. Empty by default: Chromium's own sandbox should stay on
   * wherever the kernel allows it. Containers that cannot grant the required
   * namespaces pass `--no-sandbox` explicitly, so turning it off is always a
   * visible decision at a call site rather than a default nobody revisits.
   */
  readonly launchArgs?: readonly string[]
  /** A print that has not finished by now is a print that has hung. */
  readonly timeoutMs?: number
}

export interface ChromiumPdfRenderer {
  /** Render one artifact's template to PDF bytes. */
  render(
    artifact: { kind: ArtifactKind; document: Record<string, CanonicalValue> },
    contentHash: string,
  ): Promise<Uint8Array>
  /** The exact HTML that was printed, for the surface-parity assertion. */
  html(
    artifact: { kind: ArtifactKind; document: Record<string, CanonicalValue> },
    contentHash: string,
  ): string
  close(): Promise<void>
}

/**
 * The Chromium this deployment prints with, pinned by path.
 *
 * A different Chromium may lay a document out differently. That is survivable —
 * the identity of a receipt is its `content_hash`, not its pixels — but it
 * should still be a deliberate upgrade rather than a surprise, so the path is
 * configuration with one honest default for this image.
 */
export const DEFAULT_CHROMIUM_PATH =
  process.env['INRSETTLE_CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'

export function createChromiumPdfRenderer(
  options: PdfRendererOptions = {},
): ChromiumPdfRenderer {
  const executablePath = options.executablePath ?? DEFAULT_CHROMIUM_PATH
  const launchArgs = options.launchArgs ?? []
  const timeout = options.timeoutMs ?? 30_000

  let browser: Browser | null = null
  let launching: Promise<Browser> | null = null

  async function instance(): Promise<Browser> {
    if (browser?.isConnected()) return browser
    // One in-flight launch, however many callers arrive at once. Two concurrent
    // receipt issuances must not start two browsers and leak one.
    launching ??= chromium
      .launch({ executablePath, args: [...launchArgs] })
      .then((b) => {
        browser = b
        launching = null
        return b
      })
      .catch((error) => {
        launching = null
        throw error
      })
    return launching
  }

  return {
    html(artifact, contentHash) {
      return renderReceiptTemplate(artifact, contentHash)
    },

    async render(artifact, contentHash) {
      const page = await (await instance()).newPage()
      try {
        // `setContent` rather than a file or an http URL: the document is
        // self-contained, so there is nothing to fetch, and giving the browser
        // no origin to load from is the cheapest way to guarantee a receipt can
        // never depend on a network request completing.
        await page.setContent(renderReceiptTemplate(artifact, contentHash), {
          waitUntil: 'load',
          timeout,
        })
        return await page.pdf({
          format: 'A4',
          // `@page` in the template owns the margins; this makes the template's
          // own CSS authoritative rather than having two places set them.
          preferCSSPageSize: true,
          printBackground: true,
        })
      } finally {
        await page.close()
      }
    },

    async close() {
      const open = browser
      browser = null
      await open?.close()
    },
  }
}
