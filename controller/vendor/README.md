# Vendored dependency: `whatsapp-web.js` 1.34.7

`controller/package.json` installs `whatsapp-web.js` from
`controller/vendor/whatsapp-web.js-1.34.7.tgz`, which is committed to this
repository so `npm install` works from a clean clone.

    sha256  83f886bb7883ad3a79875e6200ad7b76f5971f93de6b91016e6387108cc3d22a
    size    106814 bytes

## Why it is vendored instead of taken from the npm registry

The published `whatsapp-web.js@1.34.7` on npm does **not** work against the
current WhatsApp Web. This tarball is upstream 1.34.7 plus the local
compatibility fixes that make the controller function:

| Fix | Why it is needed |
|---|---|
| Normalise `_serialized` → `$1` on message/chat IDs (`msg.id._serialized \|\| msg.id.$1`) | WhatsApp Web renamed the serialized-ID field to `$1` (2026-07 update). Without this, `whatsapp-web.js` looks messages up by an undefined key and `sendMessage()`/event handling breaks. |
| Delete the colliding `__x_id` from serialised `MediaData` | `MediaData.__x_id` collides with `Msg`'s internal id when enumerable properties are spread, breaking `getValidatedSender()` during `Msg` initialisation. |
| `PR #201824` media metadata fix, applied by `scripts/apply-patches.js` at install time | `mediaMetadata: window.require('WAWebMediaMetadata').mediaMetadata(msg)` replaces `msg.avParams()`, which is required for channel media to upload. |

Verified: the npm tarball contains none of the first two fixes, so simply
switching `package.json` to `"whatsapp-web.js": "1.34.7"` would silently
regress the WhatsApp integration.

## Patching

`postinstall` runs `scripts/apply-patches.js`, which rewrites one exact line
in `node_modules/whatsapp-web.js/src/util/Injected/Utils.js` and refuses to
continue if the expected source line is missing (upstream changed). It is
idempotent: re-running it reports "already applied".

## Verifying an install

```bash
cd controller
node test/dependency.test.js
```

The test asserts the installed package version, that `PR #201824` is applied,
and that the `_serialized`/`$1` and `__x_id` fixes are present.