# Client

Capacitor-wrapped HTML/CSS/JS game. Fully built as of Phase 10 (`../docs/ROADMAP.md`) — see
`../docs/ARCHITECTURE.md` Section 3 for the game mechanics this client implements.

```
src/
  index.html          screen router markup (home, auth, game, leaderboard, stats,
                       attempt-history, info, profile screens)
  css/styles.css       all styling
  js/
    game-engine.js     pure match-3 logic — seeded RNG, board gen, match detection,
                        scoring, cascade resolution. No DOM.
    attempt.js          attempt orchestration — 26-slot forced-sequential play, shared
                         life pool, bonus rounds, AdMob rewarded-ad flow, score-replay
                         submission
    app.js              screen router, auth-state routing, AdMob SDK init
    auth.js              email-link sign-in/sign-up
    profile.js            display-name / email-change flow
    leaderboard.js         daily/weekly/all-time leaderboard screen
    attempt-history.js     player's own past-attempts screen
    stats.js                all-time stats + calendar screen
    deep-link.js              completes magic-link sign-in inside the native app via the
                               matchemojisdaily://auth-callback URL scheme (see
                               ../docs/ARCHITECTURE.md Section 10)
    config.js, supabaseClient.js   Supabase project connection
assets/
  icon.svg             app icon source — regenerated into every density/adaptive-icon
                        variant by @capacitor/assets on each CI run (never hand-committed)
android/                NOT committed — scaffolded fresh by ../.github/workflows/build-apk.yml
                        on every CI run
capacitor.config.json
package.json            pinned exact @capacitor/* versions
```

No local build step is required or expected — GitHub Actions (`../.github/workflows/build-apk.yml`) handles the entire Capacitor + Gradle build and produces the signed APK.
