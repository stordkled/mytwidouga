# Fixtures

- `twikeep-ranking-downloads-24h.json` — shape of `GET https://www.twikeep.com/api/ranking?metric=downloads&range=24h` (checked live on 2026-11-18). The first item is the live first item; the rest are trimmed samples plus rows the parser must drop (non-twimg host, duplicate, bad thumbnail).
- `twihozon-top.html` — complete, unmodified HTTP 200 response body from `GET https://www.twihozon.org/`, saved with Node's `fetch` on 2026-11-18 at 07:10:54 UTC (66,082 bytes). The 20 ranking cards have real `pbs.twimg.com` backgrounds, counts, authors and play links. MP4 URLs are in encoded data outside the cards, so the current listing parser returns `resolve` for all 20; no media attributes were added. The saved-page test also covers adjacent tags and t.co suffixes ending in digits. SHA-256: `593ac32902cd78eef1d3347ac59d9e454e97b9596842f3a5c154da2afd96151e`.
- `twihozon-play-14725.html` — complete, unmodified HTTP 200 response body from `GET https://www.twihozon.org/play-14725-video.html`, saved with Node's `fetch` on 2026-11-18 at 07:11:31 UTC (5,045 bytes). Tests use this saved response to check both `parsePlayPage` and the listing → `resolvePlayback` → direct MP4 path without networking. SHA-256: `083f5a67127d4fc40c84a9aea55916174f64cfa16c3fe431550c571424cf920c`.
- `twihozon-top-minified.html` — synthetic regression sample, not a saved response. Cards 14721 and 14722 have t.co link text ending in a digit right before the `件の表示` element. Before the fix, these parsed as 8,284,571 and 2,162,794 views. The URLs and media attributes are placeholders for unit coverage of direct MP4 extraction.

The board-path mapping test reuses the saved top-page body for `/week.html` and `/month.html`; it does not claim those responses were separately captured.

The two saved HTML responses retain the upstream whitespace. Their `.gitattributes` entries disable line-ending conversion and whitespace checks to preserve the captured bytes and hashes across checkouts.
