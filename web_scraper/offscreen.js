// offscreen.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.target === 'offscreen-doc' && msg.action === 'analyzeOffscreenHtml') {
        const { html, pageUrl, baseOrigin } = msg;
        let analysisData = { formTypes: null, phoneNumbers: null, error: null };

        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            analysisData = analyzeHtmlContentForOffscreen(doc, pageUrl, baseOrigin); // Updated function call
        } catch (e) {
            console.error("Error parsing HTML in offscreen document for ", pageUrl, e);
            analysisData.error = e.message;
        }

        sendResponse(analysisData); // Send back the whole analysis object
        return true; // Important for async response
    }
});

// New function to extract phone numbers from a parsed document
function extractPhoneNumbersInDocument(documentContext) {
    if (!documentContext || !documentContext.body) {
        return null;
    }
    const bodyText = documentContext.body.innerText || "";
    const AHTMLElements = Array.from(documentContext.getElementsByTagName('a'));
    const phoneNumbers = new Set();
    // Regex for various phone number formats (broad, might need refinement for international)
    // Includes optional country code, handles brackets, dots, hyphens, spaces.
    const phoneRegex = /(?:(?:\+|00)\d{1,3}[-\.\s]?)?(?:\(?\d{2,5}\)?[-\.\s]?)?\d{2,4}[-\.\s]?\d{2,4}[-\.\s]?\d{0,4}(?:\s?(?:ext|x|ext.)\s?\d{1,5})?/gi;
    let match;

    // Search in body text
    while ((match = phoneRegex.exec(bodyText)) !== null) {
        // Basic validation to filter out sequences of numbers that aren't likely phone numbers
        if (match[0].replace(/\D/g, '').length >= 7 && match[0].replace(/\D/g, '').length <= 17) {
             phoneNumbers.add(match[0].trim());
        }
    }
    phoneRegex.lastIndex = 0; // Reset regex for next use on different strings

    // Search in 'tel:' links and their text
    AHTMLElements.forEach(a => {
        const linkHref = (a.getAttribute('href') || "").toLowerCase();
        const linkText = (a.innerText || a.textContent || "").trim();

        if (linkHref.startsWith('tel:')) {
            let telNumber = linkHref.substring(4).replace(/[^\d\+\-\(\)\s\.extx]/gi, '').trim();
            if (telNumber.replace(/\D/g, '').length >= 7 && telNumber.replace(/\D/g, '').length <= 17) {
                phoneNumbers.add(telNumber);
            }
        }
        // Also check link's inner text if href was weirdly formatted or not a tel link
        if (linkText) {
            while ((match = phoneRegex.exec(linkText)) !== null) {
                 if (match[0].replace(/\D/g, '').length >= 7 && match[0].replace(/\D/g, '').length <= 17) {
                    phoneNumbers.add(match[0].trim());
                }
            }
            phoneRegex.lastIndex = 0; // Reset regex index
        }
    });

    // Also check common phone number container classes/ids (heuristic)
    // Note: querySelectorAll on documentContext
    documentContext.querySelectorAll('[class*="phone"], [class*="tel"], [id*="phone"], [id*="tel"]').forEach(el => {
        const elText = (el.innerText || el.textContent || "").trim();
         if (elText) {
            while ((match = phoneRegex.exec(elText)) !== null) {
                if (match[0].replace(/\D/g, '').length >= 7 && match[0].replace(/\D/g, '').length <= 17) {
                    phoneNumbers.add(match[0].trim());
                }
            }
            phoneRegex.lastIndex = 0; // Reset regex index
        }
    });

    return phoneNumbers.size > 0 ? Array.from(phoneNumbers) : null;
}


function analyzeHtmlContentForOffscreen(documentContext, pageUrl, baseOrigin) {
    // This function now orchestrates both form and phone number detection.
    const formTypes = checkForFormTypesInDocument(documentContext, pageUrl, baseOrigin);
    const phoneNumbers = extractPhoneNumbersInDocument(documentContext);

    return {
        formTypes: formTypes,
        phoneNumbers: phoneNumbers,
        // error will be handled by the caller if DOM parsing itself fails
    };
}


function checkForFormTypesInDocument(documentContext, pageUrl, baseOrigin) {
    // This function is adapted to work on a parsed documentContext (DOM document)
    // It cannot reliably check live `window` variables.
    // Focus on HTML structure and script src attributes.

    const forms = Array.from(documentContext.getElementsByTagName('form'));
    const formTypes = new Set(); // Use a Set to avoid duplicate entries

    const formChecks = [
        // Specific WordPress Plugins (usually have distinct footprints)
        { name: 'Gravity Form', selector: 'form[id^="gform_"], div.gform_wrapper', scriptSrc: '/gravityforms/' },
        { name: 'Contact Form 7', selector: 'form.wpcf7-form', scriptSrc: '/contact-form-7/' },
        { name: 'Ninja Form', selector: 'form.nf-form-layout, div.nf-form-layout, div.nf-field-container', scriptSrc: '/ninja-forms/' },
        { name: 'WPForms', selector: 'form.wpforms-form, div.wpforms-container-full', scriptSrc: '/wpforms/' },
        { name: 'Formidable Forms', selector: 'form.frm-show-form, div.frm_forms', scriptSrc: '/formidable/' },
        { name: 'Elementor Form', selector: 'form.elementor-form', scriptSrc: 'elementor-pro/assets/js/forms' },

        // Specific SaaS / Third-party Forms
        { name: 'HubSpot Form', selector: 'form.hs-form, iframe[src*="forms.hsforms.com"], div.hbspt-form', scriptSrc: '//js.hsforms.net/forms/'},
        { name: 'Pardot Form', selector: 'form[action*=".pardot.com/l/"]', iframeSrc: '.pardot.com/l/'},
        { name: 'Marketo Form', selector: 'form.mktoForm', scriptSrc: '//app-sjst.marketo.com/js/forms2/' },
        {
            name: 'Wufoo Form',
            selector: 'div[id^="wufoo-"], iframe[src*=".wufoo.com/embed/"], iframe[src*=".wufoo.com/forms/"]',
            scriptSrc: 'wufoo.com/scripts/embed/form.js',
            scriptContentPattern: /new WufooForm\(\)/i
        },
        // Add other specific SaaS forms here before the generic check

        // Generic check for common third-party embedded form scripts
        // This should be placed after more specific checks.
        {
            name: 'Third-Party Embedded Form',
            scriptSrcPatterns: [
                /form\.js/i, /forms\.js/i, /embed\.js/i, /loader\.js/i, /widget\.js/i,
                /scripts\/forms\//i, /js\/forms\//i, /form-builder\//i
            ],
            iframeSrcPatterns: [ /form/i, /survey/i, /signup/i ],
            genericPlaceholderSelectors: [
                'div[class*="form-embed"]', 'div[id*="form-embed"]',
                'div[class*="form-placeholder"]', 'div[id*="form-placeholder"]',
                'div[data-form-id]'
            ]
        }
    ];

    // 1. Check <form> elements directly
    forms.forEach(form => {
        formChecks.forEach(check => {
            if (check.name === 'Third-Party Embedded Form') return; // Skip generic for direct <form> tags here
            try {
                if (check.selector && form.matches(check.selector.split(',')[0].trim())) formTypes.add(check.name);
                if (check.actionPattern && form.action && form.action.match(check.actionPattern)) formTypes.add(check.name);
            } catch (e) { /* ignore */ }
        });
    });

    // 2. Check broader selectors, script tags, and iframes for all defined checks
    formChecks.forEach(check => {
        if (check.selector) {
            const selectors = check.selector.split(',');
            for (const s of selectors) {
                try { if (documentContext.querySelector(s.trim())) { formTypes.add(check.name); break; } }
                catch (e) { /* ignore */ }
            }
        }
        if (check.scriptSrc) {
            if (Array.from(documentContext.scripts).some(s => s.src && s.src.includes(check.scriptSrc))) {
                formTypes.add(check.name + " (script detected)");
            }
        }
        if (check.scriptContentPattern) {
            if (Array.from(documentContext.scripts).some(s => s.innerHTML && check.scriptContentPattern.test(s.innerHTML))) {
                formTypes.add(check.name + " (JS pattern detected)");
            }
        }
        if (check.iframeSrc) {
             if (Array.from(documentContext.getElementsByTagName('iframe')).some(iframe => iframe.src && iframe.src.includes(check.iframeSrc))) {
                formTypes.add(check.name + " (iframe detected)");
            }
        }
        if (check.name === 'Third-Party Embedded Form') {
            if (check.scriptSrcPatterns && Array.from(documentContext.scripts).some(s => s.src && check.scriptSrcPatterns.some(pattern => pattern.test(s.src)))) {
                formTypes.add(check.name + " (generic embed script detected)");
            }
            if (check.iframeSrcPatterns && Array.from(documentContext.getElementsByTagName('iframe')).some(iframe => iframe.src && check.iframeSrcPatterns.some(pattern => pattern.test(iframe.src)))) {
                formTypes.add(check.name + " (generic iframe detected)");
            }
            if (check.genericPlaceholderSelectors) {
                 for (const s of check.genericPlaceholderSelectors) {
                    try { if (documentContext.querySelector(s.trim())) { formTypes.add(check.name + " (placeholder element detected)"); break; } }
                    catch (e) { /* ignore */ }
                }
            }
        }
    });

    if (formTypes.size === 0 && forms.length > 0) {
        formTypes.add('Generic HTML Form(s)');
    }
    return formTypes.size > 0 ? Array.from(formTypes) : null;
}
// console.log("Offscreen script loaded with phone number and form detection.");
