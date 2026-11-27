# png-squeeze

[![make.fun · png-squeeze-01-run-20261127](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/vansouthrace/png-squeeze-01-run-20261127/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/vansouthrace/png-squeeze-01-run-20261127/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127?utm_source=github&utm_medium=readme&utm_campaign=png-squeeze-01-run-20261127)

Squeeze screenshots into the smallest PNG — a lossless PNG minimiser in pure TypeScript, written for the [make.fun bounty](https://make.fun/bounty/png-squeeze-01-run-20261127).

## What it does

`main.ts` reads each 1280×720 RGBA screenshot from `/input/<id>/image.png` and writes a lossless, byte-smaller PNG to `/output/<id>/image.png`. Every pixel decodes back exactly, including the colour of fully transparent pixels.

- **Smaller representation first** — palette (colour type 3) when the image holds at most 256 colours, grey / grey+alpha when every pixel is grey, and a `tRNS` key when a single transparent colour can replace the whole alpha channel. Palette entries are tried ordered by count and by luminance.
- **Per-row filter search** — every candidate form is screened with the minimum-sum heuristic, all five fixed filters, and (for the winning form) brute force: each row tried under all five filters, priced by a real zlib run with the previous 32 KiB as dictionary. Unfiltered rows win outright on large flat transparent areas, where any filter only makes things worse. A level-9 per-row cost model was tried and rejected: it screened smaller at level 6 but compressed larger at level 9 on flat images, and doubled the runtime.
- **Strong deflate** — candidates are screened at zlib level 6; the winner (and a runner-up within 3%, since level-6 and level-9 rankings differ) is written at zlib level 9 with both the default and filtered strategies, and the smallest whole file wins.
- **Deterministic** — no clock, no environment, no randomness. Two runs on the same set produce byte-identical outputs, and the whole set of 8 finishes in about 11 seconds locally, far inside the 60-second wall.

## Practice-set score

Scored with the kit's own scorer on the practice set:

| | score |
|---|---:|
| this entry | **702,766** |
| house baseline (fixed-paeth) | 420,399 |
| scale (666.67 reference point) | 666,667 |

Per instance: i001 718, i002 700, i003 665, i004 692, i005 742, i006 688, i007 702, i008 714 (points out of 1000). All 8 instances answered (`passed=1`).

## Run it

```sh
node main.ts
```

`main.ts` is a single self-contained file: Node 22 built-ins only (`node:fs`, `node:path`, `node:zlib`), no installs, no network. `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override `/input` and `/output` for local runs.

## License

MIT — see [LICENSE](LICENSE).
