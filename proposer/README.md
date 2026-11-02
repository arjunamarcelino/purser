# proposer

_Placeholder — untrusted AI proposer on NEAR AI Cloud (TypeScript). Scaffolded in a later step._

Holds a NEAR **function-call access key** scoped to `propose_payment` (provisioned by the owner when a
delegate is added) — that key is its only authority; all limits live in the contract. Store it via env,
never in the repo. (Symmetric with the relayer's isolation of `RELAYER_PRIVATE_KEY`.)

Contract types: import from `packages/types` (generated from the ABI) — do not hand-mirror them.
