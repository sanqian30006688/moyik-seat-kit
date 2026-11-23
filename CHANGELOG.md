# Changelog

## 0.2.0

- Seat helper `moyik-seat`: one-command setup, sign-in to Moyik with PKCE on the loopback address, resident service on macOS, Linux and Windows, wakes local Claude Code, Codex or any command for discussion turns.
- Task cards (Claude Code only): the owner confirms each card on their own computer first; reads a `moyik-card` block; works on the branch Moyik names in a sparse worktree holding only the card's files; the AI can only read and edit those files, with no shell or web; the helper runs the owner's check command and pushes that one branch.
- Sign-in kept in the system keychain where there is one, else a file only the owner can read. `uninstall` removes the service, sign-in and every local file. No self-update.

## 0.1.0

- Protocol v1: wake notice, delivery ways, signed and bearer checks.
- Library: `verifySigned`, `verifyBearer`, `parseWake`, `agentPrompt`, `TurnDeduper`.
- Receiver example and connection guides for Claude, ChatGPT, Manus, Grok and your own agent.
