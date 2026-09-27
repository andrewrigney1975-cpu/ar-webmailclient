/**
 * Store screenshots of the browser build in demo mode (sample mail), taken
 * with headless Chrome over the DevTools protocol.
 *
 *   npm run dev -- --port 5195     (in another terminal)
 *   node scripts/screenshots.mjs [http://localhost:5195] [path/to/chrome]
 *
 * Writes store/screenshots/*.png at Play Store sizes, plus store/icon-512.png and
 * store/feature-graphic.png from store/source/.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = process.argv[2] ?? 'http://localhost:5195';
const chrome = process.argv[3] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port = 9230;
const out = 'store/screenshots';

const SHOTS = [
  { name: 'phone-1-inbox', width: 412, height: 915, scale: 2.625, mobile: true, url: '/?demo#/folder/unified', ready: '.vlist__row[data-id]' },
  { name: 'phone-2-conversation', width: 412, height: 915, scale: 2.625, mobile: true, url: '/?demo&open#/folder/unified', ready: '.card--expanded' },
  {
    name: 'phone-3-compose',
    width: 412,
    height: 915,
    scale: 2.625,
    mobile: true,
    url: '/?demo#/folder/unified',
    ready: '.vlist__row[data-id]',
    // Reply to the invoice once the demo mailbox exists.
    then: `(async () => {
      const { id } = await window.despatch.db.get("SELECT id FROM messages WHERE subject = 'Invoice #1042'");
      window.despatch.router.navigate({ name: 'compose', mode: 'reply', id: String(id) });
    })()`,
    thenReady: '.compose__body',
  },
  { name: 'phone-4-dark', width: 412, height: 915, scale: 2.625, mobile: true, url: '/?demo#/folder/unified', ready: '.vlist__row[data-id]', dark: true },
  { name: 'tablet-1-conversation', width: 1280, height: 800, scale: 2, mobile: false, url: '/?demo&open#/folder/unified', ready: '.card--expanded' },
];

const ASSETS = [
  { source: 'store/source/icon.html', out: 'store/icon-512.png', width: 512, height: 512 },
  { source: 'store/source/feature-graphic.html', out: 'store/feature-graphic.png', width: 1024, height: 500 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      id += 1;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => ws.close() };
}

async function main() {
  mkdirSync(out, { recursive: true });
  const profile = join(tmpdir(), `despatch-screenshots-${Date.now()}`);
  const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank']);
  try {
    let page;
    for (let i = 0; i < 50 && !page; i++) {
      await sleep(200);
      page = await fetch(`http://127.0.0.1:${port}/json`).then((r) => r.json()).then((targets) => targets.find((t) => t.type === 'page')).catch(() => null);
    }
    const { send, close } = await connect(page);
    await send('Page.enable');

    // Store listing artwork, rendered from store/source/*.html.
    for (const asset of ASSETS) {
      await send('Emulation.setDeviceMetricsOverride', { width: asset.width, height: asset.height, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url: pathToFileURL(resolve(asset.source)).href });
      await sleep(800);
      const { result } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(asset.out, Buffer.from(result.data, 'base64'));
      console.log(`ok  ${asset.out}`);
    }

    for (const shot of SHOTS) {
      // Start each shot from a blank page (hash-only navigation wouldn't reload the app)
      // and an empty origin, so demo mode starts from an empty database.
      await send('Page.navigate', { url: 'about:blank' });
      await sleep(300);
      await send('Storage.clearDataForOrigin', { origin: base, storageTypes: 'all' });
      await send('Emulation.setDeviceMetricsOverride', { width: shot.width, height: shot.height, deviceScaleFactor: shot.scale, mobile: shot.mobile });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: shot.dark ? 'dark' : 'light' }] });
      await send('Page.navigate', { url: `${base}${shot.url}` });

      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        await sleep(250);
        const result = await send('Runtime.evaluate', { expression: `Boolean(document.querySelector(${JSON.stringify(shot.ready)}))`, returnByValue: true });
        ready = result.result?.result?.value === true;
      }
      if (shot.then) {
        await send('Runtime.evaluate', { expression: shot.then, awaitPromise: true });
        ready = false;
        for (let i = 0; i < 60 && !ready; i++) {
          await sleep(250);
          const result = await send('Runtime.evaluate', { expression: `Boolean(document.querySelector(${JSON.stringify(shot.thenReady)}))`, returnByValue: true });
          ready = result.result?.result?.value === true;
        }
      }
      await sleep(800); // let frames and fonts settle
      const { result } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(out, `${shot.name}.png`), Buffer.from(result.data, 'base64'));
      console.log(`${ready ? 'ok ' : 'NOT READY'} ${shot.name}`);
    }
    close();
  } finally {
    browser.kill();
    await sleep(500);
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
