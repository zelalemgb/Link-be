export const PAYMENT_STATUS = {
  PENDING: 'pending',
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  PAID: 'paid',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
  WAIVED: 'waived',
  DISPUTED: 'disputed',
} as const;

export type PaymentStatus = (typeof PAYMENT_STATUS)[keyof typeof PAYMENT_STATUS];

export const PAYMENT_STATUS_VALUES: PaymentStatus[] = Object.values(PAYMENT_STATUS);

