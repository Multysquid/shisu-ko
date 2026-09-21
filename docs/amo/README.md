# Publishing on addons.mozilla.org

Everything the public listing needs, ready to paste or to send through the API. The extension
already exists on AMO as an *unlisted* add-on (the self-distributed builds from `sign-addon.cmd`,
id `shisu-ko@multysquid.github.io`); the first listed version is added to that same add-on.

| File | Used for |
|---|---|
| `summary.txt` | Listing summary (max 250 characters, no URLs) |
| `description.md` | Listing description (AMO renders this Markdown subset: bold, lists, links, code) |
| `release-notes.md` | Version notes shown on the listing; edit per release |
| `reviewer-notes.md` | Notes to the reviewer: architecture, test steps, permission rationale. Not public |
| `privacy-policy.md` | Privacy policy; Developer Hub only |
| `icon-128.png`, `icon-256.png` | Listing icon (rendered from `addon/icons/icon.svg`); Developer Hub only |
| `screenshots/` | Listing screenshots with the captions below; Developer Hub only |
| `make_metadata.py` | Builds `amo-metadata.json` from the files above for `publish-addon.cmd` |

Listing values that are not in a file: categories **Language Support** and **Photos, Music &
Videos**; tags **youtube**, **streaming** (AMO's tag list is fixed); license **MIT License**;
homepage `https://github.com/Multysquid/shisu-ko`; support site
`https://github.com/Multysquid/shisu-ko/issues`; not experimental, no payment; compatible with
**Firefox** only (the server has to run on the same computer, so untick Firefox for Android).

Screenshot captions, in order:

| File | Caption |
|---|---|
| `01-subtitles.png` | Live subtitles drawn over the player as real text, a few seconds behind the transcription running on your own machine. |
| `02-yomitan-lookup-anki.png` | Hover a line and the video waits. Look the word up with Yomitan, add the card, and Shisu-ko attaches the frame and the sentence audio. |
| `03-hover-pickaxe.png` | The pickaxe on a hovered line (or Alt+Shift+M) mines the sentence by hand, into the newest Anki card or into Downloads. |
| `04-transcript-and-style.png` | The transcript panel lists every line so far; timestamps seek, pickaxes mine. Font, position, colour and outline are adjustable. |
| `05-settings-popup.png` | Every setting lives in the toolbar popup; the switch in its header turns the whole extension off and on. |

## Before every submission

1. Bump `version` in `addon/manifest.json` and `VERSION` in `server/server.py` together. AMO
   refuses a version number that was uploaded before, in either channel (0.2.0 to 0.4.0 are
   taken by the unlisted builds).
2. Run the checks: `for f in addon/*.js; do node --check "$f"; done` (`node --check` takes one file),
   `npx web-ext lint --source-dir addon --ignore-files "tests/**"`,
   `node --test addon/tests/*.test.js`, `python -m pytest server/tests`.
3. Build: `npx web-ext build --source-dir addon --artifacts-dir dist --overwrite-dest --ignore-files "tests/**"`
   gives `dist/shisu-ko-<version>.zip`. The zip is the source: there is no build step, so answer
   **No** when AMO asks whether source code needs to be submitted.
4. Update `release-notes.md`, and `reviewer-notes.md` if permissions or the test steps changed.
   A changed `privacy-policy.md` is pasted into the Developer Hub by hand (the listing's **Edit**
   pages): only the first submission takes it from the file, `publish-addon.cmd` never uploads
   it. 0.9.0 changes it (the release check against GitHub), and so does the word colours
   release (what is read from Anki and stored, and the model download at setup).
5. Commit and tag (`v<version>`); the reviewer notes point to the tag. Mind that pushing the tag
   runs the release workflow, which signs that version in the *unlisted* channel, and AMO then
   refuses the same number in the listed channel: submit the listing first and tag afterwards
   (the workflow's signing step then fails for that version, so re-run it or attach the zips by
   hand), or give the listed submission a version number of its own.

## First listed version: Developer Hub

Log in at https://addons.mozilla.org/developers/, open **My Add-ons** > **Shisu-ko** >
**Upload New Version** (for an add-on that is not on AMO yet, **Submit a New Add-on** shows the
same screens).

1. **Distribution**: On this site.
2. **Upload**: `dist/shisu-ko-<version>.zip`. The validator should report no errors; one warning
   about `strict_min_version` and Firefox for Android is expected and harmless.
3. **Compatibility**: Firefox only.
4. **Source code**: No.
5. **Describe add-on**: name `Shisu-ko`; add-on URL (slug) `shisu-ko`; summary from
   `summary.txt`; description from `description.md`; the categories, tags, license, homepage and
   support site listed above; privacy policy from `privacy-policy.md`; notes to reviewer from
   `reviewer-notes.md` (replace `<version>`); release notes from `release-notes.md`.
6. **Submit**, then in the listing's **Edit** pages upload `icon-128.png` (or the 256 one) as the
   icon and the five screenshots with their captions, in order.

AMO validates the upload at once and usually approves and publishes a version within minutes; a
first submission can instead be held for a manual review that takes days to a few weeks.
Reviewers also look at published versions afterwards. Their questions arrive by email and on the
version's page in the Developer Hub, and are answered there.

## Later versions: `publish-addon.cmd`

`publish-addon.cmd` (needs the AMO API key like `sign-addon.cmd`) regenerates
`amo-metadata.json` and runs `web-ext sign --channel listed`, which uploads the build, creates the
version with the release notes and reviewer notes, and rewrites the listing text from the files
here. It returns as soon as the version exists; approval happens later. The privacy policy, icon
and screenshots stay as set in the Developer Hub: a changed `privacy-policy.md` is pasted there
by hand (step 4 above).

It also works for the very first listed version (AMO accepts the metadata on version creation);
the privacy policy, icon and screenshots then still have to be added in the Developer Hub before
or during the review.

## After approval

- Put the listing link into the README's *Install the extension* section, before the GitHub
  release route: `https://addons.mozilla.org/firefox/addon/shisu-ko/` (check the slug in the
  Developer Hub; AMO may have assigned a different one).
- Attach `dist/shisu-ko-<version>.zip` to the GitHub release as before. Self-distributed
  `.xpi` builds from `sign-addon.cmd` keep working next to the listing, but users installed from
  AMO get updates from AMO, so publish every release there.
