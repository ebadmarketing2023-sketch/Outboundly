/** Abstraction over "now" so scheduling/policy logic (Section 15) is testable without wall-clock time. */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
