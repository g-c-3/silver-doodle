#!/usr/bin/env python3
"""Patches the Capacitor-generated client/android/app/src/main/AndroidManifest.xml
for two independent customizations, both otherwise impossible to commit
directly since client/android/ isn't checked into the repo:

1. Registers the matchemojisdaily://auth-callback custom URL scheme on
   MainActivity, alongside its existing LAUNCHER intent-filter.

   Why this exists: signInWithOtp() uses Supabase's PKCE flow by default,
   which stores a code_verifier in whichever origin actually started the
   sign-in. The emailed magic link always opens in the OS's system browser
   regardless of where sign-in was requested -- a different origin/
   localStorage than the app's own WebView -- so if sign-in was started
   inside the app, the code can never be exchanged in that browser tab; the
   verifier just isn't there. The fix (see client/src/js/deep-link.js and
   index.html's early inline redirect script) routes the callback back into
   the app via this custom scheme, so the exchange happens in the same
   origin that started it.

2. (Phase 10) Declares the app's AdMob App ID via the standard
   com.google.android.gms.ads.APPLICATION_ID meta-data the Google Mobile
   Ads SDK requires at startup -- without it, AdMob.initialize() (app.js)
   fails immediately and no ad, rewarded or otherwise, can ever load. The
   value is docs/ARCHITECTURE.md Section 12's already-public AdMob App ID
   (an app identifier, not a secret -- same category as the Supabase anon
   key already committed in client/src/js/config.js), so it's a plain
   literal here rather than routed through a GitHub secret.

Pinned exact Capacitor versions in client/package.json keep the generated
text both patches match on stable run to run; each check below is a
deliberate tripwire -- if Capacitor's own template changes shape on a
future version bump, this fails the build loudly here instead of silently
shipping an app that can never complete sign-in when started in-app, or
that can never load an ad.

Verified 2026-09-17 (deep-link patch) and 2026-09-18 (AdMob App ID patch)
against the real output of:
  npx @capacitor/cli@8.5.2 add android
(with @capacitor/core and @capacitor/android also pinned to 8.5.2).
"""
import pathlib
import sys

path = pathlib.Path("client/android/app/src/main/AndroidManifest.xml")
text = path.read_text()

# ---- 1. Auth-callback deep link ----

deep_link_filter = """
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="matchemojisdaily" android:host="auth-callback" />
            </intent-filter>
"""

activity_marker = "        </activity>"
if activity_marker not in text:
    sys.exit(
        "PATCH FAILED: '</activity>' closing tag not found in the expected "
        "shape -- Capacitor's template shape changed, this script needs "
        "updating."
    )
text = text.replace(activity_marker, deep_link_filter + activity_marker, 1)

# ---- 2. AdMob App ID meta-data (Phase 10) ----
# docs/ARCHITECTURE.md Section 12 -- current registered App ID, usable for
# development as-is; Phase 12 swaps to a separate production identity when
# that phase lands, not this literal.
ADMOB_APP_ID = "ca-app-pub-6922359485200410~4812181773"

admob_meta_data = f"""
        <meta-data
            android:name="com.google.android.gms.ads.APPLICATION_ID"
            android:value="{ADMOB_APP_ID}" />
"""

# Matches the <application ...> opening tag's closing '>' specifically via
# its final, distinguishing attribute line -- android:theme="@style/
# AppTheme" (note the trailing '>' with no further text), which only
# appears once in the generated manifest; MainActivity's own theme is the
# differently-valued "@style/AppTheme.NoActionBarLaunch", so this can't
# accidentally match there instead.
application_marker = '        android:theme="@style/AppTheme">'
if application_marker not in text:
    sys.exit(
        "PATCH FAILED: '<application ...android:theme=\"@style/AppTheme\">' "
        "opening tag not found in the expected shape -- Capacitor's "
        "template shape changed, this script needs updating."
    )
text = text.replace(application_marker, application_marker + admob_meta_data, 1)

path.write_text(text)
print("AndroidManifest.xml patched with the auth-callback deep-link intent-filter and AdMob App ID meta-data.")
