# X → WhatsApp Channel Poster

## UX/UI Specification

**Document Status:** Draft
**Version:** 1.0
**Related Documents:**

* Product Requirements Document (PRD)
* Functional Requirements Specification (FRS)
* Technical Architecture Specification

---

# 1. UX Objective

The extension should make transferring content from X to a WhatsApp Channel feel like a native X action.

The ideal workflow is:

> **See post → Click one button → Confirm if enabled → Done**

The interface should remain minimal and avoid turning a simple publishing action into a complicated workflow.

---

# 2. Design Principles

The UI MUST follow these principles:

### 2.1 Minimal

The extension should expose only information required to complete the task.

### 2.2 Fast

The user should not have to navigate through multiple screens for a normal post.

### 2.3 Clear

Every operation should have an obvious state.

### 2.4 Non-intrusive

The extension should feel like part of X rather than an unrelated overlay.

### 2.5 User-controlled

The user should always understand:

* What is being posted.
* Where it is being posted.
* Whether it has already been posted.

---

# 3. X Action Button

The primary interaction is the **Post to WhatsApp** button.

It should appear alongside the existing X post actions.

Conceptually:

```text id="6qu2r4"
Reply    Repost    Like    Views    Bookmark    Share    WhatsApp
```

The exact location should adapt to X's current action-bar layout.

---

# 4. Button Design

The button SHOULD use:

* WhatsApp-style recognizable iconography.
* Compact dimensions.
* Visual consistency with X's existing action buttons.
* Accessible tooltip/label.

The button MUST NOT dominate the X interface.

### Tooltip

On hover:

> Post to WhatsApp

---

# 5. Button States

## 5.1 Idle

```text
[ WhatsApp icon ]
```

Tooltip:

> Post to WhatsApp

---

## 5.2 Extracting

```text
[ spinner ]
```

Tooltip/status:

> Preparing post…

---

## 5.3 Preparing Media

For image/video:

```text
[ spinner ]
```

Status:

> Preparing media…

---

## 5.4 Downloading Video

```text
[ spinner ]
```

Status:

> Downloading video…

If progress is available:

```text
Downloading video… 64%
```

---

## 5.5 Publishing

```text
[ spinner ]
```

Status:

> Publishing…

---

## 5.6 Success

The button temporarily changes to a success indicator.

```text
[ ✓ ]
```

Tooltip:

> Posted to WhatsApp

The success state should automatically return to the normal state after a reasonable period.

---

## 5.7 Failure

```text
[ ! ]
```

Tooltip:

> Posting failed — click to retry

---

# 6. User Interaction

Clicking the button begins the publishing workflow.

The extension SHOULD NOT open unnecessary configuration screens when a default Channel is already configured.

---

# 7. Default Workflow

If:

* A default Channel exists.
* Confirmation is disabled.

The workflow should be:

```text id="p4bbj1"
Click button
      ↓
Extract
      ↓
Prepare media
      ↓
Publish
      ↓
✓
```

No intermediate screen should be required.

---

# 8. Confirmation Workflow

If confirmation is enabled:

```text id="4t1n6w"
Click
 ↓
Preview
 ↓
Confirm
 ↓
Publish
```

The preview should be compact.

---

# 9. Preview UI

The preview should contain:

```text id="z85tjp"
┌──────────────────────────────────┐
│ Post to WhatsApp                 │
│                                  │
│ Channel                          │
│ My News Channel                  │
│                                  │
│ ┌──────────────────────────────┐ │
│ │ X post text appears here...  │ │
│ └──────────────────────────────┘ │
│                                  │
│ [ Media Preview ]                │
│                                  │
│          [Cancel] [Post]         │
└──────────────────────────────────┘
```

---

# 10. Preview Requirements

The preview MUST show:

* Destination Channel.
* Extracted text.
* Media preview when available.

The preview SHOULD NOT display unnecessary X metadata.

Optional metadata:

* Source X username.
* Source post link.

These should not dominate the interface.

---

# 11. Text Editing

For MVP, extracted text should be treated as the original post content.

The user SHOULD be able to edit the caption in confirmation mode.

Example:

```text id="1uj3k0"
┌──────────────────────────────┐
│ Caption                      │
│                              │
│ Original X post text...      │
│                              │
└──────────────────────────────┘
```

Editing MUST NOT modify the original X post.

---

# 12. Media Preview

### Image

Display an image thumbnail.

### Video

Display:

* Video thumbnail where available.
* Video indicator.
* Approximate size if known.

The extension does not need to play the entire video in the preview.

---

# 13. Channel Selection

The destination Channel should be visually obvious.

Example:

```text id="5xw0ko"
Channel

[ My News Channel             ▼ ]
```

Clicking it opens a compact Channel selector.

---

# 14. Channel Selector

Example:

```text id="skh9qj"
┌─────────────────────────────┐
│ Select Channel              │
│                             │
│ 🔵 My News Channel          │
│ 🟢 Technology Updates       │
│ 🟣 Personal Channel         │
└─────────────────────────────┘
```

If many Channels exist, the selector SHOULD support search.

---

# 15. Popup UI

The browser extension popup should be intentionally compact.

```text id="j8i4de"
┌───────────────────────────────┐
│ WhatsApp Poster               │
│                               │
│ Destination                   │
│ ┌───────────────────────────┐ │
│ │ My News Channel        ▼  │ │
│ └───────────────────────────┘ │
│                               │
│ ☑ Confirm before posting      │
│                               │
│ X             ● Connected     │
│ WhatsApp      ● Connected     │
│                               │
│ Settings                      │
└───────────────────────────────┘
```

---

# 16. Connection Status

The popup should show simple status indicators.

### X

```text
● Available
```

### WhatsApp

```text
● Connected
```

Possible failure:

```text
● Not available
```

Avoid technical terminology such as:

> WebSocket disconnected

unless shown in a diagnostic section.

---

# 17. First-Run Experience

When the extension is installed for the first time:

```text id="8nj7ar"
WhatsApp Poster

Post X content directly to
your WhatsApp Channel.

1. Open WhatsApp Web
2. Make sure you're logged in
3. Choose your default Channel

[ Get Started ]
```

The onboarding should be short.

---

# 18. First Channel Setup

After onboarding:

```text id="v1mtba"
Choose your default Channel

[ Search Channels... ]

○ Channel A
○ Channel B
○ Channel C

                 [Save]
```

The selected Channel becomes the default destination.

---

# 19. No Channel Configured

If the user clicks the X button without configuring a destination:

```text id="i0c79h"
No WhatsApp Channel selected.

Choose a default Channel first.

[ Choose Channel ]
```

The user should be taken directly to the relevant configuration flow.

---

# 20. WhatsApp Not Available

If WhatsApp Web is not available:

```text id="a3w0x1"
WhatsApp Web isn't available.

Open WhatsApp Web and make sure
you're logged in.

[ Open WhatsApp Web ]
```

---

# 21. Channel Not Found

If the configured Channel cannot be found:

```text id="rx5h0p"
Channel unavailable.

The selected Channel could not be found.

[ Choose Another Channel ]
```

---

# 22. Media Download State

For videos:

```text id="f4uvy2"
Preparing video

Downloading…
████████████░░░░ 72%

Please keep this tab open.
```

The user should not need to interact while the operation is progressing.

---

# 23. Publishing State

```text id="1x4vgu"
Publishing to

My News Channel

Please wait…
```

The Post button should be disabled while the job is actively publishing.

---

# 24. Success State

After successful publishing:

```text id="4t6c2j"
✓ Posted successfully

My News Channel
```

The success notification should disappear automatically.

---

# 25. Failure State

Example:

```text id="6d2m1n"
Couldn't post to WhatsApp.

The video could not be retrieved from X.

[ Retry ]   [ Cancel ]
```

The error should describe the actual problem whenever possible.

---

# 26. Notification Strategy

Notifications should be lightweight.

Preferred priority:

1. Inline button state.
2. Small extension notification/toast.
3. Popup status.

The extension should avoid unnecessary browser-level notifications.

---

# 27. Accessibility

The extension MUST provide:

* Accessible button labels.
* Keyboard accessibility where practical.
* Sufficient visual distinction between states.
* Tooltips for icon-only actions.
* Meaningful status text for screen readers.

The primary action MUST NOT rely solely on color.

---

# 28. Responsive Behavior

The extension should work across normal desktop browser viewport sizes.

The popup should not require excessive dimensions.

The X button should adapt to X's responsive action bar.

---

# 29. Visual Language

The visual language should be:

* Clean.
* Utility-oriented.
* Modern.
* Compact.
* Consistent with WhatsApp/X without attempting to clone either application.

Avoid:

* Large decorative graphics.
* Excessive animation.
* Dashboard-style layouts.
* Unnecessary gradients.
* Excessive configuration controls.

---

# 30. Animation

Animations should be subtle.

Allowed:

* Loading spinner.
* Progress transition.
* Success checkmark.
* Small state transitions.

Avoid:

* Large modal animations.
* Attention-grabbing effects.
* Persistent motion.

---

# 31. Dark Mode

The extension SHOULD support dark mode.

It should detect the browser/system preference where practical.

The X action button should also remain visually appropriate when X is using dark mode.

---

# 32. Error UX Principle

Errors should answer three questions:

1. **What happened?**
2. **Why did it happen?**
3. **What can I do now?**

Example:

> **Video couldn't be retrieved**
> X did not provide an accessible video source.
> **[Retry]**

Avoid:

> `ERR_MEDIA_403`

as the primary user-facing message.

---

# 33. Confirmation Defaults

Recommended MVP defaults:

```text id="c72s4w"
Confirm before posting: ON
Default Channel: Not configured
Button: ON
```

This prioritizes preventing accidental Channel posts.

The user can disable confirmation after becoming comfortable with the workflow.

---

# 34. Settings

The settings area should contain only MVP-relevant controls:

### Publishing

* Default Channel
* Confirm before posting

### X

* Enable Post to WhatsApp button

### Diagnostics

* Connection status
* Version

Avoid adding advanced configuration until there is a demonstrated need.

---

# 35. Empty States

Every selectable list should have a useful empty state.

Example:

> No WhatsApp Channels found.

Possible action:

> Open WhatsApp Web

---

# 36. Long Text

Very long X posts should not make the preview excessively large.

The preview SHOULD:

* Limit visible height.
* Allow scrolling.
* Preserve the complete text internally.

---

# 37. Large Media

Large videos should display useful information when available:

```text
Video
125 MB
```

The user should receive progress feedback during preparation.

---

# 38. Multiple Media

For multiple images:

```text id="7qtw3f"
[Image 1] [Image 2] [Image 3] [Image 4]
```

The preview should remain compact.

The user should understand that multiple media items will be published.

---

# 39. Cancellation

At any cancellable preparation stage, the user SHOULD be able to cancel.

Cancellation should:

* Stop the active operation where technically possible.
* Delete temporary media.
* Return the UI to the idle state.

---

# 40. Retry UX

Retry should reuse the original extracted X post where possible.

The user should not need to return to X and start again unless the original data is no longer available.

---

# 41. UX Acceptance Criteria

The UX is considered complete when:

### Button

* The WhatsApp action is clearly visible.
* It does not disrupt X's existing controls.
* It has clear idle/loading/success/failure states.

### Preview

* Text is readable.
* Media is visible.
* Destination Channel is obvious.
* User can cancel or confirm.

### Popup

* Default Channel is easy to configure.
* Connection state is understandable.
* Settings are minimal.

### Errors

* Errors are understandable.
* Retry actions are obvious.
* No raw technical errors are shown by default.

### Workflow

A normal post should require no more than:

**One click without confirmation**

or

**Two clicks with confirmation.**

---

# 42. UX Non-Goals

The UI MUST NOT become:

* A social-media dashboard.
* A WhatsApp replacement.
* A full media editor.
* A content-management system.
* A scheduling platform.

The extension is a focused publishing utility.
