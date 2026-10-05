import { MIN_PASSWORD_LENGTH } from '@/types/system';

/**
 * Whether a proposed password may be used, and what to say if not.
 *
 * ---------------------------------------------------------------------------
 * WHY SO FEW RULES
 * ---------------------------------------------------------------------------
 * Length, not character classes. A rule demanding a capital, a digit and a
 * symbol produces "Password1!" on every desk in the building, because that is
 * what people type when a box refuses everything else. Length is the thing
 * that actually costs an attacker time, and it is the one rule people satisfy
 * by choosing something longer rather than something they have to write on a
 * note under the keyboard.
 *
 * The two refusals beyond length are both about the same failure: a password
 * that anybody who has met the user could guess. The account name is the
 * first thing tried, and "password" is the second.
 */

/** Written out so a user can be told the rule before they fail it. */
export const PASSWORD_RULE = `At least ${MIN_PASSWORD_LENGTH} characters. A phrase you will remember is better than a short word with symbols in it.`;

const OBVIOUS = ['password', 'cfms', 'candoni', '12345678', 'qwerty', 'admin'];

export function passwordProblem(
  password: string,
  context?: { email?: string | null; currentPassword?: string | null },
): string | null {
  const value = password ?? '';

  if (value.length < MIN_PASSWORD_LENGTH) {
    return `A password must be at least ${MIN_PASSWORD_LENGTH} characters. That one is ${value.length}.`;
  }

  if (context?.currentPassword && value === context.currentPassword) {
    return 'That is the password you are already using. Choose a different one.';
  }

  const lower = value.toLowerCase();

  for (const word of OBVIOUS) {
    if (lower.includes(word)) {
      return `A password containing "${word}" is among the first things anybody would try. Choose something else.`;
    }
  }

  const localPart = (context?.email ?? '').split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length >= 4 && lower.includes(localPart)) {
    return 'A password containing your own account name is among the first things anybody would try. Choose something else.';
  }

  return null;
}
