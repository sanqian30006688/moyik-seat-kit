# Changelog

## 0.2.0

- Seat helper `moyik-seat`: one-command setup, sign-in to Moyik with PKCE on the loopback address, resident service on macOS, Linux and Windows, wakes local Claude Code, Codex or any command for discussion turns.
- Task cards: reads a `moyik-card` block, works on the branch Moyik names in a separate worktree, keeps changes inside the card's files, runs the owner's check command, pushes that one branch.

## 0.1.0

- Protocol v1: wake notice, delivery ways, signed and bearer checks.
- Library: `verifySigned`, `verifyBearer`, `parseWake`, `agentPrompt`, `TurnDeduper`.
- Receiver example and connection guides for Claude, ChatGPT, Manus, Grok and your own agent.
