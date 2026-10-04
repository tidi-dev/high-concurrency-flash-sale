import { canTransition, TRANSITIONS } from './reservation-state';

describe('reservation state machine', () => {
  it.each([
    ['RESERVED', 'PAID'],
    ['RESERVED', 'EXPIRED'],
    ['RESERVED', 'REJECTED'],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['PAID', 'EXPIRED'], // a paid reservation must never give its unit back
    ['EXPIRED', 'PAID'], // paying after expiry would sell a unit that was already returned
    ['EXPIRED', 'EXPIRED'], // expiring twice would return stock twice
    ['PAID', 'PAID'], // double payment
    ['REJECTED', 'PAID'],
    ['REJECTED', 'RESERVED'],
  ] as const)('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('terminal states have no outgoing transitions', () => {
    expect(TRANSITIONS.PAID).toEqual([]);
    expect(TRANSITIONS.EXPIRED).toEqual([]);
    expect(TRANSITIONS.REJECTED).toEqual([]);
  });
});
