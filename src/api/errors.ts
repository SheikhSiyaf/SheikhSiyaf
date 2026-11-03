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
  [/Only the Administrator/, 'err.adminOnly'],
  [/Issued documents are never changed/, 'err.docImmutable'],
  [/A credit note cannot be more/, 'err.creditTooMuch'],
  [/more than is due on/, 'err.overDue'],
  [/amounts settled are more than the payment/, 'err.overAllocated'],
  [/Payments are never changed/, 'err.paymentImmutable'],
  [/Sales lines use an income account/, 'err.salesAccount'],
  [/Purchase lines use an expense or asset account/, 'err.purchaseAccount'],
  [/Choose a customer for this document|Choose a supplier for this document|Choose a customer or supplier/, 'err.contact'],
  [/bank or cash account/, 'err.bankAccount'],
  [/Enter who was paid/, 'err.payee'],
  [/someone else must approve or reject/, 'err.selfApprove'],
  [/Give a reason for rejecting/, 'err.rejectReason'],
  [/A submitted claim cannot be changed/, 'err.claimLocked'],
  [/Choose an employee for this claim/, 'err.pickEmployee'],
  [/Choose a customer of this company for the project/, 'err.projectCustomer'],
  [/voided with a reversing entry/, 'err.expenseImmutable'],
  [/cannot move from/, 'err.quoteStatus'],
  [/A sent quotation cannot be changed/, 'err.quoteImmutable'],
  [/same role for every client/, 'err.sameRole'],
  [/only belong to their own company/, 'err.clientOneCompany'],
  [/Not enough stock/, 'err.notEnoughStock'],
  [/Account codes have 4 digits/, 'err.accountCode'],
  [/has postings, so its code and type/, 'err.accountUsed'],
  [/Attachments of an issued document are kept/, 'err.attachmentKept'],
  [/Restaurant module is not turned on/, 'err.restaurantOff'],
  [/Menu items are sold to an income account/, 'err.recipeAccount'],
  [/Posted goods notes are never changed/, 'err.notePosted'],
  [/Stock changes only through/, 'err.stockDirect'],
  [/Imported statement lines are never changed/, 'err.statementImmutable'],
  [/matched statement line cannot be removed/, 'err.lineMatched'],
  [/not the amount on the statement/, 'err.matchAmount'],
  [/same bank account/, 'err.matchAccount'],
  [/Run depreciation up to/, 'err.depBeforeDisposal'],
  [/already booked for months after this date/, 'err.disposeAfterRuns'],
  [/runs one month at a time/, 'err.depNextMonth'],
  [/future month/, 'err.depFuture'],
  [/disposed asset never changes/, 'err.assetDisposed'],
  [/Depreciation has been booked on this asset/, 'err.assetLocked'],
  [/Goods received are credited/, 'err.noteAccount'],
  [/Choose a supplier \(goods received\)/, 'err.noteContact'],
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
  employee_is_only_employee: ['An employee cannot also be a customer or supplier.', 'err.employeeOnly'],
  contacts_employee_no: ['Another employee already has this employee number.', 'err.employeeNoTaken'],
  contact_sa_vat: ['A Saudi VAT number has 15 digits, starting and ending with 3.', 'err.saVat'],
  contact_ae_trn: ['A UAE TRN has 15 digits.', 'err.aeTrn'],
  line_net_is_qty_times_price: ['A line amount does not equal quantity x price.', 'err.lineNumbers'],
  line_vat_is_net_times_rate: ['A line VAT amount is not right.', 'err.lineNumbers'],
  bank_accounts_iban: ['Another bank account already has this IBAN.', 'err.ibanTaken'],
  bank_accounts_number: ['Another bank account already has this account number.', 'err.bankNumberTaken'],
  bank_accounts_iban_check: ['This IBAN is not right.', 'err.iban'],
  recipes_company_id_name_key: ['Another menu item already has this name.', 'err.recipeNameTaken'],
  accounts_company_id_code_key: ['Another account already has this code.', 'err.accountCodeTaken'],
  items_company_id_sku_key: ['Another item already has this code.', 'err.skuTaken'],
  items_qty_on_hand_check: ['Not enough stock.', 'err.notEnoughStock'],
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
