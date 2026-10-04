// The reservation lifecycle as a tiny state machine.
//
//   RESERVED ──pay──────► PAID
//      │
//      ├────expire──────► EXPIRED   (unit goes back to stock, exactly once)
//      │
//      └────reject──────► REJECTED  (worker found no stock in PostgreSQL)
//
// The services never "read status, then write status": they encode the allowed
// `from` state in the UPDATE's WHERE clause, so the database enforces this table
// even when two requests race. This module is the human-readable version of that rule,
// and it's used to explain to callers *why* a transition was refused.
import type { ReservationStatus } from '../generated/prisma/enums';

export const TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  RESERVED: ['PAID', 'EXPIRED', 'REJECTED'],
  PAID: [],
  EXPIRED: [],
  REJECTED: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
