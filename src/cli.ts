import { readStream, run } from "./main.ts";

const diff = await readStream(Deno.stdin.readable);
Deno.exit(await run(diff));
