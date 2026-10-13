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
- runs `controller/src/supervisor.js`, which starts the controller and starts
  it again whenever it stops — so a crash, a closed browser or a killed
  process recovers on its own instead of staying down until the next logon
- refuses to start a second controller (it checks whether port 47825 is
  already listening)
- appends everything to `%LOCALAPPDATA%\x-whatsapp-poster\controller.log`
- writes an explicit error line if `node.exe` is missing, and verifies the
  controller answered ~8 seconds after starting, so a failed launch is
  reported rather than silent

**Windows and Linux keep it up in the same way.** There is no service manager
on Windows, so the launcher runs a small supervisor that does what systemd's
`Restart=on-failure` does on Linux: if the controller stops, it is started
again after a short wait. A few quick failures in a row (a crash loop, not a
transient fault) stop the supervisor with a clear log line rather than
spinning forever — the same start-limit idea as the systemd unit.

The supervisor is why you no longer have to notice that the controller did not
come up, or bring it back by hand. If it *is* down, `status` and the log will
say why.

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

Go to x.com, and every post gets the extension's **toolbar**: a row of its own
icons, sitting directly beneath the post's own action bar (reply, repost, like,
share). New actions go in that row; for now it holds the **Post to WhatsApp**
button, a duplicate **Post with the author's name** button (the `@` icon), a
duplicate **Post in Urdu** button (the globe icon), and the screenshot button.

The toolbar is the extension's own row rather than extra buttons inside X's
action bar, so X's layout cannot squeeze them and the two sets of controls stay
visually separate. The icons are minimal line icons — outlined, with no
background and no filled shape.

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

When a post has **no media of its own** and its text contains a link, the first
link is placed at the top of the message, on its own line, with the rest of the
text below it. So

```
Helllo
example.com
how are your?
```

is posted as

```
example.com
Helllo
how are your?
```

The Channel then shows the link preview above the words instead of buried
inside them. A post that has media keeps its text exactly as written — there the
text is a caption beside the picture, not the whole post.

### Link previews

A text post that contains a link is sent with WhatsApp's **link preview card** —
the page's title, description and thumbnail, shown above the message.

WhatsApp only returns the full card when the preview request carries a **chat
context**. The pinned `whatsapp-web.js` build requested previews with no context,
so WhatsApp answered with a bare `domain.com` line and no image. The controller
now requests the preview with the destination Channel as context and *awaits* it
before sending, so the card is complete (title and picture) rather than just the
domain. That is the programmatic equivalent of typing the link into the Channel's
message box and waiting for the preview to appear before hitting send.

`controller/scripts/apply-patches.js` applies this to the vendored client, and
`controller/test/dependency.test.js` guards it. If a link's preview cannot be
fetched, the message is still sent — only without the card.

### Naming the author

Beside the post button there is a duplicate of it — marked with an **`@`** icon
instead of the WhatsApp bubble — that puts the **author's name on top of the
post**. A post by Imran Khan is sent as

```
Imran Khan's Tweet

<the post>
```

The name is read from the post's own byline — the display name only, never the
`@handle`, the timestamp, or the author of a quoted post nested inside it. If
the name cannot be read, the post is still sent, just without the header.

The header goes above whatever the post's text already is, so a text post's
link-first order (above) is kept beneath the name. Both send buttons publish the
same post; the only difference is that one names the author.

### Posting in Urdu

Beside the other two send buttons there is a third — marked with a **globe**
icon — that has the post's **text translated to Urdu** before it is sent. A post
with media is translated too: the text becomes the caption, in Urdu, and the
images or video go with it unchanged.

The translation happens in the **controller**, not the browser: it is a small
request to Google's keyless translate endpoint (the same one a dictionary
lookup uses), made from the local controller so it is not subject to the page's
origin rules and so the request and its outcome are logged in one place. Only
the post's **text** is sent to it. A URL in the text is left exactly as it is, so
a text post's link-first order — and the preview card it earns — still works,
and the words around it arrive in Urdu.

If the translation cannot be fetched, the post is **not** sent in the wrong
language: the button reports `Could not translate this post just now` and the
post can be tried again.

This endpoint is Google's and is not an official, supported API. It is used
because it needs no key and no setup, but it is a network request that leaves
your machine, and it is the one part of this tool that sends post content
anywhere other than WhatsApp. See
[Security / isolation](#security--isolation). To use a different translator,
change `translateText` in `controller/src/translate.js`; it is the only place
translation happens.

### Sending a screenshot of the post

Beside the post button, in the same toolbar row, there is a camera button that
sends **a picture of the post itself** — the text, images and layout as they
appear — instead of the post's own media. Useful when you want the Channel to
look like what you saw, rather than a pile of separate images and videos.

The capture is of that one post, not of the window or the page: the crop is
computed from the post's own position on the page, and the post does not have
to be fully on screen to be captured.

What the picture contains is the post itself — the author, the text, and any
images or quoted card. It stops above the post's action bar (reply / repost /
like / share), which, together with this extension's own row beneath it, is a
row of controls rather than part of the post. A screenshot is therefore of the
post as written, with no interface around it.

The page's own floating furniture — the top bar with its **For you / Following**
tabs, and any overlay or toast — is fixed or sticky, and a capture taller than
the window would paint it on top of the post. It is hidden for the length of the
capture and shown again immediately afterwards, so the picture carries the post
and not the bar floating over it. Nothing the post is inside, or that is inside
the post, is ever hidden.

The box is found from the button itself — the post is the nearest post element
above the clicked button. A container that holds more than one post (the
timeline list, or a thread module) is refused rather than cropped, so a
neighbouring post can never end up in the picture. The action bar that the
crop stops above is found from the post's **like** button, and a quoted post's
own like row inside the post is skipped, so the wrong row is never used as the
cut-off.

Capturing needs the extension's **debugger** permission. It is attached for
the length of one capture and detached immediately afterwards, and only ever
to the tab you clicked in. The alternative — `chrome.tabs.captureVisibleTab` —
can only ever photograph the whole viewport, and reaching it would mean asking
for `<all_urls>`, which is a view of every site you visit. That is a much
larger permission than this needs, so it is not used.

| The popup says | Meaning |
|---|---|
| **Could not capture** | The capture did not happen. The usual cause is Developer Tools being open on that tab — close it and try again. |
| **Nothing could be captured from this post** | The post was not on screen, so there was no box to capture. |

What a screenshot **cannot** include:

- **Playing video.** A video frame is captured as whatever is on screen at that
  moment, which is often the poster image or a black rectangle. Use the post
  button when you want the video itself.
- **Content below the fold that has not loaded yet.** Lazy-loaded images that
  have not appeared are simply absent.
- **Anything the page has not rendered** — expanded threads are captured in
  their collapsed state.
- **Private or cross-origin frames** X does not paint into the page.

Screenshots are deduplicated separately from posts, so photographing a post
does not stop you posting it, and posting it does not stop you photographing
it.

### What the buttons show

Each send button is a small, outlined icon — no background, no filled shape —
that changes as the post is sent, so you can see the outcome without opening
anything. The three send buttons share every state; only the idle glyph tells
them apart (the WhatsApp bubble, the `@`, the globe). Their colour and glyph
both change:

| State | Icon | Colour | Meaning |
|---|---|---|---|
| Idle | WhatsApp / `@` / globe glyph | grey | ready — click to post |
| Working | spinner | blue | posting (the spinner keeps turning) |
| Success | check mark | green | everything was published |
| Partial | warning | amber | some items published, some could not be fetched |
| Error | cross | red | nothing was published |

There is no text on a button. Hover it for a tooltip with the detail
(for example *Partial 3/4* or *Err: channel-not-permitted*), and the same
information is exposed to screen readers as an `aria-label`.

**A post that was sent keeps its tick.** It does not turn back into its idle
icon, and scrolling away and back does not lose it — the sent post is
remembered, so the tick comes back with the post when X rebuilds the page. All
three send buttons show it, since they publish the same post. Hover it to see
*already sent*. Clicking it still works, if you ever want to send that post
again (the controller refuses a repeat within two minutes).

Anything that did not go through — a failure, or a post X would not let us
read — goes back to its idle icon after a few seconds, so you can simply click
again and try once more.

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
| `translate-failed` | could not translate this post just now — please try again |
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

**If it stops entirely:** both platforms start it again on their own. Linux
uses the systemd unit (`Restart=on-failure`); Windows uses the supervisor the
launcher runs. You do not have to bring it back by hand — `status` and the log
are there if you want to know what happened.

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
| Service/launcher | `~/.config/systemd/user/x2wa-controller.service` | Startup folder: `x2wa-controller.cmd` → runs `controller/src/supervisor.js` |

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
| **Controller not running** | It should keep itself up: the startup script on Linux, the supervisor the launcher runs on Windows, restart it if it stops. If it is still down, Linux: `./scripts/install-startup.sh status`, then `restart`. Windows: `… install-startup.ps1 status`. If it is not installed at all, run `install`. |
| **Connecting to WhatsApp…** | Still starting up. It normally resolves on its own within ~30 seconds. |
| **Reconnecting to WhatsApp…** | The connection dropped (common after sleep). It retries automatically; channels reappear by themselves. |
| **Authentication required / QR** | This computer is not linked yet, or the session was invalidated. Press **Authenticate WhatsApp** and scan. |
| **Authentication failed** | The saved session was rejected. Scan a new QR, or re-link the device from the phone's Linked Devices. |
| **Not linked to WhatsApp** | You signed out with **Disconnect**. Press **Authenticate WhatsApp** to pair again. |
| **No channels found that this account can post to** | The account is not an admin/owner of any channel. Create one, or have an existing owner add this account as admin, then reload. |
| **Channels could not be read from WhatsApp right now** | Transient. The controller retries on its own; if it persists, restart the service. |

### Keeping it up to date

The popup has a **Version** card showing the branch, the short commit and
whether anything newer is waiting on the remote. Reading that is local and
free, so it never holds the popup up; **Check for updates** is the button
that actually goes to the network.

| The popup says | Meaning |
|---|---|
| **Up to date** | This checkout matches the remote. |
| **N updates available** | Press **Update now**, then confirm. |
| **N local commits ahead** | Commits here the remote has not seen. Push them yourself. |
| **Update status unknown** | Nothing has been asked yet — press **Check for updates**. |
| **Could not reach the remote** | The remote could not be asked. The numbers shown are the last known ones, not a fresh answer. |
| **Local changes** | Uncommitted edits to tracked files, so updating is not offered rather than being refused later. Untracked files do not count. |

Updating **fast-forwards** your checkout to the latest commit on the remote.
It never creates a merge commit, never stashes your work, and is refused
outright if any tracked file has uncommitted edits. Untracked files do not
block it — a fast-forward cannot lose them, and if an incoming file would
overwrite one, git refuses the pull itself. What changed decides what happens
next: only changes under `extension/` reload the extension, only changes under
`controller/` restart the controller.

## Installation problems

| Symptom | Fix |
|---|---|
| `npm install` fails on the library | Run from `controller/` — the vendored library is at `controller/vendor/`. |
| `Node.js 18+ not found in PATH` | Install Node, **reopen the terminal**, and re-run. |
| `controller dependencies missing` | `cd controller && npm install` |
| `ffmpeg not found` (warning at install, videos will fail) | Install ffmpeg and re-open the terminal. |
| `another controller (pid …) is already using …` | A previous controller is still running. Stop it, or use `restart`. |
| `The controller did not report ready yet` | Read the log (table above) to see why, then `restart`. |
| `"event":"give-up"` in the log (Windows) | The controller exited several times in a row, so the supervisor stopped restarting it. Fix what the lines above it report — usually Chrome not found, or the session in use — then `… install-startup.ps1 restart`. |
| Chrome not found on Windows | The controller looks in the usual install locations; if Chrome is somewhere else, set `CHROME_PATH` to `chrome.exe` and restart. Any Chromium build works. |

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
  ↓ "Post in Urdu": the text is translated first; links are left intact
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

**How a video is produced (the fast path).** Measured on this project's own
sources, ffmpeg's HLS demuxer spent about **1 s of CPU but 40–150 s of wall
clock** on a 5-minute X video: it fetches segments one at a time and each one
waits a round trip, so the wait was the *network*, not the encoding. Two
changes follow from that:

1. **Segments are fetched in parallel**, then handed to ffmpeg as local files.
   Eight workers measured ~2.2 MB/s against ~0.3 MB/s serially. Playlist order,
   the `#EXT-X-MAP` init section, and the separate audio rendition are all
   preserved, so audio/video sync is unchanged. ffmpeg still does the remux.
2. **The remux stream-copies** (`-c copy`) by default — no re-encode — and only
   falls back to `libx264 -preset veryfast` when the copy is unusable. The
   output is inspected with `ffprobe` either way; a copy that lost the audio
   track is rejected, not published.

This adds no new dependency: no `yt-dlp`, no `aria2c`. The source must be an
X HLS master; anything else uses the previous single-download path. Failures
that re-encoding cannot fix (ambiguous source, expired signature, unreachable
playlist) are reported instead of retried more slowly.

Note that for a large video the **WhatsApp upload** is usually the largest
remaining cost — larger than fetching and remuxing combined. Stream-copy also
avoids the re-encode bloat that made some outputs *bigger* than the source,
which matters for that upload.

## Security / isolation

- The controller binds to `127.0.0.1` only; nothing is reachable from the network.
- The extension never reads WhatsApp cookies, local storage, QR data or profile data.
- Session files live only in the dedicated per-user directory, owned by the controller.
- Temporary media is deleted as soon as a job finishes or fails.
- ffmpeg produces WhatsApp-safe H.264/AAC MP4; media over 64 MB is rejected.
- The same post cannot be sent to the same channel twice within 120 seconds.
- The one time post content leaves the machine for anything other than WhatsApp
  is the **Post in Urdu** button, which sends the post's text (never its media)
  to Google's public translate endpoint. No other button, and no other part of
  the tool, makes an outside request with post content. See
  [Posting in Urdu](#posting-in-urdu).

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
| `POST /send` | `{ tweetId, tweetUrl, text, media: [{type, source}], mediaFailures?, channelId, translateTo? }` — an image `source` may also be a `data:` URL (a screenshot, which has no URL to fetch); anything not recognised as an image is refused; `translateTo` (a short language code, e.g. `ur`) translates `text` before sending |
| `GET /version` | `{ branch, sha, dirty, upstream, behind, ahead, checkedAt }` — local facts only, never touches the network; `behind`/`ahead` come from the last check |
| `POST /version/check` | Fetches from the remote and returns the same shape, with `behind`/`ahead` fresh. `checkFailed: 'unreachable'` if the remote could not be reached |
| `POST /update` | Fast-forwards to the upstream commit. Refused with `local-changes` when a tracked file has uncommitted edits (untracked files do not block it) and `no-upstream` when the branch has none. Returns `{ updated, from, to, files, reloadExtension, restartController }` |

`/send` publishes `media` in the post's own order (images and videos
interleaved) and captions only the first item with `text`. `mediaFailures`
lists items the extension could not resolve, so the response reports `partial`
instead of a false success. Posting rights are re-checked before every send.
When `translateTo` is set, `text` is translated to that language first (a
failure is reported, never sent untranslated); the response is otherwise
unchanged.

```bash
curl -s http://127.0.0.1:47825/status
curl -s http://127.0.0.1:47825/channels
```

## Tests

```bash
node controller/test/dependency.test.js      # vendored library + patches intact
node controller/test/controller.test.js      # session paths, browser choice, single-instance lock, channel eligibility, liveness watchdog
node controller/test/repo.test.js            # update checks and fast-forward, against throwaway repos (no network)
node extension/test/screenshot.test.js       # screenshot crop targeting (stops above the action bar; hides the page chrome) + inline-image transfer
node extension/test/toolbar.test.js          # our icons get a row of their own beneath X's action bar
node controller/test/screenshot-pipeline.test.js  # a captured image becomes a real, sniffed image file
node extension/test/popup-states.test.js     # every popup state, incl. reconnecting and signed-out
node controller/test/hls-prefetch.test.js    # HLS parsing, ordered parallel fetch, copy-vs-re-encode, audio preserved
node controller/test/duplicate-guard.test.js # a post cannot be sent twice while one is running or just after
node extension/test/video-source.test.js     # an ambiguous video mapping is refused, never guessed
node extension/test/link-first.test.js       # a text-only post's link moves to the top, media posts untouched
node extension/test/author-header.test.js    # the author's name is read cleanly and put above the post
node controller/test/translate.test.js       # the Urdu button: the split, the endpoint's shapes, the request
node extension/test/post-variant.test.js     # each send button's variant: name, glyph, author, translate
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