# X → WhatsApp Channel Poster

A Chrome extension that posts content from X.com straight to a WhatsApp Channel.
Text, single images, multi-image posts, video, and mixed image+video posts are all supported.

The project has two halves:

| Half | What it is | Where it runs |
|---|---|---|
| **Controller** (`controller/`) | A local Node service that owns the WhatsApp connection | Your machine, bound to `127.0.0.1` only |
| **Extension** (`extension/`) | Reads the X post and asks the controller to publish it | Chrome |

---

# Table of contents

1. [Requirements](#requirements)
2. [Install](#install)
3. [Start automatically at login](#start-automatically-at-login)
4. [Load the Chrome extension](#load-the-chrome-extension)
5. [Link your WhatsApp account](#link-your-whatsapp-account)
6. [Choose a destination channel](#choose-a-destination-channel)
7. [Post something](#post-something)
8. [Everyday operation](#everyday-operation)
9. [Where the files live](#where-the-files-live)
10. [Troubleshooting](#troubleshooting)
11. [How it works](#how-it-works)
12. [API](#api)
13. [Limitations](#limitations)

---

# Requirements

| Requirement | Linux | Windows |
|---|---|---|
| **Node.js 18+** | `sudo apt install nodejs` (Debian/Ubuntu) or [nodejs.org](https://nodejs.org) | [nodejs.org](https://nodejs.org) installer, or `winget install OpenJS.NodeJS` |
| **ffmpeg + ffprobe** | `sudo apt install ffmpeg` | `winget install Gyan.FFmpeg` |
| **Google Chrome** | `google-chrome-stable` | installed with Chrome |
| **A dedicated WhatsApp account** | see [Link your WhatsApp account](#link-your-whatsapp-account) | same |
| **git** | `sudo apt install git` | `winget install Git.Git` |

Check what you have:

```bash
node --version      # must be v18 or newer
ffmpeg -version     # must print a version
ffprobe -version
google-chrome --version    # or google-chrome-stable on Linux
```

> **Use a dedicated WhatsApp account.** Linking your personal number puts this
> bot session on your phone's Linked Devices list, where it is easy to confuse
> with your real chats. A spare number keeps channel posting clearly separate.

---

# Install

```bash
git clone <repo-url> x2wa-publisher
cd x2wa-publisher
cd controller
PUPPETEER_SKIP_DOWNLOAD=1 npm install
```

```powershell
git clone <repo-url> x2wa-publisher
cd x2wa-publisher\controller
$env:PUPPETEER_SKIP_DOWNLOAD="1"; npm install
```

**What that does**

- Installs the pinned `whatsapp-web.js` from `controller/vendor/` (already in
  the repository — no external tarball needed) plus `qrcode-terminal` and
  `qrcode-generator`.
- Runs `scripts/apply-patches.js`, which applies the WhatsApp Channel media
  patch. It prints `[patch] applied PR #201824 media metadata fix` on a fresh
  install, or `[patch] PR #201824 already applied` if you re-run it.
- `PUPPETEER_SKIP_DOWNLOAD=1` avoids a ~250 MB Chromium download that this
  project does not use (the controller drives your installed Chrome).

**Verify the install:**

```bash
node test/dependency.test.js      # -> DEPENDENCY VERIFIED
node test/controller.test.js      # -> ALL CONTROLLER TESTS PASSED
```

`dependency.test.js` fails loudly if the library version, the Channel media
patch, or the WhatsApp Web message-ID compatibility fixes are missing — run it
after any dependency change.

---

# Start automatically at login

You should never have to start the controller by hand after a reboot.

## Linux — per-user systemd service

No `sudo`, no root. The unit lives in your own user directory.

```bash
./scripts/install-startup.sh install
```

That writes `~/.config/systemd/user/x2wa-controller.service`, enables it for
`default.target`, starts it, and waits for the controller to report ready.

| Command | What it does |
|---|---|
| `./scripts/install-startup.sh status` | Shows the unit status **and** the controller's own `/status` (state, session dir) |
| `./scripts/install-startup.sh restart` | Restarts it and prints the new status |
| `./scripts/install-startup.sh logs` | Follows the journal (`journalctl --user -u x2wa-controller -f`) |
| `./scripts/install-startup.sh uninstall` | Disables and removes the unit. **Your WhatsApp session is left untouched** |

The unit:

- starts at every login, and restarts on failure up to 5 times in 2 minutes
  before systemd gives up (so a crash cannot spin forever)
- runs the absolute path to your `node` and to `controller/src/server.js`
- writes logs to the journal — connection state, job ids, results, and never
  QR payloads, cookies or session secrets

**Verify it works:**

```bash
systemctl --user is-enabled x2wa-controller    # -> enabled
systemctl --user is-active x2wa-controller     # -> active
curl -s http://127.0.0.1:47825/status
```

```json
{ "state": "ready", "me": { "_serialized": "…@c.us" }, "sessionDir": "…" }
```

To also keep it running while you are logged out, enable lingering (once):

```bash
sudo loginctl enable-linger "$USER"   # optional; requires sudo
```

### Using a different session directory on Linux

The installer honours `SESSION_DIR` if you export it first:

```bash
SESSION_DIR=/custom/path ./scripts/install-startup.sh install
```

The value is baked into the unit file; re-running `install` regenerates it.

## Windows — Startup-folder launcher

No administrator rights, no scheduled task, no stored credentials.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1 install
```

This writes `x2wa-controller.cmd` into your user's **Startup** folder, so the
controller starts when you log in.

| Command | What it does |
|---|---|
| `… install-startup.ps1 install` | Writes the launcher (checks Node, dependencies and ffmpeg first) |
| `… install-startup.ps1 status` | Shows whether the controller process runs, the `/status` state, and whether the startup entry exists |
| `… install-startup.ps1 restart` | Stops the controller and starts it again through the launcher |
| `… install-startup.ps1 uninstall` | Removes the launcher and stops the controller. **Your WhatsApp session is left untouched** |

The generated launcher:

- resolves `node.exe` and Chrome to **absolute paths at install time** — a
  logon session does not reliably inherit a `PATH` that changed after you
  installed Node
- refuses to start a second controller (it checks whether port 47825 is
  already listening)
- appends everything to `%LOCALAPPDATA%\x-whatsapp-poster\controller.log`
- writes an explicit error line if `node.exe` is missing, and verifies the
  controller answered ~8 seconds after starting, so a failed launch is
  reported rather than silent

**Verify it works:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1 status
Get-Content "$env:LOCALAPPDATA\x-whatsapp-poster\controller.log" -Tail 20
```

> **Status of Windows support:** the Linux path has been exercised end to end on
> a real machine. The Windows path is implemented and its launcher contract is
> covered by automated static checks
> (`node scripts/windows/startup.test.js`), but it has **not** been run on a
> physical Windows host — treat the first run as something to verify with
> `status` and the log file.

## Running it manually (either OS)

Useful for debugging, or if you don't want it to start at login:

```bash
cd controller
SESSION_DIR=~/.local/share/x-whatsapp-poster/whatsapp-session node src/server.js
```

```powershell
cd controller
$env:SESSION_DIR="$env:LOCALAPPDATA\x-whatsapp-poster\whatsapp-session"
node src/server.js
```

Press **Disconnect** in the popup before stopping it by hand if you want the
session closed cleanly.

---

# Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the **`extension/`** folder inside the project (not the project root)

The popup icon appears in Chrome's toolbar. Pin it for one-click access:
right-click the icon → **Pin**.

> Loading an unpacked extension is a developer workflow. If Chrome is updated,
> or the extension folder is moved, reload it from `chrome://extensions`
> (**Reload** button). Your channel preference survives reloads — it is stored
> in the extension, not in the controller.

---

# Link your WhatsApp account

Do this once, with the **dedicated** account.

1. Open the extension popup.
2. The popup checks the controller automatically. If it says
   *Controller not running*, use the startup script — see
   [Troubleshooting](#troubleshooting).
3. Press **Authenticate WhatsApp**.
4. Scan the QR code shown in the popup:
   - on the phone, open **WhatsApp** → **Linked Devices** → **Link a Device**
   - point the phone at the code

The controller also prints the QR in its own output (terminal, or the journal
/ log file) if that is easier.

Once paired, the session is stored on disk and reused. Restarts, reboots and
extension reloads do **not** require another scan. The popup only shows a QR
when a scan is genuinely needed — for example the first time, or after you
press **Disconnect** or unlink the device from your phone.

To unlink deliberately, use **Disconnect** in the popup. It asks for
confirmation, signs the account out, and immediately offers a fresh QR.

---

# Choose a destination channel

Pick a channel from the popup's **Destination channel** list.

Only channels this account can actually **post to** are listed. Channels where
the account is merely a subscriber are hidden, because posting there is not
possible and would fail at send time. The list is re-checked before every post,
so if the account loses admin rights the post is refused
(`channel-not-permitted`) instead of failing silently.

Your choice is remembered. If a saved channel stops being eligible, it is
cleared and the popup explains why, rather than leaving you posting to nowhere.

---

# Post something

Go to x.com, and every post gets a **Post to WhatsApp** button.

| The post contains | What is published |
|---|---|
| Text only | one text message |
| One image | one image |
| Text + one image | image with the text as caption |
| One video | one video |
| Text + one video | video with the text as caption |
| Several images | every image, in post order |
| Several videos | every video, in post order |
| Text + several media | text as the caption of the **first** item only |
| Images and videos mixed | every item, in the post's original order |

### What the button shows

The button is a small icon that changes as the post is sent, so you can see the
outcome without opening anything:

| State | Icon | Colour | Meaning |
|---|---|---|---|
| Idle | WhatsApp glyph | green | ready — click to post |
| Working | spinner | grey | posting (the spinner keeps turning) |
| Success | check mark | teal | everything was published |
| Partial | warning | amber | some items published, some could not be fetched |
| Error | cross | red | nothing was published |

There is no text on the button. Hover it for a tooltip with the detail
(for example *Partial 3/4* or *Err: channel-not-permitted*), and the same
information is exposed to screen readers as an `aria-label`.

It returns to the WhatsApp icon a few seconds after finishing.

### The notification

Because the button carries no text, the outcome is also announced in a
snackbar at the bottom centre of the page:

| Kind | Looks like | Example |
|---|---|---|
| Success | teal edge, check | **Posted to Test** — *Your post is in the channel.* |
| Info | blue edge, info | **Partly posted** — *2 of 4 items reached the channel…* |
| Error | red edge, cross | **Could not post** — *This account cannot post in that channel…* |

Each snackbar can be dismissed with its **×** and disappears on its own after
a few seconds (errors linger longer, since they usually need reading). At most
three are shown at once. Errors are written in plain language rather than
error codes, for example:

| Cause | What you are told |
|---|---|
| `channel-not-permitted` | pick a different channel in the popup |
| `permission-check-failed` | could not confirm permission — please try again |
| `duplicate-send` | this post already went to that channel moments ago |
| `Failed to fetch` | the controller is not reachable |

A post is never silently downgraded: if an image or video cannot be retrieved,
the partial state is shown rather than quietly dropping the item.

---

# Everyday operation

| I want to… | Linux | Windows |
|---|---|---|
| Check it is running | `./scripts/install-startup.sh status` | `… install-startup.ps1 status` |
| Restart it | `./scripts/install-startup.sh restart` | `… install-startup.ps1 restart` |
| Read the log | `./scripts/install-startup.sh logs` | `Get-Content "$env:LOCALAPPDATA\x-whatsapp-poster\controller.log" -Tail 50` |
| Stop it | `systemctl --user stop x2wa-controller` | `Stop-Process -Name node` (or uninstall) |
| Start it | `systemctl --user start x2wa-controller` | run the launcher in the Startup folder |
| Remove it from login | `./scripts/install-startup.sh uninstall` | `… install-startup.ps1 uninstall` |

**After sleep or a dropped connection:** the controller notices that WhatsApp is
no longer reachable, reports *Reconnecting…*, and rebuilds the connection from
the saved session by itself — no button to press and no QR scan. The popup
shows *Reconnecting to WhatsApp…* and the channels come back on their own.

You do not have to wait for a post to fail to find out. A heartbeat every 30
seconds checks that the WhatsApp page is still really there, and notices when
it arrives far too late — which is what waking from sleep looks like, since
timers do not run while a machine is suspended. Either signal rebuilds the
connection, so the controller is normally back on its own within seconds of
waking, before you click anything.

Stopping the controller shuts the WhatsApp browser down properly rather than
leaving it behind holding the session profile, so `systemctl --user restart`
is quick and never leaves the next start unable to launch its browser.

**Changing the port:** set `CONTROLLER_PORT` for both the controller and the
extension (`CONTROLLER` in `extension/background/service-worker.js` and
`extension/popup/popup.js`).

---

# Where the files live

One stable, per-user directory holds the WhatsApp session, so a restart or a
reboot never needs a new scan.

| | Linux | Windows |
|---|---|---|
| Session (`LocalAuth`) | `~/.local/share/x-whatsapp-poster/whatsapp-session` | `%LOCALAPPDATA%\x-whatsapp-poster\whatsapp-session` |
| Temporary media | `~/.local/share/x-whatsapp-poster/tmp/` | `%LOCALAPPDATA%\x-whatsapp-poster\tmp\` |
| Logs | journal: `journalctl --user -u x2wa-controller` | `%LOCALAPPDATA%\x-whatsapp-poster\controller.log` |
| Service/launcher | `~/.config/systemd/user/x2wa-controller.service` | Startup folder: `x2wa-controller.cmd` |

(`$XDG_DATA_HOME` is honoured on Linux if set; macOS uses
`~/Library/Application Support/x-whatsapp-poster/`.)

`curl -s http://127.0.0.1:47825/status` always reports the directory actually
in use, so you never have to guess. Override it with the `SESSION_DIR`
environment variable if you want the session somewhere else.

**Backing up your pairing:** copy the session directory somewhere safe. Put it
back to restore the pairing without a new QR scan.

**Clearing everything:** stop the controller, delete the session directory,
and start again — you will be asked to scan a new QR.

A lock file inside the session directory prevents two controllers from opening
the same WhatsApp session at once, which would corrupt it.

---

# Troubleshooting

## The popup

| The popup says | Meaning and fix |
|---|---|
| **Controller not running** | The startup script should have started it. Linux: `./scripts/install-startup.sh status`, then `restart`. Windows: run `… install-startup.ps1 status`. If it is not installed at all, run `install`. |
| **Connecting to WhatsApp…** | Still starting up. It normally resolves on its own within ~30 seconds. |
| **Reconnecting to WhatsApp…** | The connection dropped (common after sleep). It retries automatically; channels reappear by themselves. |
| **Authentication required / QR** | This computer is not linked yet, or the session was invalidated. Press **Authenticate WhatsApp** and scan. |
| **Authentication failed** | The saved session was rejected. Scan a new QR, or re-link the device from the phone's Linked Devices. |
| **Not linked to WhatsApp** | You signed out with **Disconnect**. Press **Authenticate WhatsApp** to pair again. |
| **No channels found that this account can post to** | The account is not an admin/owner of any channel. Create one, or have an existing owner add this account as admin, then reload. |
| **Channels could not be read from WhatsApp right now** | Transient. The controller retries on its own; if it persists, restart the service. |

## Installation problems

| Symptom | Fix |
|---|---|
| `npm install` fails on the library | Run from `controller/` — the vendored library is at `controller/vendor/`. |
| `Node.js 18+ not found in PATH` | Install Node, **reopen the terminal**, and re-run. |
| `controller dependencies missing` | `cd controller && npm install` |
| `ffmpeg not found` (warning at install, videos will fail) | Install ffmpeg and re-open the terminal. |
| `another controller (pid …) is already using …` | A previous controller is still running. Stop it, or use `restart`. |
| `The controller did not report ready yet` | Read the log (table above) to see why, then `restart`. |

## Posting problems

| Response | Meaning |
|---|---|
| `whatsapp-not-ready` | WhatsApp is not connected yet — wait for `ready`. |
| `channel-not-permitted` | The account lost admin/owner rights for that channel. Pick another. |
| `duplicate-send` | The same post was already sent to that channel in the last 120 seconds. |
| Blue "Partly posted" snackbar | Some media could not be retrieved; the rest was published. The counts are in the snackbar. |
| `ffprobe-validation-failed` | The video could not be processed. Try another post. |
| `media-too-large` | The media exceeds 64 MB. |
| `video-master-unavailable` / `video-id-unknown` | X did not expose a usable stream — typical for live or streamed clips such as Periscope replays. It is reported, never substituted with another video. |

## Logs

The controller logs one JSON object per line: timestamp, level, event, plus
context such as request id, job id, tweet id and channel id. It never logs QR
payloads, cookies, credentials or session data.

```bash
journalctl --user -u x2wa-controller -n 100            # Linux
journalctl --user -u x2wa-controller -f | grep '"event":"send-job-complete"'
```

```powershell
Get-Content "$env:LOCALAPPDATA\x-whatsapp-poster\controller.log" -Tail 100   # Windows
```

---

# How it works

```text
X.com
  ↓ content script: text, links, images, videos (in post order)
Extension service worker
  ↓ resolves each video to the HLS manifest that names it
  ↓ POST http://127.0.0.1:47825/send
Controller (Node, loopback only)
  ↓ whatsapp-web.js + LocalAuth session
WhatsApp Channel
```

**Channel eligibility.** Being visible in WhatsApp Web is not proof that the
account may post, so each channel is checked against the server's own
membership data:

```
WAWebNewsletterMetadataQueryJob.queryNewsletterMetadataByJid(channelId)
  .newsletterMembershipMetadataMixin.membershipType   → 'owner' | 'admin' | 'subscriber' | …
```

A channel is offered only for `owner`/`admin` and is not terminated. Anything
that cannot be verified is hidden rather than guessed.

**Videos.** X names each video in both its poster
(`pbs.twimg.com/amplify_video_thumb/<id>/…`) and its stream
(`video.twimg.com/amplify_video/<id>/…`). The extension captures manifests per
tab and per video id, so a post can only ever get manifests belonging to its
own videos — never whatever the page loaded last. Only an HLS **master**
playlist is sent, because a rendition is a single video-only stream and would
produce a silent video.

## Security / isolation

- The controller binds to `127.0.0.1` only; nothing is reachable from the network.
- The extension never reads WhatsApp cookies, local storage, QR data or profile data.
- Session files live only in the dedicated per-user directory, owned by the controller.
- Temporary media is deleted as soon as a job finishes or fails.
- ffmpeg produces WhatsApp-safe H.264/AAC MP4; media over 64 MB is rejected.
- The same post cannot be sent to the same channel twice within 120 seconds.

## Dependency pin

- `whatsapp-web.js@1.34.7`, installed from the committed artifact
  `controller/vendor/whatsapp-web.js-1.34.7.tgz`. See
  `controller/vendor/README.md` for its sha256 and why the published npm build
  cannot be used (it lacks the WhatsApp Web `_serialized` → `$1` message-ID
  compatibility fixes).
- One patch is applied automatically by `controller/scripts/apply-patches.js`:
  `mediaMetadata: window.require('WAWebMediaMetadata').mediaMetadata(msg),`
  (PR #201824). No other source edits.
- `node controller/test/dependency.test.js` verifies the installed build.

# API

The controller is a small local HTTP API on `127.0.0.1:47825`. Useful for
debugging, and for scripting a check:

| Endpoint | Returns |
|---|---|
| `GET /health` | `{ ok, state }` |
| `GET /status` | `{ state, me, sessionDir, authRequired, reconnecting, jobs }` — `state` is the **real** WhatsApp state: `starting`, `qr`, `authenticated`, `ready`, `reconnecting`, `disconnected`, `auth_failure`, `error`, `stopped`, `auth_required` |
| `GET /auth/qr` | `{ image }` — the pairing QR as a self-contained SVG data URL. 404 when no scan is needed. The QR payload is never logged, persisted, or sent to the extension as text |
| `POST /auth/start` | Idempotent: reconnects, or starts pairing if there is nothing to reconnect to |
| `POST /auth/logout` | `{ confirm: true }` — signs the account out (the flag is required) and offers a fresh QR |
| `GET /channels` | `{ channels, checked, ineligible }` — only channels this account may post to; `ineligible` is kept for diagnostics; results are cached for 30s |
| `POST /send` | `{ tweetId, tweetUrl, text, media: [{type, source}], mediaFailures?, channelId }` |

`/send` publishes `media` in the post's own order (images and videos
interleaved) and captions only the first item with `text`. `mediaFailures`
lists items the extension could not resolve, so the response reports `partial`
instead of a false success. Posting rights are re-checked before every send.

```bash
curl -s http://127.0.0.1:47825/status
curl -s http://127.0.0.1:47825/channels
```

## Tests

```bash
node controller/test/dependency.test.js      # vendored library + patches intact
node controller/test/controller.test.js      # session paths, single-instance lock, channel eligibility
node extension/test/popup-states.test.js     # every popup state, incl. reconnecting and signed-out
node scripts/windows/startup.test.js         # Windows launcher contract (static)
```

---

# Limitations

- Channel eligibility depends on a WhatsApp Web internal
  (`WAWebNewsletterMetadataQueryJob`). If WhatsApp renames it, the controller
  hides every channel rather than listing channels it could not verify.
- Media upload depends on the compatibility patch above for current WhatsApp
  Web internals.
- Windows startup has **not** been run on a physical Windows host; only static
  checks cover it.
- Only HLS master playlists are sent; a video without one is reported as a
  failure rather than published without sound.
- Live/streamed clips (Periscope and similar) are not served from
  `video.twimg.com`, so they are reported as `video-id-unknown`.
- Chrome is driven by the controller in headless mode; the WhatsApp Web session
  it uses is separate from your personal Chrome.