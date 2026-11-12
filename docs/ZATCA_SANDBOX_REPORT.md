# ZATCA e-invoicing: Stage 1 sandbox test report

Run on 2026-11-12 with `scripts/zatca-sandbox-check.ts`. Our own ZATCA code (src/einvoice/zatca) was run end to end
against ZATCA's **developer-portal sandbox** with **dummy data only**. Nothing was fixed; this report comes first.

## What was called

Only the sandbox base address `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal`. The script refuses
any other base. Simulation (`/e-invoicing/simulation`) and production (`/e-invoicing/core`) were never called.

| Step | Exact path (under the sandbox base) | Calls |
|---|---|---|
| 1. Compliance certificate (CSID) for our CSR | `POST /compliance` | 1 |
| 2. Compliance checks, one per invoice type | `POST /compliance/invoices` | 6 |
| 3. "Production" CSID: the sandbox's own version of this step, not the production system | `POST /production/csids` | 1 |
| 4. Clearance of standard (B2B) invoices | `POST /invoices/clearance/single` | 3 |
| 5. Reporting of simplified (B2C) invoices | `POST /invoices/reporting/single` | 3 |

Dummy data used:
- **Seller:** VAT 399999999900003, which is ZATCA's dummy sample format, and CR 1010010000.
- **Buyer:** VAT 399999999800003.
- **One-time code:** 123345, the fixed test code ZATCA publishes for the sandbox.
- **Key and certificate:** a new key made for the run, and the certificates the sandbox issued.

No real VAT number, certificate or one-time code was used.

API version: Fatoora API **V2** (`Accept-Version: V2`).

The code follows ZATCA's *E-Invoice XML Implementation Standard*, its *Security Features Implementation Standard*
and the Fatoora SDK's CSR template. The exact version numbers of those documents are **not recorded in the code**,
and I have not yet confirmed them against ZATCA's site.

## Which ZATCA steps are built

| ZATCA step | Built? | Where | Sandbox result |
|---|---|---|---|
| Key and certificate request (CSR) | Yes | `crypto.ts` `makeCsr` | Accepted: compliance CSID issued |
| Compliance CSID with the one-time code | Yes | `api.ts` `complianceCsid`, `einvoiceService.onboard` | Accepted |
| Compliance checks for each invoice type | Yes | `einvoiceService.finishOnboarding` | 6 of 6 accepted |
| Production CSID | Yes | `api.ts` `productionCsid` | Issued (see failure 1) |
| Clearance of standard invoices | Yes | `api.ts` `clearance`, `einvoiceService.submit` | 3 of 3 cleared |
| Reporting of simplified invoices | Yes | `api.ts` `reporting`, `einvoiceService.submit` | **3 of 3 rejected** |
| QR code (phase 2, tags 1–9) | Yes | `xml.ts` `qrCode` | Passed in compliance; rejected in reporting (failure 1) |
| Invoice counter (ICV) and previous-invoice hash chain (PIH) | Yes, enforced in the database | `0025_einvoicing.sql` | ICV 1–12 accepted in order |
| Cryptographic stamp (XAdES signature) | Yes | `xml.ts` `stampInvoice` | Passed in compliance; rejected in reporting (failure 1) |
| **Automatic reporting within 24 hours** | **Partly** | — | Not tested (see failure 2) |
| **Certificate renewal before expiry** | **No** | — | Not tested (see failure 3) |
| **Debit notes from the books** | Yes | `invoiceData` | Only the dummy samples were tested here |

## Results by invoice type

| Invoice type | Compliance check | Clearance / reporting |
|---|---|---|
| Standard tax invoice (388) | Accepted (PASS) | **Cleared** |
| Standard credit note (381) | Accepted (PASS) | **Cleared** |
| Standard debit note (383) | Accepted (PASS) | **Cleared** |
| Simplified tax invoice (388) | Accepted (PASS) | **Rejected**, HTTP 400, NOT_REPORTED |
| Simplified credit note (381) | Accepted (PASS) | **Rejected**, HTTP 400, NOT_REPORTED |
| Simplified debit note (383) | Accepted (PASS) | **Rejected**, HTTP 400, NOT_REPORTED |

No warnings were returned on any accepted invoice.

ZATCA's exact error text, the same for all three rejections:

```
publicKey_QRCODE_INVALID (QRCODE_VALIDATION): ECDSA Public Key does not match with qr code ECDSA public key
signed-properties-hashing (CERTIFICATE_ERRORS): Invalid signed properties hashing, SignedProperties with id='xadesSignedProperties'
```

## Failures in plain language, with proposed fixes

### 1. Simplified invoices rejected after the production certificate

**What happened:**
- The sandbox's production-certificate step returned a certificate whose key is **not our key**. I compared the
  saved certificates offline.
- The compliance certificate carries our key, from our CSR.
- The production certificate has a different key, issuer `PRZEINVOICESCA4-CA`, and a 2029 expiry. Its request
  number (`1234567890123`) is also a dummy.
- So it looks like ZATCA's fixed sample certificate, not one made for our request.
- We then signed with our key but named that certificate in the signature. ZATCA saw that the key in the QR code
  doesn't match the certificate, and that the signed properties don't match.
- Clearance in the sandbox did not check this; reporting did.

**What it means:**
- Most likely a limit of the sandbox, not a fault in our signing.
- The same simplified invoices passed the compliance checks when signed with the certificate that matches our key.
- But the sandbox cannot prove it. The simulation stage (with its real one-time code) issues a production
  certificate for our own key, and that is where it will be settled.

**Proposed fixes:**
- (a) Before activating a device, check that the production certificate's public key matches the device's key. If
  it doesn't, stop with a clear message instead of producing invoices ZATCA will reject. Small change, with a test.
- (b) Optional diagnostic, sandbox only, needing your OK: one extra call to `POST /compliance/invoices`. It would
  send a simplified invoice signed with that sample certificate. This tells us whether the `signed-properties-hashing`
  error has a second cause: how we write a certificate issuer with several parts
  (`CN=…, DC=extgazt, DC=gov, DC=local`). That way we would know before simulation rather than during it.

### 2. Simplified invoices are not sent automatically within 24 hours

**What happened:**
- Simplified invoices must be reported within 24 hours.
- Today they are sent when the user presses send, or "send pending" (`/api/companies/:id/einvoices/send-pending`).
- Recurring invoices made by the nightly job are sent automatically.
- Ordinary invoices left pending are not sent automatically.

**Proposed fix:** a background job, like the other jobs, that sends pending e-invoices every few minutes. It should
raise a notice for anything still pending after 12 hours.

### 3. No certificate renewal

**What happened:** the expiry date is stored (`cert_valid_to`), but nothing warns before it expires or renews it.

**Proposed fix:** a calendar notice 30 days before expiry, and a "renew" action that runs onboarding again with a
new one-time code.

### 4. Document versions not recorded

**What happened:** the code names the ZATCA standards but not their version numbers or dates.

**Proposed fix:** download the current versions from zatca.gov.sa (the environment now allows it), check the code
against them, and record the versions in `docs/DECISIONS.md`.

## What the next stage needs from you and the resort (do not start until you confirm)

Stage 2, the **simulation** environment (`/e-invoicing/simulation`), will need:

1. **The resort's real details:**
   - Legal name.
   - VAT number (15 digits).
   - CR number.
   - The full national address: building number, street, district, city and postal code.
   - The branch name.
   - Whether they issue standard (B2B) invoices, simplified (B2C) invoices or both.
2. **A one-time code from the Fatoora simulation portal.** Someone with the resort's ZATCA (Fatoora) login creates
   it. It works once, for about one hour, so we must agree a time and have the code given to me at that moment.
3. **Your decision** on fixes 1(a), 2 and 3 above: before Stage 2 (recommended for 1(a)), or after.
4. **Where to run it.** It needs the real app with its database, not this test script, because the device key and
   certificates must be stored encrypted.

## Evidence

- Every request and response, the CSR and each signed XML were saved during the run.
- Re-run it with `NODE_USE_ENV_PROXY=1 npx tsx scripts/zatca-sandbox-check.ts <folder>`. The proxy setting is only
  needed inside the cloud build environment.
