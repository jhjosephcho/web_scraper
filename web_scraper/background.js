const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';

// Helper to create and manage the offscreen document
async function setupOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existingContexts.length > 0) {
        // console.log("Offscreen document already exists.");
        return;
    }
    // Ensure the API call is awaited
    await chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: [chrome.offscreen.Reason.DOM_PARSER],
        justification: 'To parse HTML of fetched pages for form and phone number analysis.',
    });
    // console.log("Offscreen document created.");
}

async function closeOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existingContexts.length > 0) {
        await chrome.offscreen.closeDocument();
        // console.log("Offscreen document closed.");
    }
}

async function analyzeHtmlViaOffscreen(htmlContent, pageUrl, baseOrigin) {
    try {
        await setupOffscreenDocument(); // Ensure it's open
        // The offscreen document will return an object like:
        // { formTypes: [...], phoneNumbers: [...], error: null }
        const result = await chrome.runtime.sendMessage({
            action: 'analyzeOffscreenHtml',
            target: 'offscreen-doc',
            html: htmlContent,
            pageUrl: pageUrl,
            baseOrigin: baseOrigin
        });
        return result;
    } catch (e) {
        console.error(`Error during offscreen analysis for ${pageUrl}:`, e);
        return { formTypes: null, phoneNumbers: null, error: e.message }; // Ensure consistent error structure
    }
}


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "analyzeRelatedPages") {
        const { urlsToAnalyze, baseOrigin } = request.data;
        if (!urlsToAnalyze || urlsToAnalyze.length === 0) {
            sendResponse({ status: "no_urls" });
            return true;
        }

        (async () => {
            // No need for allResults here if we send individual updates and popup reconstructs
            // let allResults = [];
            let fetchCounter = 0;
            for (const url of urlsToAnalyze) {
                let pageAnalysisData = { url: url, formTypes: null, phoneNumbers: null, error: null };

                try {
                    if (new URL(url).origin !== baseOrigin) {
                        console.warn(`Skipping fetch for ${url} as it's not on the same origin as ${baseOrigin}`);
                        pageAnalysisData.error = "Cross-origin fetch skipped";
                    } else {
                        console.log(`Fetching ${url}`);
                        const response = await fetch(url, {
                            headers: { 'User-Agent': 'ChromeExtension-WebsiteAnalyzer/1.1' }
                        });
                        if (!response.ok) {
                            throw new Error(`HTTP error! status: ${response.status}`);
                        }
                        const htmlText = await response.text();
                        // analysisResult will contain { formTypes, phoneNumbers, error }
                        const analysisResult = await analyzeHtmlViaOffscreen(htmlText, url, baseOrigin);

                        pageAnalysisData.formTypes = analysisResult.formTypes;
                        pageAnalysisData.phoneNumbers = analysisResult.phoneNumbers; // Store phone numbers
                        pageAnalysisData.error = analysisResult.error; // Store potential error from offscreen analysis
                    }
                } catch (error) {
                    console.error(`Failed to fetch or analyze ${url}:`, error);
                    pageAnalysisData.error = error.message;
                }

                // Send individual result back to popup, now including phoneNumbers
                chrome.runtime.sendMessage({
                    action: "relatedPageSingleResult",
                    data: pageAnalysisData // Send the whole object
                }).catch(e => console.warn("Error sending single result to popup:", e.message));

                fetchCounter++;
                if (fetchCounter === urlsToAnalyze.length) {
                    await closeOffscreenDocument(); // Close offscreen doc after all pages are processed
                }
            }
            console.log("All related page analyses attempted.");
        })();

        sendResponse({ status: "processing" });
        return true;
    }
    return true;
});

console.log("Background service worker started (v2 - with phone number handling).");
