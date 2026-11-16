// Driver for the markdown-render-speed-02 harness.
// Reads every case from cases.json in the input directory, renders each
// with parse(), and writes the HTML array to html.json in the output
// directory. The sandbox mounts /input and /output; outside it, the
// MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR variables stand in.
// Runs on Node 22, which strips TypeScript types natively (erasable
// syntax only: no enums, namespaces, or parameter properties).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const raw = readFileSync(join(inputDir, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Array<{ id: string; markdown: string }>;

const rendered = new Array<string>(cases.length);
for (let i = 0; i < cases.length; i++) {
  rendered[i] = parse(cases[i].markdown);
}

writeFileSync(join(outputDir, 'html.json'), JSON.stringify(rendered));
