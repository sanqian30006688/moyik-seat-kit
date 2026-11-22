export { verifySigned, verifyBearer, sign, signingKey, header, DEFAULT_TOLERANCE_SECONDS } from './verify.ts';
export type { VerifyResult, VerifyFailure, HeaderSource } from './verify.ts';
export { parseWake, agentPrompt } from './payload.ts';
export type { WakeNotice, ParseResult } from './payload.ts';
export { TurnDeduper } from './dedupe.ts';
