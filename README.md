# Match Emojis Daily

A match-3 puzzle game shipping as an Android APK. Client is a Capacitor-wrapped HTML/CSS/JS game; backend is Supabase (Postgres, Auth, Edge Functions); analytics/crash reporting is Firebase (Analytics + Crashlytics only).

Project documentation lives in `docs/`:

- `docs/ARCHITECTURE.md` — technical design: stack, data model, game-fairness model, score-integrity model, CI/CD.
- `docs/DECISIONS.md` — dated log of design and technical decisions, with rationale.
- `docs/ROADMAP.md` — phased build plan.
- `docs/SESSIONS.md` — running dev log, most recent session first.

Distribution is manual APK sideload via GitHub Releases during development. Google Play submission is a later phase, gated on the privacy policy page and production ad unit IDs.
