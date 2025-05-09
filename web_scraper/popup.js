document.addEventListener('DOMContentLoaded', () => {
    // --- Get references to DOM elements ---
    const analyzeBtn = document.getElementById('analyzeBtn');
    const urlInput = document.getElementById('urlInput');
    const analysisOutputDiv = document.getElementById('analysisOutput');
    const loadingStatusDiv = document.getElementById('loadingStatus');
    const copyResultsBtn = document.getElementById('copyResultsBtn');
    const draftNextStepsBtn = document.getElementById('draftNextStepsBtn');
    const nextStepsOutputDiv = document.getElementById('nextStepsOutput');
    const copyNextStepsBtn = document.getElementById('copyNextStepsBtn');

    // --- State variables ---
    let aggregatedData = {}; // Stores combined results from current and related pages
    let relatedPagesToProcess = 0;
    let relatedPagesProcessed = 0;
    let currentAnalyzedUrl = ''; // Store the URL that was analyzed

    // --- Function to reset state before a new analysis ---
    function resetAnalysisState() {
        aggregatedData = {
            gtm: null,
            ga4: null,
            adsConversionIds: new Set(),
            bingUET: null,
            callTracking: new Set(),
            chatPlatforms: new Set(),
            platform: null,
            privacyPolicy: null,
            formTypes: new Set(),
            phoneNumbers: new Set(),
            errors: [],
        };
        relatedPagesToProcess = 0;
        relatedPagesProcessed = 0;
        currentAnalyzedUrl = '';
        analysisOutputDiv.innerHTML = "<p>Click \"Analyze\" to see website details.</p>";
        loadingStatusDiv.textContent = "";
        copyResultsBtn.style.display = 'none';
        copyResultsBtn.textContent = 'Copy Results';
        copyResultsBtn.removeAttribute('data-clipboard-text');
        draftNextStepsBtn.style.display = 'none';
        nextStepsOutputDiv.style.display = 'none';
        nextStepsOutputDiv.innerHTML = '';
        copyNextStepsBtn.style.display = 'none';
        copyNextStepsBtn.removeAttribute('data-clipboard-text');
        copyNextStepsBtn.textContent = 'Copy Next Steps';
    }

    // --- Initial setup ---
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].url && !tabs[0].url.startsWith('chrome://') && !tabs[0].url.startsWith('about:')) {
            urlInput.value = tabs[0].url;
        }
    });

    // --- Analyze Button Event Listener ---
    analyzeBtn.addEventListener('click', () => {
        resetAnalysisState();
        analysisOutputDiv.innerHTML = "<p>Analyzing current page...</p>";
        loadingStatusDiv.textContent = "Starting analysis...";

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs[0];
            if (!activeTab || !activeTab.id || !activeTab.url) {
                analysisOutputDiv.innerHTML = "<p>Error: Could not get active tab or URL.</p>";
                loadingStatusDiv.textContent = "Error.";
                return;
            }
            currentAnalyzedUrl = activeTab.url;

            if (activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('about:')) {
                analysisOutputDiv.innerHTML = `<p>Cannot analyze special browser pages (e.g., ${activeTab.url.split('/')[0]}/...). Please navigate to a website.</p>`;
                loadingStatusDiv.textContent = "Error.";
                return;
            }

            chrome.scripting.executeScript(
                {
                    target: { tabId: activeTab.id },
                    func: runPageAnalysisAndFindRelated
                },
                (injectionResults) => {
                    if (chrome.runtime.lastError) {
                        console.error("Error executing script: " + chrome.runtime.lastError.message);
                        analysisOutputDiv.innerHTML = `<p>Error: Could not analyze the page. ${chrome.runtime.lastError.message}.</p>`;
                        loadingStatusDiv.textContent = "Error.";
                        copyResultsBtn.style.display = 'none';
                        draftNextStepsBtn.style.display = 'none';
                        return;
                    }

                    analysisOutputDiv.innerHTML = ""; // Clear "Analyzing..."

                    if (injectionResults && injectionResults[0] && injectionResults[0].result) {
                        const resultData = injectionResults[0].result;

                        if (resultData.error) {
                            console.error("Error from current page analysis script:", resultData.error);
                            aggregatedData.errors.push(`Error on current page (${escapeHTML(activeTab.url)}): ${escapeHTML(resultData.error.message || 'Unknown error')}`);
                        }

                        // Process current page data into aggregatedData
                        if (resultData.currentPageAnalysis) {
                            const currentPageData = resultData.currentPageAnalysis;
                            aggregatedData.gtm = currentPageData.gtm;
                            aggregatedData.ga4 = currentPageData.ga4;
                            currentPageData.adsConversionIds?.forEach(id => aggregatedData.adsConversionIds.add(id));
                            aggregatedData.bingUET = currentPageData.bingUET;
                            currentPageData.callTracking?.forEach(ct => aggregatedData.callTracking.add(ct));
                            currentPageData.chatPlatforms?.forEach(cp => aggregatedData.chatPlatforms.add(cp));
                            aggregatedData.platform = currentPageData.platform;
                            aggregatedData.privacyPolicy = currentPageData.privacyPolicy;
                            currentPageData.formTypes?.forEach(ft => aggregatedData.formTypes.add(ft));
                            currentPageData.phoneNumbers?.forEach(pn => aggregatedData.phoneNumbers.add(pn)); // Includes refined numbers
                        }

                        loadingStatusDiv.textContent = "Current page analysis complete.";

                        if (resultData.relatedPages && resultData.relatedPages.length > 0) {
                            const uniqueRelatedPages = resultData.relatedPages.filter(url => url !== activeTab.url);
                            relatedPagesToProcess = uniqueRelatedPages.length;

                            if (relatedPagesToProcess === 0) {
                                displayAggregatedResults();
                                loadingStatusDiv.textContent = "Analysis complete. No new related pages to analyze.";
                                return;
                            }

                            loadingStatusDiv.textContent += ` Found ${relatedPagesToProcess} related page(s). Fetching and analyzing...`;
                            chrome.runtime.sendMessage(
                                {
                                    action: "analyzeRelatedPages",
                                    data: {
                                        urlsToAnalyze: uniqueRelatedPages,
                                        baseOrigin: new URL(activeTab.url).origin
                                    }
                                },
                                (response) => {
                                    if (chrome.runtime.lastError) {
                                        console.error("Error sending message to background:", chrome.runtime.lastError.message);
                                        aggregatedData.errors.push(`Error starting related page analysis: ${escapeHTML(chrome.runtime.lastError.message)}`);
                                        relatedPagesToProcess = 0;
                                        displayAggregatedResults();
                                        loadingStatusDiv.textContent = "Error with related page analysis.";
                                    } else if (response && response.status === "processing") {
                                        console.log("Background script is processing related pages.");
                                        if(relatedPagesProcessed < relatedPagesToProcess) {
                                            loadingStatusDiv.textContent = `Analyzing ${relatedPagesToProcess} related pages...`;
                                        }
                                    } else {
                                        console.warn("Unexpected response from background for related pages:", response);
                                        if (relatedPagesProcessed >= relatedPagesToProcess) {
                                            displayAggregatedResults();
                                            loadingStatusDiv.textContent = "All analyses attempted.";
                                        }
                                    }
                                }
                            );
                        } else {
                            displayAggregatedResults();
                            loadingStatusDiv.textContent = "Analysis complete. No related pages found.";
                        }
                    } else {
                        analysisOutputDiv.innerHTML = "<p>No results returned from current page analysis.</p>";
                        loadingStatusDiv.textContent = "Analysis failed or no results.";
                        copyResultsBtn.style.display = 'none';
                        draftNextStepsBtn.style.display = 'none';
                        console.log("Injection results (may contain errors):", injectionResults);
                    }
                }
            );
        });
    });

    // --- Listener for messages from background script ---
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "relatedPageSingleResult") {
            const pageData = message.data;

            pageData.formTypes?.forEach(ft => aggregatedData.formTypes.add(ft));
            pageData.phoneNumbers?.forEach(pn => aggregatedData.phoneNumbers.add(pn));
            if (pageData.error) {
                aggregatedData.errors.push(`Error on ${escapeHTML(pageData.url)}: ${escapeHTML(pageData.error)}`);
            }

            relatedPagesProcessed++;
            loadingStatusDiv.textContent = `Processed ${relatedPagesProcessed} of ${relatedPagesToProcess} related pages...`;

            if (relatedPagesProcessed >= relatedPagesToProcess) {
                displayAggregatedResults(); // Display final results
                loadingStatusDiv.textContent = "All analyses complete.";
            }
        }
        return true; // Keep message channel open for async responses
    });

    // --- Function to display the aggregated results ---
    function displayAggregatedResults() {
        analysisOutputDiv.innerHTML = ""; // Clear previous content

        // Build plain text version for clipboard first
        let clipboardText = `Analysis for: ${currentAnalyzedUrl}\n\n`;
        clipboardText += `Google Tag Manager: ${aggregatedData.gtm || 'Not found'}\n`;
        clipboardText += `Google Analytics 4 (GA4): ${aggregatedData.ga4 || 'Not found'}\n`;
        clipboardText += `Google Ads Conversion/Remarketing IDs: ${aggregatedData.adsConversionIds.size > 0 ? Array.from(aggregatedData.adsConversionIds).join(', ') : 'Not found'}\n`;
        clipboardText += `Bing UET Tag ID: ${aggregatedData.bingUET || 'Not found'}\n`;
        clipboardText += `Call Tracking: ${aggregatedData.callTracking.size > 0 ? Array.from(aggregatedData.callTracking).join(', ') : 'Not found'}\n`;
        clipboardText += `Chat Platforms: ${aggregatedData.chatPlatforms.size > 0 ? Array.from(aggregatedData.chatPlatforms).join(', ') : 'Not found'}\n`;
        clipboardText += `Website Platform: ${aggregatedData.platform || 'Unknown'}\n`;
        clipboardText += `Privacy Policy: ${aggregatedData.privacyPolicy || 'Not found'}\n`;
        clipboardText += `Forms Found (across analyzed pages): ${aggregatedData.formTypes.size > 0 ? Array.from(aggregatedData.formTypes).join(', ') : 'None detected'}\n`;
        clipboardText += `Phone Numbers Found (across analyzed pages): ${aggregatedData.phoneNumbers.size > 0 ? Array.from(aggregatedData.phoneNumbers).join(', ') : 'None found'}\n`;

        if (aggregatedData.errors.length > 0) {
            clipboardText += `\nErrors During Analysis:\n`;
            aggregatedData.errors.forEach(err => {
                clipboardText += `- ${err}\n`;
            });
        }

        // Build HTML version for display
        let contentHTML = "";
        contentHTML += `<p><strong>Google Tag Manager:</strong> ${escapeHTML(aggregatedData.gtm) || 'Not found'}</p>`;
        contentHTML += `<p><strong>Google Analytics 4 (GA4):</strong> ${escapeHTML(aggregatedData.ga4) || 'Not found'}</p>`;
        contentHTML += `<p><strong>Google Ads Conversion/Remarketing IDs:</strong> ${aggregatedData.adsConversionIds.size > 0 ? Array.from(aggregatedData.adsConversionIds).map(escapeHTML).join(', ') : 'Not found'}</p>`;
        contentHTML += `<p><strong>Bing UET Tag ID:</strong> ${escapeHTML(aggregatedData.bingUET) || 'Not found'}</p>`;
        contentHTML += `<p><strong>Call Tracking:</strong> ${aggregatedData.callTracking.size > 0 ? Array.from(aggregatedData.callTracking).map(escapeHTML).join(', ') : 'Not found'}</p>`;
        contentHTML += `<p><strong>Chat Platforms:</strong> ${aggregatedData.chatPlatforms.size > 0 ? Array.from(aggregatedData.chatPlatforms).map(escapeHTML).join(', ') : 'Not found'}</p>`;
        contentHTML += `<p><strong>Website Platform:</strong> ${escapeHTML(aggregatedData.platform) || 'Unknown'}</p>`;
        contentHTML += `<p><strong>Privacy Policy:</strong> ${
            aggregatedData.privacyPolicy ?
                (aggregatedData.privacyPolicy.startsWith('http') ?
                    `<a href="${escapeHTML(aggregatedData.privacyPolicy)}" target="_blank">${escapeHTML(aggregatedData.privacyPolicy)}</a>`
                    : escapeHTML(aggregatedData.privacyPolicy))
                : 'Not found'
        }</p>`;
        contentHTML += `<p><strong>Forms Found (across analyzed pages):</strong> ${aggregatedData.formTypes.size > 0 ? Array.from(aggregatedData.formTypes).map(escapeHTML).join(', ') : 'None detected'}</p>`;
        contentHTML += `<p><strong>Phone Numbers Found (across analyzed pages):</strong> ${aggregatedData.phoneNumbers.size > 0 ? Array.from(aggregatedData.phoneNumbers).map(n => `<code>${escapeHTML(n)}</code>`).join('<br>') : 'None found'}</p>`;

        if (aggregatedData.errors.length > 0) {
            contentHTML += `<hr style="margin: 10px 0;"><h4>Errors During Analysis:</h4>`;
            aggregatedData.errors.forEach(err => {
                contentHTML += `<p style="color:red; font-size:0.9em;">- ${err}</p>`;
            });
        }
        analysisOutputDiv.innerHTML = contentHTML;
        copyResultsBtn.style.display = 'block'; // Show the copy button
        draftNextStepsBtn.style.display = 'block'; // Show the next steps button
        copyResultsBtn.dataset.clipboardText = clipboardText.trim(); // Store plain text
    }

    // --- Copy Button Event Listener ---
    copyResultsBtn.addEventListener('click', () => {
        const textToCopy = copyResultsBtn.dataset.clipboardText;
        if (textToCopy && navigator.clipboard) {
            navigator.clipboard.writeText(textToCopy).then(() => {
                const originalText = copyResultsBtn.textContent;
                copyResultsBtn.textContent = 'Copied!';
                copyResultsBtn.disabled = true;
                setTimeout(() => {
                    copyResultsBtn.textContent = originalText;
                    copyResultsBtn.disabled = false;
                }, 1500);
            }).catch(err => {
                console.error('Failed to copy text: ', err);
                loadingStatusDiv.textContent = 'Failed to copy results!';
                setTimeout(() => { loadingStatusDiv.textContent = ''; }, 2000);
            });
        } else {
            console.error('Clipboard API not available or no text to copy.');
            loadingStatusDiv.textContent = 'Copy failed.';
            setTimeout(() => { loadingStatusDiv.textContent = ''; }, 2000);
        }
    });

    // --- Draft Next Steps Button Event Listener ---
    draftNextStepsBtn.addEventListener('click', () => {
        generateNextSteps();
    });

    // --- Generate Next Steps Function ---
    function generateNextSteps() {
        const steps = [];
        const url = currentAnalyzedUrl || urlInput.value || '[Website URL]';
        let stepCounter = 1;

        if (aggregatedData.ga4 && !aggregatedData.ga4.includes('Not found')) {
            steps.push(`${stepCounter}. Please provide the Google Analytics account name and invite manager3@searchkings.ca with Editor level access to ${escapeHTML(aggregatedData.ga4)} associated with ${escapeHTML(url)}:\nIn Google Analytics: Gear Icon (Admin - bottom left) → Account Access Management → Plus Button (top right) → Add Users → Enter manager3@searchkings.ca → Select Editor → Add`);
            stepCounter++;
        }
        if (aggregatedData.gtm && !aggregatedData.gtm.includes('Not found')) {
            steps.push(`${stepCounter}. Please add manager3@searchkings.ca with admin / publish access to the Google Tag Manager (${escapeHTML(aggregatedData.gtm)}) account associated with ${escapeHTML(url)}. If you prefer our team to do this for you, please provide the login information for the Google Tag Manager account.`);
            stepCounter++;
        }
        const platform = aggregatedData.platform || '';
        const isCustom = platform.toLowerCase().includes('custom') || platform.toLowerCase().includes('unknown') || platform === '';
        if (platform && !isCustom) {
            const basePlatform = platform.split(' (')[0];
            steps.push(`${stepCounter}. Please share the ${escapeHTML(basePlatform)} admin login information or add searchkingcanada@gmail.com as an admin user for ${escapeHTML(url)} so we can install the tracking codes. If you prefer to install them yourself please let me know, and we will send them to you.`);
            stepCounter++;
        }
        if (aggregatedData.chatPlatforms.size > 0) {
            const chatPlatformList = Array.from(aggregatedData.chatPlatforms).map(p => p.split(' (')[0]).join(' / ');
            steps.push(`${stepCounter}. Please send us the ${escapeHTML(chatPlatformList)} login credentials. We would like to see if we can set up tracking for the chat function on the website.`);
            stepCounter++;
        }
        if (!aggregatedData.privacyPolicy || aggregatedData.privacyPolicy === 'Not found') {
            steps.push(`${stepCounter}. Please add a Privacy Policy page/statement on ${escapeHTML(url)}. Since you are collecting visitor information you risk being suspended by Google by not displaying one clearly on your website.`);
            stepCounter++;
        }

        if (steps.length > 0) {
            const nextStepsText = steps.join('\n\n');
            nextStepsOutputDiv.innerHTML = steps.map(s => `<p>${s.replace(/\n/g, '<br>')}</p>`).join('');
            nextStepsOutputDiv.style.display = 'block';
            copyNextStepsBtn.style.display = 'block';
            copyNextStepsBtn.dataset.clipboardText = nextStepsText;
        } else {
            nextStepsOutputDiv.innerHTML = '<p>No specific next steps identified based on analysis.</p>';
            nextStepsOutputDiv.style.display = 'block';
            copyNextStepsBtn.style.display = 'none';
        }
    }

     // --- Copy Next Steps Button Event Listener ---
     copyNextStepsBtn.addEventListener('click', () => {
        const textToCopy = copyNextStepsBtn.dataset.clipboardText;
        if (textToCopy && navigator.clipboard) {
            navigator.clipboard.writeText(textToCopy).then(() => {
                const originalText = copyNextStepsBtn.textContent;
                copyNextStepsBtn.textContent = 'Copied!';
                copyNextStepsBtn.disabled = true;
                setTimeout(() => {
                    copyNextStepsBtn.textContent = originalText;
                    copyNextStepsBtn.disabled = false;
                }, 1500);
            }).catch(err => {
                console.error('Failed to copy next steps text: ', err);
                loadingStatusDiv.textContent = 'Failed to copy steps!';
                setTimeout(() => { loadingStatusDiv.textContent = ''; }, 2000);
            });
        } else {
            console.error('Clipboard API not available or no text to copy for next steps.');
            loadingStatusDiv.textContent = 'Copy failed.';
            setTimeout(() => { loadingStatusDiv.textContent = ''; }, 2000);
        }
    });


    // --- HTML Escaping Function ---
    function escapeHTML(str) {
        if (str === null || str === undefined) return '';
        const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        return str.toString().replace(/[&<>"']/g, (match) => map[match]);
    }

    // ===============================================================================
    // MAIN ANALYSIS FUNCTION (INJECTED INTO PAGE)
    // Updated extractPhoneNumbers function
    // ===============================================================================
    function runPageAnalysisAndFindRelated() {
        // --- Helper Functions ---
        function getScriptContent(scriptElement) { return scriptElement.innerHTML || ''; }
        function checkForGTM() { /* ... Full GTM logic ... */
             const scripts = Array.from(document.getElementsByTagName('script')); const gtmScriptTag = scripts.find(script => script.src && script.src.includes('googletagmanager.com/gtm.js')); if (gtmScriptTag && gtmScriptTag.src) { const gtmIdMatch = gtmScriptTag.src.match(/id=([^&]+)/); if (gtmIdMatch && gtmIdMatch[1]) return gtmIdMatch[1]; } if (window.dataLayer && Array.isArray(window.dataLayer)) { for (const item of window.dataLayer) { if (item && typeof item === 'object' && item.event === 'gtm.js' && item['gtm.start']) { try { if (typeof arguments !== 'undefined' && arguments && arguments.length > 1 && typeof arguments[1] === 'string' && arguments[1].startsWith('GTM-')) return arguments[1]; } catch (e) {/*ignore*/} for (const dlItem of window.dataLayer) { if (Array.isArray(dlItem) && dlItem.length > 1 && typeof dlItem[1] === 'string' && dlItem[1].startsWith('GTM-')) return dlItem[1]; } return 'GTM detected (dataLayer initialization)'; } if (Array.isArray(item) && item.length > 1 && typeof item[1] === 'string' && item[1].startsWith('GTM-')) return item[1]; } } if (document.querySelector('iframe[src*="googletagmanager.com/ns.html"]') || document.querySelector('script[src*="googletagmanager.com/gtm.js"]')) { return 'GTM likely present (found related elements/scripts)'; } return null;
        }
        function checkForGA4() { /* ... Full GA4 logic (latest broad version) ... */
            const scripts = Array.from(document.getElementsByTagName('script')); let ga4Id = null; const ga4IdPattern = /(G-[A-Z0-9]+)/i; for (const script of scripts) { for (const attr of script.attributes) { if (attr.value && attr.value.includes('googletagmanager.com/gtag/js')) { const idMatch = attr.value.match(/id=(G-[A-Z0-9]+)/i); if (idMatch && idMatch[1]) return idMatch[1]; if (!ga4Id) ga4Id = "gtag.js loaded"; } } } for (const script of scripts) { let scriptContent = getScriptContent(script); const delayedInlineId = script.getAttribute('data-two_delay_id'); if (!scriptContent && delayedInlineId && window.two_worker_data_js?.js) { const delayedScriptData = window.two_worker_data_js.js.find(item => item.uid === delayedInlineId && item.inline); if (delayedScriptData?.code) { try { scriptContent = decodeURIComponent(atob(delayedScriptData.code)); } catch (e) { console.warn("Could not decode delayed script:", delayedInlineId, e); scriptContent = ''; } } } if (scriptContent) { let match = scriptContent.match(/gtag\s*\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)['"]\s*(?:,\s*\{[^}]*\})?\s*\)\s*;/i); if (match && match[1]) return match[1] + (delayedInlineId ? " (Delayed Inline)" : ""); match = scriptContent.match(ga4IdPattern); if (match && match[1]) { if (!ga4Id || ga4Id === "gtag.js loaded") { ga4Id = match[1] + (delayedInlineId ? " (ID in Delayed Inline)" : " (ID in Inline Script)"); } } } } if (ga4Id && ga4Id !== "gtag.js loaded") return ga4Id; if (window.dataLayer && Array.isArray(window.dataLayer)) { for (const item of window.dataLayer) { if (Array.isArray(item) && item.length >= 2 && item[0] === 'config' && typeof item[1] === 'string' && item[1].startsWith('G-')) return item[1]; if (typeof item === 'object' && item !== null && item[0] === 'config' && typeof item[1] === 'string' && item[1].startsWith('G-')) return item[1]; if (JSON.stringify(item).match(ga4IdPattern)) { const match = JSON.stringify(item).match(ga4IdPattern); if (match && match[1]) { if (!ga4Id || ga4Id === "gtag.js loaded") { ga4Id = match[1] + " (ID in dataLayer)"; } } } } } if (ga4Id && ga4Id !== "gtag.js loaded") return ga4Id; if (typeof window.gtag === 'function' && window.google_tag_manager) { for (const containerId in window.google_tag_manager) { if (Object.prototype.hasOwnProperty.call(window.google_tag_manager, containerId) && containerId.startsWith('G-') && window.google_tag_manager[containerId]?.dataLayer?.gtagConfig) return containerId; } } return ga4Id;
         }
        function checkForAdsConversion(scriptSources) { /* ... Full Ads Conversion logic (collects multiple) ... */
            const adsIds = new Set(); const adsIdPattern = /(AW-\d{9,11})/gi; const legacyIdPattern = /(\d{9,11})/; let legacyScriptFound = false; if (scriptSources && scriptSources.length > 0) { for (const src of scriptSources) { if (!src) continue; let match = src.match(/googleads\.g\.doubleclick\.net\/pagead\/viewthroughconversion\/(\d{9,11})/i); if (match && match[1]) { adsIds.add(`AW-${match[1]}`); } match = src.match(/googleadservices\.com\/pagead\/conversion\/(\d{9,11})/i); if (match && match[1]) { adsIds.add(`AW-${match[1]}`); } match = src.match(/googletagmanager\.com\/gtag\/js.*[?&]id=(AW-\d{9,11})/i); if (match && match[1]) { adsIds.add(match[1]); } if (src.includes('googleadservices.com/pagead/conversion_async.js')) { legacyScriptFound = true; } } } const scripts = Array.from(document.getElementsByTagName('script')); for (const script of scripts) { let scriptContent = getScriptContent(script); const delayedInlineId = script.getAttribute('data-two_delay_id'); if (!scriptContent && delayedInlineId && window.two_worker_data_js?.js) { const delayedScriptData = window.two_worker_data_js.js.find(item => item.uid === delayedInlineId && item.inline); if (delayedScriptData?.code) { try { scriptContent = decodeURIComponent(atob(delayedScriptData.code)); } catch (e) { console.warn("Could not decode delayed script:", delayedInlineId, e); scriptContent = ''; } } } if (scriptContent) { const configMatches = scriptContent.matchAll(/gtag\s*\(\s*['"]config['"]\s*,\s*['"](AW-\d{9,11})['"]\s*(?:,\s*\{[^}]*\})?\s*\)\s*;/gi); for (const match of configMatches) { if (match && match[1]) adsIds.add(match[1]); } const legacyMatch = scriptContent.match(/google_conversion_id\s*=\s*(\d{9,11})/i); if (legacyMatch && legacyMatch[1]) { adsIds.add(`AW-${legacyMatch[1]}`); } const patternMatches = scriptContent.matchAll(adsIdPattern); for (const match of patternMatches) { if (match && match[1]) adsIds.add(match[1]); } } } if (window.dataLayer && Array.isArray(window.dataLayer)) { for (const item of window.dataLayer) { if (Array.isArray(item) && item.length >= 2 && item[0] === 'config' && typeof item[1] === 'string' && item[1].startsWith('AW-')) { adsIds.add(item[1]); } if (typeof item === 'object' && item !== null && item[0] === 'config' && typeof item[1] === 'string' && item[1].startsWith('AW-')) { adsIds.add(item[1]); } try { const itemString = JSON.stringify(item); const patternMatches = itemString.matchAll(adsIdPattern); for (const match of patternMatches) { if (match && match[1]) adsIds.add(match[1]); } } catch(e) {/* ignore */} } } if (window.google_conversion_id) { if (String(window.google_conversion_id).match(/^\d{9,11}$/)) { adsIds.add(`AW-${window.google_conversion_id}`); } } if (adsIds.size === 0 && legacyScriptFound) { return ["Legacy Script Found"]; } return adsIds.size > 0 ? Array.from(adsIds) : null;
        }
        function checkForBingUET() { /* ... Full Bing UET logic (with ID extraction) ... */
            const scripts = Array.from(document.getElementsByTagName('script')); let uetTagId = null; let foundScript = false; const uetIdPattern = /(\d{7,10})/; for (const script of scripts) { for (const attr of script.attributes) { if (attr.value && attr.value.includes('bat.bing.com/')) { foundScript = true; const urlMatch = attr.value.match(/bat\.bing\.com\/p\/action\/(\d{7,10})\.js/i); if (urlMatch && urlMatch[1]) { return urlMatch[1]; } if (attr.value.includes('bat.bing.com/bat.js')) { if (!uetTagId) uetTagId = "bat.js loaded"; } } } } const uetInitPattern = /uetq\s*=\s*window\.uetq\s*\|\|\s*\[\];\s*window\.uetq\.push\(\s*['"]u['"]\s*,\s*['"](\d+)['"]\s*\)/i; for (const script of scripts) { const scriptContent = getScriptContent(script); if (scriptContent) { const match = scriptContent.match(uetInitPattern); if (match && match[1]) { return match[1]; } if (scriptContent.includes('uetq')) { const idMatch = scriptContent.match(uetTagIdPattern); if (idMatch && idMatch[1]) { if (!uetTagId || uetTagId === "bat.js loaded") { uetTagId = idMatch[1] + " (ID in Script)"; } } } } } if (uetTagId && uetTagId !== "bat.js loaded") return uetTagId; if (window.uetq && Array.isArray(window.uetq)) { if (!uetTagId) uetTagId = "window.uetq object found"; for (const item of window.uetq) { if (Array.isArray(item) && item.length >= 2 && item[0] === 'u' && typeof item[1] === 'string' && item[1].match(/^\d{7,10}$/)) { return item[1]; } } } if (foundScript && !uetTagId) { return "bat.js loaded (ID not found)"; } return uetTagId;
        }
        function checkForCallTracking(scriptSources) { /* ... Full CallTracking logic (with AID output) ... */
            const servicesFound = new Set(); const ctmDomains = ['tctm.co', 'calltrackingmetrics.com']; const patterns = [ { name: "CallTrackingMetrics", regex: /(cdn\.calltrackingmetrics\.com\/[^\/]+\/track\.js|ctm\.js|calltrackingmetrics\.com|tctm\.co)/i, obj: "_ctm", obj2: "__ctm_loaded", configObj: "__ctm", attribute: "data-ctm-identifier", elementSelector: 'span[data-ctm-tracked="true"]' }, { name: "CallRail", regex: /cdn\.callrail\.com|callrail\.com/i, obj: "CallTrk" }, { name: "WhatConverts", regex: /t\.whatconverts\.com|whatconverts\.com/i, obj: "wc_event_yp" }, { name: "ServiceTitan DNI", regex: /dna\.js|servicetitan.*dni/i }, { name: "Google Call Tracking", regex: /googleadservices\.com\/pagead\/conversion_async\.js/i, func: "google_wcc_status", element: "._goog_wcc_swap" } ]; if (scriptSources && scriptSources.length > 0) { scriptSources.forEach(src => { if (!src) return; patterns.forEach(pattern => { if (pattern.regex && pattern.regex.test(src)) { servicesFound.add(pattern.name); } }); }); } patterns.forEach(pattern => { let foundViaObjectOrElement = false; if (pattern.obj && window[pattern.obj]) { servicesFound.add(pattern.name + " (JS Object)"); foundViaObjectOrElement = true; } if (pattern.obj2 && window[pattern.obj2]) { servicesFound.add(pattern.name + " (JS Object 2)"); foundViaObjectOrElement = true; } if (pattern.configObj && pattern.name === "CallTrackingMetrics") { try { const accountId = window?.__ctm?.config?.aid; if (accountId) { const entryWithAID = pattern.name + ` (AID: ${accountId})`; servicesFound.forEach(item => { if (item === pattern.name || item.startsWith(pattern.name + " (")) { servicesFound.delete(item); } }); servicesFound.add(entryWithAID); foundViaObjectOrElement = true; } } catch (e) { /* ignore */ } } if (pattern.func && typeof window[pattern.func] === 'function') { servicesFound.add(pattern.name + " (JS Function)"); foundViaObjectOrElement = true; } if (pattern.element && document.querySelector(pattern.element)) { servicesFound.add(pattern.name + " (Known Element)"); foundViaObjectOrElement = true; } if (pattern.attribute && document.querySelector(`[${pattern.attribute}]`)) { servicesFound.add(pattern.name + " (Data Attribute)"); foundViaObjectOrElement = true; } if (pattern.elementSelector) { try { if (document.querySelector(pattern.elementSelector)) { servicesFound.add(pattern.name + " (Specific Element)"); foundViaObjectOrElement = true; } } catch (e) { /* Ignore */ } } }); if (document.querySelectorAll('span[class*="dni"], span[id*="dni"], span[data-dni]').length > 0 && !Array.from(servicesFound).some(s => s.toLowerCase().includes("dni") || s.includes("CallTrackingMetrics") || s.includes("CallRail"))) { servicesFound.add("Generic DNI Pattern Found"); } return servicesFound.size > 0 ? Array.from(servicesFound) : null;
        }
        function checkForChatPlatforms() { /* ... Full Chat Platform logic (including generic) ... */
            const scripts = Array.from(document.getElementsByTagName('script')); const chatPlatforms = new Set(); let specificPlatformFound = false; const patterns = [ { name: 'Tidio', scriptSrc: 'widget.tidiochat.com', obj: 'tidioChatApi', elementSelector: 'iframe[id^="tidio-chat-iframe"]' }, { name: 'Podium', scriptSrc: 'connect-widget.podium.com', obj: 'Podium', elementSelector: '[id*="podium-bubble"], [id*="podium-widget"]' }, { name: 'LiveChat', scriptSrc: 'cdn.livechatinc.com', obj: 'LiveChatWidget', elementSelector: '#livechat-widget' }, { name: 'Intercom', scriptSrc: 'widget.intercom.io', scriptSrc2: 'js.intercomcdn.com', obj: 'Intercom', elementSelector: '[id^="intercom-"]' }, { name: 'Drift', scriptSrc: 'js.driftt.com', obj: 'drift', elementSelector: '#drift-widget' }, { name: 'Tawk.to', scriptSrc: 'embed.tawk.to', obj: 'Tawk_API', elementSelector: '[id*="tawk-chat-widget"]' }, { name: 'Crisp', scriptSrc: 'client.crisp.chat', obj: '$crisp', elementSelector: '#crisp-client' }, { name: 'HubSpot Chat', scriptSrc: 'js.hs-scripts.com', scriptSrc2: 'js.usemessages.com', obj: ' HubSpotConversations', elementSelector: '#hubspot-messages-iframe-container' }, { name: 'Zendesk Chat', scriptSrc: 'v2.zopim.com', scriptSrc2: 'static.zdassets.com/ekr/snippet.js', obj: '$zopim', elementSelector: 'iframe[id^="zopim"]' }, { name: 'Wix Chat', obj: 'wixChat', elementSelector: '[id*="wixapps-chat"], iframe[src*="wix-chat"]' }, { name: 'HappyFox Chat', scriptSrc: 'widget.happyfoxchat.com', obj: 'HFCHAT', elementSelector: '#hf-chat-widget, iframe[src*="happyfoxchat.com"]' }, { name: 'Emitrr Chat', scriptSrc: 'widget.emitrr.com', obj: 'emitrr', elementSelector: '#emitrr-widget, iframe[src*="emitrr.com"]' } ]; scripts.forEach(script => { if (script.src) { patterns.forEach(pattern => { if (pattern.scriptSrc && script.src.includes(pattern.scriptSrc)) { chatPlatforms.add(pattern.name); specificPlatformFound = true; } if (pattern.scriptSrc2 && script.src.includes(pattern.scriptSrc2)) { chatPlatforms.add(pattern.name); specificPlatformFound = true; } }); } }); patterns.forEach(pattern => { if (pattern.obj && window[pattern.obj]) { chatPlatforms.add(pattern.name + " (JS Object)"); specificPlatformFound = true; } if (pattern.elementSelector) { try { if (document.querySelector(pattern.elementSelector)) { chatPlatforms.add(pattern.name + " (HTML Element)"); specificPlatformFound = true; } } catch (e) { /* Ignore */ } } }); if (!specificPlatformFound) { const genericChatPattern = /chat|livechat|messaging|widget/i; scripts.forEach(script => { if (script.src) { const urlParts = script.src.split('?')[0].split('/'); const filename = urlParts[urlParts.length - 1]; if (filename && genericChatPattern.test(filename)) { if (!script.src.includes('googletagmanager') && !script.src.includes('google-analytics')) { chatPlatforms.add(`Generic Chat Script (${filename})`); } } } }); } return chatPlatforms.size > 0 ? Array.from(chatPlatforms) : null;
        }
        function checkForFormTypes() { /* ... Full Form Type logic ... */
            const forms = Array.from(document.getElementsByTagName('form')); const formTypes = new Set(); const formChecks = [ { name: 'Gravity Form', selector: 'form[id^="gform_"], div.gform_wrapper', scriptSrc: '/gravityforms/', jsVar: 'gf_apply_rules' }, { name: 'Contact Form 7', selector: 'form.wpcf7-form', scriptSrc: '/contact-form-7/', jsVar: 'wpcf7' }, { name: 'Ninja Form', selector: 'form.nf-form-layout, div.nf-form-layout, div.nf-field-container', scriptSrc: '/ninja-forms/', jsVar: 'nfForms' }, { name: 'HubSpot Form', selector: 'form.hs-form, iframe[src*="forms.hsforms.com"]', scriptSrc: '//js.hsforms.net/forms/', globalObj: 'hbspt'}, { name: 'WPForms', selector: 'form.wpforms-form, div.wpforms-container-full', scriptSrc: '/wpforms/', jsVar: 'wpforms' }, { name: 'Formidable Forms', selector: 'form.frm-show-form, div.frm_forms', scriptSrc: '/formidable/', jsVar: 'frm_js' }, { name: 'Elementor Form', selector: 'form.elementor-form', scriptSrc: 'elementor-pro/assets/js/forms', jsVar: 'elementorFrontend.modules.forms' }, { name: 'Quform', selector: 'form.quform-form[id^="quform-form-"]', scriptSrc: '/quform/cache/quform.js' } ]; forms.forEach(form => { formChecks.forEach(check => { try { if (form.matches(check.selector.split(',')[0])) formTypes.add(check.name); } catch(e) {/*ignore*/} }); }); formChecks.forEach(check => { try { if (document.querySelector(check.selector)) formTypes.add(check.name); } catch(e) {/*ignore*/} if (check.scriptSrc && Array.from(document.scripts).some(s => s.src && s.src.includes(check.scriptSrc))) formTypes.add(check.name + " (script detected)"); if (check.jsVar) { let obj = window; const parts = check.jsVar.split('.'); let found = true; for(const part of parts) { if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, part)) obj = obj[part]; else { found = false; break; } } if (found) formTypes.add(check.name + " (JS variable)"); } if (check.globalObj && window[check.globalObj]) formTypes.add(check.name + " (Global Object)"); }); if (formTypes.size === 0 && forms.length > 0) formTypes.add('Generic HTML Form(s)'); return formTypes.size > 0 ? Array.from(formTypes) : null;
        }
        function detectWebsitePlatform() { /* ... Full Platform logic (Simplified Output) ... */
             let platform = 'Unknown Platform'; let isWordPress = false; let generatorInfo = null; let generatorName = null; const hasWpContent = document.querySelector('link[href*="wp-content/"], script[src*="wp-content/"], link[href*="wp-includes/"], script[src*="wp-includes/"]'); const hasWpObject = window.wp || (window.jQuery && typeof window.jQuery.fn.wpAjax !== 'undefined'); if (hasWpContent || hasWpObject) { isWordPress = true; platform = 'WordPress'; let version = ""; if (document.body && document.body.className && typeof document.body.className === 'string' && document.body.className.includes("wp-version-")) { const match = document.body.className.match(/wp-version-(\S+)/); if (match) version = match[1].replace(/_/g, '.'); } if (version) platform += ` ${version}`; } const metaGenerators = Array.from(document.getElementsByTagName('meta')); const generatorTag = metaGenerators.find(meta => meta.name && meta.name.toLowerCase() === 'generator' && meta.content); if (generatorTag && generatorTag.content) { generatorInfo = generatorTag.content; const contentLower = generatorInfo.toLowerCase(); generatorName = generatorInfo.split(/[;,\s]/)[0]; if (isWordPress) { if (generatorName && !contentLower.includes('wordpress')) { platform += ` (Generator: ${generatorName})`; } } else { if (contentLower.includes('wix.com')) return 'Wix'; if (contentLower.includes('squarespace')) return 'Squarespace'; if (contentLower.includes('joomla')) return 'Joomla!'; if (contentLower.includes('drupal')) return `Drupal (${generatorInfo})`; if (contentLower.includes('shopify')) return 'Shopify'; platform = `Platform by generator: ${generatorInfo}`; } } if (!isWordPress) { if (window.Shopify || document.querySelector('script[src*="cdn.shopify.com"]') || (document.documentElement.innerHTML && document.documentElement.innerHTML.includes("Shopify.theme"))) { let themeName = ""; if(window.Shopify?.theme?.name) themeName = ` (Theme: ${window.Shopify.theme.name})`; return 'Shopify' + themeName; } if (window.wixPerformanceMeasurements || window.wixBiSession || window.viewerModel || document.querySelector('script[src*="static.parastorage.com"]') || document.getElementById("wix-warmup-data")) return 'Wix'; if (window.Squarespace || (window.Static?.SQUARESPACE_CONTEXT) || document.querySelector('script[src*=".squarespace.com"]')) return 'Squarespace'; if (window.Joomla || document.querySelector('script[src*="/media/jui/js/joomla.min.js"]')) return 'Joomla!'; if (window.Drupal || (window.jQuery && typeof window.jQuery.fn.drupal !== 'undefined') || document.querySelector('script[src*="/misc/drupal.js"]')) return 'Drupal'; if (document.getElementById('weebly-username') || document.querySelector('link[href*="cdn2.editmysite.com"]')) return 'Weebly'; if (window.BCData || document.querySelector('script[src*="bigcommerce.com/"]')) return 'BigCommerce'; if (document.querySelector('[data-reactroot], #__next, .ReactModalPortal')) return 'React-based site'; if (window.Vue || document.querySelector('[data-v-app]')) return 'Vue.js-based site'; if (window.angular || document.querySelector('[ng-app], [data-ng-app]')) return 'AngularJS/Angular-based site'; } if (platform === 'Unknown Platform' && document.doctype?.name?.toLowerCase() === 'html') return 'Potentially Custom HTML or Less Common CMS/Framework'; return platform;
        }
        function extractPhoneNumbers() { /* ... Full Phone Number logic (Refined) ... */
            const bodyText = document.body.innerText || "";
            const AHTMLElements = Array.from(document.getElementsByTagName('a'));
            const phoneNumbers = new Set();
            const phoneRegex = /(?:(?:\+|00)\d{1,3}[-\.\s]?)?(?:\(?\d{2,5}\)?[-\.\s]?)?\d{2,4}[-\.\s]?\d{2,4}[-\.\s]?\d{0,4}(?:\s?(?:ext|x|ext.)\s?\d{1,5})?/gi;
            let match;

            function addIfValidPhone(potentialNumber) {
                const digitsOnly = potentialNumber.replace(/\D/g, '');
                // Check for exactly 10 or 11 digits
                if (digitsOnly.length === 10 || digitsOnly.length === 11) {
                    phoneNumbers.add(potentialNumber.trim());
                }
            }

            // Search in body text
            while ((match = phoneRegex.exec(bodyText)) !== null) {
                addIfValidPhone(match[0]);
            }
            phoneRegex.lastIndex = 0; // Reset regex

            // Search in 'tel:' links and their text
            AHTMLElements.forEach(a => {
                const linkHref = (a.getAttribute('href') || "").toLowerCase();
                const linkText = (a.innerText || a.textContent || "").trim();

                if (linkHref.startsWith('tel:')) {
                    let telNumber = linkHref.substring(4).replace(/[^\d\+\-\(\)\s\.extx]/gi, '').trim();
                    addIfValidPhone(telNumber);
                }
                // Also check link's inner text
                if (linkText) {
                    while ((match = phoneRegex.exec(linkText)) !== null) {
                        addIfValidPhone(match[0]);
                    }
                    phoneRegex.lastIndex = 0; // Reset regex index
                }
            });

            // Also check common phone number container classes/ids
            document.querySelectorAll('[class*="phone"], [class*="tel"], [id*="phone"], [id*="tel"]').forEach(el => {
                const elText = (el.innerText || el.textContent || "").trim();
                 if (elText) {
                    while ((match = phoneRegex.exec(elText)) !== null) {
                         addIfValidPhone(match[0]);
                    }
                    phoneRegex.lastIndex = 0; // Reset regex index
                }
            });

            return phoneNumbers.size > 0 ? Array.from(phoneNumbers) : null;
        }
        function checkForPrivacyPolicyPage() { /* ... Full Privacy Policy logic (Blurb detection updated) ... */
            const links = Array.from(document.getElementsByTagName('a')); const privacyKeywords = [ 'privacy policy', 'privacy-policy', 'privacy statement', 'privacy-statement', 'data protection', 'data-protection', 'privacy notice', 'privacy-notice', 'politique de confidentialité', 'datenschutz', 'datenschutzerklärung', 'política de privacidad', 'informativa sulla privacy', 'privacyverklaring' ]; const privacyUrlPaths = [ '/privacy', '/privacy-policy', '/legal/privacy', '/privacy_policy', '/privacystatement', '/data-privacy', '/meta/privacy' ]; let foundPolicyLink = null; for (let link of links) { const hrefAttr = link.getAttribute('href'); if (!hrefAttr || hrefAttr.startsWith('javascript:') || hrefAttr.startsWith('#')) continue; try { const absoluteLinkUrl = new URL(hrefAttr, window.location.href); const linkText = (link.innerText || link.textContent || "").toLowerCase().trim(); const linkPathnameLower = absoluteLinkUrl.pathname.toLowerCase(); for (let keyword of privacyKeywords) { if (linkText.includes(keyword)) { if (linkText.includes('policy') || linkText.includes('statement') || linkText.includes('notice') || linkText.includes('erklärung') || linkText.includes('confidentialité') ) return absoluteLinkUrl.href; if (!foundPolicyLink) foundPolicyLink = absoluteLinkUrl.href; } } for (let pathKeyword of privacyUrlPaths) { if (linkPathnameLower.includes(pathKeyword)) { if (pathKeyword.includes('policy') || pathKeyword.includes('statement')) return absoluteLinkUrl.href; if (!foundPolicyLink) foundPolicyLink = absoluteLinkUrl.href; } } } catch (e) { /* Ignore invalid URLs */ } } if (foundPolicyLink) return foundPolicyLink; const metaLinks = Array.from(document.querySelectorAll('link[rel="privacy-policy"]')); if (metaLinks.length > 0 && metaLinks[0].href) { try { return new URL(metaLinks[0].href, window.location.href).href; } catch (e) { /* Ignore */ } } const bodyText = document.body.innerText || ""; const broadPrivacyPattern = /privacy/i; if (broadPrivacyPattern.test(bodyText)) { let isLikelyLinkText = false; links.forEach(link => { const linkText = (link.innerText || link.textContent || "").toLowerCase().trim(); if (linkText.includes("privacy")) { isLikelyLinkText = true; } }); if (!isLikelyLinkText) { return "Privacy policy found on page"; } } return null;
        }
        function findRelatedInternalPages() { /* ... Full Related Pages logic ... */
            const relatedPages = new Set(); const currentFullUrl = window.location.href; const currentOrigin = window.location.origin; const keywords = [ 'contact', 'schedule', 'book', 'booking', 'appointment', 'support', 'quote', 'estimate', 'request-a-quote', 'get-in-touch', 'demo', 'consultation', 'pricing', 'ask', 'reach-us', 'contact-us', 'customer-service', 'reservations', 'free-trial' ]; document.querySelectorAll('a[href]').forEach(a => { try { const hrefAttr = a.getAttribute('href'); if (!hrefAttr || hrefAttr.startsWith('javascript:') || hrefAttr.startsWith('#') || hrefAttr.startsWith('mailto:') || hrefAttr.startsWith('tel:')) return; const linkUrl = new URL(hrefAttr, currentFullUrl); if (linkUrl.origin === currentOrigin) { const linkText = (a.innerText || a.textContent || "").toLowerCase().trim(); const linkFullHrefLower = linkUrl.href.toLowerCase(); for (const keyword of keywords) { if (linkText.includes(keyword) || linkFullHrefLower.includes(keyword.replace(/\s+/g, '-')) || linkFullHrefLower.includes(keyword.replace(/\s+/g, '_')) || linkFullHrefLower.includes(keyword) ) { if (linkUrl.href !== currentFullUrl) relatedPages.add(linkUrl.href); break; } } } } catch (e) { /* console.warn("Could not parse link href:", a.getAttribute('href'), e); */ } }); return Array.from(relatedPages).slice(0, 5);
        }

        // --- Main execution of analysis for the current page ---
        let currentPageAnalysisResults = {};
        let relatedPagesFound = [];
        try {
            // Collect all script sources currently in the DOM
            const currentScriptSources = Array.from(document.scripts).map(s => s.src || s.getAttribute('data-two_delay_src') || null).filter(Boolean);

            currentPageAnalysisResults.gtm = checkForGTM();
            currentPageAnalysisResults.ga4 = checkForGA4();
            currentPageAnalysisResults.adsConversionIds = checkForAdsConversion(currentScriptSources);
            currentPageAnalysisResults.bingUET = checkForBingUET();
            currentPageAnalysisResults.callTracking = checkForCallTracking(currentScriptSources);
            currentPageAnalysisResults.chatPlatforms = checkForChatPlatforms();
            currentPageAnalysisResults.formTypes = checkForFormTypes();
            currentPageAnalysisResults.platform = detectWebsitePlatform();
            currentPageAnalysisResults.phoneNumbers = extractPhoneNumbers(); // Updated check
            currentPageAnalysisResults.privacyPolicy = checkForPrivacyPolicyPage();
            relatedPagesFound = findRelatedInternalPages();
        } catch (e) {
            console.error("Error during page analysis in content script:", e);
             return { error: { message: e.message, stack: e.stack } };
        }

        return {
            currentPageAnalysis: currentPageAnalysisResults,
            relatedPages: relatedPagesFound
        };
    } // End of runPageAnalysisAndFindRelated

});
