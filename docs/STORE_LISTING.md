# Play Store Listing — Match Emojis Daily

Draft copy for the Google Play Console store listing. Text fields below are ready to paste
in as-is; the asset checklist at the bottom lists what still needs to be produced separately
(most of it needs a real device to capture).

---

## App details

**App name** (30 char max): `Match Emojis Daily`
_(19 chars — fits comfortably)_

**Short description** (80 char max):
```
Daily emoji match-3 puzzle. 26 levels, real leaderboards, one shot a day.
```
_(74 chars)_

**Full description** (4000 char max):
```
Match Emojis Daily is a daily match-3 puzzle built around one idea: everyone plays the
same 26 levels each day, so the leaderboard is decided by skill, not luck of the draw.

HOW IT WORKS
Every day brings a fresh set of 26 themed levels — pets, wild animals, desserts, space,
musical instruments, and more — each with its own emoji piece set and move budget. Clear
a level by matching 3 or more identical emoji in a row or column before you run out of
lives. Chain a horizontal and vertical match at once for a big score bonus.

THREE LIVES, ONE SHARED POOL
You get 3 lives per attempt, shared across the whole 26-level run — lose one and the
clock on your current level just gets 60 extra seconds, no restart. Run out, and a single
rewarded ad can buy you one more shot before the attempt ends.

BONUS ROUNDS
Every third level clears, you're offered a bonus round: 30 seconds, no move limit, mixed
emoji from your last three themes — pure free points if you want them.

DAILY LEADERBOARDS
Compete on Daily, Weekly, and All-Time leaderboards, each using the same fair ranking
system: highest score first, then average score, then time bonus, then how efficiently
you played. Every score is verified on our server before it counts — no shortcuts, no
leaderboard cheating.

TRACK YOUR PROGRESS
A full stats page shows your best days, total attempts, and a calendar of everything
you've played, so you can see your own progress build day over day.

12 attempts a day. New levels every day. Everyone plays the same puzzle — only your skill
decides where you land.
```

**App category:** Games → Puzzle

**Tags** (pick up to 5 in Play Console): Puzzle, Casual, Daily challenge, Match-3, Brain

**Contact email:** _(same address used in privacy-policy.html Section 10 — fill in once decided)_

**Website:** _(optional — GitHub Pages URL if wanted:
`https://g-c-3.github.io/silver-doodle/`, or leave blank)_

**Privacy policy URL:** `https://g-c-3.github.io/silver-doodle/privacy-policy.html`

---

## Graphic assets — none of these exist yet, checklist for what's needed

Google Play requires all of the following before a listing can go live. None of these can
be produced sight-unseen from this side — screenshots need a real device running the app,
and the feature graphic/icon need actual design decisions confirmed against how they render
at Play Store size (not just at app-icon size, which is already handled by Phase 11's
`icon.svg` pipeline).

| Asset | Spec | Status |
|---|---|---|
| App icon | 512×512 PNG, 32-bit with alpha | **Done** — exported from the live `client/assets/icon.svg`. Note: that file was deliberately switched to an externally-sourced (AI-generated) image, not the "Option B" neon-glow design DECISIONS.md/ARCHITECTURE.md still describe — those docs need a correction pass. |
| Feature graphic | 1024×500 PNG or JPG, no alpha | **Done** — color-matched to the current icon's blue palette. |
| Phone screenshots | 2–8 images, 16:9 or 9:16, min 320px on the short side | Not started — needs real gameplay screenshots from a device (reveal screen, in-level HUD, bonus round, leaderboard, attempt summary make a good spread) |
| Short promo video (optional) | YouTube link | Not planned — optional, skip unless wanted later |

**Suggested screenshot set (5, once captured):**
1. In-level HUD mid-match, showing the theme banner and score
2. Theme-reveal screen for a colorful theme (e.g. Tropical Fruits or Desserts)
3. Bonus round in progress
4. Leaderboard screen (Daily tab)
5. Attempt-summary "server-validated" result screen

---

## Content rating

Not yet filled out — Play Console's content rating questionnaire needs to be completed
directly in the console (it's an interactive form, not something to pre-draft). Given the
app has no violence, gambling-style real-money mechanics, or mature content, it should
land in the lowest rating tier, but the actual rating is only assigned after Google's
questionnaire is submitted.

---

## Next steps, in order

1. Fill in the two bracketed placeholders in `privacy-policy.html` (date + contact email),
   commit it, and publish it via GitHub Pages.
2. Decide and share the contact email so it can be reused consistently across the privacy
   policy and this listing.
3. ~~Export a 512×512 PNG of `client/assets/icon.svg` for the Play Console icon slot.~~ Done.
4. ~~Design a 1024×500 feature graphic.~~ Done.
5. Capture the 5 suggested screenshots from a real device running the current build.
6. Swap in production AdMob ad unit IDs (separate Phase 12 item — needs new ad units
   created in the AdMob console, since the current ones are marked development/test-only).
7. Start the Google Play Console developer account / identity verification (Phase 1's
   still-open item) — this has its own lead time and can run in parallel with the above.
8. Correct DECISIONS.md/ARCHITECTURE.md's app-icon description — both still describe the
   earlier "Option B" neon-glow vector design; the icon was since deliberately replaced with
   an externally-sourced image (confirmed intentional). Docs haven't been updated to match yet.
