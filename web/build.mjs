#!/usr/bin/env node
// Builds the static web inspector into ./site (Cloudflare Pages output directory):
//
//   site/index.html   www/inspector/db-inspector.html + web host (unchanged UI)
//   site/host.js|css, worker.js, lazy-file-vfs.js
//   site/vendor/wa-sqlite/…   SQLite compiled to WebAssembly (MIT)
//   site/demo.db      fictional demo database (web/demo/make-demo-db.py)
//   site/_headers     strict Content-Security-Policy: no outgoing connections
//
//   node web/build.mjs
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'web');
const out = join(root, 'site');
const waSqlite = join(root, 'node_modules', 'wa-sqlite');

if (!existsSync(waSqlite)) {
  console.error('wa-sqlite is missing — run `npm install` first.');
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'vendor', 'wa-sqlite', 'dist'), { recursive: true });
mkdirSync(join(out, 'vendor', 'wa-sqlite', 'src'), { recursive: true });

for (const f of ['wa-sqlite.mjs', 'wa-sqlite.wasm']) cpSync(join(waSqlite, 'dist', f), join(out, 'vendor', 'wa-sqlite', 'dist', f));
for (const f of ['sqlite-api.js', 'sqlite-constants.js', 'VFS.js']) cpSync(join(waSqlite, 'src', f), join(out, 'vendor', 'wa-sqlite', 'src', f));
cpSync(join(waSqlite, 'LICENSE'), join(out, 'vendor', 'wa-sqlite', 'LICENSE'));
for (const f of ['host.js', 'host.css', 'worker.js', 'lazy-file-vfs.js', 'favicon.ico', 'icon.svg', 'apple-touch-icon.png', 'robots.txt']) cpSync(join(web, f), join(out, f));

// ---- index.html: the plugin's page, plus the web host --------------------------------------
let html = readFileSync(join(root, 'www', 'inspector', 'db-inspector.html'), 'utf8');
const head = [
  '<meta name="description" content="Inspect SQLite databases in your browser: browse tables, read the structure, build queries visually. Files never leave your device.">',
  '<meta name="theme-color" content="#f0f4f9" media="(prefers-color-scheme: light)">',
  '<meta name="theme-color" content="#090c10" media="(prefers-color-scheme: dark)">',
  '<meta property="og:title" content="DB Inspector: SQLite in your browser">',
  '<meta property="og:description" content="Open-source SQLite inspector and visual query builder. Runs locally in WebAssembly; nothing is uploaded.">',
  '<link rel="icon" href="favicon.ico" sizes="48x48">',
  '<link rel="icon" href="icon.svg" type="image/svg+xml">',
  '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
  '<link rel="stylesheet" href="host.css">'
].join('\n');
html = html.replace('<title>DB Inspector</title>', '<title>DB Inspector: SQLite in your browser</title>\n' + head);

const scriptOpen = html.lastIndexOf('<script>');
const scriptClose = html.indexOf('</script>', scriptOpen);
if (scriptOpen < 0 || scriptClose < 0) throw new Error('Inline inspector script not found');
const inline = html.slice(scriptOpen + '<script>'.length, scriptClose);
html = html.slice(0, scriptOpen) + '<script src="host.js"></script>\n' + html.slice(scriptOpen);
writeFileSync(join(out, 'index.html'), html);

// ---- security headers ------------------------------------------------------------------------
// connect-src 'self' is only needed to fetch the .wasm and the demo database from this site;
// nothing can be sent anywhere else.
const scriptHash = "'sha256-" + createHash('sha256').update(inline, 'utf8').digest('base64') + "'";
const csp = [
  "default-src 'none'",
  `script-src 'self' ${scriptHash} 'wasm-unsafe-eval'`,
  "worker-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  // Inter is embedded in db-inspector.html as a data: URI (the page must work offline in the app).
  "font-src data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');
writeFileSync(join(out, '_headers'), `/*
  Content-Security-Policy: ${csp}
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin

/vendor/*
  Cache-Control: public, max-age=31536000, immutable
`);

// ---- demo database ---------------------------------------------------------------------------
execFileSync('python3', [join(web, 'demo', 'make-demo-db.py'), join(out, 'demo.db')], { stdio: 'inherit' });

console.log('site/ ready — preview with: npx wrangler pages dev site');
