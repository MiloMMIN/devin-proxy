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
  discovery), JWT cache, token invalidation/retry.
- `src/server.ts` + `src/handlers/` — OpenAI Chat Completions / Responses,
  Anthropic Messages endpoints.
- `src/token.ts` + `src/desktop.ts` — token resolution chain:
  `DEVIN_API_KEY` → `~/.devin-proxy/token` → Devin Desktop `state.vscdb`.

Never log or commit full session tokens or JWTs — use `tokenFingerprint`.
