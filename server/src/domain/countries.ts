/**
 * Payout countries per receive currency: phone format, mobile money providers and bank
 * account rules. Shared with the web app through /api/config so both validate the same way.
 *
 * Phone numbers are stored in E.164 (+<dial><national>). `trunk` is the domestic prefix that
 * is dropped when a number is written locally (Ghana/Nigeria "0"); CEMAC countries have none.
 */
export interface PayoutCountry {
  code: string;
  name: string;
  currency: string;
  dial: string;
  trunk: string;
  /** National significant number, without trunk prefix. */
  phonePattern: RegExp;
  phoneExample: string;
  mobileMoneyProviders: string[];
  bankAccountPattern: RegExp;
  bankAccountHint: string;
}

const CEMAC_BANK = /^[A-Z0-9]{10,34}$/;
const CEMAC_BANK_HINT = 'RIB or IBAN, 10–34 letters/digits without spaces.';

export const PAYOUT_COUNTRIES: PayoutCountry[] = [
  {
    code: 'GH',
    name: 'Ghana',
    currency: 'GHS',
    dial: '233',
    trunk: '0',
    phonePattern: /^[235]\d{8}$/,
    phoneExample: '024 123 4567',
    mobileMoneyProviders: ['MTN MoMo', 'Telecel Cash', 'AirtelTigo Money'],
    bankAccountPattern: /^\d{6,20}$/,
    bankAccountHint: '6–20 digits.',
  },
  {
    code: 'NG',
    name: 'Nigeria',
    currency: 'NGN',
    dial: '234',
    trunk: '0',
    phonePattern: /^[789][01]\d{8}$/,
    phoneExample: '0803 123 4567',
    mobileMoneyProviders: ['OPay', 'PalmPay', 'Moniepoint', 'Paga', 'MTN MoMo PSB'],
    bankAccountPattern: /^\d{10}$/,
    bankAccountHint: '10-digit NUBAN account number.',
  },
  {
    code: 'CM',
    name: 'Cameroon',
    currency: 'XAF',
    dial: '237',
    trunk: '',
    phonePattern: /^[26]\d{8}$/,
    phoneExample: '6 71 23 45 67',
    mobileMoneyProviders: ['MTN Mobile Money', 'Orange Money'],
    bankAccountPattern: CEMAC_BANK,
    bankAccountHint: CEMAC_BANK_HINT,
  },
  {
    code: 'GA',
    name: 'Gabon',
    currency: 'XAF',
    dial: '241',
    trunk: '',
    phonePattern: /^\d{8,9}$/,
    phoneExample: '077 12 34 56',
    mobileMoneyProviders: ['Airtel Money', 'Moov Money'],
    bankAccountPattern: CEMAC_BANK,
    bankAccountHint: CEMAC_BANK_HINT,
  },
  {
    code: 'CG',
    name: 'Republic of the Congo',
    currency: 'XAF',
    dial: '242',
    trunk: '',
    phonePattern: /^\d{9}$/,
    phoneExample: '06 123 4567',
    mobileMoneyProviders: ['MTN Mobile Money', 'Airtel Money'],
    bankAccountPattern: CEMAC_BANK,
    bankAccountHint: CEMAC_BANK_HINT,
  },
  {
    code: 'TD',
    name: 'Chad',
    currency: 'XAF',
    dial: '235',
    trunk: '',
    phonePattern: /^\d{8}$/,
    phoneExample: '66 12 34 56',
    mobileMoneyProviders: ['Airtel Money', 'Moov Money'],
    bankAccountPattern: CEMAC_BANK,
    bankAccountHint: CEMAC_BANK_HINT,
  },
  {
    code: 'CF',
    name: 'Central African Republic',
    currency: 'XAF',
    dial: '236',
    trunk: '',
    phonePattern: /^\d{8}$/,
    phoneExample: '72 12 34 56',
    mobileMoneyProviders: ['Orange Money'],
    bankAccountPattern: CEMAC_BANK,
    bankAccountHint: CEMAC_BANK_HINT,
  },
  {
    code: 'GQ',
    name: 'Equatorial Guinea',
    currency: 'XAF',
    dial: '240',
    trunk: '',
    phonePattern: /^\d{9}$/,
    phoneExample: '222 123 456',
    mobileMoneyProviders: [],
    bankAccountPattern: CEMAC_BANK,
    bankAccountHint: CEMAC_BANK_HINT,
  },
];

export function countriesForCurrency(currency: string): PayoutCountry[] {
  return PAYOUT_COUNTRIES.filter((c) => c.currency === currency);
}

export function findCountry(code: string): PayoutCountry | undefined {
  return PAYOUT_COUNTRIES.find((c) => c.code === code);
}

/**
 * Normalises to E.164. Accepts international (+237…, 00237…, 237…) or local writing
 * (with the trunk prefix where the country uses one). Returns null if invalid.
 */
export function normalizePhone(country: PayoutCountry, raw: string): string | null {
  let digits = raw.replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  let national: string;
  if (digits.startsWith(country.dial) && country.phonePattern.test(digits.slice(country.dial.length))) {
    national = digits.slice(country.dial.length);
  } else if (country.trunk && digits.startsWith(country.trunk)) {
    national = digits.slice(country.trunk.length);
  } else {
    national = digits;
  }
  return /^\d+$/.test(national) && country.phonePattern.test(national) ? `+${country.dial}${national}` : null;
}

/** JSON-safe description for the web app. */
export function publicCountries() {
  const byCurrency: Record<string, object[]> = {};
  for (const c of PAYOUT_COUNTRIES) {
    (byCurrency[c.currency] ??= []).push({
      code: c.code,
      name: c.name,
      dial: c.dial,
      phoneExample: c.phoneExample,
      mobileMoneyProviders: c.mobileMoneyProviders,
      bankAccountHint: c.bankAccountHint,
    });
  }
  return byCurrency;
}
