# X → WhatsApp Channel Poster

## Technical Architecture Specification

**Document Status:** Draft
**Version:** 1.0
**Related Documents:**

* Product Requirements Document (PRD)
* Functional Requirements Specification (FRS)

---

# 1. Purpose

This document defines the technical architecture for the X → WhatsApp Channel Poster browser extension.

It defines:

* System components
* Component responsibilities
* Communication boundaries
* Browser-extension architecture
* X integration
* WhatsApp integration
* Media processing
* Storage
* Security
* Error handling
* Testing boundaries

The architecture MUST remain independent from the existing WhatsApp CLI project.

---

# 2. Architectural Principle

The extension is a **standalone browser extension**.

It MUST NOT depend on:

* The existing `wa` CLI.
* The existing WhatsApp daemon.
* A local WhatsApp CLI server.
* Code imported from the existing WhatsApp CLI project.
* Any existing project database.

The extension owns its own runtime and configuration.

---

# 3. High-Level Architecture

```text
┌──────────────────────────────────────────────┐
│                    X.com                     │
│                                              │
│  ┌───────────────┐                           │
│  │ X Post        │                           │
│  │               │                           │
│  │ [Post to      │                           │
│  │  WhatsApp]    │                           │
│  └───────┬───────┘                           │
└──────────┼───────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────┐
│             Browser Extension               │
│                                              │
│  Content Script                              │
│      │                                       │
│      ▼                                       │
│  Post Extractor                              │
│      │                                       │
│      ├── Text                                │
│      ├── Images                              │
│      └── Video                               │
│                                              │
│      ▼                                       │
│  Background Service Worker                   │
│      │                                       │
│      ├── State management                    │
│      ├── Media processing                    │
│      ├── WhatsApp integration                │
│      └── Settings                            │
└───────────────┬──────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────┐
│               WhatsApp Web                   │
│                                              │
│       Existing authenticated session         │
│                                              │
│                 ▼                            │
│          Selected Channel                    │
└──────────────────────────────────────────────┘
```

---

# 4. Extension Components

The extension SHOULD use the following logical components.

## 4.1 Content Script

Runs in the context of X pages.

Responsibilities:

* Detect X posts.
* Inject the action button.
* Identify the post associated with a button.
* Extract text.
* Identify media.
* Send extracted information to the extension runtime.
* Display lightweight status on the X page.

The content script MUST NOT contain the entire application logic.

---

# 5. Background Service Worker

The background service worker is the central coordinator.

Responsibilities:

* Receive requests from content scripts.
* Manage publishing jobs.
* Coordinate media preparation.
* Coordinate WhatsApp interaction.
* Manage extension settings.
* Maintain temporary job state.
* Handle retries.
* Report results back to the originating X page.

The service worker SHOULD remain stateless between jobs wherever practical.

Persistent state should be stored explicitly.

---

# 6. Extension Popup

The popup provides user configuration.

Minimum functionality:

```text
┌─────────────────────────┐
│ WhatsApp Poster         │
│                         │
│ Channel                 │
│ [ My Channel       ▼ ]  │
│                         │
│ ☑ Confirm before post   │
│                         │
│ X integration: Active   │
│ WhatsApp: Connected     │
└─────────────────────────┘
```

The popup MUST NOT perform the actual X extraction.

It is a configuration/control interface.

---

# 7. Settings Storage

Browser extension storage SHOULD be used.

Example conceptual structure:

```json
{
  "defaultChannel": "...",
  "confirmationRequired": true,
  "buttonEnabled": true
}
```

No sensitive authentication information should be stored.

---

# 8. Message Architecture

Communication should follow:

```text
X Content Script
        │
        │ chrome.runtime messaging
        ▼
Background Service Worker
        │
        ├── Settings
        ├── Media
        └── WhatsApp
```

The content script SHOULD send structured messages rather than arbitrary executable payloads.

Example conceptual request:

```json
{
  "type": "CREATE_POST",
  "source": "x",
  "post": {
    "id": "...",
    "text": "...",
    "media": []
  }
}
```

---

# 9. Post Data Model

The extension SHOULD internally represent an extracted X post using a normalized model.

Example:

```typescript
interface SourcePost {
  source: "x";
  id?: string;
  text: string;
  media: MediaItem[];
  sourceUrl?: string;
}
```

Media:

```typescript
interface MediaItem {
  type: "image" | "video";
  url: string;
  previewUrl?: string;
}
```

The implementation may extend this model when necessary.

---

# 10. Publishing Job Model

Publishing should be represented as a job.

Example:

```typescript
interface PublishJob {
  id: string;
  sourcePost: SourcePost;
  destination: {
    type: "whatsapp-channel";
    channelId?: string;
  };
  status:
    | "pending"
    | "extracting"
    | "preparing"
    | "publishing"
    | "completed"
    | "failed"
    | "cancelled";
}
```

This allows the extension to provide reliable status feedback.

---

# 11. X Integration

## 11.1 DOM Strategy

The extension should operate against X's rendered DOM rather than assuming a static HTML page.

X is a dynamic SPA.

The implementation should use:

* DOM observation.
* Robust selectors.
* Post-level boundaries.
* Defensive detection.

Selectors MUST NOT depend unnecessarily on unstable generated CSS classes.

---

# 12. X Button Injection

The content script should:

1. Discover rendered posts.
2. Identify the post container.
3. Check whether the extension button already exists.
4. Inject the button.
5. Associate the button with that post.

A `WeakSet`, DOM marker, or equivalent mechanism may be used to prevent duplicate injection.

---

# 13. X Post Identification

The implementation SHOULD obtain the X post ID from the post's canonical URL or another stable identifier.

Example:

```text
https://x.com/user/status/123456789
```

Post ID:

```text
123456789
```

This ID should be used for job tracking and duplicate protection.

---

# 14. Text Extraction Architecture

Text extraction should occur within the specific post container.

The extractor SHOULD:

1. Locate the post's text element.
2. Extract readable text.
3. Preserve paragraph boundaries.
4. Preserve links/hashtags where possible.
5. Remove unrelated UI elements.

The extractor MUST NOT scrape the entire page.

---

# 15. Image Extraction Architecture

The image extractor should inspect the selected post only.

Potential sources include:

* Rendered image elements.
* `src`.
* `srcset`.
* X media URLs.

The implementation should prefer the highest usable image resolution where practical.

The extractor should normalize image URLs before downloading them.

---

# 16. Video Architecture

Video is the most technically sensitive component.

The architecture MUST treat video extraction as a separate subsystem.

```text
X Post
  │
  ▼
Video Detection
  │
  ▼
Source Discovery
  │
  ▼
Accessible Media URL
  │
  ▼
Temporary Download
  │
  ▼
Media Validation
  │
  ▼
WhatsApp Upload
```

The implementation MUST NOT assume that:

```text
<video src="...">
```

always represents the original downloadable video.

X may use:

* Streaming manifests.
* Segmented media.
* Temporary URLs.
* Browser-managed media resources.

The implementation agent must test the current X behavior and document the actual extraction mechanism used.

---

# 17. Media Download Strategy

Media should be downloaded only when required.

The extension SHOULD avoid sending large media through unnecessary intermediate servers.

Preferred flow:

```text
X
 ↓
Browser Extension
 ↓
Temporary local/browser-controlled data
 ↓
WhatsApp
```

The implementation must minimize unnecessary third-party infrastructure.

---

# 18. Temporary Media Lifecycle

Temporary media should have a defined lifecycle:

```text
Created
   ↓
Used for upload
   ↓
Upload successful
   ↓
Deleted
```

If upload fails:

```text
Created
   ↓
Upload failed
   ↓
Retry
   ↓
Success → Delete
   OR
Permanent failure → Cleanup
```

No permanent media archive is required for MVP.

---

# 19. WhatsApp Integration Strategy

The initial target is **WhatsApp Web**.

The extension should interact with the user's existing authenticated WhatsApp Web environment.

The implementation MUST first investigate the technically reliable mechanism for:

* Opening WhatsApp Web.
* Detecting readiness.
* Locating Channels.
* Selecting a Channel.
* Preparing text.
* Attaching media.
* Sending.

The architecture MUST NOT assume that ordinary DOM automation is sufficient until verified against the current WhatsApp Web implementation.

---

# 20. WhatsApp Web Isolation

WhatsApp integration should be isolated behind an internal adapter.

Example:

```typescript
interface WhatsAppAdapter {
  isAvailable(): Promise<boolean>;

  getChannels(): Promise<Channel[]>;

  selectChannel(channelId: string): Promise<void>;

  sendText(text: string): Promise<void>;

  sendMedia(
    media: MediaItem,
    caption?: string
  ): Promise<void>;
}
```

The rest of the extension MUST NOT depend directly on WhatsApp DOM details.

This makes future implementation changes easier.

---

# 21. Channel Model

Internal representation:

```typescript
interface Channel {
  id: string;
  name: string;
  avatarUrl?: string;
}
```

The actual implementation may contain additional metadata.

---

# 22. WhatsApp Adapter Boundary

The following components MUST NOT directly manipulate WhatsApp-specific details:

* X content script
* X extractor
* Popup
* Settings manager

Only the WhatsApp integration layer should know how WhatsApp Web operates.

---

# 23. Publishing Pipeline

The complete pipeline should be:

```text
1. Detect X post
        ↓
2. User clicks button
        ↓
3. Extract post
        ↓
4. Normalize content
        ↓
5. Detect media
        ↓
6. Prepare media
        ↓
7. Resolve destination Channel
        ↓
8. Optional preview
        ↓
9. Publish
        ↓
10. Verify result
        ↓
11. Cleanup temporary media
        ↓
12. Report success
```

---

# 24. Confirmation Architecture

When confirmation is enabled:

```text
Extractor
   ↓
Publish Job
   ↓
Preview UI
   ↓
User Confirmation
   ↓
WhatsApp Adapter
```

When disabled:

```text
Extractor
   ↓
Publish Job
   ↓
WhatsApp Adapter
```

---

# 25. Error Architecture

Errors should be classified.

```typescript
type ErrorCategory =
  | "X_EXTRACTION"
  | "MEDIA_RETRIEVAL"
  | "MEDIA_PROCESSING"
  | "WHATSAPP_UNAVAILABLE"
  | "CHANNEL_NOT_FOUND"
  | "PUBLISH_FAILED"
  | "AUTHENTICATION"
  | "PERMISSION"
  | "UNKNOWN";
```

This allows the UI to provide useful messages without exposing internal implementation details.

---

# 26. Retry Architecture

Retryable operations should be explicitly identified.

Example:

```text
MEDIA_RETRIEVAL
PUBLISH_FAILED
WHATSAPP_TEMPORARILY_UNAVAILABLE
```

Non-retryable errors should stop immediately.

The extension should use bounded retries rather than infinite retry loops.

---

# 27. Duplicate Protection Architecture

A publishing job should have a unique ID.

The extension MAY maintain short-lived records such as:

```text
X post ID
+
Destination Channel
+
Publishing timestamp
```

This prevents accidental duplicate clicks.

The system MUST NOT permanently block legitimate reposting.

---

# 28. Security Architecture

The extension should follow least-privilege principles.

### Content isolation

X content is untrusted.

Extracted text MUST be treated as plain text.

### DOM safety

The extension MUST avoid unsafe HTML insertion.

### Credential safety

No WhatsApp credentials should be extracted or stored.

### Network safety

No unnecessary external backend should exist in MVP.

---

# 29. External Backend

MVP SHOULD NOT require a backend.

Preferred architecture:

```text
Browser
 ├── X
 ├── Extension
 └── WhatsApp Web
```

No mandatory:

```text
Browser → Custom Server → WhatsApp
```

architecture should be introduced unless technically unavoidable.

If a backend becomes necessary for a specific capability, it MUST be documented and approved separately.

---

# 30. Manifest Architecture

The implementation should use the current browser extension manifest standard supported by the target browsers.

The exact manifest version and permissions MUST be documented by the implementation agent.

The extension SHOULD use:

* Content scripts
* Service worker
* Popup
* Extension storage

only where required.

---

# 31. Permission Architecture

Permissions should be scoped to the minimum required origins.

Potential host permissions:

```text
https://x.com/*
https://twitter.com/*
https://web.whatsapp.com/*
```

The implementation agent MUST verify whether each permission is actually required.

It MUST NOT automatically use:

```text
<all_urls>
```

without a documented technical reason.

---

# 32. Browser Compatibility Architecture

MVP should prioritize Chromium.

The implementation should avoid proprietary APIs where equivalent standard extension APIs exist.

Browser-specific code should be isolated where unavoidable.

---

# 33. Observability

The extension should provide limited local diagnostics.

Example:

```text
Job ID
Source post ID
Current state
Failure category
Timestamp
```

Diagnostic logs MUST NOT contain credentials or sensitive session data.

---

# 34. Testing Architecture

Testing should operate at multiple levels.

### Unit tests

Test:

* Text extraction
* Post identification
* Media classification
* Job state transitions
* Settings
* Error classification

### Integration tests

Test:

* X DOM → extractor
* Extractor → job
* Job → media preparation
* Job → WhatsApp adapter

### Browser tests

Test:

* Real X pages
* Dynamic scrolling
* SPA navigation
* Button injection

### End-to-end tests

Test:

```text
X post
 ↓
Button
 ↓
Extraction
 ↓
Media
 ↓
WhatsApp
 ↓
Channel
```

The implementation agent should distinguish mocked tests from real browser verification.

---

# 35. Architecture Constraints

The implementation MUST NOT:

* Modify the existing WhatsApp CLI project.
* Depend on the existing WhatsApp CLI.
* Introduce a mandatory cloud backend without approval.
* Store WhatsApp credentials.
* Request unnecessary browser permissions.
* Permanently store downloaded X media.
* Build an unnecessary database.
* Turn the MVP into a general social-media management platform.

---

# 36. Key Technical Risks

## Risk 1 — X Video Retrieval

X's media delivery architecture may prevent straightforward video downloading.

**Mitigation:** Build and verify a dedicated video extraction prototype before finalizing the implementation.

---

## Risk 2 — WhatsApp Web DOM Changes

WhatsApp Web can change its internal DOM and UI.

**Mitigation:** Isolate WhatsApp functionality behind an adapter and avoid coupling the entire extension to WhatsApp selectors.

---

## Risk 3 — Browser Security Restrictions

Browser extension security policies may restrict direct interaction between extension contexts and WhatsApp Web.

**Mitigation:** Verify the exact browser-extension communication model during technical implementation.

---

## Risk 4 — Large Media

Large videos can consume substantial memory/storage.

**Mitigation:** Stream or process media efficiently where possible and clean temporary data immediately after use.

---

# 37. Architecture Decision Gate

Before full implementation, the agent MUST prove two technical assumptions:

### Gate A — WhatsApp

Can the extension reliably:

```text
Open/communicate with WhatsApp Web
→ identify a Channel
→ attach text/media
→ publish
```

without relying on the existing WhatsApp CLI?

### Gate B — X Video

Can the extension reliably:

```text
X video
→ obtain usable media
→ download/process it
→ provide it to WhatsApp Web
```

for the current X implementation?

If either gate fails, the agent MUST stop and report the technical limitation rather than silently inventing an alternative architecture.

---

# 38. Definition of Technical Completion

The architecture is considered validated when the implementation agent has demonstrated:

* X post detection.
* Reliable button injection.
* Text extraction.
* Image extraction.
* At least one real supported video extraction path.
* WhatsApp Web integration.
* Channel discovery/selection.
* Text publishing.
* Image publishing.
* Video publishing.
* Temporary media cleanup.
* Error reporting.
* No dependency on the existing WhatsApp CLI.

Only after these architecture gates pass should full MVP implementation proceed.
