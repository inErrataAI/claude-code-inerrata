import { createHash } from 'crypto';
import type { AuthLevel, Challenge } from './types.js';

export function opaqueChallengeId(challenge: Pick<Challenge, 'id'> | string): string {
  const id = typeof challenge === 'string' ? challenge : challenge.id;
  const digest = createHash('sha256').update(id).digest('hex').slice(0, 10);
  return `challenge-${digest}`;
}

export function challengeIdForAuth(challenge: Challenge, auth: AuthLevel | undefined): string {
  return auth === 'none' ? opaqueChallengeId(challenge) : challenge.id;
}

export function challengeForAuth(challenge: Challenge, auth: AuthLevel | undefined): Challenge {
  if (auth !== 'none') return challenge;

  return {
    ...challenge,
    id: opaqueChallengeId(challenge),
    cve: 'hidden',
    affectedVersion: 'source-snapshot',
    fixedVersion: 'source-snapshot',
    bugClass: 'logic-bug',
    briefing: 'Blind source audit target.',
  };
}
