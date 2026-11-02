// Turns database errors into plain-language messages. `key` lets the UI show the message in Arabic.
export class HttpError extends Error {
  constructor(public status: number, message: string, public key?: string, public details?: string[]) {
    super(message);
  }
}

const RAISED: [RegExp, string][] = [
  [/period is locked/, 'err.periodLocked'],
  [/does not balance/, 'err.notBalanced'],
  [/at least two lines/, 'err.twoLines'],
  [/cost centre is required/, 'err.costCentreRequired'],
  [/already been reversed/, 'err.alreadyReversed'],
  [/itself a reversal/, 'err.isReversal'],
  [/cannot be changed or deleted/, 'err.immutable'],
  [/different company/, 'err.otherCompany'],
  [/first client user/, 'err.firstClientUser'],
];

const CONSTRAINTS: Record<string, [string, string]> = {
  sa_cr_format: ['A Saudi CR number has 10 digits.', 'err.saCr'],
  sa_vat_format: ['A Saudi VAT number has 15 digits, starting and ending with 3.', 'err.saVat'],
  ae_trn_format: ['A UAE TRN has 15 digits.', 'err.aeTrn'],
  vat_number_when_registered: ['Enter the VAT number, or choose VAT unregistered.', 'err.vatNumber'],
  currency_matches_country: ['The currency does not match the country.', 'err.currency'],
  cr_number_unique: ['A client with this registration number already exists.', 'err.crTaken'],
  vat_number_unique: ['A client with this VAT number already exists.', 'err.vatTaken'],
  users_email_unique: ['A user with this email already exists.', 'err.emailTaken'],
  users_email_check: ['Enter a valid email address.', 'err.email'],
};

interface PgError { code?: string; message: string; constraint?: string }

export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const e = err as PgError;
  const known = e.constraint ? CONSTRAINTS[e.constraint] : undefined;
  switch (e.code) {
    case 'P0001': {
      const key = RAISED.find(([re]) => re.test(e.message))?.[1];
      return new HttpError(400, e.message, key);
    }
    case '42501':
      return new HttpError(403, 'Your role does not allow this.', 'err.forbidden');
    case '23505':
    case '23514':
      if (known) return new HttpError(400, known[0], known[1]);
      if (e.constraint?.startsWith('journal_lines_check'))
        return new HttpError(400, 'Each line needs a debit or a credit amount, not both, and never negative.', 'err.lineAmounts');
      return new HttpError(400, 'Some details are not valid.', 'err.invalid');
    case '23502':
      return new HttpError(400, 'Fill in all required fields.', 'err.required');
    case '23P01':
      return new HttpError(400, 'This period overlaps another period.', 'err.overlap');
    case '23503':
      return new HttpError(400, 'Something you picked no longer exists.', 'err.missing');
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return new HttpError(400, 'Some values are not in the right format.', 'err.format');
    default:
      return new HttpError(500, 'Something went wrong. Please try again.', 'err.server');
  }
}
