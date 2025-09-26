# Emoji Verdict PRD

## Introduction / Overview
This feature delivers a whimsical, emoji-only verdict experience for short text inputs. Users paste copy, adjust emoji weirdness, and receive a shareable streaming verdict that drives delight, virality, and top-of-funnel visibility for the 30-apps challenge. The launch also validates the OG-card generation pipeline while collecting lightweight engagement signals (visitors, verdicts, shares, sign-ups).

## Goals
- Achieve ≥5,000 unique visitors in week 1 with ≥500 social shares (Twitter/LinkedIn).
- Ensure ≥25% of sessions submit a verdict with total render time <5s p95 and API TTFB <1.5s p95.
- Keep infrastructure cost < $10 per 1,000 verdicts while delivering a playful, viral experience.
- Drive portfolio awareness and grow the email/follower list for future launches.

## User Stories
- As a user, I paste text and get a fun verdict with only emojis for evidence/sentence.
- As a user, I tweak weirdness to change emoji density and tone before submitting.
- As a user, I share a link or OG card so friends see the exact verdict I received.
- As a creator, I see aggregate usage metrics such as verdicts per day and shares per session.

## Functional Requirements
1. The interface must accept pasted text up to 500 characters, handling empty or emoji-only input gracefully.
2. Provide a Weirdness/Density slider from 0–10 and reflect the current value in the UI.
3. When the user submits, stream verdict output (verdict, evidence, sentence) as it arrives from the model.
4. Automatically generate an OG card aligned with the current verdict for sharing.
5. Offer controls to copy/share a link that reconstructs the result using a URL-encoded payload; fall back to a signed shortlink if the URL exceeds ~1.9k characters.
6. Provide a one-click option to download or share the OG card image.
7. Surface curated example prompts for quick trial.
8. Autodetect language, translating to an English-style verdict while preserving emoji relevance.
9. Auto-truncate emoji sequences that exceed the density rules while preserving humor.
10. Enforce a friendly rate limit of 30 requests per IP per day, returning an informative message when exceeded.
11. Apply a safe-mode filter that rewrites disallowed content with a playful warning; hard-block only extreme or policy-violating input.
12. Ensure responses conform to the defined JSON schema, with emoji-only fields free of letters/punctuation.
13. Deliver responsive, accessible UX across mobile and desktop, honoring keyboard navigation, ARIA labels, WCAG AA contrast, and `prefers-reduced-motion`.
14. Guarantee that share links and OG images reproduce the exact verdict, density, and emoji payload.
15. Maintain p95 API latency <3s and full render <5s, with graceful error handling and retry prompts for transient failures.
16. Implement logging, moderation decisions, and rate limiting without exposing secrets to the client; ensure environment guard passes for all deployments.
17. Respect data policy: do not persist raw user text; store only encoded payloads for share links when needed.

## Non-Goals (Out of Scope)
- Auth, login, or saved history features.
- Payments, premium tiers, or monetization flows.
- Image uploads or true image generation beyond OG card composition.
- Multi-language UI (non-English input may still be processed if translated per requirements).
- Public gallery or feed of verdicts.
- Advanced theming, font packs, or deep customization beyond the Weirdness slider.

## Design Considerations
- Follow a minimal yet playful “whimsical courthouse” aesthetic (gavels, columns) blended with bold emoji-focused cards.
- Embrace a minimal black/white foundation with high-contrast emoji and color pops that support virality.
- Ensure accessibility best practices including WCAG AA compliance and honoring `prefers-reduced-motion`.
- No existing mocks; collaborate with lightweight explorations as needed.

## Technical Considerations
- Primary stack: Vercel hosting for the web app and OG image generation, OpenAI GPT-5-Codex for verdict synthesis.
- Use Upstash Redis for per-IP rate limiting, Supabase for structured logging/metrics, and PostHog or Umami plus Sentry for analytics and monitoring.
- Share mechanism should prefer URL-encoded payloads (no storage) with automatic fallback to a signed shortlink when necessary.
- Moderation pipeline rewrites disallowed content safely, escalating to hard blocks for extreme cases; log decisions with 30-day retention.
- Emoji density mapping: linear slider 0→0.2 temperature, 10→0.9; evidence clamp `3 + D` (3–16), verdict clamp `1 + (D>5)` (1–3), sentence clamp `4 + 2D` (4–24).
- Plan for serverless cold starts by priming critical paths or caching prompt templates.

## Success Metrics
- Visitors per day with ≥30% verdict completion rate.
- Shares per session ≥0.4 with OG card click-through rate ≥6%.
- Median Weirdness/Density value between 5–6 (engagement proxy).
- Cost per 1,000 verdicts <$10 with total error rate <2%.
- ≥12% of users return within 7 days of first verdict.
- <3 moderation abuse reports or support tickets per week.

## Data Requirements
- Log minimal analytics: page views, conversions, verdict/share counts.
- Capture request metadata (timestamp, IP hash, token usage, latency, success flag) for observability.
- Store encoded result payloads only when generating shortlinks; otherwise encode entirely in URL.
- Keep logs for 30 days, purging afterward; never persist raw user content long-term.
- Integrate with PostHog/Umami for product analytics and Sentry for error monitoring.

## Task List
- [ ] **Frontend Experience**
  - [x] Build the verdict input flow (text field, Weirdness slider, example prompts, validation).
  - [x] Implement streaming verdict rendering with emoji density controls and truncation rules.
  - [x] Add share actions (URL-encoded link, shortlink fallback, OG card download) with copy UX.
  - [x] Ensure responsive, accessible UI aligned with whimsical courthouse theme and WCAG AA.
- [ ] **Verdict API & Moderation**
  - [x] Implement verdict generation endpoint with OpenAI GPT-5-Codex and density mapping.
  - [x] Add language detection/translation while preserving emoji relevance.
  - [x] Enforce moderation pipeline (rewrite with playful warning, hard-block extreme cases).
  - [x] Integrate rate limiting (30 requests/day/IP) and friendly over-limit messaging.
- [ ] **Sharing & OG Pipeline**
  - [ ] Generate OG card service on Vercel that matches verdict payloads exactly.
  - [ ] Guarantee share links reproduce verdict, density, and emoji payload via URL encoding.
  - [ ] Implement automatic shortlink fallback when URL length exceeds ~1.9k characters.
- [ ] **Telemetry & Infrastructure**
  - [ ] Configure Supabase logging, PostHog/Umami analytics, and Sentry error monitoring.
  - [ ] Ensure no secrets leak to client; confirm environment guard for dev/test/prod.
  - [ ] Track cost, latency, and rate-limit metrics with 30-day retention and purge policy.
- [ ] **Quality Assurance & Launch**
  - [ ] Write automated tests covering success paths, moderation, rate limiting, and share flow.
  - [ ] Validate performance targets (p95 API <3s, render <5s) and log review workflows.
  - [ ] Finalize launch checklist including playful moderation copy and available assets.

## Relevant Files
- `tasks/prd-emoji-verdict.md` – PRD, task list, and open questions for the Emoji Verdict feature.
- `frontend/src/app/api/verdict/route.ts` – Streaming verdict endpoint calling OpenAI and emitting share metadata.

## Open Questions
- Confirm the exact playful warning copy to display for moderated rewrites and hard blocks.
- Validate availability of assets (illustrations, iconography) supporting the whimsical courthouse theme.
- Determine whether additional incentives (e.g., copy for email capture) are needed within the initial experience.
