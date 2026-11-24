import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createHeadInjector,
  injectGrokPwaHead,
  isDocumentPath,
  isInstallQuery,
  renderWebManifest,
  resolveOgCardAsset,
  stripInstallParams,
} from "./grok-pwa-shared.mjs";

test("injects local PWA and OG tags without external Grok scripts or remote URLs", () => {
  const empty = mkdtempSync(join(tmpdir(), "kgb-pwa-empty-"));
  try {
    const out = injectGrokPwaHead("<html><head><title>KGB</title></head><body></body></html>", {
      host: "kgb.example.com",
      cwd: empty,
      site: { title: "KGB" },
    });
    assert.match(out, /rel="manifest"/);
    assert.match(out, /apple-touch-icon/);
    assert.match(out, /property="og:title" content="KGB"/);
    assert.doesNotMatch(out, /<script\b/i);
    assert.doesNotMatch(out, /grok\.com/i);
    assert.doesNotMatch(out, /og\.grok\.me/i);
    assert.doesNotMatch(out, /extensions\.js/i);
    assert.doesNotMatch(out, /property="og:image"/);
    assert.ok(out.indexOf("manifest") < out.indexOf("</head>"));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("emits same-origin og:image only when a local card asset exists", () => {
  const root = mkdtempSync(join(tmpdir(), "kgb-pwa-card-"));
  try {
    mkdirSync(join(root, "public"));
    writeFileSync(join(root, "public/og.jpg"), "x");
    assert.equal(resolveOgCardAsset({}, root), "/og.jpg");
    const out = injectGrokPwaHead("<html><head></head></html>", {
      host: "kgb.example.com",
      cwd: root,
      site: { title: "KGB" },
    });
    assert.match(out, /property="og:image" content="https:\/\/kgb\.example\.com\/og\.jpg"/);
    assert.doesNotMatch(out, /og\.grok\.me/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("streaming injector handles </head> split across chunks and injects no scripts", () => {
  const injector = createHeadInjector({ appName: "KGB", site: { title: "KGB" } });
  const chunks = [
    ...injector.push("<html><head><title>KGB</title></he"),
    ...injector.push("ad><body>hello</body></html>"),
  ];
  const out = Buffer.concat(chunks).toString("utf8");
  assert.match(out, /rel="manifest"/);
  assert.match(out, /property="og:title" content="KGB"/);
  assert.match(out, /<body>hello<\/body>/);
  assert.doesNotMatch(out, /<script\b/i);
  assert.deepEqual(injector.flush(), []);
});

test("is idempotent", () => {
  const once = injectGrokPwaHead("<html><head><title>KGB</title></head></html>");
  const twice = injectGrokPwaHead(once);
  assert.equal(once, twice);
});

test("renders manifest named KGB and handles path/query helpers", () => {
  const manifest = JSON.parse(renderWebManifest("localhost:8080"));
  assert.equal(manifest.name, "KGB");
  assert.equal(manifest.short_name, "KGB");
  assert.equal(isInstallQuery("/?install=1&platform=ios"), true);
  assert.equal(isInstallQuery("/"), false);
  assert.equal(isDocumentPath("/"), true);
  assert.equal(isDocumentPath("/api/thing"), false);
  assert.equal(stripInstallParams("/?install=1&platform=ios"), "/");
});
