import { describe, it, expect } from 'vitest';
import { passwordProblem } from './passwordRules';
import { MIN_PASSWORD_LENGTH } from '@/types/system';

describe('passwordProblem', () => {
  it('accepts a long ordinary phrase', () => {
    expect(passwordProblem('rainy tuesday ledger')).toBeNull();
  });

  it('refuses anything shorter than the rule, and says how short', () => {
    const problem = passwordProblem('short');
    expect(problem).toContain(String(MIN_PASSWORD_LENGTH));
    expect(problem).toContain('5');
  });

  it('accepts exactly the minimum length', () => {
    expect(passwordProblem('a'.repeat(MIN_PASSWORD_LENGTH) + 'x')).toBeNull();
    expect(passwordProblem('abcdefghij')).toBeNull();
  });

  it('refuses the obvious words, whatever the capitalisation', () => {
    expect(passwordProblem('MyPassword123')).toContain('password');
    expect(passwordProblem('CandoniOffice1')).toContain('candoni');
    expect(passwordProblem('cfms-treasury-01')).toContain('cfms');
  });

  it('refuses a password built from the account name', () => {
    expect(
      passwordProblem('jdelacruz-2026-ok', { email: 'jdelacruz@mgocandoni.gov.ph' }),
    ).toContain('account name');
  });

  it('does not refuse on a very short account name that could appear by chance', () => {
    // "jo" would match half the dictionary. The rule only bites at four
    // characters, where a match is no longer a coincidence.
    expect(passwordProblem('a joyful morning', { email: 'jo@mgocandoni.gov.ph' })).toBeNull();
  });

  it('refuses reusing the password already in force', () => {
    expect(
      passwordProblem('rainy tuesday ledger', { currentPassword: 'rainy tuesday ledger' }),
    ).toContain('already using');
  });

  it('allows a password that merely resembles the current one', () => {
    expect(
      passwordProblem('rainy tuesday ledgers', { currentPassword: 'rainy tuesday ledger' }),
    ).toBeNull();
  });
});
