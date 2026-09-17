#!/usr/bin/env python3
"""Patches the Capacitor-generated client/android/app/build.gradle for
release signing (reading client/android/keystore.properties, written by a
prior CI step from GitHub Secrets -- never committed) and a per-build
versionCode/versionName. The generated file is never committed to the repo
(see docs/DECISIONS.md's "android/ generated fresh in CI" entry, 2026-09-17),
so this patch is the only place these customizations live. Pinned exact
Capacitor versions in client/package.json keep the generated text this
patch matches on stable run to run; each check below is a deliberate
tripwire -- if Capacitor's own template changes shape on a future version
bump, this fails the build loudly here instead of silently shipping an
unsigned or unversioned APK.

Verified 2026-09-16 against the real output of:
  npx @capacitor/cli@8.5.2 add android
(with @capacitor/core and @capacitor/android also pinned to 8.5.2).
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
