export interface PublicCorridor {
  from: string;
  to: string;
  available: boolean;
  unavailableReason: string | null;
  minSendAmount: string;
  maxSendAmount: string;
  feeRate: string | null;
  quoteTtlSeconds: number;
  payoutSlaHours: number;
  payoutTerms: string;
}

export interface PublicConfig {
  corridors: PublicCorridor[];
  settings: {
    business_name: string;
    support_email: string;
    support_phone: string;
    support_whatsapp: string;
    operating_hours: string;
    terms_version: string;
    terms_text: string;
  };
  mobileMoneyProviders: string[];
  upload: { maxBytes: number; types: string[] };
}

export interface RateInfo {
  from: string;
  to: string;
  rate: string | null;
  kind: 'api' | 'operator' | null;
  source: string | null;
  providerTimestamp: string | null;
  fetchedAt: string | null;
  usable: boolean;
  stale: boolean;
  message: string | null;
  feeRate: string | null;
  corridorAvailable: boolean;
  corridorMessage: string | null;
}

export interface Quote {
  id: string;
  sendCurrency: string;
  receiveCurrency: string;
  sendAmount: string;
  rate: string;
  rateKind: string;
  rateSource: string;
  rateTimestamp: string;
  feeRate: string;
  feeBasis: string;
  grossAmount: string;
  feeAmount: string;
  otherFees: { label: string; amount: string }[];
  payoutAmount: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  accepted: boolean;
  payoutSlaHours: number;
  payoutTerms: string;
  paymentWindowMinutes: number;
}

export interface TrackingOrder {
  reference: string;
  status: string;
  statusLabel: string;
  statusChangedAt: string;
  updatedAt: string;
  createdAt: string;
  terms: {
    sendAmount: string;
    sendCurrency: string;
    receiveCurrency: string;
    rate: string;
    rateSource: string;
    rateTimestamp: string;
    feeRate: string;
    grossAmount: string;
    feeAmount: string;
    payoutAmount: string;
    termsVersion: string;
    acceptedAt: string;
  };
  recipient: {
    name: string;
    phone: string;
    payoutMethod: string;
    mobileMoneyProvider: string | null;
    bankName: string | null;
    bankAccount: string | null;
  };
  paymentDueAt: string;
  payoutDueAt: string | null;
  expectedPayoutHours: number;
  paymentInstructions: { method_label: string; instructions: string } | null;
  customerTransferReference: string | null;
  operatorMessage: string | null;
  canUploadProof: boolean;
  canCancel: boolean;
  proofs: { submitted_at: string; review_status: string; original_filename: string }[];
  timeline: { status: string; label: string; note: string | null; at: string }[];
  completion: { payoutAmount: string; payoutReference: string; payoutDate: string } | null;
  refund: { amount: string; currency: string; reference: string; reason: string } | null;
  support: { email: string; phone: string; whatsapp: string; hours: string };
}
