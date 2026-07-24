# Project Booth — MVP Product Specification

**Status:** Draft for product approval  
**Version:** 0.2  
**Platform:** iPhone first; Android later  
**Working title:** Project Booth  
**Target session:** 12–18 minutes  
**Target audience:** 16+; not designed for children

## 1. Product definition

Project Booth is a synchronous multiplayer social-strategy game. Players are isolated in virtual booths and can communicate only through private, one-to-one text conversations. During each round, players negotiate, offer virtual-currency bribes, lie, form temporary alliances, and secretly vote to eliminate another contestant.

The defining promise is:

> Players may purchase limited leverage, but nobody can purchase guaranteed survival. A deal is a social promise, not an enforced contract.

Booth Coins have no cash value, cannot be withdrawn, cannot be redeemed for real-world goods or prizes, and cannot leave the game economy.

## 2. Product principles

1. **Psychology over arithmetic.** Persuasion, credibility, timing, bluffing, and betrayal decide more than wallet size.
2. **Paid leverage is capped.** A large wallet never increases the per-match transfer limit.
3. **Betrayal is legitimate gameplay.** A player who accepts a bribe remains free to vote for anyone.
4. **Abandonment is not betrayal.** A player cannot keep a round's bribes by accepting them and failing to vote.
5. **Votes remain secret while consequences are live.** Individual votes are revealed only in the post-match dossier.
6. **The server is authoritative.** Clients never calculate balances, timers, vote totals, eliminations, or rewards.
7. **Chat safety is a launch requirement.** Reporting, blocking, filtering, enforcement, and support are part of the MVP, not deferred operations.
8. **The backend is platform-neutral.** iOS, Android, and future clients consume the same versioned game contracts.

## 3. MVP goals

- Deliver a complete live match from matchmaking through a final winner.
- Make private conversations and non-binding bribe offers understandable without a tutorial video.
- Let free players compete using persuasion and earn a limited supply of Booth Coins through play.
- Monetize through capped Booth Coin purchases and cosmetics without unlimited competitive spending.
- Meet Apple's user-generated-content and In-App Purchase expectations.
- Establish reusable backend contracts for a later Android client.
- Produce enough analytics to tune round length, player count, coin limits, and payer advantage.

## 4. Explicit non-goals

The MVP does not include:

- Voice or video calls
- Images, attachments, links, or voice notes in chat
- Global, public, group, or post-match chat
- Real money, cash prizes, gift cards, crypto, NFTs, or cash-out
- Player-to-player transfers outside an active match offer
- A player marketplace or external coin trading
- Android, web, or desktop clients
- Ranked leagues, esports tournaments, clans, or public leaderboards
- User-generated rooms or custom rule editors
- Randomized paid rewards or loot boxes
- Advertising during a live match
- Licensed names, footage, likenesses, logos, audio, or marketing from _Beast Games_

## 5. Match format

### 5.1 Default configuration

All numerical values are server-configurable. The launch defaults are:

| Setting                   |                                           MVP default |
| ------------------------- | ----------------------------------------------------: |
| Contestants               |                                                     6 |
| First negotiation phase   |                                           120 seconds |
| Later negotiation phases  |                                            90 seconds |
| Voting phase              |                                            20 seconds |
| Elimination reveal        |                                            10 seconds |
| Runoff negotiation        |                                            30 seconds |
| Runoff voting             |                                            15 seconds |
| Final plea                |                                            60 seconds |
| Jury voting               |                                            20 seconds |
| Reconnect grace period    |                                            30 seconds |
| Maximum typed message     |                                        240 characters |
| Outgoing Booth Coin limit | TBD through economy design; fixed equally per ruleset |

### 5.2 Match lifecycle

1. **Preparation**
   - The player reviews the rules, wallet balance, and configured match outflow cap.
   - Coins cannot be purchased or added to the active match after matchmaking begins.
2. **Matchmaking**
   - The service groups six eligible players by language, latency region, safety restrictions, and block relationships.
3. **Booth entry**
   - Each contestant sees only aliases, avatars, remaining contestants, their wallet, and their private phone threads.
4. **Negotiation**
   - Active contestants exchange private messages and formal bribe offers.
   - Conflicting promises and multiple accepted deals are allowed.
5. **Voting**
   - Each active contestant secretly votes to eliminate one other active contestant.
   - Chat and new offers are locked while voting is open.
6. **Elimination**
   - The server tallies votes and removes one contestant.
   - The eliminated player becomes a juror and spectator.
   - Only aggregate results needed to explain the elimination are shown; individual ballots remain hidden.
7. **Repeat**
   - Negotiation, voting, and elimination repeat until two finalists remain.
8. **Final plea and jury**
   - Each finalist submits a short final plea.
   - Eliminated contestants vote for the winner. Bribes are disabled.
9. **Dossier and rewards**
   - The match reveals individual ballots, accepted offers, honored deals, and betrayals.
   - XP, earned rewards, and progression are granted.

### 5.3 Voting rules

- A contestant cannot vote for themselves during normal voting.
- A contestant cannot abstain intentionally.
- A submitted ballot may be changed until the voting deadline; only the final selection counts.
- No submitted ballot results in one automatic elimination vote against the inactive contestant.
- The contestant with the most votes is eliminated.
- Ballots are stored server-side and never sent to other clients before the dossier.

### 5.4 Elimination tie rules

Tie handling must be predictable and server-controlled:

1. A runoff begins between the tied contestants.
2. Non-tied active contestants vote again after a short negotiation window.
3. Tied contestants cannot vote during the runoff.
4. If every active contestant is tied, or the runoff is still tied, the tied contestant with the most cumulative elimination votes across the match is eliminated.
5. If cumulative votes are also tied, the server selects one tied contestant using an auditable random draw.

The random fallback is never affected by purchases, coin balance, or client state.

### 5.5 Final jury rules

- Eliminated contestants remain eligible jurors even if they no longer spectate continuously.
- Jurors receive the finalists' pleas and cast one secret vote.
- Missing jury ballots are excluded rather than replaced.
- The finalist with the most jury votes wins.
- A jury tie is resolved by:
  1. Fewer cumulative elimination votes received during the match
  2. Fewer missed ballots or automatic self-votes during the match
  3. An auditable server draw if both remain tied
- If no juror votes, the same fallback sequence determines the winner.

## 6. Booth Coin economy

### 6.1 Currency properties

Booth Coins are a persistent in-game currency used for:

- Bribes during active matches
- Booth and telephone themes
- Avatars, profile frames, titles, and emotes
- Ringtones, call animations, and elimination effects
- Future seasonal cosmetic passes and private-room hosting

Booth Coins:

- Have no real-world monetary or prize value
- Cannot be cashed out, redeemed, exported, or traded externally
- Cannot be transferred directly between accounts
- Can move between contestants only through a formal bribe in an active match
- Do not expire, regardless of whether they were purchased or earned
- Are maintained in an append-only, server-authoritative ledger

### 6.2 Initial and earnable supply

Exact coin quantities are intentionally deferred to a dedicated economy-design phase. That phase will define:

- New-account allocation
- Recurring free and earnable supply
- Match-completion, placement, and winner rewards
- Coin-pack sizes and prices
- Cosmetic prices and other permanent sinks
- Minimum offer increment and maximum match outflow
- Target payer advantage and inflation limits

Players can enter and complete matches with a zero balance; persuasion remains a complete gameplay path. All grants are remotely configurable. Reward farming, alternate accounts, and abnormal device/account patterns must be rate-limited and reviewable.

### 6.3 Competitive spending limit

- Each ruleset defines one outgoing Booth Coin limit that applies equally to every contestant.
- The limit applies to cumulative outgoing transfers, not current balance.
- Receiving coins does not restore or increase the recipient's outgoing allowance.
- Wallet size and purchase history never raise the match limit.
- Purchases completed after matchmaking begins are credited to the persistent wallet but are unavailable until the match ends.
- The client displays the player's remaining match allowance beside their available balance.

If the configured cap is represented by `C`, accepted outgoing transfers totaling `C` exhaust the player's allowance. Receiving additional coins never increases `C`.

### 6.4 Bribe contract

A formal bribe contains:

- Sender
- Recipient
- Coin amount
- Requested elimination target
- Optional filtered message
- Round identifier
- Creation and expiry timestamps
- State: pending, declined, expired, accepted, reversed, or settled

Rules:

- A player may send an offer only to another active contestant.
- The amount must fit both the sender's spendable balance and remaining match outflow allowance.
- Only one pending offer may exist per sender-recipient pair; it may be replaced before acceptance.
- Accepting an offer atomically reserves the sender's coins and immediately shows them as pending incoming funds for the recipient.
- Pending incoming funds are not spendable until the recipient submits a valid ballot for that round.
- Submitting any valid ballot settles the pending funds immediately, regardless of whether the promised target was selected.
- Accepted offers cannot be cancelled or reclaimed because the recipient votes differently.
- The requested target is descriptive only. It never restricts or preselects the recipient's ballot.
- A recipient may accept mutually conflicting offers.
- Deal states are private to sender and recipient until the post-match dossier.
- Offers expire when the negotiation phase closes.

### 6.5 Betrayal, abandonment, and reversal

- **Legitimate betrayal:** The recipient submits a ballot but does not vote as promised. The recipient keeps the bribe.
- **Change of mind:** The recipient changes their ballot before the deadline. The final ballot determines whether the dossier labels the deal honored or betrayed.
- **No ballot:** If the recipient submits no ballot in that round, their pending incoming bribes are reversed to their senders and never become spendable.
- **Voluntary quit:** A quit before submitting the round's ballot is treated as no ballot; current-round accepted bribes are reversed.
- **Post-vote disconnect:** If a valid ballot was submitted, accepted bribes remain settled.
- **Server cancellation:** If the platform cancels or invalidates the match, every match transfer and reward is reversed through compensating ledger entries.

A reversed bribe restores the sender's corresponding match outflow allowance. It does not consume part of the configured cap.

Reversals never edit or delete historical ledger entries.

### 6.6 Purchase integrity

- iOS purchases use StoreKit and are verified by the backend.
- Store transaction identifiers are processed idempotently.
- Refunds and revoked transactions are reconciled server-side.
- An account whose refunded balance has already been transferred may enter a restricted or negative-balance state and cannot send additional bribes until resolved.
- Suspicious circular transfers, repeated pairings, device clusters, and new-account funnels are recorded for review.
- Price tiers and pack sizes are deliberately excluded from this version of the product spec and will be defined with an economy model.

### 6.7 Denomination and perceived value

The economy should use comfortably large integer denominations rather than tiny coin counts. Larger displayed pack sizes can make purchases and rewards feel more substantial, while competitive power remains controlled by ratios and the fixed match outflow cap.

The economy-design phase will benchmark comparable successful games and select the denomination together with:

- Pack size relative to the match cap
- Free allocation relative to a typical bribe
- Minimum and typical offer sizes
- Cosmetic prices relative to earnable supply
- Expected matches required to earn common items
- Payer versus non-payer win-rate guardrails

Changing the denomination must scale grants, offers, caps, packs, and prices consistently. It must not obscure the real purchase price or create an unlimited gameplay advantage.

## 7. Communication design

### 7.1 Gameplay chat boundaries

- Chat is private, one-to-one, text-only, and available only between active contestants in the same match.
- There is no public discovery, follower system, contact list, global inbox, or post-match messaging.
- Eliminated contestants lose normal chat access.
- The phone interface provides a thread for each active contestant, unread indicators, and formal offer cards.
- Quick phrases and structured offer language appear above the keyboard.
- URLs, email addresses, telephone numbers, and other obvious contact-sharing patterns are blocked.
- Images, files, audio, video, stickers with user-authored content, and rich link previews are not supported.

### 7.2 Automated protections

Every message passes through server-side controls before delivery:

- Unicode and obfuscation normalization
- Profanity, slur, sexual-content, threat, and self-harm screening
- Personal-information and contact-sharing detection
- Flood, duplicate, and rapid-target-switching limits
- Account enforcement and mute checks
- A maximum of 240 characters
- Configurable per-user and per-thread rate limits

A blocked message produces a neutral sender-side explanation and is not delivered.

### 7.3 User safety controls

From every chat thread and message, a player can:

- Mute the contestant for the remainder of the match
- Report a specific message or the contestant's overall behavior
- Block the account from future communication and matchmaking
- Open concise community rules and safety guidance

Blocking during a match silences communication but does not change votes, accepted bribes, or the current match roster. The matchmaking service avoids future pairings between blocked accounts.

### 7.4 Moderation operations

The MVP cannot ship without an authenticated moderator interface that supports:

- A report queue ordered by severity and recency
- The reported message and limited surrounding context
- Reporter, subject, match, and enforcement history
- Warning, chat restriction, temporary suspension, and permanent ban actions
- Internal moderator notes and an append-only audit trail
- Search by account, match, message, transaction, and device-risk identifier
- Escalation of credible threats or child-safety issues
- User appeal and support status

Initial operational targets:

- Credible threats and urgent safety reports reviewed within 24 hours
- Other reports reviewed within 72 hours
- Chat evidence retained for an initial 30-day moderation window, subject to final privacy and legal review
- Public support contact, privacy policy, terms of service, and community guidelines available before App Review

## 8. Player identity and access

- Players use persistent accounts and are not anonymous to the platform.
- Other contestants see a pseudonymous display name, avatar, and progression level.
- The product does not show real name, email, phone number, precise location, or purchase history.
- Display names are filtered and reportable.
- Account deletion is available inside the app.
- Authentication, identity-provider details, age handling, and deletion are backend capabilities exposed through platform-neutral contracts.
- The app is not submitted to the Kids category and does not market itself to children.

## 9. Reconnection and failure behavior

- All phase deadlines use server time.
- Reconnecting clients request a current snapshot and resume from the server's event sequence.
- A player receives a 30-second reconnect grace period where the phase permits it; global match timers do not pause for one player.
- Backgrounding the app does not stop server timers.
- If a contestant misses a normal ballot, the automatic self-elimination vote and bribe reversal rules apply.
- If fewer than four contestants successfully enter the booth, the match is cancelled without coin movement.
- After a match has begun, disconnected contestants remain in the roster and can be eliminated normally.
- Platform-wide failures cancel the match and create compensating ledger entries.
- Every mutable command uses an idempotency key to prevent duplicate votes, offers, acceptances, purchases, and reports.

## 10. MVP user experience

### 10.1 Required screens

1. Launch and service-status screen
2. Account creation/sign-in and age acknowledgement
3. Onboarding and interactive bot tutorial
4. Home screen with Play, wallet, progression, shop, and safety access
5. Match preparation with rules and configured outflow cap
6. Matchmaking and ready confirmation
7. Booth screen with timer, contestants, wallet, and red-phone entry point
8. Private conversation thread
9. Formal bribe composer and offer card
10. Secret vote selection and confirmation
11. Elimination result
12. Eliminated spectator/jury state
13. Final plea and jury vote
14. Post-match dossier and rewards
15. Booth Coin shop and cosmetic inventory
16. Profile, block list, account deletion, support, policies, and settings
17. Message/user report flow

### 10.2 Interaction requirements

- The current phase and remaining server time are always visible in a live match.
- Coin balance and remaining match outflow allowance are visually distinct.
- Accepting an offer requires a confirmation stating that funds become pending immediately, settle after any valid ballot, and never bind the recipient's choice.
- Sending an offer requires confirmation that a dishonest recipient keeps the coins if they cast any valid ballot.
- Voting requires explicit confirmation and remains editable until the deadline.
- The dossier clearly distinguishes accepted, honored, betrayed, reversed, declined, and expired offers.
- Eliminated players are told why they should stay: they will vote in the final jury and see the dossier.

## 11. Progression and rewards

MVP progression is intentionally light:

- Account level based on completed matches and placement XP
- Non-competitive achievements for first offer, first accepted offer, survival, jury participation, and similar milestones
- Cosmetic unlocks at selected levels
- Daily first-match Booth Coin grant
- Winner Booth Coin and XP reward

The MVP does not expose a persistent honor, betrayal, or trust score before matches. Such a score would weaken uncertainty and could turn a permitted strategy into long-term punishment.

## 12. Notifications

The iOS app may send opt-in notifications for:

- Match ready confirmation
- A short reconnect warning if the app backgrounds during an active match
- Final jury vote availability for an eliminated contestant
- Moderation or appeal outcomes
- Optional daily reward availability

Promotional notification consent is separate from match-critical messaging. Push delivery is never treated as authoritative; the client always verifies current state with the backend.

## 13. Analytics and balancing

### 13.1 Required events

- Onboarding started/completed
- Matchmaking started, cancelled, timed out, and matched
- Match entered, round completed, eliminated, juror retained, and match completed
- Message attempted, delivered, blocked, muted, reported, and enforced
- Offer created, accepted, declined, expired, reversed, honored, and betrayed
- Ballot submitted/changed/missed
- Coin earned, purchased, spent on bribe, received, spent on cosmetic, refunded, and restricted
- Purchase funnel and StoreKit failure category
- Reconnect, abandonment, client error, and server cancellation

Analytics must not record raw private message text or other unnecessary personal data.

### 13.2 Launch health metrics

- Match completion rate
- Median matchmaking time by region and hour
- First-match completion and day-one return
- Juror retention through the final vote
- Bribe offer, acceptance, honor, and betrayal rates
- Percentage of contestants hitting the match outflow cap
- Win-rate difference between purchasers and non-purchasers
- Report rate per 1,000 delivered messages
- Blocked-message false-positive and appeal rates
- Purchase conversion, refund rate, and suspicious-transfer rate

### 13.3 Balance guardrails

- If purchasers' win rate exceeds comparable non-purchasers by more than 10 percentage points after accounting for experience, reduce the outflow cap or increase earnable supply.
- If more than 25% of paying contestants routinely hit the cap, review pack presentation and cap clarity before increasing the cap.
- If fewer than 10% of matches contain an accepted offer, review starter supply, offer UX, and negotiation time.
- If juror retention falls below 60%, shorten later rounds or improve eliminated-player participation.

These are product alarms, not automatic balance changes.

## 14. App Review readiness

Before submission, provide App Review with:

- A fully functional reviewer account or demo mode
- A scripted bot match demonstrating messages, offers, voting, elimination, reporting, blocking, jury voting, and the dossier
- Clear review notes explaining that Booth Coins have no cash-out or real-world value
- An explanation of the configured per-match outflow cap
- An explanation that accepted offers are non-binding gameplay promises
- StoreKit products and purchase restoration/reconciliation behavior
- Accessible privacy policy, terms, community guidelines, and support contact
- A working moderation queue and testable report path
- A truthful age-rating questionnaire

The store title, screenshots, metadata, art, and copy must use original branding and must not imply affiliation with a television program or third-party creator.

## 15. Backend contract requirements

This specification does not select infrastructure yet. It does require the future architecture to provide:

- Versioned HTTPS request/response contracts
- Versioned real-time event contracts
- Server-authoritative match state and timers
- Idempotent commands and monotonic event sequence numbers
- Atomic vote and ledger operations
- Store-provider abstraction for purchase verification and refunds
- Push-provider abstraction for APNs and later FCM
- Identity-provider abstraction
- Remote configuration for every match and economy value in this document
- Auditable moderation, economy, and match histories
- Administrative kill switches for chat, purchases, matchmaking, and individual regions
- A client compatibility policy that allows iOS and Android versions to coexist

## 16. MVP acceptance criteria

The MVP is feature-complete only when all of the following are demonstrated in a production-like environment:

1. Six independent clients can complete a full match and select one winner.
2. A recipient can accept a bribe, vote against the promise, keep the coins, and appear as a betrayal in the dossier.
3. A recipient who accepts a bribe but submits no ballot cannot spend the pending funds and has that round's bribe reversed.
4. No player can transfer more than the configured outgoing cap, including after receiving coins.
5. Duplicate or retried offer acceptance cannot transfer coins twice.
6. Individual ballots cannot be observed by other clients before the dossier.
7. A reconnecting client recovers the authoritative phase, timer, messages, offers, and ballot status.
8. A tied vote follows the documented runoff and fallback sequence.
9. StoreKit purchases, refunds, and revoked transactions reconcile without creating spendable duplicate value.
10. A blocked message is not delivered, and a report appears in the moderator queue with context.
11. Blocking a user prevents future matchmaking while preserving the current match outcome.
12. Account deletion, support contact, policies, and community guidelines are accessible in-app.
13. Server-side configuration can change timers, rewards, and coin caps without an iOS release.
14. The scripted App Review flow works without requiring five reviewers to join simultaneously.

## 17. Deferred decisions for architecture planning

The architecture phase must recommend and justify:

- Backend language and framework
- Database and append-only ledger design
- Real-time transport and connection topology
- Authentication providers and account-linking model
- StoreKit verification and App Store Server Notification processing
- Chat filtering/moderation implementation and vendor boundaries
- Deployment region, hosting provider, scaling model, and estimated indie operating cost
- Analytics and observability stack
- Admin/moderator interface technology
- API schema, event envelope, versioning, and client compatibility strategy
- Test strategy for deterministic matches, concurrency, reconnects, and purchase/refund abuse
