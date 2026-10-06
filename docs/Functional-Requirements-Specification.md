# X → WhatsApp Channel Poster

## Functional Requirements Specification (FRS)

**Document Status:** Draft
**Version:** 1.0
**Related Document:** Product Requirements Document (PRD)

---

## 1. Purpose

This document defines the exact functional behavior required from the X → WhatsApp Channel Poster browser extension.

The FRS is implementation-facing. Each requirement should be independently testable.

---

# 2. X Post Detection

## FR-001 — Detect X Posts

The extension MUST identify individual X posts displayed on `x.com`.

It MUST support posts appearing in:

* Home timeline
* User profiles
* Search results
* Replies
* Threads/conversations
* Other X views where standard post components are rendered

The extension MUST distinguish an individual post from surrounding posts.

---

## FR-002 — Dynamic Post Detection

X dynamically loads posts as the user scrolls.

The extension MUST detect newly rendered posts without requiring a full page reload.

It MUST also handle posts that are removed and re-rendered by X.

The implementation SHOULD use an efficient DOM observation strategy rather than continuously polling the entire page.

---

## FR-003 — Unique Post Identification

The extension SHOULD identify a post using its X post/status identifier whenever available.

The identifier should be used to associate:

* The post
* Its text
* Its media
* The injected action button
* Publishing state

---

# 3. WhatsApp Action Button

## FR-004 — Inject Button

The extension MUST add a dedicated **Post to WhatsApp** action to eligible X posts.

The button MUST be visually associated with the specific post.

---

## FR-005 — No Duplicate Buttons

The extension MUST NOT inject multiple buttons into the same post.

If X re-renders an existing post, the extension MUST detect that the action already exists.

---

## FR-006 — Button State

The button SHOULD support visual states:

* Idle
* Processing
* Success
* Failed

Example:

```text
Idle:
[ Post to WhatsApp ]

Processing:
[ Posting… ]

Success:
[ Posted ✓ ]

Failure:
[ Retry ]
```

---

# 4. Post Content Extraction

## FR-007 — Extract Text

When the user clicks the action button, the extension MUST extract the text belonging to that exact X post.

It MUST NOT include:

* Text from neighboring posts
* X navigation elements
* Reply counts
* Like counts
* Repost counts
* View counts
* Timestamps
* Accessibility/UI metadata unrelated to the post

---

## FR-008 — Preserve Formatting

The extraction process SHOULD preserve:

* Paragraph breaks
* Hashtags
* Mentions
* URLs
* Basic readable spacing

The extension MUST NOT unnecessarily rewrite the author's text.

---

## FR-009 — Empty Text

If a post contains no text but contains media, the extension MUST still allow publishing the media.

If the post contains neither text nor supported media, the extension MUST display an appropriate error.

---

# 5. Image Extraction

## FR-010 — Detect Images

The extension MUST determine whether the selected post contains images.

It MUST associate only images belonging to that post.

---

## FR-011 — Retrieve Images

The extension MUST obtain a usable representation of each detected image.

The implementation MUST handle X's image URL transformations where necessary.

---

## FR-012 — Multiple Images

If multiple images are present, the extension SHOULD preserve their order.

If WhatsApp supports the required multi-image publishing behavior, all images SHOULD be published.

If the implementation cannot reliably support multi-image publishing, it MUST clearly document the limitation.

---

## FR-013 — Image + Caption

When an image and text are both present:

```text
Image
+
Original X post text
```

should be sent as the WhatsApp Channel post.

---

# 6. Video Extraction

## FR-014 — Detect Video

The extension MUST detect when the selected X post contains video.

---

## FR-015 — Identify Video Source

The extension MUST determine a usable video source.

It MUST NOT assume that the visible `<video>` element always contains a directly downloadable file.

---

## FR-016 — Download Video

When required, the extension MUST download the video to a temporary location or otherwise make the media available to WhatsApp.

---

## FR-017 — Download Progress

For videos that require meaningful download time, the user MUST receive progress feedback.

Example:

```text
Downloading video…
42%
```

---

## FR-018 — Video Failure

If the video cannot be retrieved, the extension MUST:

1. Stop the publishing workflow.
2. Preserve the original X post.
3. Display a clear error.
4. Allow the user to retry.

It MUST NOT silently publish only the text when the user expected the video to be included.

---

# 7. WhatsApp Integration

## FR-019 — WhatsApp Availability

Before publishing, the extension MUST determine whether the required WhatsApp environment is available.

If WhatsApp is unavailable, the extension MUST provide an actionable error.

---

## FR-020 — Existing Session

The extension SHOULD use the user's existing authenticated WhatsApp Web session.

It MUST NOT request or store the user's WhatsApp password.

---

## FR-021 — Channel Discovery

The extension MUST be capable of identifying the configured destination WhatsApp Channel.

---

## FR-022 — Channel Selection

The user MUST be able to configure a destination Channel.

At minimum, the extension MUST support one default Channel.

---

## FR-023 — Channel Change

The user SHOULD be able to change the destination Channel without reinstalling the extension.

---

# 8. Publishing

## FR-024 — Text Publishing

The extension MUST support publishing:

```text
Text only
```

to the selected Channel.

---

## FR-025 — Image Publishing

The extension MUST support:

```text
Image + caption
```

---

## FR-026 — Video Publishing

The extension MUST support:

```text
Video + caption
```

for supported video formats/sizes.

---

## FR-027 — Publishing State

During publishing, the extension MUST prevent accidental duplicate submissions caused by repeated clicks.

---

## FR-028 — Successful Publishing

After successful publishing, the extension MUST provide clear confirmation.

Example:

> Posted to WhatsApp Channel.

---

## FR-029 — Failed Publishing

If publishing fails, the extension MUST provide:

* Failure status
* Human-readable reason where available
* Retry option

---

# 9. Preview & Confirmation

## FR-030 — Preview

If confirmation mode is enabled, the extension MUST display a preview containing:

* Extracted text
* Image/video thumbnail where available
* Destination Channel

---

## FR-031 — Confirm

The user MUST explicitly confirm before publishing when confirmation mode is enabled.

---

## FR-032 — Cancel

The user MUST be able to cancel a pending post without publishing it.

---

# 10. Extension Settings

## FR-033 — Default Channel

The extension MUST allow the user to configure a default destination Channel.

---

## FR-034 — Confirmation Setting

The extension MUST provide a setting to enable/disable publishing confirmation.

---

## FR-035 — Button Enable/Disable

The user SHOULD be able to enable or disable the X action button.

---

## FR-036 — Persistent Settings

Settings MUST persist across browser restarts.

Settings SHOULD use browser extension storage rather than external storage.

---

# 11. Notifications & Feedback

## FR-037 — Processing Feedback

The user MUST receive feedback for operations that take noticeable time.

Examples:

* Extracting…
* Preparing media…
* Downloading…
* Publishing…

---

## FR-038 — Success Feedback

A successful operation MUST produce a visible success state.

---

## FR-039 — Error Feedback

Errors MUST be understandable without requiring technical knowledge.

---

# 12. Retry Behavior

## FR-040 — Retry Failed Post

A failed post SHOULD be retryable without requiring the user to locate the original X post again.

---

## FR-041 — Media Retry

If media retrieval fails, the extension SHOULD retry the retrieval operation independently before declaring the entire operation failed.

---

# 13. Duplicate Protection

## FR-042 — Prevent Accidental Duplicate Posts

The extension MUST prevent rapid repeated clicks from triggering multiple identical publishing operations.

---

## FR-043 — Intentional Reposting

Duplicate protection MUST NOT permanently prevent the user from reposting the same X post later.

---

# 14. Temporary Media Management

## FR-044 — Temporary Storage

Downloaded media MUST be treated as temporary.

---

## FR-045 — Cleanup

Temporary media SHOULD be deleted after:

* Successful publishing
* Failed publishing after the retry window expires
* User cancellation

The extension MUST NOT indefinitely accumulate downloaded videos/images.

---

# 15. Permissions

## FR-046 — Minimal Permissions

The extension MUST request only permissions necessary for its functionality.

---

## FR-047 — Permission Documentation

Every requested permission MUST have a documented purpose.

The implementation MUST NOT add broad permissions merely for convenience.

---

# 16. Security

## FR-048 — Untrusted X Content

All X content MUST be treated as untrusted input.

The extension MUST prevent extracted content from becoming executable HTML/JavaScript.

---

## FR-049 — WhatsApp Credentials

The extension MUST NOT request, extract, or store:

* WhatsApp passwords
* Authentication tokens
* Session credentials

---

## FR-050 — External Transmission

The extension MUST NOT transmit X post content or WhatsApp-related information to an external server unless explicitly required, documented, and approved.

---

# 17. Browser Compatibility

## FR-051 — Chromium

The MVP MUST support Chromium-based browsers.

At minimum, testing SHOULD cover:

* Chrome
* Chromium-based Edge
* Brave

---

# 18. Dynamic X Behavior

## FR-052 — Infinite Scroll

The extension MUST continue working as new posts are loaded while scrolling.

---

## FR-053 — SPA Navigation

X is a single-page application.

The extension MUST continue working when the user navigates between X pages without a full browser reload.

---

# 19. Error Recovery

## FR-054 — Recoverable Errors

Recoverable errors SHOULD allow retry without refreshing X.

---

## FR-055 — Session Changes

If the user logs out of WhatsApp or the WhatsApp session becomes unavailable, the extension MUST detect the condition and report it appropriately.

---

# 20. Logging

## FR-056 — Local Diagnostic Logging

The extension SHOULD provide limited local diagnostic information for troubleshooting.

Logs MUST NOT contain:

* Passwords
* Authentication credentials
* Session tokens
* Sensitive WhatsApp data

---

# 21. Functional Acceptance Tests

The following scenarios MUST pass before MVP completion.

### FAT-001 — Text Post

**Given:** X post containing text
**When:** User clicks Post to WhatsApp
**Then:** Text is published to the configured Channel.

### FAT-002 — Image Post

**Given:** X post containing text + image
**When:** User clicks Post to WhatsApp
**Then:** Image and text are published.

### FAT-003 — Video Post

**Given:** X post containing text + supported video
**When:** User clicks Post to WhatsApp
**Then:** Video and text are published.

### FAT-004 — Media-only Post

**Given:** X post containing only media
**When:** User clicks Post to WhatsApp
**Then:** Media is published without requiring text.

### FAT-005 — Multiple Images

**Given:** X post containing multiple images
**When:** User publishes
**Then:** Supported images are preserved in their original order.

### FAT-006 — Failed Video

**Given:** Video cannot be retrieved
**When:** User attempts publishing
**Then:** Publishing fails visibly and provides a retry option.

### FAT-007 — Duplicate Click

**Given:** User rapidly clicks the button multiple times
**When:** Processing starts
**Then:** Only one publishing operation is initiated.

### FAT-008 — Dynamic Timeline

**Given:** User scrolls through X
**When:** New posts load dynamically
**Then:** New posts receive the WhatsApp action.

### FAT-009 — SPA Navigation

**Given:** User navigates between X pages without refreshing
**When:** Posts appear
**Then:** The extension continues functioning.

### FAT-010 — WhatsApp Unavailable

**Given:** WhatsApp Web is unavailable
**When:** User attempts publishing
**Then:** The extension provides a clear actionable error.

---

# 22. Implementation Boundary

The FRS defines **what the extension must do**, not how it must technically accomplish it.

The implementation agent MUST NOT treat implementation details as product requirements.

The following decisions belong in the Technical Architecture Specification:

* Manifest implementation
* Content-script architecture
* Service-worker architecture
* WhatsApp Web integration mechanism
* X video extraction mechanism
* Media transport
* Temporary file handling
* Browser APIs
* Communication between extension components

Those decisions should be made separately before implementation.
