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
    const urlsOf = ($: CheerioAPI, baseUrl: string) => extractLinks($, baseUrl).map((link) => link.url);

    it('resolves relative hrefs to absolute URLs against the base', () => {
        const $ = parse(`<body>
            <a href="/docs">a</a>
            <a href="../about">b</a>
            <a href="page.html?x=1#frag">c</a>
            <a href="https://other.example.org/x">d</a>
        </body>`);
        expect(urlsOf($, BASE)).toEqual([
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
        expect(urlsOf($, BASE)).toEqual(['https://example.com/b', 'https://example.com/a']);
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
        expect(urlsOf($, BASE)).toEqual(['https://example.com/real']);
    });

    it('keeps hash-routing links of single-page apps and resolves them against the base', () => {
        const $ = parse(`<body>
            <a href="#section">anchor</a>
            <a href="#">top</a>
            <a href="#/quickstart">quickstart</a>
            <a href="#!/page">page</a>
            <a href="#/">home</a>
        </body>`);
        expect(urlsOf($, 'https://example.org/docs/v2/')).toEqual([
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
        expect(urlsOf($, getDocumentBaseUrl($, pageUrl))).toEqual([
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
        expect(urlsOf($, getDocumentBaseUrl($, pageUrl))).toEqual(['https://docs.example.com/guide/concepts']);
    });

    it('skips unrendered template hrefs', () => {
        const $ = parse(`<body>
            <a href="{{ item.url }}">tpl</a>
            <a href="/items/{{id}}">tpl2</a>
            <a href="/real">real</a>
        </body>`);
        expect(urlsOf($, BASE)).toEqual(['https://example.com/real']);
    });

    it('collects image map area links along with anchors, in document order', () => {
        const $ = parse(`<body>
            <a href="/first">first</a>
            <map name="m"><area href="/map-area" shape="rect" coords="0,0,1,1"><area shape="default" nohref></map>
            <a href="/map-area">dup</a>
            <a href="/last">last</a>
        </body>`);
        expect(urlsOf($, BASE)).toEqual([
            'https://example.com/first',
            'https://example.com/map-area',
            'https://example.com/last',
        ]);
    });

    describe('link text', () => {
        it('takes the text of the anchor', () => {
            const $ = parse('<body><a href="/pricing">Pricing</a><a href="/docs"><b>Read</b> the <em>docs</em></a></body>');
            expect(extractLinks($, BASE)).toEqual([
                { url: 'https://example.com/pricing', text: 'Pricing' },
                { url: 'https://example.com/docs', text: 'Read the docs' },
            ]);
        });

        it('falls back to aria-label, title, alt and the alt of a nested image, in that order', () => {
            const $ = parse(`<body>
                <a href="/1" aria-label="From aria" title="From title"><svg></svg></a>
                <a href="/2" title="From title"><svg></svg></a>
                <a href="/3" alt="From alt"></a>
                <a href="/4"><img src="x.png" alt="From image"></a>
                <a href="/5" aria-label="Own text wins">Own text</a>
                <a href="/6"><svg></svg></a>
            </body>`);
            expect(extractLinks($, BASE)).toEqual([
                { url: 'https://example.com/1', text: 'From aria' },
                { url: 'https://example.com/2', text: 'From title' },
                { url: 'https://example.com/3', text: 'From alt' },
                { url: 'https://example.com/4', text: 'From image' },
                { url: 'https://example.com/5', text: 'Own text' },
                { url: 'https://example.com/6' },
            ]);
        });

        it('falls back when the anchor text is only whitespace', () => {
            const $ = parse('<body><a href="/x" title="Titled">  \n\t </a></body>');
            expect(extractLinks($, BASE)).toEqual([{ url: 'https://example.com/x', text: 'Titled' }]);
        });

        it('collapses whitespace and trims', () => {
            const $ = parse('<body><a href="/x">\n   Getting \t  started\n <span> now </span>  </a></body>');
            expect(extractLinks($, BASE)).toEqual([{ url: 'https://example.com/x', text: 'Getting started now' }]);
        });

        it('cuts the text to 200 characters', () => {
            const $ = parse(`<body><a href="/long">${'a'.repeat(250)}</a><a href="/exact">${'b'.repeat(200)}</a></body>`);
            const [long, exact] = extractLinks($, BASE);
            expect(long.text).toBe('a'.repeat(200));
            expect(exact.text).toBe('b'.repeat(200));
        });

        it('does not split an emoji when cutting the text', () => {
            // The emoji is a surrogate pair, whose first half would sit at index 199 of a UTF-16 cut.
            const $ = parse(`<body><a href="/x">${'a'.repeat(199)}😀tail</a></body>`);
            const [link] = extractLinks($, BASE);
            expect(link.text).toBe(`${'a'.repeat(199)}😀`);
            expect(Array.from(link.text!)).toHaveLength(200);
            // `encodeURIComponent` throws on a lone surrogate.
            expect(() => encodeURIComponent(link.text!)).not.toThrow();
        });

        it('leaves out the text key when there is no text', () => {
            const $ = parse('<body><a href="/a"></a><a href="/b" title="  "><img src="x.png" alt=""></a></body>');
            const links = extractLinks($, BASE);
            expect(links).toEqual([{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }]);
            for (const link of links) expect(link).not.toHaveProperty('text');
        });

        it('keeps the first non-empty text of a URL and the order of first appearance', () => {
            const $ = parse(`<body>
                <a href="/b"><img src="x.png"></a>
                <a href="/a">First a</a>
                <a href="https://example.com/b">Text for b</a>
                <a href="/a">Second a</a>
                <a href="/b">Another b</a>
            </body>`);
            expect(extractLinks($, BASE)).toEqual([
                { url: 'https://example.com/b', text: 'Text for b' },
                { url: 'https://example.com/a', text: 'First a' },
            ]);
        });

        it('uses the alt of an image map area', () => {
            const $ = parse('<body><map name="m"><area href="/map" alt="Map area" shape="rect" coords="0,0,1,1"></map></body>');
            expect(extractLinks($, BASE)).toEqual([{ url: 'https://example.com/map', text: 'Map area' }]);
        });

        it('keeps the text of a hash-routing link', () => {
            const $ = parse('<body><a href="#section">Skip</a><a href="#/quickstart">Quickstart</a></body>');
            expect(extractLinks($, BASE)).toEqual([{ url: 'https://example.com/blog/post#/quickstart', text: 'Quickstart' }]);
        });

        it('returns plain text, leaving out hidden code and not interpreting markup in the text', () => {
            const $ = parse(`<body><a href="/x">&lt;img src=x onerror=alert(1)&gt;
                <script>var secret = 1;</script><style>.a { color: red }</style> visible</a></body>`);
            expect(extractLinks($, BASE)).toEqual([
                { url: 'https://example.com/x', text: '<img src=x onerror=alert(1)> visible' },
            ]);
        });
    });

    it('ignores empty and unparseable hrefs and returns [] when there are no links', () => {
        expect(urlsOf(parse('<body><a href="">x</a><a href="   ">y</a></body>'), BASE)).toEqual([]);
        expect(urlsOf(parse('<body><a href="http://[::1">bad</a></body>'), BASE)).toEqual([]);
        expect(urlsOf(parse('<body><p>no links here</p></body>'), BASE)).toEqual([]);
    });
});

describe('getDocumentBaseUrl', () => {
    it('should resolve a relative base against the page URL', () => {
        const $ = parse('<html><head><base href="/docs/"></head><body></body></html>');
        expect(getDocumentBaseUrl($, 'https://example.com/a/b')).toBe('https://example.com/docs/');
    });
});
