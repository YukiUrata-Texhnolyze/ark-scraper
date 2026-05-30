# BicCamera Policy

## Current Policy

- BicCamera is not a normal Playwright scraping target in this repository.
- In this Linux / WSL environment, direct retrieval is unstable due to `ERR_HTTP2_PROTOCOL_ERROR` and Akamai block behavior.
- Regular scraping, blind retry loops, and scheduled Bic runs are out of scope.
- Bic investigations must use BrowserMCP only under explicit human instruction with a connected browser tab.

## Public Bic Surfaces That Remain

- `npm run market:bic-search-browsermcp`
  - Emits query-plan CSV / JSONL only.
  - Manual / operator-assisted BrowserMCP workflow.
  - Does not autonomously drive the browser.
- `npm run market:bic-parse-html -- --input ... --query ...`
  - Parses saved Bic search HTML offline.
  - Intended for saved evidence, not live scraping.
- `npm run bic:profile`
  - Headful troubleshooting helper.
  - Human handles consent dialogs, confirmation pages, or CAPTCHA if they appear.
- `npm run bic:probe-home`
  - Saves JSON / HTML / PNG evidence for environment diagnostics.
  - Not a routine research or collection path.

## Non-Public Legacy Surface

- `src/scrapers/marketBicSearch.ts` remains in the repo only as low-level reference / diagnostic code.
- It is intentionally not exposed through `src/main.ts` or `package.json`.
- Do not wire it back into scheduled jobs or normal research flows without an explicit policy change.

## BrowserMCP Research Notes

- A connected browser tab is mandatory. Without it, BrowserMCP returns a no-connection error.
- Exact model queries can produce partial-match noise instead of target products.
- Brand queries can be normalized or broadened unexpectedly by Bic search.
- Category queries are more useful for observing current shelf, price, points, delivery labels, and sold-out state.
- Save snapshots or screenshots per query because Bic result state can change with normalized queries and `sold_out_tp2` flags.

## Nicoh-Specific Notes Recorded On 2026-05-31

- `NK-H01` and `NK-H01A` did not resolve to Nicoh products on Bic.
- `Nicoh Coffee` broadened to generic `coffee` results.
- `ポータブル エスプレッソマシン` exposed a real shelf with current products and sold-out WACACO items.
- For Nicoh launch work, Bic should currently be treated as a trust / retail-assurance channel, not a strong brand or model-name search entry point.