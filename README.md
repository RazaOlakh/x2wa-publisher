# X → WhatsApp Channel Poster

A standalone Chrome extension that posts content from X.com directly to a WhatsApp Channel.

## Prerequisites

- `node` ≥ 18
- `ffmpeg` and `ffprobe` in PATH
- Google Chrome (non-personal profile and dedicated WhatsApp account required)

## Quick start

### 1. Install the controller dependencies

```bash
cd controller
PUPPETEER_SKIP_DOWNLOAD=1 npm install   # also runs scripts/apply-patches.js
```

### 2. Make the controller start automatically at login

**Linux** (per-user systemd unit, no `sudo` needed):

```bash
./scripts/install-startup.sh install      # writes ~/.config/systemd/user/x2wa-controller.service
./scripts/install-startup.sh status       # is it running?
./scripts/install-startup.sh restart
journalctl --user -u x2wa-controller -f  # follow the log
./scripts/install-startup.sh uninstall    # stop and remove (keeps your WhatsApp session)
```

**Windows** (per-user Startup-folder launcher, no administrator rights):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1 install
powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1 status
powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1 restart
powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1 uninstall
```

Prerequisites on both: Node.js 18+ on `PATH`, `ffmpeg`/`ffprobe` on `PATH`
(Windows: e.g. `winget install Gyan.FFmpeg`), and Google Chrome.

To run it by hand instead: `cd controller && node src/server.js`.

### 3. Load the extension

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → select
the `extension/` folder.

### 4. Link WhatsApp (once)

Open the extension popup. If the controller is running, the popup shows the
status; press **Authenticate WhatsApp** and scan the QR with the dedicated
WhatsApp account (phone → Linked Devices → Link a Device). The controller
also prints the QR in its terminal/journal.

After this scan the session is reused: later starts, restarts and reboots
reconnect without asking again. The popup only shows a QR when a scan is
actually required.

### 5. Pick a destination channel

In the popup, choose a channel. Only channels this account can **post to**
(admin/owner) are listed — channels it merely follows are hidden.

### 6. Post

On X, each post shows a **Post to WhatsApp** button.

## Where the WhatsApp session is stored

One stable, per-user directory holds `LocalAuth` credentials, so a restart or
reboot never needs a new scan:

| OS | Session directory (default) |
|---|---|
| Linux | `~/.local/share/x-whatsapp-poster/whatsapp-session` (or `$XDG_DATA_HOME/x-whatsapp-poster/whatsapp-session`) |
| Windows | `%LOCALAPPDATA%\x-whatsapp-poster\whatsapp-session` |
| macOS | `~/Library/Application Support/x-whatsapp-poster/whatsapp-session` |

`GET /status` reports the directory actually in use. Override with the
`SESSION_DIR` environment variable (the systemd unit and the Windows launcher
set it explicitly). Session files are only ever touched by the controller on
this computer — never by the extension, and never your personal WhatsApp
session. A lock file in the session directory stops a second controller from
using it at once.

## Channel eligibility

The popup must not offer a channel this account cannot post to. Being
*visible* in WhatsApp Web is not proof of that, so each channel is checked
against the server's own membership data:

```
WAWebNewsletterMetadataQueryJob.queryNewsletterMetadataByJid(channelId)
  .newsletterMembershipMetadataMixin.membershipType   -> 'owner' | 'admin' | 'subscriber' | ...
```

A channel is offered only when that role is `owner`/`admin` (the same rule
`whatsapp-web.js` applies in `isMembershipAdminOrOwner`) and the channel is
not terminated. Anything that cannot be verified is hidden rather than
guessed. The same check runs again before each post, so a channel that lost
admin rights in the meantime refuses the publish
(`channel-not-permitted`) instead of failing silently.

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

- `GET /health` → `{ ok, state }`
- `GET /status` → `{ state, me, sessionDir, authRequired, jobs }` — `state`
  is the real WhatsApp state (`starting`, `qr`, `authenticated`, `ready`,
  `disconnected`, `auth_failure`, `error`, `stopped`)
- `GET /auth/qr` → `{ image }` where `image` is a self-contained SVG data URL
  of the pairing QR. Returns 404 when no scan is needed. The QR payload is
  never logged, persisted, or sent to the extension as text.
- `POST /auth/logout` → `{ confirm: true }` signs the account out (requires
  the explicit flag) and stops the client
- `GET /channels` → channels this account may post to (`channels`), plus
  `ineligible` for diagnostics; results cached 30s
- `POST /send` → `{ tweetId, tweetUrl, text, media: [{type, source}], mediaFailures?, channelId }`

  `media` is sent in the post's own order (images and videos interleaved);
  `mediaFailures` lists media items the extension could not resolve, so the
  response reports `partial` instead of a false success.

## Troubleshooting

- `whatsapp-not-ready` → wait for controller state to become `ready`.
- `ffprobe-validation-failed` → media format issue; switch post or file.
- `media-too-large` → oversized media.
- Video never starts sending → the post's video has no HLS manifest. A
  manifest is only used for the video it names: a video whose poster carries
  no id is matched only when the post's own document holds exactly one
  video. `video-master-unavailable` in the response means that video had no
  master playlist, which X uses for live/streamed clips (e.g. Periscope
  replays served from another host); it is reported, never substituted with
  another video's stream.

## Limitations

- Media-to-channel requires the compatibility patch above for the current WhatsApp Web internals.
- Channel eligibility depends on a WhatsApp Web internal
  (`WAWebNewsletterMetadataQueryJob`); if WhatsApp renames it, the controller
  hides every channel rather than listing channels it could not verify.
- Only an HLS *master* playlist is sent: a rendition such as
  `/pl/avc1/3840x2160/<token>.m3u8` is one video-only stream, and muxing it
  would publish a silent video. A video without a master is reported as a
  failure rather than sent without sound.
- Live/streamed clips (Periscope and similar) are not served from
  `video.twimg.com`, so they are reported as `video-id-unknown`.
