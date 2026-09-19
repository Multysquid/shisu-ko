@echo off
REM Submits a new version of the extension to the public listing on addons.mozilla.org (listed
REM channel). The listing text comes from docs\amo (make_metadata.py builds the JSON web-ext
REM sends); the privacy policy, icon and screenshots are set once in the Developer Hub, see
REM docs\amo\README.md. Needs Node.js, Python and the same AMO API key as sign-addon.cmd:
REM   1. https://addons.mozilla.org/developers/addon/api/key/
REM   2. Set the two values for this window:   set WEB_EXT_API_KEY=user:...   set WEB_EXT_API_SECRET=...
REM   3. Bump "version" in addon\manifest.json and VERSION in server\server.py first: AMO refuses a
REM      version number that was uploaded before, in either channel.
REM   4. Run this script. It uploads, creates the version and returns at once; the review takes days.
setlocal
cd /d "%~dp0"
if "%WEB_EXT_API_KEY%"=="" (
  echo WEB_EXT_API_KEY / WEB_EXT_API_SECRET are not set. See the comments at the top of this script.
  pause
  exit /b 1
)
python docs\amo\make_metadata.py || (pause & exit /b 1)
npx --yes web-ext sign --source-dir addon --artifacts-dir dist --channel listed --amo-metadata docs\amo\amo-metadata.json --approval-timeout 0 --ignore-files "tests/**" --no-input
pause
