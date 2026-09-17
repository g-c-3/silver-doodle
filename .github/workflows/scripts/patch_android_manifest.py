#!/usr/bin/env python3
"""Patches the Capacitor-generated client/android/app/src/main/AndroidManifest.xml
to register the matchemojisdaily://auth-callback custom URL scheme on
MainActivity, alongside its existing LAUNCHER intent-filter.

Why this exists: signInWithOtp() uses Supabase's PKCE flow by default, which
stores a code_verifier in whichever origin actually started the sign-in. The
emailed magic link always opens in the OS's system browser regardless of
where sign-in was requested -- a different origin/localStorage than the
app's own WebView -- so if sign-in was started inside the app, the code can
never be exchanged in that browser tab; the verifier just isn't there. The
fix (see client/src/js/deep-link.js and index.html's early inline redirect
script) routes the callback back into the app via this custom scheme, so
the exchange happens in the same origin that started it.

The generated file is never committed to the repo (same reasoning as
patch_build_gradle.py and docs/DECISIONS.md's "android/ generated fresh in
CI" entry), so this patch is the only place this customization lives.
Pinned exact Capacitor versions in client/package.json keep the generated
text this patch matches on stable run to run; the check below is a
deliberate tripwire -- if Capacitor's own template changes shape on a
future version bump, this fails the build loudly here instead of silently
shipping an app that can never complete sign-in when started in-app.

Verified 2026-09-17 against the real output of:
  npx @capacitor/cli@8.5.2 add android
(with @capacitor/core and @capacitor/android also pinned to 8.5.2).
"""
import pathlib
import sys

path = pathlib.Path("client/android/app/src/main/AndroidManifest.xml")
text = path.read_text()

deep_link_filter = """
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="matchemojisdaily" android:host="auth-callback" />
            </intent-filter>
"""

marker = "        </activity>"
if marker not in text:
    sys.exit(
        "PATCH FAILED: '</activity>' closing tag not found in the expected "
        "shape -- Capacitor's template shape changed, this script needs "
        "updating."
    )
text = text.replace(marker, deep_link_filter + marker, 1)

path.write_text(text)
print("AndroidManifest.xml patched with the auth-callback deep-link intent-filter.")
