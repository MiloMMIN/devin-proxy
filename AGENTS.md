# Agent Notes

Bun + TypeScript, zero runtime dependencies.

## Commands

```bash
bun install                 # devDeps only (typescript, @types/bun)
bun run start               # serve (default subcommand)
bun run dev                 # serve with --watch
bun run login               # OAuth PKCE login → writes ~/.devin-proxy/token
bun run status              # token source + JWT account info
bun run models              # list upstream models
bun test                    # offline test suite (live.test.ts skips unless LIVE=1)
bun run typecheck           # tsc --noEmit
LIVE=1 bun test test/live.test.ts   # one real upstream call (requires local Devin Desktop login)
```

## Layout

- `src/proto.ts` — protobuf wire encode/decode for the Cascade Connect API. Ported
  verbatim from devin-gateway; do not change field numbers or framing.
- `src/upstream.ts` — upstream client (GetUserJwt + GetChatMessage + model
  discovery), JWT cache, token invalidation/retry. `Metadata.ide_type` is
  pinned to `chisel` (the Devin Local identity); required for the
  gpt-5-6-sol/luna/terra and gpt-6-astra families.
- `src/models.ts` — model catalog (TTL cache), `MODEL_MAP` aliases, and
  effort→uid resolution in `catalog.resolve`: `family:level[-tier]` syntax and
  the per-protocol effort hints rewrite to the nearest catalog uid (upstream
  has no effort parameter; each family-level-tier combo is a distinct uid).
  `list()` appends `adaptive` (upstream auto-router) plus two built-in fusion
  preset aliases (`BUILTIN_ALIASES`); fusion uids are chisel lead+sidekick
  orchestration presets, not standalone models.
- `src/server.ts` + `src/handlers/` — OpenAI Chat Completions / Responses,
  Anthropic Messages endpoints.
- `src/token.ts` + `src/desktop.ts` — token resolution chain:
  `DEVIN_API_KEY` → `~/.devin-proxy/token` → Devin Desktop `state.vscdb`.

Never log or commit full session tokens or JWTs — use `tokenFingerprint`.
