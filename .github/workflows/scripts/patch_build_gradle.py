#!/usr/bin/env python3
"""Patches two Capacitor-generated files under client/android/ that need
customization beyond Capacitor's own default template: app/build.gradle
(release signing, reading client/android/keystore.properties written by a
prior CI step from GitHub Secrets -- never committed -- plus a per-build
versionCode/versionName) and variables.gradle (minSdkVersion, raised from
Capacitor's default -- see the SECURITY/COMPATIBILITY FIX comment below).
Neither generated file is ever committed to the repo (see docs/DECISIONS.md's
"android/ generated fresh in CI" entry, 2026-09-17), so this patch is the
only place these customizations live. Pinned exact Capacitor versions in
client/package.json keep the generated text this patch matches on stable
run to run; each check below is a deliberate tripwire -- if Capacitor's own
template changes shape on a future version bump, this fails the build
loudly here instead of silently shipping an unsigned, unversioned, or
wrong-minSdk APK.

Verified 2026-09-16 against the real output of:
  npx @capacitor/cli@8.5.2 add android
(with @capacitor/core and @capacitor/android also pinned to 8.5.2).
The variables.gradle default (minSdkVersion = 24) was re-verified
2026-09-19 directly from @capacitor/cli@8.5.2's own bundled
assets/android-template.tar.gz, not assumed to still match the 2026-09-16
note above.
"""
import os
import pathlib
import sys

path = pathlib.Path("client/android/app/build.gradle")
text = path.read_text()

signing_block = """
    signingConfigs {
        release {
            def keystoreProps = new Properties()
            def keystorePropsFile = rootProject.file('keystore.properties')
            if (keystorePropsFile.exists()) {
                keystoreProps.load(new FileInputStream(keystorePropsFile))
                storeFile rootProject.file(keystoreProps['storeFile'])
                storePassword keystoreProps['storePassword']
                keyAlias keystoreProps['keyAlias']
                keyPassword keystoreProps['keyPassword']
            }
        }
    }
"""

marker = "android {\n"
if marker not in text:
    sys.exit(
        "PATCH FAILED: 'android {' opening line not found in the generated "
        "build.gradle -- Capacitor's template shape changed, this script "
        "needs updating."
    )
text = text.replace(marker, marker + signing_block, 1)

# GITHUB_RUN_NUMBER is set automatically by Actions on every job -- no need
# to pass it in explicitly. Falls back to "1" only for a local dry run.
run_number = os.environ.get("GITHUB_RUN_NUMBER", "1")

if "versionCode 1" not in text:
    sys.exit(
        "PATCH FAILED: 'versionCode 1' default not found -- Capacitor's "
        "template shape changed, this script needs updating."
    )
text = text.replace("versionCode 1", f"versionCode {run_number}", 1)
text = text.replace('versionName "1.0"', f'versionName "1.0.{run_number}"', 1)

old_release = "        release {\n            minifyEnabled false"
new_release = (
    "        release {\n"
    "            signingConfig signingConfigs.release\n"
    "            minifyEnabled false"
)
if old_release not in text:
    sys.exit(
        "PATCH FAILED: release buildType block not found in the expected "
        "shape -- Capacitor's template shape changed, this script needs "
        "updating."
    )
text = text.replace(old_release, new_release, 1)

path.write_text(text)
print("client/android/app/build.gradle patched for release signing.")

# SECURITY/COMPATIBILITY FIX (2026-09-19, §5.13): following an external
# code review (docs/DECISIONS.md's 2026-09-19 (later still) entry), 7 of
# the 156 emoji glyphs used as game pieces (client/src/js/attempt.js's
# THEMES array) were Emoji 13.0-15.0, unsupported on a real share of this
# app's target devices -- rendering as blank, indistinguishable boxes,
# which made valid matches look broken. Fixed two ways together: those 7
# glyphs were swapped for Emoji <=12.0 equivalents (see attempt.js's own
# comment on this), and minSdkVersion is raised here from Capacitor's
# default of 24 (Android 7) to 29 (Android 10) -- the actual floor Emoji
# 12.0 needs, verified against Unicode's own emoji-data.txt / Emojipedia,
# not assumed. This is a real, deliberate compatibility tradeoff, not a
# side effect: any device below Android 10 can no longer install this app
# at all. Approved as the chosen option among three the review raised
# (the other two -- bundling a font, or runtime glyph detection -- both
# keep Capacitor's default minSdk 24 but cost real APK size or code
# complexity instead).
variables_path = pathlib.Path("client/android/variables.gradle")
variables_text = variables_path.read_text()
old_min_sdk = "minSdkVersion = 24"
new_min_sdk = "minSdkVersion = 29"
if old_min_sdk not in variables_text:
    sys.exit(
        "PATCH FAILED: 'minSdkVersion = 24' default not found in "
        "variables.gradle -- Capacitor's template default changed (or was "
        "already raised elsewhere), this script needs updating rather than "
        "silently leaving minSdkVersion unpatched."
    )
variables_text = variables_text.replace(old_min_sdk, new_min_sdk, 1)
variables_path.write_text(variables_text)
print("client/android/variables.gradle patched: minSdkVersion 24 -> 29.")
