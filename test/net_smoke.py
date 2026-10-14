"""Multiplayer test of the GitHub Pages build: one host + several friends on separate
"phones" (browser contexts), relayed through a local MQTT broker (plus a dead one, to prove fallback).

Setup (once):  npm install --prefix /tmp/nettest mqtt@5.10.1 aedes@0.51.3 websocket-stream@5.5.2
Run:           python3 test/net_smoke.py /tmp/nettest [friends]   (after `node build.js`)
"""
import pathlib, subprocess, sys, time, http.server, threading, functools
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
DEPS = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '/tmp/peertest')
N_FRIENDS = int(sys.argv[2]) if len(sys.argv) > 2 else 4
MQTTJS = (DEPS / 'node_modules/mqtt/dist/mqtt.min.js').read_bytes()

SERVER_JS = """
const aedes = require('aedes')(); const http = require('http'); const ws = require('websocket-stream');
const srv = http.createServer(); ws.createServer({ server: srv }, aedes.handle);
srv.listen(9124, '127.0.0.1');
"""
(DEPS / 'broker.js').write_text(SERVER_JS)
server = subprocess.Popen(['node', str(DEPS / 'broker.js')], cwd=str(DEPS), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / 'docs'))
handler.log_message = lambda *a: None
httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()
time.sleep(1.5)

OPTS = "window.CHIPSTACK_BROKERS = ['ws://127.0.0.1:9124', 'ws://127.0.0.1:9199'];"
errors, logs = [], []

def phone(browser, label, ctx=None):
    if ctx is None:
        ctx = browser.new_context(viewport={'width': 390, 'height': 844})
        ctx.add_init_script(OPTS)
        ctx.route('**/mqtt.min.js', lambda r: r.fulfill(body=MQTTJS, content_type='application/javascript'))
        ctx.route('https://fonts.googleapis.com/**', lambda r: r.abort())
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(f'{label}: {e}'))
    pg.on('console', lambda m: logs.append(f'{label} {m.type}: {m.text}') if m.type in ('error', 'warning') else None)
    pg.goto('http://127.0.0.1:8765/')
    return pg

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        host = phone(browser, 'host')
        host.fill('#in-name', 'Abbey')
        host.wait_for_selector('#b-create:not([disabled])')
        host.click('#b-create')
        host.wait_for_selector('.codepill', timeout=15000)
        code = host.locator('.codepill').inner_text().strip()
        print('code', code)
        friends = []
        for i in range(N_FRIENDS):
            f = phone(browser, f'f{i}')
            f.fill('#in-name', f'Friend{i}')
            f.fill('#in-code', code)
            f.wait_for_selector('#b-join:not([disabled])')
            f.click('#b-join')
            try:
                f.wait_for_selector(f'.seat:has-text("Friend{i}")', timeout=15000)
                print(f'Friend{i} joined')
            except Exception:
                print(f'Friend{i} FAILED; screen says:', f.locator('.err').inner_text() if f.locator('.err').count() else f.locator('body').inner_text()[:300])
            friends.append(f)
        # a second tab in the same browser as Friend0 must get its own seat
        same = phone(browser, 'sametab', ctx=friends[0].context)
        same.fill('#in-name', 'SameBrowser'); same.fill('#in-code', code)
        same.wait_for_selector('#b-join:not([disabled])'); same.click('#b-join')
        same.wait_for_selector('.seat:has-text("SameBrowser")', timeout=15000)
        assert same.locator('.seat:has-text("SameBrowser") .tag.you').count() == 1
        assert friends[0].locator('.seat:has-text("Friend0") .tag.you').count() == 1
        print('second tab in same browser got its own seat')
        friends.append(same)
        time.sleep(1)
        print('host sees seats:', host.locator('.seat').count())
        host.click('#b-deal')
        time.sleep(1.5)
        print('dealt; players in hand per host:', host.evaluate("document.querySelectorAll('.tok.sb, .tok.bb').length"), 'blinds shown')
        # whoever is first to act takes an action from their own phone
        acted = False
        for f in friends + [host]:
            if f.locator('#b-call').count():
                f.click('#b-call'); acted = True; break
        time.sleep(1)
        assert acted, 'nobody had controls'
        print('action from a friend phone reached everyone:', host.locator('.seat .bet').count(), 'bets on host screen')
        # host's phone reloads (e.g. screen locked, tab reopened) and resumes hosting
        host.reload()
        host.wait_for_selector('[data-resume]', timeout=15000)
        host.click('[data-resume]')
        host.wait_for_selector('.codepill', timeout=15000)
        time.sleep(1)
        # a friend acts after the host came back
        for f in friends + [host]:
            if f.locator('#b-call').count():
                before = f.locator('#b-call').inner_text(); f.click('#b-call'); break
        time.sleep(1.5)
        print('after host resumed, a friend acted:', before, '| bets now on host screen:', host.locator('.seat .bet').count(), '| on Friend0:', friends[0].locator('.seat .bet').count())
        for i, f in enumerate(friends):
            print(f'Friend{i} sees seats:', f.locator('.seat').count(), '| hand:', f.locator('.top .meta').inner_text().split('\n')[0])
        browser.close()
finally:
    server.terminate(); httpd.shutdown()

print('\n'.join(errors + logs[:20]) or 'no page errors')
