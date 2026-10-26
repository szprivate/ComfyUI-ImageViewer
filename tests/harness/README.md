Headless check of the Agent code panel against the real viewer js with stubbed ComfyUI scripts:
`node tests/harness/server.mjs <viewer checkout>` then open `http://127.0.0.1:8765/page.html#docked`
(also `#wrap`, `#pick`, `#file`; the Agent code reader is a tab now) in headless Chrome with `--screenshot`. The page title reports the outcome.
