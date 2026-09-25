# Updates and release

How the add-on checks for a new release and asks the server to update, and how a tag becomes a GitHub release and an addons.mozilla.org version.

## How the update check works

The add-on side of updates lives in the "updates" section of `addon/background.js` and in
`popup.js`; the extension never installs itself (no `update_url`, no `.xpi` handling: its
updates come from the addons.mozilla.org listing, and every GitHub release carries an `.xpi` AMO
signed for self-distribution, see "Release"), it only tells the viewer and asks the server to
update itself.

- Check. `fetchLatestRelease()` gets `GITHUB_LATEST_URL`
  (`https://api.github.com/repos/Multysquid/shisu-ko/releases/latest`, `Accept:
  application/vnd.github+json`, `UPDATE_CHECK_TIMEOUT_MS` 10 s). No host permission: GitHub's
  API answers cross-origin requests with `Access-Control-Allow-Origin: *`. `releaseFromApi()`
  reads `{version, tag, url, xpi}` (tag `v0.9.0` -> `0.9.0`; `html_url`; the
  `browser_download_url` of the `.xpi` asset or null; https only, since the popup opens `url`
  in a tab). `checkForUpdate({force})` answers from `storage.local.updateCheck`
  (`{checkedAt, latest, error}`) while it is fresh (`checkIsFresh()`: no error and under
  `UPDATE_CHECK_MAX_AGE_MS`, 24 h), else fetches; one check at a time (`checkInFlight`). A
  failure (offline, 403/429 rate limit, non-JSON, no `tag_name`) is stored as `error`, keeps the
  last `latest`, is logged with `console.debug` and never notifies; 404 means no release yet.
- When. `startupCheck()` on `runtime.onStartup` and `onInstalled`, but only once the profile
  has a stored check: a profile that never opened the popup makes no request on its own, which
  keeps `scripts/browser-smoke.mjs` (fresh Chromium profile, local fixtures) off GitHub; the
  smoke test seeds `updateCheck: {checkedAt: Date.now(), latest: null, error: null}` beside its
  settings. The popup's first `updateStatus` carries `check: true` (the day's check when the
  store is stale); "Check for updates" sends `checkForUpdate` with `force: true`.
- Decision. `parseVersion("v0.9.0") -> [0, 9, 0]` (non-numeric or missing parts are 0),
  `compareVersions(a, b) -> -1 | 0 | 1`, and `decideUpdate({latest, serverVersion,
  serverLauncher, extensionVersion, serverOnline})` -> `{server, extension}`. `server`:
  `current` (latest <= version), `newer` (latest > version and `launcher: true`), `cannot`
  (newer, `launcher: false`: Docker, Nix, a hand start, `--no-update`), `behind` (newer, no
  launcher flag: every 0.8.0 server, so no claim about run.cmd), `unknown` (no `latest`, or a
  server without a version such as the smoke fixture's `/health`), `offline` (no server).
  `extension`: `newer` when latest > `browser.runtime.getManifest().version`, else `current`.
  `serverInfo(health)` reads `version` and `launcher` from `/health`, null when missing.
  `popup.js` keeps copies of `parseVersion`, `compareVersions`, `UPDATE_SHUTDOWN_MS` and
  `UPDATE_WINDOW_MS`; `addon/tests/popup-copies.test.js` keeps them equal.
- Ask. `applyBadge()` sets the toolbar badge (`action.setBadgeText` "1", `BADGE_COLOR`
  `#5b6fb8`, never the alert red) for `newer`, `cannot`, `behind` or a newer extension and clears
  it otherwise; `notifyNewer()` creates one system notification per release and browser session
  (`notifiedVersion` in `storage.session`; id `shisuko-update`, "Shisu-ko <latest> is
  available" / "The server runs <server>. Click to update it now."), only for `newer`, only from
  the start-up check. `notifications.onClicked` runs `updateServer({watch: true})`; a request
  that fails there gets a notification of its own (`shisuko-update-failed`, whose click does
  nothing), except when the server already runs the release (`upToDate: true`: updated another
  way while the notification sat there, and the click's own clear was all there was to do);
  `updateStatus()` clears `shisuko-update` whenever the decision is `current`. Badge and
  notification helpers tolerate a missing API (the test sandbox, a content script). The
  popup's banner (`#update-banner`, `renderUpdate()`) names the release and the server's
  version with **Update** and **Not now** for `newer`, the reason and no Update button
  for `cannot` ("was not started by run.cmd / run.sh", the one text for every blocker, since
  `/health` carries only the flag and a `--no-update` server's 409 text is never fetched) and
  `behind` ("cannot be updated from
  here"), the release page link for an extension behind, and nothing for `offline` (the next
  start updates) or after "Not now" (`updateSnoozed` = latest in `storage.session`). The
  "Check for updates" link in the last drawer writes `#update-result` ("Newest release: 0.9.0,
  checked 3 min ago", "No release found, …", "Update check failed: <error> (last seen: X)").
- Update. Popup **Update** or the notification click -> `{type: "updateServer"}` ->
  `requestUpdate()`: `/health` first (so a spent record ends, see below), refuse without a POST
  (`{ok: false, upToDate: true, error}`) when the server already runs >= latest, else
  `POST /update` through `apiRequest()`. On
  `{ok: true, restarting: true}` the record `serverUpdate` `{requestedAt, from, to, deadline,
  down}` (`deadline` = `UPDATE_WINDOW_MS`, 120 s: the launcher's update plus a model load) goes
  to `storage.session` with a memory fallback (`sessionGet` / `sessionSet`), the notification is
  cleared and the popup gets `{ok, restarting, from, to, requestedAt, deadline}`; a 409 passes
  the server's text through as `{ok: false, error, refused: true}` (the banner shows it and
  drops the button), unreachable is `offline: true`. Every `/health` answer through
  `apiRequest()` passes `noteHealth()`: no answer marks the record `down`; a version >= `to` ends
  it, recomputes the badge and notifies "Shisu-ko updated to <version>" (`shisuko-updated`);
  the old version ends it silently once the server was seen down or `UPDATE_SHUTDOWN_MS` (10 s)
  has passed since the request (the old server closes its port within a second), because the
  old code back after a restart means `update.py` could not update. The notification path has
  no popup polling, so `watchUpdate()` polls `/health` every `UPDATE_POLL_MS` (3 s) until the
  record ends. The popup's `updateFlow` (`idle -> requesting -> updating -> done | stale |
  failed | lost`) mirrors it: badge "Updating server" with "Restarting with <latest>…", then
  "Updated to <version>", `stillOldHint()` ("The server restarted but still runs X; look at its
  window: update.py said why", banner stays) or, offline at the deadline, `UPDATE_LOST_HINT`
  with the Start button back. `refreshUpdate()` sends the popup's own `/health` answer with the
  question and re-asks only when the server's version, launcher flag or reachability changed or
  after an action; answers are numbered (`updateAsked`) so a slow first answer, held up by the
  check of GitHub, cannot overwrite the verdict for the server now on screen; an overtaken
  first answer makes the popup ask once more, since it carried the day's check, which the answer
  that overtook it was given without. It resolves to whether an answer was taken, and the banner
  is painted again only then. A reopened popup resumes the flow from `startServerStatus`
  (`updating`) before its first paint.
- Chrome. `browser-api.js` bridges `action.setBadgeText` / `setBadgeBackgroundColor`,
  `notifications.create` / `clear` (with `onClicked` passed through) and `tabs.create`; the
  endpoint is plain HTTP, so the flow is the same there.

Messages: `updateStatus {health?, check?}` -> `{latest, checkedAt, error, server: {version,
launcher} | null, decision, snoozed, updating, extensionVersion}`; `checkForUpdate {force?}` ->
`{checkedAt, latest, error}`; `updateServer` -> as above; `snoozeUpdate {version}` -> `{ok}`.

Tests: `addon/tests/background.test.js`, `addon/tests/popup.test.js`, `addon/tests/browser-api.test.js`, `addon/tests/settings.test.js`, `addon/tests/popup-copies.test.js`.
`addon/tests/_loadBackground.js` stubs `action`, `notifications`, `runtime.onStartup` /
`onInstalled` / `getManifest` and exposes `startup()`, `clickNotification()` and `setNow()`.

## Release

Pushing a tag `v<version>` (on the merge commit, matching `addon/manifest.json`) makes the release
and its `.xpi`, and nothing more; `.github/workflows/release.yml`:

- runs the checks and builds the zips; the listing texts are none of its business (it runs the
  build tests without `amo-metadata.test.mjs` and never `make_metadata.py`): a text AMO would
  refuse must not hold up the `.xpi`, and the Tests workflow checks them on every push;
- signs `dist/firefox` the way the releases up to 0.13.0 were signed: `web-ext sign --channel
  unlisted` (no listing texts, the AMO API key from the repository secrets `WEB_EXT_API_KEY` /
  `WEB_EXT_API_SECRET`) uploads it to addons.mozilla.org's unlisted channel, waits up to 15
  minutes for AMO to sign it for self-distribution (usually a few minutes; AMO allows itself a
  day, more for a version it picks for a manual review) and downloads the signed
  `shisu_ko-<version>.xpi` into `dist/`;
- then creates the GitHub release with the zips and the `.xpi`.

Every release carries an `.xpi`, signed or not. AMO holds some versions for a human review,
which can take days (0.14.2 was one); when web-ext's wait runs out on a version AMO did take,
the job goes on (a warning), a step with no condition copies the Firefox zip to
`shisu-ko-<version>-firefox-unsigned.xpi`, and the release goes out with that stand-in, which
installs in Firefox Developer Edition, Nightly and ESR with `xpinstall.signatures.required` off,
or for the session from `about:debugging`; a release made without the AMO key gets it too. An
upload AMO never took (`status` still `missing` after web-ext failed) fails the job. AMO takes a
number once, so the job cannot upload it again: a re-run finds the number taken
(`amo-xpi.mjs status`), waits for AMO's signed file of the first upload (`fetch --wait 900`) and
takes it only when `amo-xpi.mjs same-build` has shown it to hold this tag's `dist/firefox`, file
for file (AMO's `META-INF/` aside, `manifest.json` as JSON), so a moved tag, or a number signed
by hand from other code, fails instead of shipping the wrong build; no signed file yet is the
same warning and the same stand-in. A tag AMO has signed is never moved: fix forward with the
next patch version. `.github/workflows/amo-xpi.yml` (every three hours for the newest release,
or by hand with a tag) puts the signed `.xpi` on a release that has none, checked against the
release's own Firefox zip the same way, and then deletes the unsigned stand-in (0.14.1's only
file is its listed one). It tells the two apart by name: AMO names its file
`shisu_ko-<version>.xpi`, and `releaseFromApi()` in `background.js` skips a name ending in
`-unsigned.xpi` too, so the popup's `latest.xpi` is always a file regular Firefox installs.
`fetch` exits 3 while AMO has not signed the version and 4 (`NO_FILE_EXIT`) when AMO has no file
for it; `amo-xpi.yml` asks `status` which: `missing` is a warning, `disabled` fails the run.

`server/tests/conftest.py` ends the pytest process with the session's own exit status once the
report is written, on CI only (`CI=true`): the native libraries faster-whisper brings can abort
the interpreter's shutdown with "terminate called without an active exception" (exit 134) after
every test has passed, as CI's Python 3.10 did once.

So every release has an `.xpi` on GitHub without waiting for a listing review, and its signed
one as soon as AMO has signed it. The public
listing is a workflow of its own, `.github/workflows/amo-listing.yml` (`workflow_dispatch` with
the tag, `gh workflow run amo-listing.yml -f tag=v<version>`), run by hand for the releases worth
an update for the listing's users and never by a tag. It publishes the newest release only (the
tag must match `^v\d+\.\d+\.\d+$` whole and be what `gh release view` calls the newest, which also
means its release workflow got through its checks): AMO takes a listed version only above the
last approved listed one (unlisted numbers do not count), and a new listed submission disables
every older listed version still waiting for its review, whatever its number, so an older tag
would be refused or would throw a newer submission away and put the older listing texts back.
It takes its scripts from its own commit and the add-on from the tag (a second checkout into
`release/`, so a tag older than a script's newest command still works), builds the tag's
`dist/firefox`, rewrites the version in its manifest to `<version>.1` (`scripts/amo-xpi.mjs
listing`, that one line: AMO refuses a version number that was uploaded before in either channel,
and the release's own number belongs to its self-distributed build), lints it and submits it with
`--channel listed --amo-metadata`, the texts built from the tag's `docs/amo/` by
`make_metadata.py` (whose `<version>` is the tag's number, so the reviewer notes link the tag). A
listed version AMO already has is not uploaded again, and one AMO has disabled fails the run,
since that number is never taken again. Firefox asks the listing for the updates of both builds,
so a GitHub install of `<version>` is offered `<version>.1` once AMO approves it;
`compareVersions()` reads three parts, so the fourth never makes the popup call the extension
behind or ahead. web-ext runs pinned to one exact version (`web-ext@10.7.0`) in every workflow and
in `publish-addon.cmd` / `sign-addon.cmd`, the places that give it the AMO key or lint for CI. The
listing workflow also refuses tags before v0.14.2: 0.14.1 is a listed version of its own, waiting
for its review, and `0.14.1.1` would disable it.

The split is a must-test: `scripts/tests/release-workflows.test.mjs` reads the workflows and the
two `.cmd` scripts as commands (comments and REM lines left out, so a step commented out counts as
gone) and holds that the tag workflow never uploads to the listed channel, sends listing texts,
runs `make_metadata.py` or the listing texts' test, signs with web-ext before it makes the
release (which carries `dist/*.xpi`), fails on an upload AMO never took, takes AMO's signed file
of an earlier upload only when `same-build` has matched it to its build, and otherwise puts the
unsigned stand-in in, from a step without a condition; that the listing workflow has no trigger but the dispatch, checks the
tag, the v0.14.2 floor and that it is the newest, then builds, stamps, lints and submits in that
order, and fails for a disabled number; that `amo-xpi.yml` only downloads, fails when the release
is not there, looks past the unsigned stand-in, checks the build before it attaches and deletes
the stand-in after, warns on a missing file and fails on a rejected one; that web-ext is pinned to one version in all of them; that `publish-addon.cmd`
takes only a major.minor.patch version and v-digits-dots tags (git allows `&`, `|`, `<`, `>` in a
tag name, and cmd.exe would run them), fetches the tags, checks the newest tag and the tree
before it builds, stamps, reads the stamp back and submits, and `sign-addon.cmd` checks the
version and the tree before it builds and signs `dist\firefox`; and that no workflow expands a
`${{ }}` expression inside a shell script (the tag typed into the dispatch form reaches the shell
through `env`).
`make_metadata.py` refuses a `release-notes.md` that does not mention the manifest's version, and
the Tests workflow runs it on every push, so bump the version and write its notes in the same
change: any release may be the one published.

**AMO's 3,000-character limit is a must-test.** AMO refuses a version whose release notes or
reviewer notes (the `approval_notes` field) run past 3,000 characters each ("Ensure this field
has no more than 3000 characters"), and it says so only when the version is submitted, after the
GitHub release exists: 0.14.0 was refused that way (8,920 and 18,844 characters) and reached the
listing as 0.14.1. So `make_metadata.py` refuses either file over `NOTES_LIMIT` (3,000, the reviewer notes
counted with `<version>` filled in), and `scripts/tests/amo-metadata.test.mjs` (in `npm test` and
the Tests workflow) holds the limits on the files as they are, and runs `make_metadata.py` on a
copy of `docs/amo/` to prove it refuses an over-long text; also summary 250 characters without a
URL, description 15,000. Keep `release-notes.md` a summary of what changed since the last listed
version (each GitHub release keeps its own full notes), and `reviewer-notes.md` a summary with a
quick test and the permissions: the full reviewer guide (every feature's test steps, every
permission and request, the code that needs a word) is `docs/amo/reviewer-guide.md`, linked from
the notes at the version's tag (`blob/v<version>/docs/amo/reviewer-guide.md`), and it is what a
change of a permission, a request or a test step updates first. A release whose listing
submission failed on the texts is not re-tagged (the listing workflow sends the texts the tag
holds): fix the texts, release the next patch version and publish that. The privacy policy, icon
and screenshots in `docs/amo/` are set in the Developer Hub by hand; `docs/amo/README.md` is the
checklist. `publish-addon.cmd` and `sign-addon.cmd` (repository owner only) are the manual
fallbacks for the listing workflow and for the release workflow's signing (a failed signing is
better helped by re-running the release job); both refuse a tree that differs from the release's
tag, `publish-addon.cmd` also a tag that is not the newest, and `sign-addon.cmd` signs the
manifest's own number, so never run it for a version still to be released. 0.14.1, the last tag
the old release workflow submitted to the listing, can only ever get its listed file: `amo-xpi.yml`
by hand with its tag once AMO approves it, and a listed submission of a newer release before that
disables it. Rebuild the Docker image with `docker compose build`.
