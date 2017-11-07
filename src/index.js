import puppeteer from 'puppeteer';
import cheerio from 'cheerio';
import Apify from 'apify';
import { typeCheck } from 'type-check';
import { isString } from 'lodash';

import PageScrapper from './scrap/page';
import parseMetadata from './parse/metadata';
import parseSchemaOrgData from './parse/schema-org';
import parseJsonLD from './parse/json-ld';
import DOMSearcher from './search/DOMSearcher';
import TreeSearcher from './search/TreeSearcher';
/* import CrawlerGenerator from './generate/Crawler'; */
import OutputGenerator from './generate/Output';
import { findCommonAncestors } from './utils';

// Definition of the input
const INPUT_TYPE = `{
    url: String,
    searchFor: Array
}`;

function timeoutPromised(timeout) {
    return new Promise((resolve) => {
        setTimeout(resolve, timeout);
    });
}

async function waitForEnd(output) {
    let done = output.get('analysisEnded');
    while (!done) {
        await timeoutPromised(100); // eslint-disable-line
        done = output.get('analysisEnded');
    }
    return done;
}

async function analysePage(browser, url, searchFor) {
    const output = new OutputGenerator();
    console.log('analysisStarted');
    output.set('analysisStarted', new Date());

    const scrappedData = {
        windowProperties: {},
        html: '<body></body>',
    };
    const scrapper = new PageScrapper(browser);

    scrapper.on('started', (data) => {
        console.log('scrapping started');
        scrappedData.loadingStarted = data;
        output.set('scrappingStarted', data.timestamp);
    });

    scrapper.on('loaded', (data) => {
        console.log('loaded');
        scrappedData.loadingFinished = data;
        output.set('pageNavigated', data.timestamp);
    });

    scrapper.on('initial-response', async (response) => {
        console.log('initial response');
        output.set('initialResponse', response.url);

        const html = response.responseBody;
        const treeSearcher = new TreeSearcher();
        try {
            const $ = cheerio.load(html);
            const metadata = parseMetadata({ $ });
            await output.set('metaDataParsed', true);
            await output.set('metaData', metadata);
            const foundMetadata = treeSearcher.find(metadata, searchFor);
            await output.set('metaDataFound', foundMetadata);
            console.log('metadata searched');
            await output.set('metadataSearched', new Date());

            const jsonld = parseJsonLD({ $ });
            await output.set('jsonLDDataParsed', true);
            await output.set('allJsonLDData', jsonld);
            const foundJsonLD = treeSearcher.find(jsonld, searchFor);
            await output.set('jsonLDDataFound', foundJsonLD);
            await output.set(
                'jsonLDData',
                findCommonAncestors(
                    jsonld,
                    foundJsonLD,
                ),
            );
            console.log('json-ld searched');
            await output.set('jsonLDSearched', new Date());

            const schemaOrgData = parseSchemaOrgData({ $ });
            await output.set('schemaOrgDataParsed', true);
            await output.set('allSchemaOrgData', schemaOrgData);
            const foundSchemaOrg = treeSearcher.find(schemaOrgData, searchFor);
            await output.set('schemaOrgDataFound', foundSchemaOrg);
            await output.set(
                'schemaOrgData',
                findCommonAncestors(
                    schemaOrgData,
                    foundSchemaOrg,
                ),
            );
            console.log('schema org searched');
            await output.set('schemaOrgSearched', new Date());
        } catch (error) {
            console.error('Intitial response parsing failed');
            console.error(error);
        }
    });

    scrapper.on('html', async (html) => {
        console.log('html');
        scrappedData.html = html;
        output.set('htmlParsed', true);
        // output.set('html', html);
        try {
            const $ = cheerio.load(scrappedData.html || '<body></body>');
            const domSearcher = new DOMSearcher({ $ });
            const foundSelectors = domSearcher.find(searchFor);
            await output.set('htmlFound', foundSelectors);
        } catch (error) {
            console.error('HTML search failed');
            console.error(error);
        }
        console.log('html searched');
        await output.set('htmlSearched', new Date());
    });

    scrapper.on('window-properties', async (properties) => {
        console.log('window properties');
        scrappedData.windowProperties = properties;
        output.set('windowPropertiesParsed', true);
        output.set('allWindowProperties', properties);
        // Evaluate non-native window properties

        const treeSearcher = new TreeSearcher();
        try {
            const foundWindowProperties = treeSearcher.find(scrappedData.windowProperties, searchFor);
            await output.set('windowPropertiesFound', foundWindowProperties);
            await output.set(
                'windowProperties',
                findCommonAncestors(
                    scrappedData.windowProperties,
                    foundWindowProperties,
                    true,
                ),
            );
            console.log('window properties searched');
        } catch (error) {
            console.error('Window properties parsing failed');
            console.error(error);
        }
        await output.set('windowPropertiesSearched', new Date());
    });

    scrapper.on('screenshot', (data) => {
        console.log('screenshot');
        output.set('screenshot', data);
    });

    scrapper.on('requests', async (requests) => {
        console.log('requests');
        scrappedData.xhrRequests = requests;
        output.set('xhrRequestsParsed', true);
        output.set('xhrRequests', requests);

        try {
            const treeSearcher = new TreeSearcher();
            const xhrRequestResults = [];
            requests.forEach(request => {
                let results;
                if (isString(request.responseBody)) {
                    const searcher = new DOMSearcher({ html: request.responseBody });
                    results = searcher.find(searchFor);
                } else {
                    results = treeSearcher.find(request.responseBody, searchFor);
                }
                if (results.length > 0) {
                    xhrRequestResults.push({
                        request: `${request.method} ${request.url}`,
                        response: request.responseBody,
                        searchResults: results,
                    });
                }
            });
            await output.set('xhrRequestsFound', xhrRequestResults);
            console.log('xhrRequests searched');
        } catch (err) {
            console.log('XHR Request search failed');
            console.error(err);
        }
        await output.set('xhrRequestsSearched', new Date());
    });

    scrapper.on('done', (data) => {
        console.log('scrapping finished');
        output.set('scrappingFinished', data.timestamp);
    });

    scrapper.on('page-error', (data) => {
        console.log('page error');
        scrappedData.pageError = data;
        output.set('pageError', data);
    });

    scrapper.on('error', (data) => {
        console.log('error');
        scrappedData.pageError = data;
        output.set('error', data);
    });

    try {
        await scrapper.start(url);
        // prevent act from closing before all data is asynchronously parsed and searched
        await waitForEnd(output);
    } catch (error) {
        console.error(error);
        try {
            await output.set('error', error);
        } catch (outputErr) {
            console.error(outputErr);
        }
    }
}

Apify.main(async () => {
    console.log('Analysing url from input');
    try {
        // Fetch the input and check it has a valid format
        // You don't need to check the input, but it's a good practice.
        const input = await Apify.getValue('INPUT');
        if (!typeCheck(INPUT_TYPE, input)) {
            console.log('Expected input:');
            console.log(INPUT_TYPE);
            console.log('Received input:');
            console.dir(input);
            throw new Error('Received invalid input');
        }

        const browser = await puppeteer.launch({ args: ['--no-sandbox'], headless: true });
        await analysePage(browser, input.url, input.searchFor);
    } catch (error) {
        console.error(error);
    }
});
