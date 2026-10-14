# ChipStack

Virtual poker chips for Texas Hold'em nights when you have a deck of cards but no chips.
Everyone opens the page on their phone, joins the table with a 4-letter code, and bets by
tapping or dragging chips onto the betting line. Cards stay physical; the app handles
stacks, blinds, turns, pots, side pots and payouts.

## What the MVP does

- **Tables with a code.** One person creates a table (buy-in and blinds), friends join with the code.
- **Real Hold'em betting.** Dealer button rotation, automatic blinds, heads-up rules,
  min-raise checks, all-ins, side pots, uncalled chips returned, split pots (odd chip to the
  first winner left of the button).
- **Chip rack.** Tap chips or drag them onto the betting line, or use Min / ½ pot / Pot / All in.
- **Dealing prompts.** The pot shows the street and what to deal next ("Burn one, deal the flop").
- **Showdown.** Tap the winner of each pot (tap two players to split) and chips are paid out.
- **Host tools.** Undo last action, act for someone whose phone died, fix a stack, change blinds,
  remove players. Anyone can reorder seats, move the button, sit out or rebuy between hands.
- **Ledger.** Buy-ins, stacks and net win/loss for settling up at the end.
- **One-phone mode.** Pass a single phone around if not everyone has theirs.

## How multiplayer works

The page picks a sync backend at runtime:

| Where it runs | Backend | Notes |
|---|---|---|
| claude.ai artifact | Shared artifact database + live room pokes | Players need a claude.ai account with access to the artifact |
| Anywhere else (GitHub Pages, any static host) | PeerJS (WebRTC) | The host's phone acts as the server: keep it awake with the page open |
| One-phone mode | Browser storage | No network needed |

All backends run the same pure reducer (`src/engine.js`), so the rules are identical everywhere.

## Project layout

```
src/engine.js      pure game reducer (no DOM) — all betting rules live here
src/transport.js   sync backends: ClaudeBackend, PeerBackend, LocalBackend
src/app.js         phone UI
src/shell.html     styles and page shell
build.js           bundles into dist/artifact.html and docs/index.html
test/              engine unit tests (node:test) and a Playwright smoke test
```

## Develop

```bash
npm test            # engine unit tests
npm run build       # writes dist/ and docs/
python3 test/ui_smoke.py   # three simulated phones play a full hand (needs Playwright)
npm run serve       # serve docs/ locally
```

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. Settings → Pages → Deploy from branch → `main`, folder `/docs`.
3. Share `https://<you>.github.io/chipstack/` — add `#CODE` to pre-fill a table code.

## Known limits (MVP)

- Trust-based: anyone at the table can deal or pay out a pot. It's for friends.
- A short all-in raise reopens betting (strict rules say it shouldn't).
- In PeerJS mode, if the host's phone sleeps the table pauses until it comes back;
  the host's table is saved on their phone and resumes under the same code.
