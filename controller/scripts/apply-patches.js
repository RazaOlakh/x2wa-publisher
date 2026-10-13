// Applies the approved compatibility patches to the pinned whatsapp-web.js.
// Deterministic and idempotent: each patch verifies its expected source and
// replaces it exactly, so a rerun is a no-op and an upstream change fails loudly.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');

// Each patch: `from` must exist in an unpatched tree, `to` must not already exist.
const patches = [
    {
        name: 'PR #201824 media metadata fix',
        from: 'mediaMetadata: msg.avParams(),',
        to: "mediaMetadata: window.require('WAWebMediaMetadata').mediaMetadata(msg),",
    },
    {
        // WhatsApp only returns the rich link card (title/description/thumbnail)
        // when the preview request is made with the chat as context. Without it,
        // getLinkPreview(link) resolves to a bare domain-only card. The awaited
        // call is what "waits for the preview to load" before the message is sent.
        name: 'link preview: pass chat context on send',
        from: [
            '                let preview = await window',
            "                    .require('WAWebLinkPreviewChatAction')",
            '                    .getLinkPreview(link);',
        ].join('\n'),
        to: [
            '                let preview = null;',
            '                try {',
            '                    preview = await window',
            "                        .require('WAWebLinkPreviewChatAction')",
            '                        .getLinkPreview(link, { id: chat.id._serialized });',
            '                } catch (e) {',
            '                    preview = null;',
            '                }',
        ].join('\n'),
    },
    {
        // Same for edited messages; the chat id lives on the message id.
        name: 'link preview: pass chat context on edit',
        from: [
            '            if (link) {',
            '                const preview = await window',
            "                    .require('WAWebLinkPreviewChatAction')",
            '                    .getLinkPreview(link);',
            '                preview.preview = true;',
            "                preview.subtype = 'url';",
            '                options = { ...options, ...preview };',
            '            }',
        ].join('\n'),
        to: [
            '            if (link) {',
            '                let preview = null;',
            '                try {',
            '                    preview = await window',
            "                        .require('WAWebLinkPreviewChatAction')",
            '                        .getLinkPreview(link, { id: msg.id.remote });',
            '                } catch (e) {',
            '                    preview = null;',
            '                }',
            '                if (preview && preview.data) {',
            '                    preview = preview.data;',
            '                    preview.preview = true;',
            "                    preview.subtype = 'url';",
            '                    options = { ...options, ...preview };',
            '                }',
            '            }',
        ].join('\n'),
    },
];

if (!fs.existsSync(file)) {
    console.error('[patch] whatsapp-web.js not installed at', file);
    process.exit(1);
}

let src = fs.readFileSync(file, 'utf8');
let changed = 0;
let failed = false;

for (const patch of patches) {
    if (src.includes(patch.to)) {
        console.log(`[patch] already applied: ${patch.name}`);
        continue;
    }
    if (!src.includes(patch.from)) {
        console.error(`[patch] expected source not found for "${patch.name}"; upstream changed unexpectedly`);
        failed = true;
        continue;
    }
    src = src.replace(patch.from, patch.to);
    changed++;
    console.log(`[patch] applied: ${patch.name}`);
}

if (failed) {
    process.exit(1);
}
if (changed > 0) {
    fs.writeFileSync(file, src);
}
console.log(`[patch] done (${changed} change${changed === 1 ? '' : 's'})`);
