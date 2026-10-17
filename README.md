# ChipWreck

Real cards, digital chips. Virtual poker chips for Texas Hold'em nights when you have a deck
but no chips. Everyone opens the page on their phone or laptop, joins with a 4-character code,
and bets by tapping or dragging chips into their play. Cards stay physical; the app handles
stacks, blinds, turns, pots, side pots and payouts.

(The repo is still called ChipStack; the app is ChipWreck.)

## What it does

- **Lobby.** Join with a code, or create a table: starting stack ($500 / $1,000 / $2,000) and
  blinds ($5/$10, $10/$20, $25/$50). Then a waiting room with the code, stats and who's seated.
- **Real Hold'em betting.** Dealer button rotation, automatic blinds, heads-up rules,
  min-raise checks, all-ins, side pots, uncalled chips returned, split pots.
- **Chip tray.** Tap or drag $5 / $10 / $25 / $100 chips into "Your play". Tap or drag a chip out
  to take it back. PLAY shows exactly what you're doing (PLAY $X, CALL $X, or ADD $N to reach the
  minimum raise). FOLD, CHECK/CALL and ALL IN are one tap.
- **Dealer scene.** The pot sits on the felt as chip stacks, with whose turn it is, the street,
  and the last thing that happened (including what to deal next).
- **Showdown.** Tap who took it. Split the pot or pick winners per side pot when needed.
- **Host tools** (table menu). Undo the last action, act for someone whose phone died, fix a stack,
  change blinds, remove players. Anyone can reorder seats, move the button, sit out or rebuy.
- **Ledger.** Buy-ins, stacks and net win/loss for settling up.
- **One-phone mode.** Pass a single phone around.

## How multiplayer works

The page picks a sync backend at runtime:

| Where it runs | Backend | Notes |
|---|---|---|
| claude.ai artifact | Shared artifact database + live room pokes | Players need a claude.ai account with access to the artifact |
| Anywhere else (GitHub Pages, any static host) | Public MQTT brokers (EMQX, HiveMQ, Mosquitto) | The host's phone runs the game; messages go through all reachable brokers at once |
| One-phone mode | Browser storage | No network needed |

All backends run the same pure reducer (`src/engine.js`), so the rules are identical everywhere.

## Project layout

```
src/engine.js      pure game reducer (no DOM) — all betting rules live here
src/transport.js   sync backends: ClaudeBackend, PeerBackend, LocalBackend
src/app.js         UI: lobby, waiting room, table, modals (component HTML builders)
src/shell.html     theme tokens, fonts, component styles, swirl background + CRT overlay
build.js           bundles into dist/artifact.html and docs/index.html
test/              engine unit tests (node:test) and a Playwright smoke test
```

## Develop

```bash
npm test            # engine unit tests
npm run build       # writes dist/ and docs/
python3 test/ui_smoke.py   # three simulated phones play a full hand (needs Playwright)
                           # CHIPWRECK_FONTS=<dir with @fontsource/jersey-15 + @fontsource-variable/archivo>
                           # serves the real fonts if Google Fonts is unreachable
python3 test/net_smoke.py <deps-dir>  # 7 players over a local MQTT broker
npm run serve       # serve docs/ locally
```

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. Settings → Pages → Deploy from branch → `main`, folder `/docs`.
3. Share `https://<you>.github.io/ChipStack/` (the path matches the repo name, capitals included) — add `#CODE` to pre-fill a table code.

## Known limits (MVP)

- Trust-based: anyone at the table can deal or pay out a pot. It's for friends.
- A short all-in raise reopens betting (strict rules say it shouldn't).
- In GitHub Pages mode, if the host's phone sleeps the table pauses until it comes back;
  the host's table is saved on their phone and resumes under the same code.
