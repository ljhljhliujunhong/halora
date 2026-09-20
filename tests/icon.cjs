const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("app icon keeps a transparent circular mark without a rounded tile", () => {
  const png = fs.readFileSync(path.join(__dirname, "../public/icon.png"));
  assert.equal(png[0], 0x89);
  assert.equal(png[1], 0x50);
  const script = fs.readFileSync(path.join(__dirname, "../scripts/make-icon.cjs"), "utf8");
  assert.match(script, /public", "icon\.png"/);
  assert.match(script, /function MatteCircle/);
  assert.match(script, /function IsGold/);
  assert.match(script, /\$cornerA -lt 24/);
  assert.match(script, /writeIco/);
  assert.match(script, /launcherIco/);
  assert.doesNotMatch(script, /for \(\$i = 3; \$i -lt \$bytes\.Length; \$i \+= 4\) \{ \$bytes\[\$i\] = 255 \}/);
  const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
  assert.match(html, /href="\/icon\.png"/);
  const css = fs.readFileSync(path.join(__dirname, "../src/styles.css"), "utf8");
  assert.match(css, /\.brand-mark \{[^}]*width: 52px/s);
  assert.match(css, /\.brand-mark \{[^}]*border-radius: 0/s);
  assert.doesNotMatch(css, /\.brand-mark \{[^}]*box-shadow/s);
});
