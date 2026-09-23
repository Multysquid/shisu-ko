@echo off
REM Signs the extension through addons.mozilla.org (unlisted channel) so it can be installed
REM permanently in regular Firefox. A manual fallback: the release workflow publishes every tag to the
REM public listing and attaches the signed .xpi to the GitHub release. AMO refuses a version number that
REM was uploaded before in either channel, so never run this for a version that is still to be released.
REM Needs Node.js and an AMO API key:
REM   1. Create/log in to a Firefox account at https://addons.mozilla.org/developers/addon/api/key/
REM   2. Set the two values for this window:   set WEB_EXT_API_KEY=user:...   set WEB_EXT_API_SECRET=...
REM   3. Run this script. The signed .xpi appears in dist\ and can be opened in Firefox to install.
setlocal
cd /d "%~dp0"
if "%WEB_EXT_API_KEY%"=="" (
  echo WEB_EXT_API_KEY / WEB_EXT_API_SECRET are not set. See the comments at the top of this script.
  pause
  exit /b 1
)
npx --yes web-ext sign --source-dir addon --artifacts-dir dist --channel unlisted --ignore-files "tests/**" --no-input
pause
