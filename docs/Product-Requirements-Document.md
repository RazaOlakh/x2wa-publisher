# X → WhatsApp Channel Poster

## Product Requirements Document (PRD)

**Document Status:** Draft
**Product Type:** Standalone Browser Extension
**Primary Platform:** X (x.com) → WhatsApp
**Version:** 1.0

---

## 1. Product Overview

X → WhatsApp Channel Poster is a standalone browser extension that allows a user to take content from an X post and publish it to a WhatsApp Channel with minimal interaction.

The extension adds a dedicated action button to X posts.

When the user clicks the button, the extension:

1. Detects the selected X post.
2. Extracts the post text.
3. Detects available media.
4. Extracts/downloads supported media.
5. Opens/interacts with WhatsApp.
6. Publishes the extracted content to the user's selected WhatsApp Channel.

The extension is an independent project.

### Explicit Independence

This project:

* MUST NOT depend on the existing WhatsApp CLI project.
* MUST NOT require the `wa` CLI.
* MUST NOT require the existing WhatsApp daemon.
* MUST NOT share application code with that project.
* MUST have its own repository, documentation, configuration, and implementation.

The only shared concept is that both projects interact with WhatsApp.

---

# 2. Problem Statement

Sharing posts from X to a WhatsApp Channel currently requires manually:

* Copying the X post text.
* Downloading media when necessary.
* Opening WhatsApp.
* Finding the desired Channel.
* Attaching media.
* Pasting/writing the text.
* Sending the post.

This becomes repetitive when publishing multiple posts.

The extension should reduce this workflow to approximately:

**X post → Click button → Publish**

while keeping the user in control.

---

# 3. Primary User

The primary user is a person who:

* Operates one or more WhatsApp Channels.
* Regularly discovers content on X.
* Wants to republish selected X content to WhatsApp Channels.
* Uses a desktop browser.
* Is already authenticated with X and WhatsApp.

The product is intended primarily for personal productivity.

---

# 4. Core User Story

> As a WhatsApp Channel operator, I want to publish an X post directly to my WhatsApp Channel so that I don't have to manually copy text and download/re-upload media.

---

# 5. Core Workflow

### Text-only post

```text
X post
  ↓
User clicks "Post to WhatsApp"
  ↓
Extension extracts text
  ↓
User selects/confirms Channel
  ↓
WhatsApp opens
  ↓
Text is inserted
  ↓
User confirms/sends OR extension completes the supported posting flow
```

### Image post

```text
X post
  ↓
User clicks "Post to WhatsApp"
  ↓
Extract text
  +
Extract image
  ↓
Prepare WhatsApp post
  ↓
Publish to Channel
```

### Video post

```text
X post
  ↓
User clicks "Post to WhatsApp"
  ↓
Extract text
  +
Identify video
  ↓
Download video
  ↓
Prepare WhatsApp post
  ↓
Publish to Channel
```

---

# 6. Functional Requirements

## FR-001 — X Post Detection

The extension MUST detect individual X posts/tweets displayed on x.com.

It MUST work with posts appearing:

* In the home timeline.
* In user profiles.
* In search results.
* In replies/conversations where an individual post is displayed.

The implementation MUST avoid attaching the action to unrelated page elements.

---

## FR-002 — Action Button

The extension MUST add a dedicated button/action to eligible X posts.

Suggested label:

**Post to WhatsApp**

The button should visually fit into X's existing post action area.

The implementation should avoid permanently modifying X's visual design beyond the required button.

---

## FR-003 — Button Interaction

When the user clicks the button:

1. The click MUST NOT trigger the normal X action associated with the surrounding button area.
2. The extension MUST identify the exact post associated with the button.
3. The extension MUST extract the post content.
4. The extension MUST determine whether media exists.
5. The extension MUST begin the WhatsApp publishing workflow.

---

# 7. Text Extraction

The extension MUST extract the visible textual content of the selected X post.

The extracted text should preserve:

* Normal wording.
* Paragraph separation.
* Mentions where reasonably possible.
* Hashtags.
* URLs.

The extension SHOULD remove unnecessary UI text such as:

* Reply counts.
* Like counts.
* Repost counts.
* View counts.
* Timestamp metadata.

The extension MUST NOT accidentally include text from neighboring posts.

---

# 8. Image Handling

If an X post contains one or more images:

1. The extension MUST detect the images belonging to that post.
2. It MUST obtain usable image URLs/data.
3. It MUST download or otherwise make the image available to WhatsApp.
4. The image MUST be attached to the WhatsApp Channel post.
5. The extracted X text SHOULD be used as the accompanying caption.

### Multiple Images

If an X post contains multiple images, the implementation SHOULD preserve the complete media set when WhatsApp supports the corresponding upload behavior.

If this cannot be reliably supported in the first release, the limitation MUST be explicitly documented.

---

# 9. Video Handling

If an X post contains video:

1. The extension MUST detect the video.
2. It MUST obtain an accessible video source.
3. It MUST download the video to a temporary location or otherwise make it available for WhatsApp upload.
4. It MUST preserve the original video content where technically possible.
5. The X post text SHOULD become the WhatsApp caption.

### Important Constraint

X's video delivery mechanism may use protected/streamed media URLs.

The implementation MUST NOT assume that the HTML `<video>` element always provides a directly downloadable MP4.

The agent MUST investigate the actual media delivery mechanism during implementation and document the selected extraction strategy.

If a video cannot be retrieved reliably, the extension MUST provide a clear failure state rather than silently publishing an incomplete post.

---

# 10. WhatsApp Integration

The extension MUST operate independently from the existing WhatsApp CLI project.

The implementation must determine the most reliable supported mechanism for interacting with WhatsApp.

### Preferred Target

The initial target should be:

**WhatsApp Web**

The extension should work with an already authenticated WhatsApp Web session.

The extension MUST NOT require the user to authenticate a second WhatsApp account solely for this extension.

---

# 11. WhatsApp Channel Selection

The user must be able to specify the destination WhatsApp Channel.

The product SHOULD support a configurable default Channel.

Example:

```text
Default Channel
[ My News Channel ▼ ]
```

The user SHOULD be able to change the destination when required.

---

# 12. Publishing Behavior

The extension should support:

### Text

```text
X post text
```

### Image

```text
[Image]

X post text
```

### Video

```text
[Video]

X post text
```

The extension SHOULD preserve the original text as closely as possible.

---

# 13. Confirmation Mode

The product SHOULD support a confirmation setting.

### Confirmation enabled

```text
X
 ↓
Post to WhatsApp
 ↓
Preview
 ↓
Confirm
 ↓
WhatsApp
```

### Confirmation disabled

```text
X
 ↓
Post to WhatsApp
 ↓
WhatsApp publishing workflow
```

The default configuration should prioritize safety and user control.

---

# 14. Popup / Extension UI

The extension popup should provide at minimum:

* Default WhatsApp Channel.
* Enable/disable X button.
* Confirmation preference.
* Current integration status.
* Basic troubleshooting/status information.

The UI should remain intentionally small.

This is a utility extension, not a dashboard-heavy application.

---

# 15. Loading States

The user MUST receive feedback while operations are occurring.

Examples:

**Extracting post…**

**Preparing image…**

**Downloading video…**

**Opening WhatsApp…**

**Publishing…**

**Posted successfully.**

---

# 16. Error Handling

The extension MUST provide meaningful errors.

Examples:

### WhatsApp unavailable

> WhatsApp Web could not be reached.

### Channel unavailable

> The selected WhatsApp Channel could not be found.

### Media unavailable

> The media from this X post could not be retrieved.

### Video download failure

> The video could not be downloaded from X.

### Authentication issue

> Please log in to WhatsApp Web and try again.

### Unknown error

> Something went wrong while publishing this post.

Errors should not expose raw internal stack traces to normal users.

---

# 17. Duplicate Protection

The extension SHOULD detect accidental repeated publishing where technically practical.

For example, clicking the button twice on the same post within a short period should not unintentionally create two identical Channel posts.

The implementation may use:

* X post ID.
* Local temporary state.
* Timestamp.
* Publishing state.

This should not prevent the user from intentionally reposting the same X post later.

---

# 18. Privacy Requirements

The extension MUST follow a privacy-first design.

It MUST NOT:

* Upload X post content to an unrelated third-party server without explicit requirement.
* Store WhatsApp credentials.
* Store WhatsApp authentication/session data independently.
* Permanently retain downloaded media unless explicitly required.
* Collect unnecessary analytics.

Temporary media files SHOULD be deleted after successful publishing.

---

# 19. Permissions

The extension MUST request only permissions that are actually required.

Potential permissions may include access to:

* x.com
* web.whatsapp.com
* Extension storage
* Temporary downloads/media handling

The final permission list MUST be justified in the technical documentation.

The implementation agent MUST NOT request broad `<all_urls>` access unless technically necessary and documented.

---

# 20. Security

The extension MUST treat content obtained from X as untrusted input.

It MUST:

* Avoid arbitrary script execution from post content.
* Sanitize extracted text before inserting it into UI.
* Avoid unsafe HTML injection.
* Validate media URLs before processing.
* Avoid exposing sensitive WhatsApp session information.

---

# 21. Browser Support

Initial release target:

**Chromium-based browsers**

Examples:

* Google Chrome
* Microsoft Edge
* Brave
* Chromium

Firefox support MAY be considered later.

The architecture SHOULD avoid unnecessary browser-specific coupling where practical.

---

# 22. Performance Requirements

The extension should remain lightweight.

For normal text/image posts:

* Button interaction should feel immediate.
* Extraction should normally complete within seconds.

For video:

* Progress feedback MUST be displayed.
* Large files MUST NOT freeze the browser UI.

The implementation should avoid unnecessary background processing.

---

# 23. Offline Behavior

The extension does not need to support completely offline operation.

Required services:

* X
* WhatsApp Web
* Internet access for media retrieval

If any required service is unavailable, the extension should fail gracefully.

---

# 24. Non-Goals

The first version MUST NOT attempt to become:

* A full X client.
* A WhatsApp client.
* A WhatsApp Channel management dashboard.
* A social-media scheduling platform.
* An analytics platform.
* A multi-account publishing platform.
* A general-purpose content downloader.
* A replacement for WhatsApp Web.

These may be future products/features but are outside the initial scope.

---

# 25. MVP Scope

The MVP must support:

* Detecting X posts.
* Adding a posting button.
* Extracting post text.
* Detecting images.
* Posting text + image.
* Detecting video.
* Downloading supported video.
* Posting text + video.
* Selecting/configuring a WhatsApp Channel.
* Clear success/failure feedback.
* Independent operation from the existing WhatsApp CLI project.

---

# 26. Future Features

Potential future capabilities:

* Multiple destination Channels.
* Channel presets.
* Scheduling.
* Caption editing.
* Automatic attribution.
* Content preview.
* Post history.
* Retry failed uploads.
* Keyboard shortcuts.
* Right-click/context-menu posting.
* Support for other platforms.
* Cross-platform publishing.

These are NOT part of MVP unless explicitly approved later.

---

# 27. Acceptance Criteria

The MVP is considered complete when:

### Text

A user can open X, select a post containing text, click the extension button, and successfully publish the text to the configured WhatsApp Channel.

### Image

A user can select an X post containing text + image and successfully publish both to the configured WhatsApp Channel.

### Video

A user can select an X post containing text + supported video, have the video retrieved successfully, and publish both text + video to the configured WhatsApp Channel.

### Isolation

The extension works without installing or running the existing WhatsApp CLI project.

### Errors

Failures are clearly communicated to the user.

### Security

No unnecessary credentials or sensitive WhatsApp session information is stored by the extension.

---

# 28. Agent Constraints

The implementation agent MUST:

1. Read this PRD completely before implementation.
2. NOT modify the existing WhatsApp CLI project.
3. NOT introduce dependencies on that project.
4. NOT make unapproved product decisions where requirements are ambiguous.
5. Document technical assumptions.
6. Separate implementation from product decisions.
7. Test text, image, and video workflows independently.
8. Verify behavior against actual X and WhatsApp Web rather than relying solely on mocked DOM structures.
9. Avoid broad browser permissions unless justified.
10. Provide a final implementation and verification report.

---

# 29. Definition of Done

The project is done when:

* The extension is installable.
* The X button works reliably.
* Text extraction works.
* Image extraction/upload works.
* Supported video extraction/download/upload works.
* WhatsApp Channel selection works.
* Publishing works.
* Errors are handled.
* Temporary media is cleaned up.
* Permissions are minimized.
* Documentation is complete.
* Tests/verification have been performed.
* The implementation agent has committed the completed work.
