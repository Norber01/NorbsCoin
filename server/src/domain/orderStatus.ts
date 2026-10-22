export const ORDER_STATUSES = [
  'awaiting_payment',
  'proof_submitted',
  'resubmission_requested',
  'payment_verified',
  'payout_processing',
  'completed',
  'rejected',
  'cancelled',
  'expired',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const TERMINAL_STATUSES: readonly OrderStatus[] = ['completed', 'rejected', 'cancelled', 'expired', 'refunded'];

export type Actor = 'customer' | 'admin' | 'system';

interface Transition {
  to: OrderStatus;
  by: readonly Actor[];
}

/**
 * The only allowed status transitions. Anything else is refused.
 * Key rule: nothing reaches payout or completion without passing payment_verified,
 * and payment_verified can only be set by an operator.
 */
const TRANSITIONS: Record<OrderStatus, readonly Transition[]> = {
  awaiting_payment: [
    { to: 'proof_submitted', by: ['customer'] },
    { to: 'cancelled', by: ['customer', 'admin'] },
    { to: 'expired', by: ['system'] },
    { to: 'rejected', by: ['admin'] },
  ],
  proof_submitted: [
    { to: 'payment_verified', by: ['admin'] },
    { to: 'resubmission_requested', by: ['admin'] },
    { to: 'rejected', by: ['admin'] },
    // Customer may send an additional/corrected proof before review.
    { to: 'proof_submitted', by: ['customer'] },
  ],
  resubmission_requested: [
    { to: 'proof_submitted', by: ['customer'] },
    { to: 'rejected', by: ['admin'] },
    { to: 'cancelled', by: ['customer', 'admin'] },
    // A corrected receipt is not needed if the operator confirms funds independently.
    { to: 'payment_verified', by: ['admin'] },
  ],
  payment_verified: [
    { to: 'payout_processing', by: ['admin'] },
    { to: 'refunded', by: ['admin'] },
  ],
  payout_processing: [
    { to: 'completed', by: ['admin'] },
    { to: 'payment_verified', by: ['admin'] }, // payout attempt failed / reverted
    { to: 'refunded', by: ['admin'] },
  ],
  completed: [],
  rejected: [],
  cancelled: [],
  expired: [],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus, actor: Actor): boolean {
  return TRANSITIONS[from].some((t) => t.to === to && t.by.includes(actor));
}

export function allowedTransitions(from: OrderStatus, actor: Actor): OrderStatus[] {
  return TRANSITIONS[from].filter((t) => t.by.includes(actor)).map((t) => t.to);
}

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Customer-facing labels (tracking page and emails). */
export const CUSTOMER_STATUS_LABEL: Record<OrderStatus, string> = {
  awaiting_payment: 'Awaiting payment',
  proof_submitted: 'Awaiting verification',
  resubmission_requested: 'Action needed: new payment proof requested',
  payment_verified: 'Payment verified',
  payout_processing: 'Payout processing',
  completed: 'Completed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired',
  refunded: 'Refunded',
};
