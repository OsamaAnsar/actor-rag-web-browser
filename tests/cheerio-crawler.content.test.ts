import type { Server } from 'node:http';

import { ImpitHttpClient } from '@crawlee/impit-client';
import { MemoryStorage } from '@crawlee/memory-storage';
import { RequestQueue } from 'apify';
import { CheerioCrawler, type CheerioCrawlingContext, Configuration, log } from 'crawlee';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ContentCrawlerTypes } from '../src/const.js';
import { createAndStartContentCrawler } from '../src/crawlers.js';
import { requestHandlerCheerio, TEXT_DOCUMENT_CONTENT_TYPES } from '../src/request-handler.js';
import type { ContentCrawlerUserData, Output, OutputFormats } from '../src/types.js';
import { createRequest } from '../src/utils.js';
import { MARKDOWN_DOCUMENT, PLAIN_TEXT_DOCUMENT, startTestServer, stopTestServer } from './helpers/server.js';

describe('Cheerio Crawler Content Tests', () => {
    let testServer: Server;
    const testServerPort = 3040;
    const baseUrl = `http://localhost:${testServerPort}`;

    // Start the test server before all tests
    beforeAll(async () => {
        testServer = startTestServer(testServerPort);
    });

    // Stop the test server after all tests
    afterAll(async () => {
        await stopTestServer(testServer);
    });

    it('test basic content extraction with cheerio', async () => {
        const failedUrls = new Set<string>();
        const successUrls = new Set<string>();

        // Create memory storage and request queue
        const client = new MemoryStorage({ persistStorage: false });
        const requestQueue = await RequestQueue.open('test-queue', { storageClient: client });

        const crawler = new CheerioCrawler({
            requestQueue,
            requestHandler: async (context: CheerioCrawlingContext<ContentCrawlerUserData>) => {
                const pushDataSpy = vi.spyOn(context, 'pushData').mockResolvedValue(undefined);
                await requestHandlerCheerio(context);

                expect(pushDataSpy).toHaveBeenCalledTimes(1);
                expect(pushDataSpy).toHaveBeenCalledWith(expect.objectContaining({
                    text: expect.stringContaining('hello world'),
                    metadata: expect.objectContaining({
                        title: 'Test Page',
                    }),
                }));
                successUrls.add(context.request.url);
            },
            failedRequestHandler: async ({ request }, error) => {
                log.error(`Request ${request.url} failed with error: ${error.message}`);
                failedUrls.add(request.url);
            },
        }, new Configuration({
            persistStorage: false,
        }));

        const r = createRequest(
            'query',
            {
                url: `${baseUrl}/basic`,
                description: 'Test request',
                rank: 1,
                title: 'Test title',
            },
            'responseId',
            {
                debugMode: false,
                outputFormats: ['text'],
                maxHtmlCharsToProcess: 100000,
                dynamicContentWaitSecs: 20,
            },
            [],
        );

        // Add initial request to the queue
        await requestQueue.addRequest(r);

        await crawler.run();

        expect(failedUrls.size).toBe(0);
        expect(successUrls.size).toBe(1);
    });

    // Runs the Cheerio request handler for one URL and returns the result it stores in the dataset.
    async function crawlAndGetResult(path: string, outputFormats: OutputFormats[]): Promise<Output> {
        const stored: Output[] = [];
        const client = new MemoryStorage({ persistStorage: false });
        const requestQueue = await RequestQueue.open(`test-queue-${path.replace(/\W/g, '-')}-${outputFormats.join('-')}`, { storageClient: client });

        const crawler = new CheerioCrawler({
            requestQueue,
            maxRequestRetries: 0,
            // As in the production crawler, which would otherwise reject these documents.
            additionalMimeTypes: TEXT_DOCUMENT_CONTENT_TYPES,
            requestHandler: async (context: CheerioCrawlingContext<ContentCrawlerUserData>) => {
                vi.spyOn(context, 'pushData').mockImplementation(async (data) => {
                    stored.push(data as Output);
                });
                await requestHandlerCheerio(context);
            },
        }, new Configuration({ persistStorage: false }));

        await requestQueue.addRequest(createRequest(
            'query',
            { url: `${baseUrl}${path}`, description: 'Test request', rank: 1, title: 'Test title' },
            'responseId',
            { debugMode: false, outputFormats, maxHtmlCharsToProcess: 100000, dynamicContentWaitSecs: 0 },
            [],
        ));
        await crawler.run();

        expect(stored).toHaveLength(1);
        return stored[0];
    }

    // A Markdown or plain text document has no HTML, so no links in it can be found the way they are on a page.
    describe.each([
        ['Markdown', '/agents.md', MARKDOWN_DOCUMENT],
        ['plain text', '/llms.txt', PLAIN_TEXT_DOCUMENT],
    ])('%s document', (_name, path, document) => {
        it('returns an empty `links` array when `links` is selected', async () => {
            const result = await crawlAndGetResult(path, ['markdown', 'html', 'links']);

            expect(result.links).toEqual([]);
            expect(result.markdown).toBe(document);
            expect(result.html).toBeNull();
        });

        it('returns an empty `links` array when only `links` is selected', async () => {
            const result = await crawlAndGetResult(path, ['links']);

            expect(result.links).toEqual([]);
            expect(result.markdown).toBeUndefined();
        });

        it('leaves `links` out when it is not selected', async () => {
            const result = await crawlAndGetResult(path, ['markdown', 'text', 'html']);

            expect(result.links).toBeUndefined();
            expect(result.markdown).toBe(document);
            expect(result.text).toBe(document);
            expect(result.html).toBeNull();
        });
    });

    it('test the crawler is created with the impit HTTP client', async () => {
        const { crawler } = await createAndStartContentCrawler(
            { type: ContentCrawlerTypes.CHEERIO, crawlerOptions: {} },
            false,
        );

        expect(Reflect.get(crawler!, 'httpClient')).toBeInstanceOf(ImpitHttpClient);
    });
});
