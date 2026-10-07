import { load } from 'cheerio';
import type { CheerioAPI } from 'crawlee';
import { describe, expect, it } from 'vitest';

import { extractLinks, extractTitle, getDocumentBaseUrl } from '../src/website-content-crawler/html-processing.js';

// The `cheerio` version bundled with Crawlee differs from the top-level one, so the types don't match.
const parse = (html: string) => load(html) as unknown as CheerioAPI;

describe('extractTitle', () => {
    it('should extract the title from somewhere else if not in head', () => {
        const $ = parse(`<html>
            <head></head>
            <body>
                <div class="content">The part with the content.</div>
                <title>Title in body</title>
            </body>
        </html>`);
        expect(extractTitle($)).toBe('Title in body');
    });

    it('should ignore titles in SVGs anywhere in the html', () => {
        const $ = parse(`<html>
            <head><svg><title>Title in head svg</title></svg></head>
            <body>
                <div class="content">The part with the content.</div>
                <svg><title>Title in body svg</title></svg>
            </body>
        </html>`);
        expect(extractTitle($)).toBe('');
    });

    it('should ignore titles in .crawlee-iframe-replacement anywhere in the html', () => {
        const $ = parse(`<html>
            <head><div class="crawlee-iframe-replacement"><title>Title in head</title></div></head>
            <body>
                <div class="crawlee-iframe-replacement"><title>Title in .crawlee-iframe-replacement</title></div>
            </body>
        </html>`);
        expect(extractTitle($)).toBe('');
    });

    it('should trim surrounding whitespace', () => {
        const $ = parse('<html><head><title>\n   Test Title  \n</title></head><body></body></html>');
        expect(extractTitle($)).toBe('Test Title');
    });
});

describe('extractLinks', () => {
    const BASE = 'https://example.com/blog/post';

    it('resolves relative hrefs to absolute URLs against the base', () => {
        const $ = parse(`<body>
            <a href="/docs">a</a>
            <a href="../about">b</a>
            <a href="page.html?x=1#frag">c</a>
            <a href="https://other.example.org/x">d</a>
        </body>`);
        expect(extractLinks($, BASE)).toEqual([
            'https://example.com/docs',
            'https://example.com/about',
            'https://example.com/blog/page.html?x=1#frag',
            'https://other.example.org/x',
        ]);
    });

    it('de-duplicates while preserving first-appearance order', () => {
        const $ = parse(`<body>
            <a href="/b">b</a>
            <a href="/a">a1</a>
            <a href="https://example.com/b">b again</a>
            <a href="/a">a2</a>
        </body>`);
        expect(extractLinks($, BASE)).toEqual(['https://example.com/b', 'https://example.com/a']);
    });

    it('drops non-HTTP(S) schemes and bare same-page anchors', () => {
        const $ = parse(`<body>
            <a href="mailto:hi@example.com">mail</a>
            <a href="tel:+123">tel</a>
            <a href="javascript:void(0)">js</a>
            <a href="#section">anchor</a>
            <a href="#">top</a>
            <a href="ftp://example.com/f">ftp</a>
            <a href="/real">real</a>
        </body>`);
        expect(extractLinks($, BASE)).toEqual(['https://example.com/real']);
    });

    it('keeps hash-routing links of single-page apps and resolves them against the base', () => {
        const $ = parse(`<body>
            <a href="#section">anchor</a>
            <a href="#">top</a>
            <a href="#/quickstart">quickstart</a>
            <a href="#!/page">page</a>
            <a href="#/">home</a>
        </body>`);
        expect(extractLinks($, 'https://example.org/docs/v2/')).toEqual([
            'https://example.org/docs/v2/#/quickstart',
            'https://example.org/docs/v2/#!/page',
            'https://example.org/docs/v2/#/',
        ]);
    });

    it('resolves relative links against the document base URL', () => {
        const pageUrl = 'https://example.com/guide/concepts';
        const $ = parse(`<html><head><base href="https://example.org/docs/v2/"></head><body>
            <a href="intro">relative</a>
            <a href="../v1/intro">parent</a>
            <a href="/root">root</a>
            <a href="#/quickstart">hash route</a>
            <a href="https://other.example.net/x">absolute</a>
        </body></html>`);
        expect(extractLinks($, getDocumentBaseUrl($, pageUrl))).toEqual([
            'https://example.org/docs/v2/intro',
            'https://example.org/docs/v1/intro',
            'https://example.org/root',
            'https://example.org/docs/v2/#/quickstart',
            'https://other.example.net/x',
        ]);
    });

    it('resolves a relative document base against the page URL first', () => {
        const pageUrl = 'https://docs.example.com/guide/concepts';
        // A page script can add `<base href="/">`, after which `guide/concepts` points to `/guide/concepts`.
        const $ = parse('<html><head><base href="/"></head><body><a href="guide/concepts">concepts</a></body></html>');
        expect(extractLinks($, getDocumentBaseUrl($, pageUrl))).toEqual(['https://docs.example.com/guide/concepts']);
    });

    it('skips unrendered template hrefs', () => {
        const $ = parse(`<body>
            <a href="{{ item.url }}">tpl</a>
            <a href="/items/{{id}}">tpl2</a>
            <a href="/real">real</a>
        </body>`);
        expect(extractLinks($, BASE)).toEqual(['https://example.com/real']);
    });

    it('collects image map area links along with anchors, in document order', () => {
        const $ = parse(`<body>
            <a href="/first">first</a>
            <map name="m"><area href="/map-area" shape="rect" coords="0,0,1,1"><area shape="default" nohref></map>
            <a href="/map-area">dup</a>
            <a href="/last">last</a>
        </body>`);
        expect(extractLinks($, BASE)).toEqual([
            'https://example.com/first',
            'https://example.com/map-area',
            'https://example.com/last',
        ]);
    });

    it('ignores empty and unparseable hrefs and returns [] when there are no links', () => {
        expect(extractLinks(parse('<body><a href="">x</a><a href="   ">y</a></body>'), BASE)).toEqual([]);
        expect(extractLinks(parse('<body><a href="http://[::1">bad</a></body>'), BASE)).toEqual([]);
        expect(extractLinks(parse('<body><p>no links here</p></body>'), BASE)).toEqual([]);
    });
});

describe('getDocumentBaseUrl', () => {
    it('should resolve a relative base against the page URL', () => {
        const $ = parse('<html><head><base href="/docs/"></head><body></body></html>');
        expect(getDocumentBaseUrl($, 'https://example.com/a/b')).toBe('https://example.com/docs/');
    });
});
