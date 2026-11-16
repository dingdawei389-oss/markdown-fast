# markdown-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/dingdawei389-oss/markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/dingdawei389-oss/markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free Markdown renderer that produces byte-identical HTML to marked 18.1.3 (CommonMark 0.31.2 + GFM tables, strikethrough, autolinks, and task lists).

The parser is a single self-contained module (`parse.js`, no dependencies): a block parser with lazy continuation, fenced/indented code, tables, and HTML blocks, plus an inline parser for emphasis, links, images, code spans, autolinks, and entities. `main.ts` is the thin harness driver that renders a whole case file.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

`./input/cases.json` holds `[{ "id": "...", "markdown": "..." }]`; `./output/html.json` receives the rendered HTML array in the same order.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zgwyxmgf&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
