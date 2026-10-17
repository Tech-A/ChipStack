"""Browser smoke test: two phones sharing a table through a fake claude db (localStorage-backed),
plus the one-phone mode. Run: python3 test/ui_smoke.py  (needs `node build.js` first)."""
import pathlib, sys, re, os
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / 'docs' / 'index.html').as_uri()
OUT = ROOT / 'test' / 'shots'
OUT.mkdir(exist_ok=True)
# Google Fonts may be unreachable from test machines: serve the same faces from @fontsource if installed.
FONTS = pathlib.Path(os.environ.get('CHIPWRECK_FONTS', '/tmp/fonts')) / 'node_modules'
FONT_CSS = None
if (FONTS / '@fontsource/jersey-15').exists():
    FONT_CSS = (
        "@font-face{font-family:'Jersey 15';font-weight:400;src:url(https://fonts.gstatic.com/x/jersey.woff2) format('woff2')}"
        "@font-face{font-family:'Archivo';font-weight:100 900;font-stretch:62% 125%;src:url(https://fonts.gstatic.com/x/archivo.woff2) format('woff2')}")
    FONT_FILES = {'jersey.woff2': FONTS / '@fontsource/jersey-15/files/jersey-15-latin-400-normal.woff2',
                  'archivo.woff2': FONTS / '@fontsource-variable/archivo/files/archivo-latin-standard-normal.woff2'}
    if not FONT_FILES['archivo.woff2'].exists():
        FONT_FILES['archivo.woff2'] = FONTS / '@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2'


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

def money_in(page, sel):
    return int(page.locator(sel).first.inner_text().replace('$', '').replace(',', '').split()[0])

def seat_stack(page, name):
    return int(page.locator('.seat', has_text=name).locator('.of').inner_text().replace('of $', '').replace(',', ''))

def drag(page, src, dst):
    a, b = page.locator(src).bounding_box(), page.locator(dst).bounding_box()
    page.mouse.move(a['x'] + a['width'] / 2, a['y'] + a['height'] / 2)
    page.mouse.down()
    page.mouse.move(b['x'] + b['width'] / 2, b['y'] + b['height'] / 2, steps=8)
    page.mouse.up()
    page.wait_for_timeout(80)

import atexit
PAGES = []
with sync_playwright() as p:
    browser = p.chromium.launch(proxy={'server': os.environ['HTTPS_PROXY']} if os.environ.get('HTTPS_PROXY') else None)
    ctx = browser.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    def mk(uid):
        pg = ctx.new_page()
        if FONT_CSS:
            pg.route('https://fonts.googleapis.com/**', lambda r: r.fulfill(body=FONT_CSS, content_type='text/css'))
            pg.route('https://fonts.gstatic.com/x/*', lambda r: r.fulfill(body=FONT_FILES[r.request.url.rsplit('/', 1)[1]].read_bytes(), content_type='font/woff2'))
        pg.on('pageerror', lambda e: errors.append(f'{uid}: {e}'))
        if uid: pg.add_init_script(FAKE_CLAUDE % uid)
        pg.goto(URL)
        pg.evaluate("""document.fonts.load('40px "Jersey 15"').then(() => document.fonts.load('16px Archivo'))""")
        PAGES.append(pg)
        return pg

    try:
      a = mk('alice')
      a.wait_for_selector('#b-submit')
      a.screenshot(path=str(OUT / '0-lobby-form.png'))
      a.click('[data-a="tab"][data-v="create"]')
      a.fill('#in-name', 'Abbey')
      a.click('#b-submit')
      a.wait_for_selector('.tiles')
      code = ''.join(a.locator('.tiles div').all_inner_texts())
      print('table code', code)
      assert re.fullmatch(r'[A-Z0-9]{4}', code), code

      friends = []
      for uid, name in [('bob', 'Sam'), ('cara', 'Kiri')]:
          f = mk(uid)
          f.fill('#in-name', name)
          f.fill('#in-code', code)
          f.click('#b-submit')
          f.wait_for_selector('#b-seat')
          a.wait_for_selector(f'.rp:has-text("{name}")')
          friends.append(f)
      b, c = friends
      a.screenshot(path=str(OUT / '1-room.png'))

      a.click('#b-start')
      # Abbey has the button, Sam SB, Kiri BB, Abbey acts first
      a.wait_for_selector('#b-play')
      b.wait_for_selector('#tbl')  # friends jump to the table when the game starts
      a.wait_for_selector('#turnPill:has-text("YOUR TURN")')
      for _ in range(3): a.click('[data-chip="10"]')
      assert 'PLAY $30' in a.locator('#b-play').inner_text(), a.locator('#b-play').inner_text()
      drag(a, '[data-chip="5"]', '#zone')
      assert 'PLAY $35' in a.locator('#b-play').inner_text(), a.locator('#b-play').inner_text()
      a.click('[data-zchip]:last-child')  # tap top chip to take it back
      assert 'PLAY $30' in a.locator('#b-play').inner_text(), a.locator('#b-play').inner_text()
      a.click('[data-chip="5"]')
      a.screenshot(path=str(OUT / '2-my-turn.png'), full_page=True)
      a.click('#b-play')

      b.wait_for_selector('#b-call:not([disabled]):has-text("CALL $30")')
      b.click('#b-call')
      c.wait_for_selector('#b-call:not([disabled]):has-text("CALL $25")')
      c.click('#b-fold')
      a.wait_for_selector('#streetPill:has-text("FLOP")')
      print('flop reached; pot', a.locator('#potLabel span').inner_text())
      assert a.locator('#potLabel span').inner_text() == '$80'

      # flop: Sam checks, Abbey bets 80 with chips, Sam calls
      b.wait_for_selector('#b-call:not([disabled]):has-text("CHECK")'); b.click('#b-call')
      a.wait_for_selector('#turnPill:has-text("YOUR TURN")')
      for v in [25, 25, 25, 5]: a.click(f'[data-chip="{v}"]')
      a.click('#b-play')
      b.wait_for_selector('#b-call:not([disabled]):has-text("CALL $80")'); b.click('#b-call')
      for _ in range(2):
          b.wait_for_selector('#b-call:not([disabled]):has-text("CHECK")'); b.click('#b-call')
          a.wait_for_selector('#turnPill:has-text("YOUR TURN")'); a.click('#b-call')
      a.wait_for_selector('[data-a="win1"]')
      a.screenshot(path=str(OUT / '3-showdown.png'))
      a.click('[data-a="win1"]:has-text("SAM")')
      a.wait_for_selector('.mtitle:has-text("SAM TAKES IT")')
      b.wait_for_selector('.mtitle:has-text("YOU TAKE IT")')
      print('stacks: Sam', seat_stack(a, 'Sam'), 'Kiri', seat_stack(a, 'Kiri'), 'Abbey', a.locator('.mestack').inner_text())
      assert seat_stack(a, 'Sam') == 1125 and seat_stack(a, 'Kiri') == 990 and a.locator('.mestack').inner_text() == '$885'
      a.screenshot(path=str(OUT / '4-won.png'))
      a.click('.modal [data-a="menu"]')
      a.wait_for_selector('.ledger')
      a.screenshot(path=str(OUT / '5-menu.png'))
      a.click('[data-a="close-sheet"]')
      a.click('#b-deal')
      a.wait_for_selector('#hHand:has-text("HAND 2")')
      # wider screens
      for w, hgt, nm in [(1280, 800, 'desktop'), (900, 1000, 'tablet')]:
          a.set_viewport_size({'width': w, 'height': hgt})
          a.wait_for_timeout(400)
          a.screenshot(path=str(OUT / f'6-table-{nm}.png'))
      b.set_viewport_size({'width': 1280, 'height': 800})
      b.wait_for_timeout(300)
      b.screenshot(path=str(OUT / '7-table-desktop-sam.png'))
      lob = mk(None); lob.set_viewport_size({'width': 1280, 'height': 800}); lob.wait_for_timeout(500)
      lob.screenshot(path=str(OUT / '8-lobby-desktop.png'))

      # one-phone mode
      d = mk(None)
      d.fill('#in-name', 'Abbey')
      d.click('[data-a="local"]')
      d.wait_for_selector('#in-add')
      for n in ['Sam', 'Kiri']:
          d.fill('#in-add', n); d.click('[data-a="add-player"]')
          d.wait_for_selector(f'.rp:has-text("{n}")')
      d.click('#b-start')
      d.wait_for_selector('#turnPill:has-text("ABBEY")')
      d.click('#b-fold'); d.wait_for_selector('#turnPill:has-text("SAM")')
      d.click('#b-fold')
      d.wait_for_selector('.mtitle:has-text("KIRI TAKES IT")')
      assert d.locator('.mamt').inner_text() == '$15'
      print('one-phone ok')
    except Exception:
        for i, pg in enumerate(PAGES):
            try: pg.screenshot(path=str(OUT / f'fail-{i}.png'))
            except Exception: pass
        raise
    browser.close()

if errors:
    print('PAGE ERRORS:', *errors, sep='\n'); sys.exit(1)
print('ALL OK')
