# README screenshots

Pictures of the real Kasboek window, made from invented data (a made-up household with three
accounts, about 900 payments over 14 months, budgets, fixed costs, goals, tips and a chat). Nothing is
read from a real data folder.

## Remake them

```sh
npm run build          # builds the renderer into out/renderer
npm run screenshots    # writes docs/screenshots/<screen>-light.png and -dark.png
```

Options after `--`: `--only overview,budgets` (some screens), `--out <folder>`, `--renderer <folder>`.

Playwright must be installed with a Chromium (`npx playwright install chromium` once). The PNGs are
compressed with `sharp` (already a dev dependency).

## How it works

- `take.mjs` serves `out/renderer`, opens it in Chromium at 1440x900 (scale 2) with a fixed clock
  (2026-11-15), and clicks to each screen in light and dark.
- `bridge.mjs` replaces `window.kasboek` (the preload bridge) and answers the operations of
  `src/shared/contract.ts` from the data.
- `data.mjs` builds the invented household (seeded, so every run gives the same pictures). Add or change
  screens in the `SHOTS` list in `take.mjs`. IBANs are documentation examples; with the app's default
  "hide account numbers" they would show as `BE…7034`.

When the app gets a new operation that a screen needs, add its answer to `data.mjs`; the bridge logs
`[bridge] <op>` for any operation without one.

These files are not part of the app: they are not in `tsconfig` and not packaged.
