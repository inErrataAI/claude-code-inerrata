/**
 * challenges/registry.ts -- public challenge metadata for the CTF Cold-To-Warm Demo.
 *
 * This file intentionally excludes scoring-only answer data. Keep ground truth,
 * exploit vectors, call chains, and patch hints in registry.private.ts.
 */

import type { Challenge } from '../shared/types.js';
import { SCORING_CHALLENGES } from './registry.private.js';

// ---------------------------------------------------------------------------
// Repository URLs
// ---------------------------------------------------------------------------

export const REPOS: Record<string, string> = {
  ghostscript: 'https://git.ghostscript.com/ghostpdl.git',
  wget:        'https://git.savannah.gnu.org/git/wget.git',
  tar:         'https://git.savannah.gnu.org/git/tar.git',
  binutils:    'https://sourceware.org/git/binutils-gdb.git',
  bash:        'https://git.savannah.gnu.org/git/bash.git',
  glibc:       'https://sourceware.org/git/glibc.git',
  curl:        'https://github.com/curl/curl.git',
  openssl:     'https://github.com/openssl/openssl.git',
  libxml2:     'https://gitlab.gnome.org/GNOME/libxml2.git',
  grub:        'https://git.savannah.gnu.org/git/grub.git',
  screen:      'https://git.savannah.gnu.org/git/screen.git',
  gnutls:      'https://gitlab.com/gnutls/gnutls.git',
  patch:       'https://git.savannah.gnu.org/git/patch.git',
  coreutils:   'https://git.savannah.gnu.org/git/coreutils.git',
  sed:         'https://git.savannah.gnu.org/git/sed.git',
};

function publicChallenge(challenge: Challenge): Challenge {
  return {
    id: challenge.id,
    cve: challenge.cve,
    repo: challenge.repo,
    repoUrl: challenge.repoUrl,
    affectedVersion: challenge.affectedVersion,
    fixedVersion: challenge.fixedVersion,
    bugClass: challenge.bugClass,
    difficulty: challenge.difficulty,
    points: challenge.points,
    briefing: challenge.briefing,
  };
}

export const CHALLENGES: Challenge[] = SCORING_CHALLENGES.map(publicChallenge);

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Get all public challenge metadata for a given repository name.
 */
export function getChallengesByRepo(repo: string): Challenge[] {
  return CHALLENGES.filter(c => c.repo === repo);
}

/**
 * Get public challenge metadata by id.
 */
export function getChallengeById(id: string): Challenge | undefined {
  return CHALLENGES.find(c => c.id === id);
}
