import type { CheerioAPI } from 'crawlee';
import { log } from 'crawlee';
import type { Element } from 'domhandler';

import type { ContentScraperSettings, Link, OpenGraphProperty } from '../types.js';
import { readableText } from './text-extractor.js';

const SKIP_CHILD_OF_ELEMENT_SELECTORS = ['.crawlee-iframe-replacement *', 'svg *'].join(', ');
const TITLE_SELECTORS = [
    `head > title:not(${SKIP_CHILD_OF_ELEMENT_SELECTORS})`,
    `title:not(${SKIP_CHILD_OF_ELEMENT_SELECTORS})`,
];

const OPEN_GRAPH_PREFIXES = ['og:', 'article:', 'book:', 'profile:', 'video:', 'website:', 'twitter:'];
const OPEN_GRAPH_SELECTOR = OPEN_GRAPH_PREFIXES.map((prefix) => `meta[property^="${prefix}"]`).join(', ');

/**
 * Extracts the page title (source: Website Content Crawler).
 *
 * Prefers the `<title>` in `<head>` and ignores `<title>` elements nested in SVGs
 * (used there as tooltips) or in Crawlee iframe replacement nodes.
 */
export function extractTitle($: CheerioAPI): string {
    for (const selector of TITLE_SELECTORS) {
        const title = $(selector).first().text().trim();
        if (title) {
            return title;
        }
    }
    return '';
}

export function getDocumentBaseUrl($: CheerioAPI, pageUrl: string): string {
    const href = $('base[href]').first().attr('href');
    if (!href) return pageUrl;

    try {
        return new URL(href, pageUrl).href;
    } catch {
        return pageUrl;
    }
}

export function extractCanonicalUrl($: CheerioAPI, baseUrl: string): string | undefined {
    const href = $('html > head > link[rel="canonical"]').first().attr('href');
    if (!href) return undefined;

    try {
        const url = new URL(href, baseUrl);
        if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {
        // Handled by the log below.
    }

    log.debug(`Ignoring the canonical link of ${baseUrl}, which is not an HTTP(S) URL: ${href}`);
    return undefined;
}

/**
 * A bare same-page anchor (`#section`, `#`) points into the page we already have. Hash-routing links of
 * single-page apps (`#/quickstart`, `#!/page`) are navigation, so they are not anchors.
 */
const isSamePageAnchor = (href: string) => href.startsWith('#') && !/^#[!/]/.test(href);

/** The text of a link is cut to this many characters, so that a link wrapping a whole card stays short. */
const MAX_LINK_TEXT_LENGTH = 200;

/** Elements whose content is code or markup that is not shown, even when they sit inside a link. */
const NON_VISIBLE_TEXT_SELECTOR = 'script, style, noscript, template';

/** Collapses whitespace and cuts to `MAX_LINK_TEXT_LENGTH` characters (code points, so that no emoji is split). */
function normalizeLinkText(text: string | undefined): string {
    const collapsed = (text ?? '').replace(/\s+/g, ' ').trim();
    return Array.from(collapsed).slice(0, MAX_LINK_TEXT_LENGTH).join('').trim();
}

/**
 * The visible text of a link, falling back to its accessible names for icon and image links: the
 * `aria-label`, `title` and `alt` attributes, and the `alt` of an image inside it. The result is plain text.
 */
function extractLinkText($: CheerioAPI, element: Element): string {
    const $el = $(element);
    const getVisibleText = () => {
        const $copy = $el.clone();
        $copy.find(NON_VISIBLE_TEXT_SELECTOR).remove();
        return $copy.text();
    };
    const candidates = [
        getVisibleText,
        () => $el.attr('aria-label'),
        () => $el.attr('title'),
        () => $el.attr('alt'),
        () => $el.find('img[alt]').first().attr('alt'),
    ];

    for (const candidate of candidates) {
        const text = normalizeLinkText(candidate());
        if (text) return text;
    }
    return '';
}

/**
 * Collects every `<a href>` and image map `<area href>` on the page as a de-duplicated list of links, with
 * absolute HTTP(S) URLs resolved against `baseUrl` and the visible text of the link when it has any.
 * Non-HTTP(S) schemes (`mailto:`, `tel:`, `javascript:`, …), unparseable hrefs, bare same-page anchors
 * (`#section`) and unrendered template hrefs (`{{ item.url }}`) are dropped. Hash-routing links (`#/page`,
 * `#!/page`) are kept. Order of first appearance is preserved, and a URL that appears more than once keeps
 * the first non-empty text.
 */
export function extractLinks($: CheerioAPI, baseUrl: string): Link[] {
    const links = new Map<string, Link>();

    for (const element of $('a[href], area[href]').get()) {
        const href = $(element).attr('href')?.trim();
        if (!href || isSamePageAnchor(href) || href.includes('{{')) continue;

        let url: URL;
        try {
            url = new URL(href, baseUrl);
        } catch {
            // Ignore hrefs that don't resolve to a valid URL.
            continue;
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;

        const text = extractLinkText($, element);
        const existing = links.get(url.href);
        if (!existing) {
            links.set(url.href, text ? { url: url.href, text } : { url: url.href });
        } else if (!existing.text && text) {
            existing.text = text;
        }
    }

    return [...links.values()];
}

export function extractOpenGraphProperties($: CheerioAPI): OpenGraphProperty[] | undefined {
    const properties = $(OPEN_GRAPH_SELECTOR).get().flatMap((element) => {
        const property = $(element).attr('property');
        const content = $(element).attr('content');
        return property && content ? [{ property, content }] : [];
    });

    return properties.length > 0 ? properties : undefined;
}

/**
 * Extracts the JSON-LD structured data of the page (source: Website Content Crawler).
 */
export function extractJsonLd($: CheerioAPI): unknown[] | undefined {
    const items = $('script[type="application/ld+json"]').get().flatMap((element) => {
        try {
            return [JSON.parse($(element).text())];
        } catch {
            log.debug('Skipping a JSON-LD script that does not contain valid JSON.');
            return [];
        }
    });

    return items.length > 0 ? items : undefined;
}

/**
 * Process HTML with the selected HTML transformer (source: Website Content Crawler).
 */
export async function processHtml(
    html: string | null,
    url: string,
    settings: ContentScraperSettings,
    $: CheerioAPI,
): Promise<string> {
    const $body = $('body').clone();
    if (settings.removeElementsCssSelector) {
        $body.find(settings.removeElementsCssSelector).remove();
    }
    const simplifiedBody = $body.html()?.trim();
    const title = extractTitle($);

    const simplified = typeof simplifiedBody === 'string'
        ? `<html lang="">
        <head>
            <title>
                ${title}
            </title>
        </head>
        <body>
            ${simplifiedBody}
        </body>
    </html>`
        : (html ?? '');

    let ret = null;
    if (settings.htmlTransformer === 'readableText') {
        try {
            ret = await readableText({ html: simplified, url, options: { fallbackToNone: true } });
        } catch (error) {
            log.warning(`Processing of HTML failed with error:`, { error });
        }
    }
    return ret ?? (simplified as string);
}
