"""Browser smoke test: two phones sharing a table through a fake claude db (localStorage-backed),
plus the one-phone mode. Run: python3 test/ui_smoke.py  (needs `node build.js` first)."""
import pathlib, sys, re
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / 'docs' / 'index.html').as_uri()
OUT = ROOT / 'test' / 'shots'
OUT.mkdir(exist_ok=True)

FAKE_CLAUDE = """
(() => {
  const uid = %r;
  const K = (p) => 'fakedb:' + p;
  const read = (p) => { const v = localStorage.getItem(K(p)); return v ? JSON.parse(v) : null; };
  const leases = {};
  const docRef = (path) => ({
    path,
    async get() { const d = read(path); return { id: path, exists: !!d, data: () => d, metadata: {} }; },
    async set(d) { localStorage.setItem(K(path), JSON.stringify(d)); },
    async acquire({ holder, ttlMs }) {
      const lk = K('lease:' + path); const now = Date.now();
      const cur = JSON.parse(localStorage.getItem(lk) || 'null');
      if (cur && cur.until > now && cur.holder !== holder) return { acquired: false };
      localStorage.setItem(lk, JSON.stringify({ holder, until: now + (ttlMs || 30000) }));
      return { acquired: true };
    },
    onSnapshot(next) {
      let last = null;
      const tick = () => { const raw = localStorage.getItem(K(path)); if (raw !== last) { last = raw; const d = raw ? JSON.parse(raw) : null; next({ id: path, exists: !!d, data: () => d, metadata: {} }); } };
      tick(); const t = setInterval(tick, 150); return () => clearInterval(t);
    },
  });
  const db = { doc: docRef };
  const user = { async id() { return uid; } };
  const room = { async join() { return { on() { return () => {}; }, emit: async () => {}, presence: async () => {}, onPeers() { return () => {}; }, peers: () => [], leave: async () => {} }; } };
  window.claude = { use: async (n) => ({ db, user, room }[n] || null) };
})();
"""

errors = []

def phone(browser, uid=None):
    ctx_page = browser.new_page(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx_page.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
    if uid:
        ctx_page.add_init_script(FAKE_CLAUDE % uid)
    ctx_page.goto(URL)
    return ctx_page

def stack_of(page, name):
    row = page.locator('.seat', has_text=name)
    return int(row.locator('.stack').inner_text().replace(',', ''))

with sync_playwright() as p:
    browser = p.chromium.launch()
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    def mk(uid):
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
        if uid: pg.add_init_script(FAKE_CLAUDE % uid)
        pg.goto(URL)
        return pg

    a = mk('alice')
    a.fill('#in-name', 'Abbey')
    a.click('#b-create')
    a.wait_for_selector('.codepill')
    code = a.locator('.codepill').inner_text().strip()
    print('table code', code)
    assert re.fullmatch(r'[A-Z0-9]{4}', code), code

    b = mk('bob')
    b.fill('#in-name', 'Sam')
    b.fill('#in-code', code)
    b.click('#b-join')
    b.wait_for_selector('.seat:has-text("Sam")')
    a.wait_for_selector('.seat:has-text("Sam")')

    c = mk('cara')
    c.fill('#in-name', 'Kiri')
    c.fill('#in-code', code)
    c.click('#b-join')
    a.wait_for_selector('.seat:has-text("Kiri")')
    a.screenshot(path=str(OUT / '1-lobby.png'))

    a.click('#b-deal')
    # Abbey has the button, Sam SB, Kiri BB, Abbey acts first
    a.wait_for_selector('#b-raise')
    a.screenshot(path=str(OUT / '2-my-turn.png'))
    # tap a chip a few times: 10 + 10 + 10 = raise to 30
    chip10 = a.locator('[data-chip="10"]')
    for _ in range(3): chip10.click()
    assert 'Raise to 30' in a.locator('#b-raise').inner_text(), a.locator('#b-raise').inner_text()
    # drag a 5 chip onto the betting line -> 35
    box = a.locator('[data-chip="5"]').bounding_box()
    line = a.locator('#betline').bounding_box()
    a.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
    a.mouse.down()
    a.mouse.move(line['x'] + 40, line['y'] + 30, steps=8)
    a.mouse.up()
    a.wait_for_timeout(100)
    assert 'Raise to 35' in a.locator('#b-raise').inner_text(), a.locator('#b-raise').inner_text()
    a.screenshot(path=str(OUT / '3-staged.png'))
    a.click('#b-raise')

    b.wait_for_selector('#b-call:has-text("Call 30")')
    b.click('#b-call')
    c.wait_for_selector('#b-call:has-text("Call 25")')
    c.click('#b-fold')
    a.wait_for_selector('.streets .on:has-text("FLOP")')
    print('flop reached; pot', a.locator('.potzone .amt').inner_text())
    assert a.locator('.potzone .amt').inner_text() == '80'

    # flop: Sam checks, Abbey bets pot, Sam calls
    b.wait_for_selector('#b-call:has-text("Check")')
    b.click('#b-call')
    a.wait_for_selector('#b-raise')
    a.click('[data-q="pot"]')
    a.click('#b-raise')
    b.wait_for_selector('#b-call:has-text("Call 80")')
    b.click('#b-call')
    # turn + river check down
    for _ in range(2):
        b.wait_for_selector('#b-call:has-text("Check")'); b.click('#b-call')
        a.wait_for_selector('#b-call:has-text("Check")'); a.click('#b-call')
    a.wait_for_selector('#b-award')
    a.screenshot(path=str(OUT / '4-showdown.png'))
    a.click('[data-win]:has-text("Sam")')
    a.click('#b-award')
    a.wait_for_selector('.result')
    a.wait_for_timeout(300)
    print('stacks', stack_of(a, 'Abbey'), stack_of(a, 'Sam'), stack_of(a, 'Kiri'))
    assert stack_of(a, "Sam") == 1125 and stack_of(a, "Abbey") == 885 and stack_of(a, "Kiri") == 990
    a.screenshot(path=str(OUT / '5-result.png'))
    a.click('#b-menu')
    a.screenshot(path=str(OUT / '6-menu.png'))

    # one-phone mode
    d = mk(None)
    d.fill('#in-name', 'Abbey')
    d.click('#b-local')
    d.wait_for_selector('#b-add')
    for n in ['Sam', 'Kiri']:
        d.click('#b-add'); d.fill('#in-add', n); d.click('#b-add-go')
        d.wait_for_selector(f'.seat:has-text("{n}")')
    d.click('#b-deal')
    d.wait_for_selector('.dockhead:has-text("Abbey\'s turn")')
    d.click('#b-fold'); d.wait_for_selector('.dockhead:has-text("Sam\'s turn")')
    d.click('#b-fold')
    d.wait_for_selector('.result:has-text("Kiri won 15")')
    print('one-phone ok')
    browser.close()

if errors:
    print('PAGE ERRORS:', *errors, sep='\n'); sys.exit(1)
print('ALL OK')
