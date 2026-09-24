import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// Which build goes where on addons.mozilla.org, a must-test (AGENTS.md, "Release"). A tag makes a
// release and its .xpi, signed for self-distribution (the unlisted channel), and nothing more; the
// public listing is a workflow of its own, run by hand for the newest release, under <version>.1,
// since AMO takes a number once in either channel. A listed upload from the tag workflow would take
// the number the GitHub .xpi needs and put every release back into the listing's review queue.
// The checks read commands, not comments: a step commented out is a step gone.
const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const release = read(".github/workflows/release.yml");
const listing = read(".github/workflows/amo-listing.yml");
const attach = read(".github/workflows/amo-xpi.yml");
const tests = read(".github/workflows/tests.yml");
const publish = read("publish-addon.cmd");
const sign = read("sign-addon.cmd");

// The keys of a workflow's top-level `on:` block.
function triggers(yaml) {
  const lines = yaml.split("\n");
  const start = lines.indexOf("on:");
  assert.ok(start >= 0, "the workflow has an on: block");
  const keys = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const key = /^ {2}([\w-]+):/.exec(line);
    if (key) keys.push(key[1]);
  }
  return keys;
}

// The shell text of every run: step, one line or a block.
function runScripts(yaml) {
  const lines = yaml.split("\n");
  const scripts = [];
  lines.forEach((line, i) => {
    const step = /^(\s*)(?:- )?run: ?(.*)$/.exec(line);
    if (!step) return;
    if (!/^[|>]/.test(step[2])) {
      scripts.push(step[2]);
      return;
    }
    const indent = line.indexOf("run:");
    const body = [];
    for (const next of lines.slice(i + 1)) {
      if (next.trim() && next.search(/\S/) <= indent) break;
      body.push(next);
    }
    scripts.push(body.join("\n"));
  });
  return scripts;
}

// The command lines of every run: step, comments and blank lines left out, a line continued with
// a backslash joined to the next.
const shellLines = (yaml) => runScripts(yaml).join("\n").replace(/\\\n\s*/g, "").split("\n")
  .map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
// The command lines of a batch file, REM lines and blank lines left out.
const cmdLines = (text) => text.split("\n").map((line) => line.trim()).filter((line) => line && !/^@?rem\b/i.test(line));
const at = (lines, re) => lines.findIndex((line) => re.test(line));
const count = (lines, re) => lines.filter((line) => re.test(line)).length;

test("a tag makes the release and its self-distributed .xpi, and nothing for the listing", () => {
  assert.deepEqual(triggers(release), ["push"]);
  assert.match(release, /tags: \["v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+"\]/);
  const lines = shellLines(release);
  // web-ext signs the package and waits for AMO's signature itself, as it did up to 0.13.0.
  assert.equal(count(lines, /^if npx --yes web-ext@\S+ sign --source-dir dist\/firefox --artifacts-dir dist --channel unlisted --no-input; then$/), 1);
  assert.equal(count(lines, /--approval-timeout/), 0);
  assert.equal(count(lines, /--channel listed/), 0);
  // Listing texts sent with a self-distributed upload would rewrite the public listing, and the
  // listing texts are no business of a release: a text AMO would refuse must not stop the .xpi.
  assert.equal(count(lines, /--amo-metadata|make_metadata/), 0);
  // Nor through the build tests: they run without the listing texts' own test.
  assert.equal(count(lines, /^npm (run )?test(:build)?$/), 0);
  assert.equal(count(lines, /^node --test \$\(ls scripts\/tests\/\*\.test\.mjs \| grep -v '\/amo-metadata\\\.test\\\.mjs\$'\)$/), 1);
  // A number AMO has not got is uploaded and signed by web-ext; an upload AMO never took fails the
  // job. A number AMO has (a re-run, or a signature that did not come within web-ext's wait) takes
  // AMO's signed file only when it holds this tag's build; none yet (a human review) is a warning,
  // and the release goes out with the unsigned .xpi.
  const missing = at(lines, /^if \[ "\$\(node scripts\/amo-xpi\.mjs status "\$version"\)" = missing \]; then$/);
  const sign = at(lines, /web-ext@\S+ sign /);
  const signed = at(lines, /^exit 0$/);
  const notTaken = lines.findIndex((line, i) => i > sign && /^if \[ "\$\(node scripts\/amo-xpi\.mjs status "\$version"\)" = missing \]; then$/.test(line));
  const fetch = at(lines, /^node scripts\/amo-xpi\.mjs fetch "\$version" --out dist --wait "\$wait" \|\| code=\$\?$/);
  const same = at(lines, /^0\) node scripts\/amo-xpi\.mjs same-build dist\/\*\.xpi dist\/firefox ;;$/);
  const unsignedWarning = at(lines, /^3\|4\) echo "::warning::/);
  const order = { missing, sign, signed, notTaken, fetch, same, unsignedWarning };
  for (const [name, index] of Object.entries(order)) assert.ok(index >= 0, `release.yml has no ${name} line`);
  const indices = Object.values(order);
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), "sign, or take AMO's file, in that order");
  assert.match(lines[notTaken + 1], /^echo "::error::/);
  assert.equal(lines[notTaken + 2], "exit 1");
  // Every release carries an .xpi: the signed one, or else the unsigned build under a name that
  // says so, with or without the AMO key (the step has no condition).
  const unsignedStep = release.indexOf("- name: Add the unsigned .xpi when there is no signed one");
  const signStep = release.indexOf("- name: Sign the Firefox package");
  const releaseStep = release.indexOf("- name: Create GitHub release");
  assert.ok(signStep >= 0 && unsignedStep > signStep && releaseStep > unsignedStep, "signed, then the unsigned stand-in, then the release");
  assert.match(release.slice(unsignedStep, releaseStep), /^- name: Add the unsigned \.xpi when there is no signed one\n {8}run: \|\n/);
  assert.equal(count(lines, /^if ! compgen -G "dist\/\*\.xpi" > \/dev\/null; then$/), 1);
  assert.equal(count(lines, /^cp "dist\/shisu-ko-\$\{GITHUB_REF_NAME#v\}-firefox\.zip" "dist\/shisu-ko-\$\{GITHUB_REF_NAME#v\}-firefox-unsigned\.xpi"$/), 1);
  assert.match(release.slice(releaseStep), /files: \|\n {12}dist\/\*\.zip\n {12}dist\/\*\.xpi\n/);
  assert.equal(count(lines, /gh release upload/), 0);
});

test("the listing is its own workflow, run by hand for the newest release, as <version>.1", () => {
  assert.deepEqual(triggers(listing), ["workflow_dispatch"]);
  assert.match(listing, /\n {6}tag:\n {8}description: .+\n {8}required: true\n/);
  // The add-on comes from the tag, the scripts from the workflow's own commit.
  assert.match(listing, /- uses: actions\/checkout@v4\n {6}- uses: actions\/checkout@v4\n {8}with:\n {10}ref: refs\/tags\/\$\{\{ inputs\.tag \}\}\n {10}path: release\n/);
  const lines = shellLines(listing);
  const format = at(lines, /^if \[\[ ! "\$TAG" =~ \^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]; then$/);
  // 0.14.1 is a listed version of its own: tags before 0.14.2 have no listed build to publish.
  const floor = at(lines, /^if \[ "\$\(printf '%s\\n' v0\.14\.2 "\$TAG" \| sort -V \| head -n 1\)" != v0\.14\.2 \]; then$/);
  const newest = at(lines, /^newest="\$\(gh release view -R "\$GITHUB_REPOSITORY" --json tagName --jq \.tagName\)"$/);
  const refuse = at(lines, /^if \[ "\$newest" != "\$TAG" \]; then$/);
  const build = at(lines, /^node release\/scripts\/build\.mjs --browser firefox$/);
  const stamp = at(lines, /^version="\$\(node scripts\/amo-xpi\.mjs listing release\/dist\/firefox\)"$/);
  const lint = at(lines, /^npx --yes web-ext@\S+ lint --source-dir release\/dist\/firefox$/);
  const state = at(lines, /^state="\$\(node scripts\/amo-xpi\.mjs status "\$LISTING_VERSION"\)"$/);
  const submit = at(lines, /web-ext@\S+ sign --source-dir release\/dist\/firefox --artifacts-dir release\/dist --channel listed --amo-metadata release\/docs\/amo\/amo-metadata\.json --approval-timeout 0 --no-input$/);
  const order = { format, floor, newest, refuse, build, stamp, lint, state, submit };
  for (const [name, index] of Object.entries(order)) assert.ok(index >= 0, `amo-listing.yml has no ${name} line`);
  const indices = Object.values(order);
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), "checked, built, stamped, linted, then submitted");
  // A number AMO has disabled is never taken again: that run fails rather than ending green.
  const disabled = at(lines, /^disabled\)$/);
  assert.ok(disabled > submit && /^echo "::error::/.test(lines[disabled + 1]) && lines[disabled + 2] === "exit 1");
  assert.equal(count(lines, /--channel unlisted/), 0);
});

test("the attach workflow only downloads what AMO signed", () => {
  assert.deepEqual(triggers(attach), ["schedule", "workflow_dispatch"]);
  const lines = shellLines(attach);
  assert.equal(count(lines, /web-ext/), 0);
  assert.equal(count(lines, /^if \[\[ ! "\$tag" =~ \^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]; then$/), 1);
  // A release that is not there fails the step; it must not read as "no .xpi yet".
  assert.equal(count(lines, /^assets="\$\(gh release view "\$tag" --json assets --jq '\.assets\[\]\.name'\)"$/), 1);
  assert.equal(count(lines, /gh release view "\$tag".*\|/), 0);
  // The signed file goes on only when it is the release's own Firefox build.
  const download = at(lines, /^gh release download "\$tag" -p "shisu-ko-\$\{tag#v\}-firefox\.zip" -D dist\/release$/);
  const same = at(lines, /^if ! node scripts\/amo-xpi\.mjs same-build dist\/signed\/\*\.xpi "dist\/release\/shisu-ko-\$\{tag#v\}-firefox\.zip"; then$/);
  const upload = at(lines, /^gh release upload "\$tag" dist\/signed\/\*\.xpi --clobber$/);
  assert.ok(download >= 0 && same > download && upload > same && lines[same + 2] === "exit 1");
  // The unsigned stand-in is no signed .xpi: it is looked past, and removed once the signed one
  // is on the release.
  assert.equal(count(lines, /^unsigned="shisu-ko-\$\{tag#v\}-firefox-unsigned\.xpi"$/), 1);
  assert.equal(count(lines, /^if grep -v -x -F "\$unsigned" <<<"\$assets" \| grep -q '\\\.xpi\$'; then$/), 1);
  const removeUnsigned = at(lines, /^gh release delete-asset "\$tag" "\$unsigned" --yes$/);
  assert.ok(removeUnsigned > upload, "the unsigned stand-in goes once the signed file is on");
  // No file on AMO yet is a warning (the release job may still be uploading, or said so already);
  // a rejection fails the run, since the release job has usually ended green before it came.
  const four = at(lines, /^4\)$/);
  assert.equal(lines[four + 1], 'state="$(node scripts/amo-xpi.mjs status "${tag#v}")"');
  assert.equal(lines[four + 2], 'if [ "$state" = disabled ]; then');
  assert.match(lines[four + 3], /^echo "::error::/);
  assert.equal(lines[four + 4], "exit 1");
  assert.match(lines[four + 6], /^echo "::warning::/);
});

test("no workflow expands an expression inside a shell script", () => {
  // A tag typed into the dispatch form is text from outside: it reaches the shell through env.
  for (const [name, yaml] of [["release.yml", release], ["amo-listing.yml", listing], ["amo-xpi.yml", attach], ["tests.yml", tests]]) {
    for (const script of runScripts(yaml)) assert.doesNotMatch(script, /\$\{\{/, `${name}: ${script}`);
  }
});

test("web-ext runs at one pinned version wherever it gets the AMO key or lints", () => {
  const versions = new Set();
  const all = [release, listing, attach, tests].flatMap(shellLines).concat(cmdLines(publish), cmdLines(sign));
  for (const line of all.filter((l) => /\bweb-ext\b/.test(l))) {
    const pinned = /npx --yes web-ext@(\d+\.\d+\.\d+) /.exec(line);
    assert.ok(pinned, `not pinned to an exact version: ${line}`);
    versions.add(pinned[1]);
  }
  assert.equal(versions.size, 1, [...versions].join(", "));
});

test("the manual scripts check the tag, then build, stamp and submit like the workflows", () => {
  const lines = cmdLines(publish);
  // Nothing but digits and dots is expanded: the version is taken only when it is major.minor.patch,
  // and the tags only when they are v, digits and dots (git allows & | < > in a tag name).
  const versionLine = /^for \/f "delims=" %%v in \('node -p "const v = require\('\.\/addon\/manifest\.json'\)\.version; \/\^\[0-9\]\+\[\.\]\[0-9\]\+\[\.\]\[0-9\]\+\$\/\.test\(v\) \? v : ''"'\) do set "VERSION=%%v"$/;
  const version = at(lines, versionLine);
  const fetch = at(lines, /^git fetch --quiet --tags origin \|\| \($/);
  const newest = at(lines, /^for \/f "delims=" %%t in \('git tag --list "v\[0-9\]\*" --sort=-v:refname \^\| findstr \/r \/v \/c:"\[\^v0-9\.\]"'\) do if not defined NEWEST set "NEWEST=%%t"$/);
  const newestCheck = at(lines, /^if not "%NEWEST%"=="v%VERSION%" \($/);
  const tree = at(lines, /^git diff --quiet "v%VERSION%" -- addon docs\\amo scripts\\build\.mjs \|\| \($/);
  const untracked = at(lines, /^for \/f "delims=" %%f in \('git ls-files --others --exclude-standard -- addon'\) do \($/);
  const build = at(lines, /^node scripts\\build\.mjs --browser firefox \|\| \(pause & exit \/b 1\)$/);
  const stamp = at(lines, /^for \/f "delims=" %%v in \('node scripts\\amo-xpi\.mjs listing dist\\firefox'\) do set "LISTED=%%v"$/);
  const stamped = at(lines, /^if not "%LISTED%"=="%VERSION%\.1" \($/);
  const submit = at(lines, /^npx --yes web-ext@\S+ sign --source-dir dist\\firefox --artifacts-dir dist --channel listed --amo-metadata docs\\amo\\amo-metadata\.json --approval-timeout 0 --no-input$/);
  const order = { version, fetch, newest, newestCheck, tree, untracked, build, stamp, stamped, submit };
  for (const [name, index] of Object.entries(order)) assert.ok(index >= 0, `publish-addon.cmd has no ${name} line`);
  const indices = Object.values(order);
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), "publish-addon.cmd checks, builds, stamps, then submits");
  assert.equal(count(lines, /--source-dir addon/), 0);

  const signing = cmdLines(sign);
  assert.equal(count(signing, versionLine), 1);
  const signTree = at(signing, /^git diff --quiet "v%VERSION%" -- addon scripts\\build\.mjs \|\| \($/);
  const signBuild = at(signing, /^node scripts\\build\.mjs --browser firefox \|\| \(pause & exit \/b 1\)$/);
  const signSubmit = at(signing, /^npx --yes web-ext@\S+ sign --source-dir dist\\firefox --artifacts-dir dist --channel unlisted --no-input$/);
  assert.ok(signTree >= 0 && signBuild > signTree && signSubmit > signBuild, "sign-addon.cmd checks the tag, builds, then signs");
  assert.equal(count(signing, /--channel listed|--source-dir addon/), 0);
});
