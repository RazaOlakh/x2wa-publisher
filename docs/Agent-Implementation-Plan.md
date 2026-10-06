# X → WhatsApp Channel Poster

## Agent Implementation Plan

**Document Status:** Ready for Implementation
**Version:** 1.0
**Related Documents:**

* Product Requirements Document (PRD)
* Functional Requirements Specification (FRS)
* Technical Architecture Specification
* UX/UI Specification

---

# 1. Objective

Build a standalone browser extension that allows a user to take content from an X post and publish it to a selected WhatsApp Channel.

The extension must support:

* X post detection.
* Text extraction.
* Image extraction.
* Video retrieval.
* WhatsApp Channel selection.
* Text publishing.
* Image publishing.
* Video publishing.
* Confirmation workflow.
* Error handling.
* Retry behavior.

The extension MUST remain completely independent from the existing WhatsApp CLI project.

---

# 2. Agent Operating Rules

The implementation agent MUST follow these rules.

## Rule 1 — Read Documentation First

Before modifying or creating code, the agent MUST read:

```text
docs/PRD.md
docs/FRS.md
docs/ARCHITECTURE.md
docs/UX.md
```

If filenames differ, the agent should identify the corresponding documents.

---

## Rule 2 — No Silent Product Decisions

If a requirement is ambiguous and the decision materially affects:

* User experience.
* Security.
* Architecture.
* Scope.
* Data handling.

the agent MUST stop and ask for a decision.

The agent may make ordinary implementation decisions that do not alter product behavior.

---

## Rule 3 — Independent Project

The agent MUST NOT:

* Modify the existing WhatsApp CLI project.
* Import code from it.
* Depend on its daemon.
* Depend on its IPC.
* Depend on its configuration.
* Depend on its database.

---

## Rule 4 — No Premature Overengineering

The agent MUST NOT introduce:

* Backend servers.
* Databases.
* Cloud infrastructure.
* Authentication systems.
* Analytics infrastructure.

unless explicitly required by a validated technical constraint.

---

# 3. Phase 0 — Repository Initialization

## Tasks

Create a clean standalone repository.

Recommended structure:

```text
x-whatsapp-poster/
├── docs/
│   ├── PRD.md
│   ├── FRS.md
│   ├── ARCHITECTURE.md
│   ├── UX.md
│   └── IMPLEMENTATION.md
│
├── src/
│   ├── content/
│   ├── background/
│   ├── popup/
│   ├── whatsapp/
│   ├── media/
│   ├── extraction/
│   ├── storage/
│   └── shared/
│
├── tests/
├── public/
├── package.json
├── manifest.json
└── README.md
```

The agent may adjust the structure if a framework requires a different organization.

---

# 4. Phase 1 — Technical Spike

This phase is mandatory.

Do NOT immediately build the entire extension.

The agent must first validate the two highest-risk capabilities.

---

## Gate A — WhatsApp Web

Determine whether the extension can reliably:

```text
Open WhatsApp Web
        ↓
Detect authenticated state
        ↓
Discover Channels
        ↓
Select Channel
        ↓
Enter text/media
        ↓
Publish
```

The agent should create a minimal proof of concept.

### Gate A Success Criteria

The agent can demonstrate a real Channel receiving a test post.

---

# 5. Gate B — X Video

Create a minimal proof of concept for:

```text
X post
 ↓
Detect video
 ↓
Resolve usable media
 ↓
Retrieve/download video
 ↓
Produce uploadable media
```

Test multiple real X video posts if possible.

### Gate B Success Criteria

At least one supported X video can be reliably retrieved and prepared for WhatsApp.

---

# 6. Technical Gate Failure

If Gate A or Gate B fails:

The agent MUST NOT continue into full implementation while pretending the architecture works.

Instead, report:

```text
Gate:
Problem:
Observed behavior:
Why current approach fails:
Possible alternatives:
Recommended approach:
Decision required:
```

Wait for approval before changing architecture.

---

# 7. Phase 2 — Extension Foundation

After technical gates pass:

Implement:

* Browser extension manifest.
* Content script.
* Background service worker.
* Popup.
* Shared types.
* Extension messaging.
* Settings storage.

At this stage there should be no complete publishing workflow yet.

---

# 8. Phase 3 — X Integration

Implement:

### Post detection

* Detect rendered X posts.
* Handle infinite scrolling.
* Handle SPA navigation.
* Identify post IDs.

### Button

* Inject WhatsApp action.
* Prevent duplicates.
* Handle button states.

### Extraction

Implement:

* Text extraction.
* Image detection.
* Video detection.
* Source URL extraction.

---

# 9. Phase 4 — Content Normalization

Create a normalized internal representation:

```typescript
interface SourcePost {
  source: "x";
  id?: string;
  text: string;
  media: MediaItem[];
  sourceUrl?: string;
}
```

The extraction layer should produce normalized data regardless of how X's DOM is structured.

---

# 10. Phase 5 — Media Pipeline

Implement the media subsystem.

## Images

Support:

* Single image.
* Multiple images where supported.
* Caption association.

## Videos

Support:

* Video detection.
* Source resolution.
* Download/retrieval.
* Temporary storage.
* Validation.
* Cleanup.

The media subsystem should expose a clean interface to the publishing system.

---

# 11. Phase 6 — WhatsApp Integration

Implement the validated WhatsApp adapter.

Responsibilities:

* Detect WhatsApp availability.
* Detect authentication state.
* Discover Channels.
* Select Channel.
* Publish text.
* Publish images.
* Publish video.
* Return publishing status.

WhatsApp-specific implementation details MUST remain isolated from X-related code.

---

# 12. Phase 7 — Publishing Pipeline

Implement:

```text
Extract
 ↓
Normalize
 ↓
Prepare media
 ↓
Resolve Channel
 ↓
Preview if required
 ↓
Publish
 ↓
Verify
 ↓
Cleanup
 ↓
Success
```

The pipeline should be represented by explicit job states.

---

# 13. Phase 8 — Confirmation & Preview

Implement the UX defined in `UX.md`.

Required:

* Preview.
* Text display/editing where supported.
* Media preview.
* Channel display.
* Cancel.
* Confirm.

Confirmation must be configurable.

---

# 14. Phase 9 — Settings

Implement:

### Required

* Default Channel.
* Confirmation toggle.

### Recommended

* Enable/disable X button.
* Connection status.

Settings must persist between browser restarts.

---

# 15. Phase 10 — Error Handling

Implement categorized errors.

Required categories:

```text
X_EXTRACTION
MEDIA_RETRIEVAL
MEDIA_PROCESSING
WHATSAPP_UNAVAILABLE
CHANNEL_NOT_FOUND
PUBLISH_FAILED
AUTHENTICATION
PERMISSION
UNKNOWN
```

Every user-facing failure must map to a meaningful message.

---

# 16. Phase 11 — Retry

Implement bounded retry behavior for recoverable operations.

Retry should be available for:

* Temporary media failures.
* Temporary WhatsApp failures.
* Publishing failures.

Do not implement infinite automatic retries.

---

# 17. Phase 12 — Duplicate Protection

Implement protection against accidental rapid repeated publishing.

The system should track:

```text
X post ID
Destination Channel
Current job
```

Multiple simultaneous publishing jobs for the same action should not be created accidentally.

---

# 18. Phase 13 — Cleanup

Implement temporary media cleanup.

Verify cleanup occurs after:

* Successful publishing.
* Failed publishing.
* Cancellation.
* Aborted jobs.

No permanent media archive should be created.

---

# 19. Phase 14 — Security Review

Before release, inspect:

### Permissions

Verify every manifest permission is necessary.

### Credentials

Verify no WhatsApp credentials/session tokens are stored.

### Content

Verify X content cannot execute as HTML/JavaScript.

### Network

Verify no unexpected external endpoints are contacted.

### Storage

Verify temporary media and settings are handled correctly.

---

# 20. Phase 15 — Testing

Testing must be performed at multiple levels.

## Unit Tests

Test:

* X post parsing.
* Text normalization.
* Media classification.
* Job state transitions.
* Settings.
* Error classification.

---

## Integration Tests

Test:

```text
X DOM
 ↓
Extractor
 ↓
Normalized post
 ↓
Publish job
```

and:

```text
Publish job
 ↓
WhatsApp adapter
```

---

## Browser Tests

Verify:

* X home timeline.
* X profile.
* X search.
* Replies/threads.
* Infinite scrolling.
* SPA navigation.
* Button injection.
* Button duplication prevention.

---

# 21. End-to-End Tests

The agent MUST test at least:

### E2E-001

Text-only X post → WhatsApp Channel.

### E2E-002

Text + image → WhatsApp Channel.

### E2E-003

Text + video → WhatsApp Channel.

### E2E-004

Media-only post → WhatsApp Channel.

### E2E-005

Multiple-image post where supported.

### E2E-006

Failed video retrieval.

### E2E-007

WhatsApp unavailable.

### E2E-008

Invalid/unavailable Channel.

### E2E-009

Rapid duplicate click.

### E2E-010

X dynamic navigation.

---

# 22. Real-World Verification

Mocked tests alone are NOT sufficient.

The agent must perform real browser verification against:

* X.
* WhatsApp Web.
* At least one real WhatsApp Channel.

The agent should document which tests were:

```text
Mocked
Integration
Real browser
Real publishing
```

---

# 23. Performance Verification

Verify:

* Normal text posts remain fast.
* Images do not unnecessarily block the UI.
* Large videos provide progress.
* Browser UI remains responsive.
* Temporary media is cleaned up.

The agent should identify obvious memory leaks or unbounded storage.

---

# 24. UX Verification

Verify the implementation against `UX.md`.

Check:

* Button appearance.
* Button states.
* Loading indicators.
* Preview.
* Channel selection.
* Success state.
* Failure state.
* Retry.
* Dark mode.
* Accessibility.

The agent MUST NOT redesign the product during implementation without approval.

---

# 25. Documentation Updates

The agent should update documentation when implementation reveals important technical realities.

Examples:

* Browser limitations.
* X video limitations.
* WhatsApp Web behavior.
* Required permissions.
* Supported media constraints.

Changes to product scope require approval.

---

# 26. README

The final repository README should contain:

* Product description.
* Features.
* Browser support.
* Installation.
* Configuration.
* Usage.
* Known limitations.
* Development instructions.
* Testing instructions.
* Privacy/security notes.

---

# 27. Known Limitations

The README MUST explicitly document limitations such as:

* X video extraction restrictions.
* Unsupported media formats.
* WhatsApp Web limitations.
* Browser-specific behavior.
* Multi-image limitations.
* Any Channel-specific limitations.

The agent MUST NOT claim universal support when actual testing shows otherwise.

---

# 28. Definition of Done

The implementation is complete only when:

* [ ] Repository initialized.
* [ ] Documentation present.
* [ ] Technical Gate A passed.
* [ ] Technical Gate B passed.
* [ ] Extension loads successfully.
* [ ] X posts are detected.
* [ ] Button is injected.
* [ ] Duplicate buttons are prevented.
* [ ] Text extraction works.
* [ ] Image extraction works.
* [ ] Video extraction works for documented supported cases.
* [ ] Channel selection works.
* [ ] Text publishing works.
* [ ] Image publishing works.
* [ ] Video publishing works.
* [ ] Confirmation workflow works.
* [ ] Settings persist.
* [ ] Errors are handled.
* [ ] Retry works.
* [ ] Duplicate publishing is prevented.
* [ ] Temporary media is cleaned.
* [ ] Permissions are reviewed.
* [ ] Security review completed.
* [ ] Real browser tests completed.
* [ ] Documentation updated.
* [ ] README completed.
* [ ] Git worktree is clean.
* [ ] Final implementation is committed.

---

# 29. Agent Final Report

At completion, the agent MUST provide:

## Summary

What was implemented.

## Files Changed

List important files and their purpose.

## Architecture

Describe the final architecture actually implemented.

## Technical Gates

```text
WhatsApp Gate: PASS/FAIL
X Video Gate: PASS/FAIL
```

## Tests

List tests performed and results.

## Real-World Verification

State exactly which workflows were tested against real X and WhatsApp.

## Known Limitations

List unresolved limitations.

## Security

List permissions and security considerations.

## Git

Provide:

* Commit hash.
* Branch.
* Working-tree status.

---

# 30. Stop Conditions

The agent MUST stop and request a decision if:

1. WhatsApp Web cannot reliably be controlled using the approved architecture.
2. X video retrieval requires an unapproved external service.
3. A backend becomes necessary.
4. New permissions substantially expand the extension's access.
5. Product behavior must change.
6. A security/privacy tradeoff requires user approval.
7. The implementation requires modifying the existing WhatsApp CLI project.

The agent MUST NOT bypass these conditions by making an undocumented architectural decision.

---

# 31. Implementation Philosophy

The agent should follow:

```text
Understand
   ↓
Validate risky assumptions
   ↓
Implement smallest working component
   ↓
Test
   ↓
Integrate
   ↓
Verify
   ↓
Document
   ↓
Commit
```

The priority is **reliability over feature quantity**.

A smaller extension that reliably publishes supported X content is preferable to a large extension with fragile automation.
