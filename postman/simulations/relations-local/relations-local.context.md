# relations-local

Created 2026-10-26. Local fixture based on the official Anthropic Messages API
envelope and the installed SDK 1.3.0, not a captured live model response.

## Purpose

Run the actual Fastify application and Anthropic SDK against the local Messages
stand-in in `postman/mocks/anthropic/default.js`, including provider failures.

## Execution

From the project root, in two terminals:

```bash
postman simulation run postman/simulations/relations-local/relations-local.sim.yaml --port 4900 --output ndjson --no-history
npm run test:simulation
```

Take the mock address from the `listening` event if the port differs; supply it
as `SIMULATION_URL` to the test. The test starts and closes its own Fastify port.
The CLI emits one `request` event per upstream call. Stop the CLI with Ctrl-C.
No real API key is needed; do not point a real provider key at this mock.

## Assumptions

- Provider mock search requires Postman login, which was unavailable. The local
  fixture was written from official docs instead. (observed 2026-10-26)
- A successful run establishes SDK transport and backend validation against this
  fixture; actual Haiku access, generation quality and provider schema acceptance
  still need a live key. (reasoned 2026-10-26, `test/simulation.ts`)

## Observations

<!-- begin:observations -->
2026-10-26: after adding source-only topic references, the backend simulation
and Flutter HTTP integration both passed. The sole `anthropic` member served
shared-log, explicit-reference, upstream-failure, and malformed-output traffic;
none stayed silent. The reference fixture used a recordless guitar target and
one exact book-log quote; the real model was tested separately, not by this run.
2026-10-26: the only member, `anthropic`, served all three requests: valid output,
upstream 500, and malformed generated JSON. The listening Fastify server returned
200/502/502 respectively; the simulation test passed. No member stayed silent.
<!-- end:observations -->
