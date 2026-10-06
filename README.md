# X → WhatsApp Channel Poster

A standalone Chrome extension that posts content from X.com directly to a WhatsApp Channel.

## Prerequisites

- `node` ≥ 18
- `ffmpeg` and `ffprobe` in PATH
- Google Chrome (non-personal profile and dedicated WhatsApp account required)

## Quick start

```bash
cd controller
PUPPETEER_SKIP_DOWNLOAD=1 npm install   # runs scripts/apply-patches.js
node scripts/apply-patches.js           # or simply npm run patch
CONTROLLER_PORT=47825 \
SESSION_DIR=~/.local/share/x-whatsapp-poster/whatsapp-session \
node src/server.js
```

1. Open the dedicated WhatsApp number via WhatsApp Web on your phone, scan the QR.
2. Default channel ID can be found in the controller by `GET /status`.
3. In Chrome: `chrome://extensions` → enable Developer mode → Load unpacked — select the `extension/` folder.
4. In the extension popup set `Default Channel ID` and save.
5. On X, each post shows a "Post to WhatsApp" button.

## Architecture

```text
X.com
  ↓ content script (article text URL / photo / video)
Extension RSS SW
  ↓ 127.0.0.1:47825 POST /send
Controller
  ↓ whatsapp-web.js (dedicated LocalAuth)
WhatsApp Channel
```

## Dependency pin

- `whatsapp-web.js@1.34.7` at `064a3d5a5a3dce1281a6a12740b5a7051339d154`
- One patch applied automatically by `controller/scripts/apply-patches.js`:
  `mediaMetadata: window.require('WAWebMediaMetadata').mediaMetadata(msg),`
  (PR #201824). No other source edits.

## Security / isolation

- All WhatsApp operations are confined to `controller/` (loopback only).
- The extension never reads WhatsApp cookies/localStorage/QR/profile data.
- The controller never touches your personal Chrome or WhatsApp session.
- Temporary media lives at `~/.local/share/x-whatsapp-poster/tmp/<jobId>` and is deleted on completion/failure.
- ffmpeg is used to produce WhatsApp-safe H.264/AAC MP4; oversized media (>64 MB) is rejected.
- Duplicate posts for the same tweet+channel within 120s return the prior result.

## API

- `GET /health`
- `GET /status`
- `POST /send` → `{ tweetId, tweetUrl, text, media: [{type, source}], channelId }`

## Troubleshooting

- `whatsapp-not-ready` → wait for controller state to become `ready`.
- `ffprobe-validation-failed` → media format issue; switch post or file.
- `media-too-large` → oversized media.
- Video never starts sending → the controller needs a video manifest; disable autoplay blockers on the X tab or refresh.

## Limitations

- Media-to-channel requires the compatibility patch above for the current WhatsApp Web internals.
- `getChannels()` is still broken upstream; we rely on known channel IDs / stored channel settings.
