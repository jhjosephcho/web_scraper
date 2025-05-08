document.addEventListener('DOMContentLoaded', () => {
    const analyzeBtn = document.getElementById('analyzeBtn');
    const urlInput = document.getElementById('urlInput');
    const analysisOutputDiv = document.getElementById('analysisOutput');
    const loadingStatusDiv = document.getElementById('loadingStatus');

    let aggregatedData = {}; // Stores combined results from current and related pages
    let relatedPagesToProcess = 0;
    let relatedPagesProcessed = 0;

    // Function to reset state before a new analysis
    function resetAnalysisState() {
        aggregatedData = {
            gtm: null,
            ga4: null,
            callTracking: new Set(),
            chatPlatforms: new Set(), // Added for chat
            platform: null,
            privacyPolicy: null,
            formTypes: new Set(),
            phoneNumbers: new Set(),
            errors: [],
        };
        relatedPagesToProcess = 0;
        relatedPagesProcessed = 0;
        analysisOutputDiv.innerHTML = "<p>Click \"Analyze\" to see website details.</p>";
        loadingStatusDiv.textContent = "";
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && tabs[0].url && !tabs[0].url.startsWith('chrome://') && !tabs[0].url.startsWith('about:')) {
            urlInput.value = tabs[0].url;
        }
    });

    analyzeBtn.addEventListener('click', () => {
        resetAnalysisState(); // Reset data for a new analysis run
        analysisOutputDiv.innerHTML = "<p>Analyzing current page...</p>";
        loadingStatusDiv.textContent = "Starting analysis...";

        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            const activeTab = tabs[0];
            if (!activeTab || !activeTab.id) {
                analysisOutputDiv.innerHTML = "<p>Error: Could not get active tab.</p>";
                loadingStatusDiv.textContent = "Error.";
                return;
            }

            if (activeTab.url && (activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('about:'))) {
                analysisOutputDiv.innerHTML = `<p>Cannot analyze special browser pages (e.g., ${activeTab.url.split('/')[0]}/...). Please navigate to a website.</p>`;
                loadingStatusDiv.textContent = "Error.";
                return;
            }

            chrome.scripting.executeScript(
                {
                    target: { tabId: activeTab.id },
                    func: runPageAnalysisAndFindRelated // This is the large function defined at the end
                },
                (injectionResults) => {
                    if (chrome.runtime.lastError) {
                        console.error("Error executing script: " + chrome.runtime.lastError.message);
                        analysisOutputDiv.innerHTML = `<p>Error: Could not analyze the page. ${chrome.runtime.lastError.message}.</p>`;
                        loadingStatusDiv.textContent = "Error.";
                        return;
                    }

                    if (injectionResults && injectionResults[0] && injectionResults[0].result) {
                        const resultData = injectionResults[0].result;

                        if (resultData.error) {
                            console.error("Error from current page analysis script:", resultData.error);
                            aggregatedData.errors.push(`Error on current page (${activeTab.url}): ${resultData.error.message || 'Unknown error'}`);
                        }

                        // Process current page data into aggregatedData
                        if (resultData.currentPageAnalysis) {
                            const currentPageData = resultData.currentPageAnalysis;
                            aggregatedData.gtm = currentPageData.gtm;
                            aggregatedData.ga4 = currentPageData.ga4;
                            currentPageData.callTracking?.forEach(ct => aggregatedData.callTracking.add(ct));
                            currentPageData.chatPlatforms?.forEach(cp => aggregatedData.chatPlatforms.add(cp)); // Add chat platforms
                            aggregatedData.platform = currentPageData.platform;
                            aggregatedData.privacyPolicy = currentPageData.privacyPolicy;
                            currentPageData.formTypes?.forEach(ft => aggregatedData.formTypes.add(ft));
                            currentPageData.phoneNumbers?.forEach(pn => aggregatedData.phoneNumbers.add(pn));
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
                                        aggregatedData.errors.push(`Error starting related page analysis: ${chrome.runtime.lastError.message}`);
                                        relatedPagesToProcess = 0;
                                        displayAggregatedResults();
                                        loadingStatusDiv.textContent = "Error with related page analysis.";
                                    } else if (response && response.status === "processing") {
                                        console.log("Background script is processing related pages.");
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
                    }
                }
            );
        });
    });

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === "relatedPageSingleResult") {
            const pageData = message.data;

            // Add data from this related page to aggregatedData
            // Note: We typically don't run chat detection on related pages, only forms/phones
            pageData.formTypes?.forEach(ft => aggregatedData.formTypes.add(ft));
            pageData.phoneNumbers?.forEach(pn => aggregatedData.phoneNumbers.add(pn));
            if (pageData.error) {
                aggregatedData.errors.push(`Error on ${escapeHTML(pageData.url)}: ${escapeHTML(pageData.error)}`);
            }

            relatedPagesProcessed++;
            loadingStatusDiv.textContent = `Processed ${relatedPagesProcessed} of ${relatedPagesToProcess} related pages...`;

            if (relatedPagesProcessed >= relatedPagesToProcess) {
                displayAggregatedResults();
                loadingStatusDiv.textContent = "All analyses complete.";
            }
        }
        return true; // Keep message channel open for async responses
    });

    function displayAggregatedResults() {
        analysisOutputDiv.innerHTML = ""; // Clear previous content

        let contentHTML = "";
        // Primarily from the current page
        contentHTML += `<p><strong>Google Tag Manager:</strong> ${escapeHTML(aggregatedData.gtm) || 'Not found'}</p>`;
        contentHTML += `<p><strong>Google Analytics 4 (GA4):</strong> ${escapeHTML(aggregatedData.ga4) || 'Not found'}</p>`;
        contentHTML += `<p><strong>Call Tracking:</strong> ${aggregatedData.callTracking.size > 0 ? Array.from(aggregatedData.callTracking).map(escapeHTML).join(', ') : 'Not found'}</p>`;
        contentHTML += `<p><strong>Chat Platforms:</strong> ${aggregatedData.chatPlatforms.size > 0 ? Array.from(aggregatedData.chatPlatforms).map(escapeHTML).join(', ') : 'Not found'}</p>`; // Added Chat Platforms
        contentHTML += `<p><strong>Website Platform:</strong> ${escapeHTML(aggregatedData.platform) || 'Unknown'}</p>`;
        contentHTML += `<p><strong>Privacy Policy Page:</strong> ${aggregatedData.privacyPolicy ? `<a href="${escapeHTML(aggregatedData.privacyPolicy)}" target="_blank">${escapeHTML(aggregatedData.privacyPolicy)}</a>` : 'Not found'}</p>`;

        // Aggregated from current and related pages
        contentHTML += `<p><strong>Forms Found (across analyzed pages):</strong> ${aggregatedData.formTypes.size > 0 ? Array.from(aggregatedData.formTypes).map(escapeHTML).join(', ') : 'None detected'}</p>`;
        contentHTML += `<p><strong>Phone Numbers Found (across analyzed pages):</strong> ${aggregatedData.phoneNumbers.size > 0 ? Array.from(aggregatedData.phoneNumbers).map(n => `<code>${escapeHTML(n)}</code>`).join('<br>') : 'None found'}</p>`;

        if (aggregatedData.errors.length > 0) {
            contentHTML += `<hr style="margin: 10px 0;"><h4>Errors During Analysis:</h4>`;
            aggregatedData.errors.forEach(err => {
                // Error messages are already escaped when added to the array
                contentHTML += `<p style="color:red; font-size:0.9em;">- ${err}</p>`;
            });
        }
        analysisOutputDiv.innerHTML = contentHTML;
    }

    function escapeHTML(str) {
        if (str === null || str === undefined) return '';
        return str.toString().replace(/[&<>"']/g, function (match) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[match];
        });
    }

    // ===============================================================================
    // MAIN ANALYSIS FUNCTION (INJECTED INTO PAGE)
    // Includes the new checkForChatPlatforms function
    // ===============================================================================
    function runPageAnalysisAndFindRelated() {
        // Helper: robustly get script content for searching
        function getScriptContent(scriptElement) {
            return scriptElement.innerHTML || '';
        }

        function checkForGTM() {
            const scripts = Array.from(document.getElementsByTagName('script'));
            const gtmScriptTag = scripts.find(script => script.src && script.src.includes('googletagmanager.com/gtm.js'));
            if (gtmScriptTag && gtmScriptTag.src) {
                const gtmIdMatch = gtmScriptTag.src.match(/id=([^&]+)/);
                if (gtmIdMatch && gtmIdMatch[1]) return gtmIdMatch[1];
            }
            if (window.dataLayer && Array.isArray(window.dataLayer)) {
                for (const item of window.dataLayer) {
                    if (item && typeof item === 'object' && item.event === 'gtm.js' && item['gtm.start']) {
                        try {
                            if (typeof arguments !== 'undefined' && arguments && arguments.length > 1 && typeof arguments[1] === 'string' && arguments[1].startsWith('GTM-')) return arguments[1];
                        } catch (e) {/*ignore*/}
                        for (const dlItem of window.dataLayer) {
                            if (Array.isArray(dlItem) && dlItem.length > 1 && typeof dlItem[1] === 'string' && dlItem[1].startsWith('GTM-')) return dlItem[1];
                        }
                        return 'GTM detected (dataLayer initialization)';
                    }
                    if (Array.isArray(item) && item.length > 1 && typeof item[1] === 'string' && item[1].startsWith('GTM-')) return item[1];
                }
            }
            if (document.querySelector('iframe[src*="googletagmanager.com/ns.html"]') || document.querySelector('script[src*="googletagmanager.com/gtm.js"]')) {
                return 'GTM likely present (found related elements/scripts)';
            }
            return null;
        }

        function checkForGA4() {
            const scripts = Array.from(document.getElementsByTagName('script'));
            let ga4Id = null;
            const gtagScriptTag = scripts.find(script => script.src && script.src.includes('googletagmanager.com/gtag/js'));
            if (gtagScriptTag && gtagScriptTag.src) {
                const idMatch = gtagScriptTag.src.match(/id=(G-[A-Z0-9]+)/);
                if (idMatch && idMatch[1]) return idMatch[1];
            }
            for (const script of scripts) {
                const scriptContent = getScriptContent(script);
                const match = scriptContent.match(/gtag\s*\(\s*['"]config['"]\s*,\s*['"](G-[A-Z0-9]+)['"]\s*(?:,\s*\{[^}]*\})?\s*\)\s*;/);
                if (match && match[1]) { ga4Id = match[1]; break; }
            }
            if (ga4Id) return ga4Id;
            if (window.dataLayer && Array.isArray(window.dataLayer)) {
                for (const item of window.dataLayer) {
                    if (Array.isArray(item) && item.length >= 2 && item[0] === 'config' && typeof item[1] === 'string' && item[1].startsWith('G-')) { ga4Id = item[1]; break; }
                    if (typeof item === 'object' && item !== null && item[0] === 'config' && typeof item[1] === 'string' && item[1].startsWith('G-')) { ga4Id = item[1]; break; }
                }
            }
            if (ga4Id) return ga4Id;
            if (typeof window.gtag === 'function' && window.google_tag_manager) {
                 for (const containerId in window.google_tag_manager) {
                    if (Object.prototype.hasOwnProperty.call(window.google_tag_manager, containerId) && containerId.startsWith('G-') && window.google_tag_manager[containerId]?.dataLayer?.gtagConfig) return containerId;
                 }
            }
            return null;
        }

        function checkForCallTracking() {
            const scripts = Array.from(document.getElementsByTagName('script'));
            const servicesFound = new Set();
            const patterns = [
                {
                    name: "CallTrackingMetrics",
                    regex: /(cdn\.calltrackingmetrics\.com\/[^\/]+\/track\.js|ctm\.js|calltrackingmetrics\.com)/i,
                    obj: "_ctm", obj2: "__ctm_loaded", attribute: "data-ctm-identifier"
                },
                { name: "CallRail", regex: /cdn\.callrail\.com|callrail\.com/i, obj: "CallTrk" },
                { name: "WhatConverts", regex: /t\.whatconverts\.com|whatconverts\.com/i, obj: "wc_event_yp" },
                { name: "ServiceTitan DNI", regex: /dna\.js|servicetitan.*dni/i },
                { name: "Google Call Tracking", regex: /googleadservices\.com\/pagead\/conversion_async\.js/i, func: "google_wcc_status", element: "._goog_wcc_swap" }
            ];
            scripts.forEach(script => {
                if (script.src) { patterns.forEach(pattern => { if (pattern.regex && pattern.regex.test(script.src)) servicesFound.add(pattern.name); }); }
            });
            patterns.forEach(pattern => {
                if (pattern.obj && window[pattern.obj]) servicesFound.add(pattern.name + " (JS Object)");
                if (pattern.obj2 && window[pattern.obj2]) servicesFound.add(pattern.name + " (JS Object 2)");
                if (pattern.func && typeof window[pattern.func] === 'function') servicesFound.add(pattern.name + " (JS Function)");
                if (pattern.element && document.querySelector(pattern.element)) servicesFound.add(pattern.name + " (HTML Element)");
                if (pattern.attribute && document.querySelector(`[${pattern.attribute}]`)) servicesFound.add(pattern.name + " (Data Attribute)");
            });
            if (document.querySelectorAll('span[class*="dni"], span[id*="dni"], span[data-dni]').length > 0 &&
                !Array.from(servicesFound).some(s => s.toLowerCase().includes("dni") || s.includes("CallTrackingMetrics") || s.includes("CallRail"))) {
                servicesFound.add("Generic DNI Pattern Found");
            }
            return servicesFound.size > 0 ? Array.from(servicesFound) : null;
        }

        // NEW function to detect chat platforms
        function checkForChatPlatforms() {
            const scripts = Array.from(document.getElementsByTagName('script'));
            const chatPlatforms = new Set();

            const patterns = [
                // Tidio
                { name: 'Tidio', scriptSrc: 'widget.tidiochat.com', obj: 'tidioChatApi', elementSelector: 'iframe[id^="tidio-chat-iframe"]' },
                // Podium
                { name: 'Podium', scriptSrc: 'connect-widget.podium.com', obj: 'Podium', elementSelector: '[id*="podium-bubble"], [id*="podium-widget"]' },
                // LiveChat
                { name: 'LiveChat', scriptSrc: 'cdn.livechatinc.com', obj: 'LiveChatWidget', elementSelector: '#livechat-widget' },
                // Intercom
                { name: 'Intercom', scriptSrc: 'widget.intercom.io', scriptSrc2: 'js.intercomcdn.com', obj: 'Intercom', elementSelector: '[id^="intercom-"]' },
                // Drift
                { name: 'Drift', scriptSrc: 'js.driftt.com', obj: 'drift', elementSelector: '#drift-widget' },
                // Tawk.to
                { name: 'Tawk.to', scriptSrc: 'embed.tawk.to', obj: 'Tawk_API', elementSelector: '[id*="tawk-chat-widget"]' },
                // Crisp
                { name: 'Crisp', scriptSrc: 'client.crisp.chat', obj: '$crisp', elementSelector: '#crisp-client' },
                // HubSpot Chat (can be tricky as it's part of broader HubSpot scripts)
                { name: 'HubSpot Chat', scriptSrc: 'js.hs-scripts.com', scriptSrc2: 'js.usemessages.com', obj: ' HubSpotConversations', elementSelector: '#hubspot-messages-iframe-container' },
                // Zendesk Chat (formerly Zopim)
                { name: 'Zendesk Chat', scriptSrc: 'v2.zopim.com', scriptSrc2: 'static.zdassets.com/ekr/snippet.js', obj: '$zopim', elementSelector: 'iframe[id^="zopim"]' },
                // Wix Chat (often detected via platform, but add specific checks)
                { name: 'Wix Chat', obj: 'wixChat', elementSelector: '[id*="wixapps-chat"], iframe[src*="wix-chat"]' } // Check for elements too
                // Add more platforms here...
            ];

            // Check script sources
            scripts.forEach(script => {
                if (script.src) {
                    patterns.forEach(pattern => {
                        if (pattern.scriptSrc && script.src.includes(pattern.scriptSrc)) {
                            chatPlatforms.add(pattern.name);
                        }
                        if (pattern.scriptSrc2 && script.src.includes(pattern.scriptSrc2)) {
                             chatPlatforms.add(pattern.name);
                        }
                    });
                }
            });

            // Check global objects and specific elements
            patterns.forEach(pattern => {
                if (pattern.obj && window[pattern.obj]) {
                    chatPlatforms.add(pattern.name + " (JS Object)");
                }
                if (pattern.elementSelector) {
                    try {
                        if (document.querySelector(pattern.elementSelector)) {
                            chatPlatforms.add(pattern.name + " (HTML Element)");
                        }
                    } catch (e) { /* Ignore potential invalid selectors */ }
                }
            });

             // Special check for Wix Chat if platform is Wix
             if (detectWebsitePlatform() === 'Wix' && window.wixDevelopersAnalytics) {
                 // Wix platform detection is primary, but this adds confidence
                 // chatPlatforms.add('Wix Chat (Platform/JS)');
             }


            return chatPlatforms.size > 0 ? Array.from(chatPlatforms) : null;
        }


        function checkForFormTypes() {
            const forms = Array.from(document.getElementsByTagName('form'));
            const formTypes = new Set();
            const formChecks = [
                { name: 'Gravity Form', selector: 'form[id^="gform_"], div.gform_wrapper', scriptSrc: '/gravityforms/', jsVar: 'gf_apply_rules' },
                { name: 'Contact Form 7', selector: 'form.wpcf7-form', scriptSrc: '/contact-form-7/', jsVar: 'wpcf7' },
                { name: 'Ninja Form', selector: 'form.nf-form-layout, div.nf-form-layout, div.nf-field-container', scriptSrc: '/ninja-forms/', jsVar: 'nfForms' },
                { name: 'HubSpot Form', selector: 'form.hs-form, iframe[src*="forms.hsforms.com"]', scriptSrc: '//js.hsforms.net/forms/', globalObj: 'hbspt'},
                { name: 'WPForms', selector: 'form.wpforms-form, div.wpforms-container-full', scriptSrc: '/wpforms/', jsVar: 'wpforms' },
                { name: 'Formidable Forms', selector: 'form.frm-show-form, div.frm_forms', scriptSrc: '/formidable/', jsVar: 'frm_js' },
                { name: 'Elementor Form', selector: 'form.elementor-form', scriptSrc: 'elementor-pro/assets/js/forms', jsVar: 'elementorFrontend.modules.forms' },
            ];
            forms.forEach(form => {
                formChecks.forEach(check => { try { if (form.matches(check.selector.split(',')[0])) formTypes.add(check.name); } catch(e) {/*ignore*/} });
            });
            formChecks.forEach(check => {
                try { if (document.querySelector(check.selector)) formTypes.add(check.name); } catch(e) {/*ignore*/}
                if (check.scriptSrc && Array.from(document.scripts).some(s => s.src && s.src.includes(check.scriptSrc))) formTypes.add(check.name + " (script detected)");
                if (check.jsVar) {
                    let obj = window; const parts = check.jsVar.split('.'); let found = true;
                    for(const part of parts) { if (obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, part)) obj = obj[part]; else { found = false; break; } }
                    if (found) formTypes.add(check.name + " (JS variable)");
                }
                if (check.globalObj && window[check.globalObj]) formTypes.add(check.name + " (Global Object)");
            });
            if (formTypes.size === 0 && forms.length > 0) formTypes.add('Generic HTML Form(s)');
            return formTypes.size > 0 ? Array.from(formTypes) : null;
        }

        function detectWebsitePlatform() {
            const metaGenerators = Array.from(document.getElementsByTagName('meta'));
            const generatorTag = metaGenerators.find(meta => meta.name && meta.name.toLowerCase() === 'generator' && meta.content);
            if (generatorTag && generatorTag.content) {
                const content = generatorTag.content.toLowerCase();
                if (content.includes('wordpress')) return `WordPress (${generatorTag.content})`;
                if (content.includes('wix.com')) return 'Wix'; if (content.includes('squarespace')) return 'Squarespace';
                if (content.includes('joomla')) return 'Joomla!'; if (content.includes('drupal')) return `Drupal (${generatorTag.content})`;
                if (content.includes('shopify')) return 'Shopify';
                return `Platform by generator: ${generatorTag.content}`;
            }
            if (window.wp || (window.jQuery && typeof window.jQuery.fn.wpAjax !== 'undefined') || document.querySelector('link[href*="wp-content/"], script[src*="wp-content/"]')) {
                let version = ""; if (document.body && document.body.className && typeof document.body.className === 'string' && document.body.className.includes("wp-version-")) { const match = document.body.className.match(/wp-version-(\S+)/); if (match) version = match[1].replace(/_/g, '.');}
                return version ? `WordPress ${version}` : 'WordPress';
            }
            if (window.Shopify || document.querySelector('script[src*="cdn.shopify.com"]') || (document.documentElement.innerHTML && document.documentElement.innerHTML.includes("Shopify.theme"))) {
                let themeName = ""; if(window.Shopify && window.Shopify.theme && window.Shopify.theme.name) themeName = ` (Theme: ${window.Shopify.theme.name})`; return 'Shopify' + themeName;
            }
            if (window.wixPerformanceMeasurements || window.wixBiSession || window.viewerModel || document.querySelector('script[src*="static.parastorage.com"]') || document.getElementById("wix-warmup-data")) return 'Wix';
            if (window.Squarespace || (window.Static && window.Static.SQUARESPACE_CONTEXT) || document.querySelector('script[src*=".squarespace.com"]')) return 'Squarespace';
            if (window.Joomla || document.querySelector('script[src*="/media/jui/js/joomla.min.js"]')) return 'Joomla!';
            if (window.Drupal || (window.jQuery && typeof window.jQuery.fn.drupal !== 'undefined') || document.querySelector('script[src*="/misc/drupal.js"]')) return 'Drupal';
            if (document.getElementById('weebly-username') || document.querySelector('link[href*="cdn2.editmysite.com"]')) return 'Weebly';
            if (window.BCData || document.querySelector('script[src*="bigcommerce.com/"]')) return 'BigCommerce';
            if (document.querySelector('[data-reactroot], #__next, .ReactModalPortal')) return 'React-based site';
            if (window.Vue || document.querySelector('[data-v-app]')) return 'Vue.js-based site';
            if (window.angular || document.querySelector('[ng-app], [data-ng-app]')) return 'AngularJS/Angular-based site';
            if (document.doctype && document.doctype.name.toLowerCase() === 'html') return 'Potentially Custom HTML or Less Common CMS/Framework';
            return 'Unknown Platform';
        }

        function extractPhoneNumbers() {
            const bodyText = document.body.innerText || "";
            const AHTMLElements = Array.from(document.getElementsByTagName('a'));
            const phoneNumbers = new Set();
            const phoneRegex = /(?:(?:\+|00)\d{1,3}[-\.\s]?)?(?:\(?\d{2,5}\)?[-\.\s]?)?\d{2,4}[-\.\s]?\d{2,4}[-\.\s]?\d{0,4}(?:\s?(?:ext|x|ext.)\s?\d{1,5})?/gi;
            let match;
            while ((match = phoneRegex.exec(bodyText)) !== null) { if (match[0].replace(/\D/g, '').length >= 7 && match[0].replace(/\D/g, '').length <= 17) phoneNumbers.add(match[0].trim()); }
            phoneRegex.lastIndex = 0;
            AHTMLElements.forEach(a => {
                const linkHref = (a.getAttribute('href') || "").toLowerCase();
                const linkText = (a.innerText || a.textContent || "").trim();
                if (linkHref.startsWith('tel:')) {
                    let telNumber = linkHref.substring(4).replace(/[^\d\+\-\(\)\s\.extx]/gi, '').trim();
                    if (telNumber.replace(/\D/g, '').length >= 7 && telNumber.replace(/\D/g, '').length <= 17) phoneNumbers.add(telNumber);
                }
                if (linkText) {
                    while ((match = phoneRegex.exec(linkText)) !== null) { if (match[0].replace(/\D/g, '').length >= 7 && match[0].replace(/\D/g, '').length <= 17) phoneNumbers.add(match[0].trim()); }
                    phoneRegex.lastIndex = 0;
                }
            });
            document.querySelectorAll('[class*="phone"], [class*="tel"], [id*="phone"], [id*="tel"]').forEach(el => {
                const elText = (el.innerText || el.textContent || "").trim();
                 if (elText) {
                    while ((match = phoneRegex.exec(elText)) !== null) { if (match[0].replace(/\D/g, '').length >= 7 && match[0].replace(/\D/g, '').length <= 17) phoneNumbers.add(match[0].trim()); }
                    phoneRegex.lastIndex = 0;
                }
            });
            return phoneNumbers.size > 0 ? Array.from(phoneNumbers) : null;
        }

        function checkForPrivacyPolicyPage() {
            const links = Array.from(document.getElementsByTagName('a'));
            const privacyKeywords = [
                'privacy policy', 'privacy-policy', 'privacy statement', 'privacy-statement',
                'data protection', 'data-protection', 'privacy notice', 'privacy-notice',
                'politique de confidentialité', 'datenschutz', 'datenschutzerklärung',
                'política de privacidad', 'informativa sulla privacy', 'privacyverklaring'
            ];
            const privacyUrlPaths = [
                '/privacy', '/privacy-policy', '/legal/privacy', '/privacy_policy',
                '/privacystatement', '/data-privacy', '/meta/privacy'
            ];
            let foundPolicyLink = null;
            for (let link of links) {
                const hrefAttr = link.getAttribute('href');
                if (!hrefAttr || hrefAttr.startsWith('javascript:') || hrefAttr.startsWith('#')) continue;
                try {
                    const absoluteLinkUrl = new URL(hrefAttr, window.location.href);
                    const linkText = (link.innerText || link.textContent || "").toLowerCase().trim();
                    const linkPathnameLower = absoluteLinkUrl.pathname.toLowerCase();
                    for (let keyword of privacyKeywords) {
                        if (linkText.includes(keyword)) {
                             if (linkText.includes('policy') || linkText.includes('statement') || linkText.includes('notice') || linkText.includes('erklärung') || linkText.includes('confidentialité') ) return absoluteLinkUrl.href;
                             if (!foundPolicyLink) foundPolicyLink = absoluteLinkUrl.href;
                        }
                    }
                    for (let pathKeyword of privacyUrlPaths) {
                        if (linkPathnameLower.includes(pathKeyword)) {
                             if (pathKeyword.includes('policy') || pathKeyword.includes('statement')) return absoluteLinkUrl.href;
                             if (!foundPolicyLink) foundPolicyLink = absoluteLinkUrl.href;
                        }
                    }
                } catch (e) { /* Ignore invalid URLs */ }
            }
            if (foundPolicyLink) return foundPolicyLink;
            const metaLinks = Array.from(document.querySelectorAll('link[rel="privacy-policy"]'));
            if (metaLinks.length > 0 && metaLinks[0].href) {
                try { return new URL(metaLinks[0].href, window.location.href).href; }
                catch (e) { /* Ignore invalid meta link href */ }
            }
            return null;
        }

        function findRelatedInternalPages() {
            const relatedPages = new Set();
            const currentFullUrl = window.location.href;
            const currentOrigin = window.location.origin;
            const keywords = [
                'contact', 'schedule', 'book', 'booking', 'appointment', 'support', 'quote', 'estimate',
                'request-a-quote', 'get-in-touch', 'demo', 'consultation', 'pricing', 'ask', 'reach-us',
                'contact-us', 'customer-service', 'reservations', 'free-trial'
            ];
            document.querySelectorAll('a[href]').forEach(a => {
                try {
                    const hrefAttr = a.getAttribute('href');
                    if (!hrefAttr || hrefAttr.startsWith('javascript:') || hrefAttr.startsWith('#') || hrefAttr.startsWith('mailto:') || hrefAttr.startsWith('tel:')) return;
                    const linkUrl = new URL(hrefAttr, currentFullUrl);
                    if (linkUrl.origin === currentOrigin) {
                        const linkText = (a.innerText || a.textContent || "").toLowerCase().trim();
                        const linkFullHrefLower = linkUrl.href.toLowerCase();
                        for (const keyword of keywords) {
                            if (linkText.includes(keyword) || linkFullHrefLower.includes(keyword.replace(/\s+/g, '-')) || linkFullHrefLower.includes(keyword.replace(/\s+/g, '_')) || linkFullHrefLower.includes(keyword) ) {
                                if (linkUrl.href !== currentFullUrl) relatedPages.add(linkUrl.href);
                                break;
                            }
                        }
                    }
                } catch (e) { /* console.warn("Could not parse link href in findRelatedInternalPages:", a.getAttribute('href'), e); */ }
            });
            return Array.from(relatedPages).slice(0, 5);
        }

        // --- Main execution of analysis for the current page ---
        let currentPageAnalysisResults = {};
        let relatedPagesFound = [];
        try {
            currentPageAnalysisResults.gtm = checkForGTM();
            currentPageAnalysisResults.ga4 = checkForGA4();
            currentPageAnalysisResults.callTracking = checkForCallTracking();
            currentPageAnalysisResults.chatPlatforms = checkForChatPlatforms(); // Added chat detection call
            currentPageAnalysisResults.formTypes = checkForFormTypes();
            currentPageAnalysisResults.platform = detectWebsitePlatform();
            currentPageAnalysisResults.phoneNumbers = extractPhoneNumbers(); // For current page
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
    }
    // ===============================================================================
    // END OF INJECTED FUNCTION
    // ===============================================================================
});
