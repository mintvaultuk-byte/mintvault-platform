---
title: "Privacy Policy"
document: "MintVault Ltd — Privacy Policy"
version: "v1.0-draft-pre-solicitor"
status: "Draft — pending solicitor review"
lastUpdated: "[DATE TO BE INSERTED BY SOLICITOR]"
effectiveFrom: "[DATE TO BE INSERTED BY SOLICITOR]"
---

# MintVault Ltd — Privacy Policy

**Version 1.0 — Draft for solicitor review**

> **Important note for solicitor:** This is one of five connected documents prepared for UK solicitor review. This Privacy Policy is written in publication-ready form using the structure and lawful-basis analysis developed in internal review rounds. Key areas requiring qualified legal judgement are flagged inline. Processor details, retention periods, and international-transfer disclosures reflect MintVault's actual technology stack. The drafting is not legal advice.

## Placeholders to complete before publication

- **[COMPANY NUMBER]** — CLIENT to insert from Companies House.
- **[REGISTERED OFFICE]** — CLIENT to insert full registered office address.
- **[DATE TO BE INSERTED BY SOLICITOR]** — Last updated / Effective from.
- Data Protection Officer (DPO) — CLIENT / SOLICITOR to confirm whether a DPO is appointed.
- ICO registration number — CLIENT to confirm ICO notification and insert registration number.
- Cookies Policy URL — separate Cookies Policy to be drafted or integrated as section 9.

## Solicitor review flags — summary

- **Section 3 (Lawful bases)** — please confirm the lawful-basis analysis for each processing activity, particularly (a) the legitimate-interests basis for indefinite retention of pseudonymous Logbook records, (b) the contract basis for identified keeper data during custody, and (c) the legal-obligation basis for MLR 2017 retention.
- **Section 5 (Retention schedule)** — please confirm the tiered retention schedule satisfies UK GDPR Art. 5(1)(e), particularly the 7-year retention of identifiable keeper data post-transfer; please confirm pseudonymous keeper identifiers should be explicitly stated as personal data during the 7-year identifiable-retention window (Recital 26).
- **Section 6 (Data subject rights)** — please confirm the Article 17(3) carve-outs for Logbook records and MLR data are correctly framed.
- **Section 7 (International transfers)** — please confirm the IDTA / UK Addendum approach for transfers to US-based AI providers (Anthropic, OpenAI) is current and adequate; please confirm the no-training commitment should be framed as "based on current provider terms as of [date], which we will update if terms change".
- **Section 8 (Processors and Data Processing Agreements)** — please confirm DPAs are in place with each processor before launch.
- **Section 9 (Cookies)** — either cookies are addressed in this Policy or a separate Cookies Policy is published; please confirm PECR 2003 reg 6 compliance.
- **Section 11 (Automated decision-making)** — please confirm human review of AI grading output is sufficient to avoid Art. 22, given ICO guidance on "meaningful" human review.

---

## 1. Who we are and how to contact us

**1.1** This Privacy Policy explains how MintVault Ltd ("MintVault", "we", "us", "our") processes your personal data when you use our website mintvaultuk.com, submit Cards for grading, hold a MintVault account, or otherwise interact with our services.

**1.2** MintVault Ltd is the data controller for the personal data described in this Policy.

| | |
|---|---|
| Company name | MintVault Ltd |
| Company number | **[COMPANY NUMBER]** |
| Registered office | **[REGISTERED OFFICE]** |
| ICO registration number | **[ICO REGISTRATION NUMBER]** |
| Privacy contact | support@mintvaultuk.com |
| Website | mintvaultuk.com |

**1.3** For privacy-related queries, rights requests, or complaints, contact us at support@mintvaultuk.com with "PRIVACY" in the subject line.

**1.4** Data Protection Officer. MintVault has not appointed a statutory Data Protection Officer. Processing activities do not meet the mandatory DPO threshold under UK GDPR Article 37. Privacy queries are handled by MintVault's senior management team via the contact in 1.3.

## 2. What personal data we collect

**2.1** Data you give us directly.

- **Identity data:** name, date of birth (where required for verification), username, password (hashed and salted).
- **Contact data:** email address, postal address, phone number (optional).
- **Billing and payment data:** billing address, payment-card data (processed by Stripe as a separate controller — MintVault does not store full payment-card numbers).
- **Submission data:** details of Cards submitted (identity, condition, Declared Value), photographs and scans of Cards, grading preferences.
- **Verification data** (under Submission Agreement clause 4A): government-issued identification, proof of address, source-of-funds documentation where required under MLR 2017.
- **Correspondence:** messages, support tickets, dispute-related communications, freeze-review correspondence.
- **Keeper and Transfer data:** name shown on Certificates (if public-display opted in), Document Reference Number, keeper-history metadata, Transfer counterparty information you provide.
- **Marketing preferences:** opt-in or opt-out status for newsletters and promotional communications.

**2.2** Data we collect automatically when you use the Site.

- **Technical data:** IP address (truncated to /24 for IPv4 or /64 for IPv6 for logging purposes per our security logging policy), device type, browser type and version, operating system, language settings, referring URL.
- **Usage data:** pages viewed, actions taken, session duration, clickstream data.
- **Cookies and similar technologies:** as described in section 9 below.

**2.3** Data we receive from third parties.

- **Payment metadata from Stripe:** transaction IDs, authorisation status, last-four digits of payment card, payment method type. (Stripe is a separate data controller for the underlying payment-card data.)
- **Fraud and verification results:** from third-party identity-verification providers when engaged for MLR 2017 compliance.
- **Email deliverability data:** from Resend (our transactional email provider).
- **Carrier and shipping data:** tracking information and delivery status from Royal Mail, DPD, ParcelForce, or other carriers.

**2.4** Special category data. MintVault's standard processing does not involve special category data under UK GDPR Article 9. Where identity verification under clause 4A involves a passport containing biometric data, MintVault does not process that biometric data for biometric-identification purposes — the document is used only for visual identity confirmation and retained under MLR 2017.

## 3. Lawful bases and purposes of processing

**3.1** Every processing activity MintVault undertakes has a specific lawful basis under UK GDPR Article 6. The table below summarises each activity, its lawful basis, and the purposes served.

| Processing activity | Lawful basis (UK GDPR Art. 6) | Purpose |
|---|---|---|
| Creating and managing your MintVault account | 6(1)(b) Contract | Providing the platform service |
| Accepting, processing, grading, encapsulating, and returning Cards | 6(1)(b) Contract | Delivering the grading service |
| Issuing Certificates and maintaining the Logbook (while you are current keeper) | 6(1)(b) Contract | Providing the Certificate service |
| Taking payment and issuing refunds | 6(1)(b) Contract + 6(1)(c) Legal obligation (refunds under CCRs 2013) | Payment processing and statutory refund compliance |
| Sending transactional emails | 6(1)(b) Contract | Performing the contract |
| Sending marketing emails | 6(1)(a) Consent | Marketing with opt-in; PECR 2003 also applies |
| Maintaining historic Logbook records (pseudonymous) after keeper relationship ends | 6(1)(f) Legitimate Interests | Integrity of the grading record |
| Retaining identifiable keeper data for 7 years post-transfer | 6(1)(f) Legitimate Interests | Fraud investigation, dispute resolution, defence of legal claims |
| Fraud prevention, security monitoring, audit logging | 6(1)(f) Legitimate Interests | Protecting users, the platform, and third parties |
| Identity verification and source-of-funds checks (clause 4A SA) where statutorily required | 6(1)(c) Legal obligation — MLR 2017 | AML / counter-terrorist-financing compliance |
| Identity verification at lower (sub-statutory) thresholds | 6(1)(f) Legitimate Interests | Fraud prevention |
| Publishing anonymised population reports and aggregated data | 6(1)(f) Legitimate Interests | Market transparency; core grading-company function |
| Research and development of grading methodology, including machine-learning training | 6(1)(f) Legitimate Interests, subject to opt-out under Submission Agreement clause 20.3 | Improving grading accuracy |
| Promotional use of identifiable Card images or Customer names | 6(1)(a) Consent | Marketing with specific opt-in, revocable |
| Responding to law-enforcement and regulatory requests | 6(1)(c) Legal obligation or 6(1)(f) Legitimate Interests | Legal compliance |
| Retention of MLR records | 6(1)(c) Legal obligation — MLR 2017 reg 40 | 5-year retention required by law |
| Retention of financial records | 6(1)(c) Legal obligation — Companies Act 2006, HMRC | 6-year retention required by law |
| Defending legal claims | 6(1)(f) Legitimate Interests | Protecting MintVault's legal position |

**3.2** Legitimate Interests Assessment (LIA). Where MintVault relies on legitimate interests under Article 6(1)(f), we have conducted an internal LIA. A summary is available on request at support@mintvaultuk.com.

**3.3** Consent. Where processing is based on consent, you may withdraw consent at any time without affecting any other processing. Withdrawal does not affect the lawfulness of processing before withdrawal.

> **SOLICITOR REVIEW FLAG — Section 3:** Please confirm the lawful-basis mapping, particularly (a) legitimate-interests basis for indefinite retention of pseudonymous Logbook records, (b) the balance between contract and legitimate-interests bases during vs. after the keeper relationship, and (c) whether any processing activity should sit under a different basis.

## 4. Who we share data with

**4.1** Processors — acting on MintVault's behalf under a Data Processing Agreement.

| Processor | Purpose | Location |
|---|---|---|
| Stripe, Inc. | Payment processing | EEA / US (with SCCs / UK Addendum) |
| Resend | Transactional email delivery | EEA / US |
| Cloudflare, Inc. (R2) | Image and file storage | EEA / UK |
| Neon, Inc. | Database hosting | EEA (eu-central-1 region) |
| Fly.io, Inc. | Application hosting | UK (London region) |
| Anthropic PBC | AI-assisted grading (no training on MintVault data under default API commercial terms) | US (with UK IDTA / SCCs + UK Addendum) |
| OpenAI, LLC | AI-assisted grading features (no training on MintVault data under Enterprise / API non-training terms) | US (with UK IDTA / SCCs + UK Addendum) |
| Identity verification provider | Identity and source-of-funds verification | TBC at engagement |
| Shipping carriers (Royal Mail, DPD, ParcelForce) | Inbound and outbound shipping | UK primarily |

**4.2** Joint / separate controllers.

- Stripe acts as a separate data controller for the underlying payment-card data it processes. Stripe's privacy notice is at stripe.com/privacy.

**4.3** Recipients of data under legal or legitimate-interest grounds.

- Law enforcement, regulators, HMRC, courts where required or permitted by law.
- Other Keepers or affected parties in ownership disputes (only the information necessary).
- Insurers in connection with custody claims.
- Legal advisers and auditors under duties of confidentiality.
- Successors in a business transfer of MintVault, subject to equivalent data-protection obligations.

**4.4** MintVault does not sell personal data to third parties for marketing purposes.

> **SOLICITOR REVIEW FLAG — Section 4:** Please confirm DPAs are in place with each processor before launch; confirm the separate-controller position for Stripe is correctly reflected.

## 5. How long we keep personal data — Tiered Retention Schedule

**5.1** MintVault retains personal data only for as long as is necessary for the purposes for which it was collected, except where law requires longer retention or legitimate interests justify it.

**5.2** Account data

| Data category | Retention period | Basis |
|---|---|---|
| Account profile (name, email, password, preferences) | Duration of account + 2 years after closure | Legitimate interests |
| Marketing preferences and consent records | Until consent withdrawn + 1 year | Legal obligation (UK GDPR Art. 7) |
| Support / correspondence history | 3 years from last communication | Legitimate interests |

**5.3** Transaction and financial data

| Data category | Retention period | Basis |
|---|---|---|
| Payment records, invoices, receipts | 6 years | Legal obligation — Companies Act 2006, HMRC |
| Refund and chargeback records | 6 years | Legal obligation — Companies Act 2006, HMRC |

**5.4** MLR-related data (clause 4A Submission Agreement)

| Data category | Retention period | Basis |
|---|---|---|
| Identity verification documents, source-of-funds, CDD records | 5 years from end of business relationship | Legal obligation — MLR 2017 reg 40 |
| SAR-related internal records | As required by POCA 2002 / internal MLR policy | Legal obligation |

*Note:* MLR records cannot be erased during the statutory retention period even on Article 17 erasure request (see section 6.4).

**5.5** Keeper and Certificate records — tiered approach

We distinguish between pseudonymous record integrity (retained indefinitely to preserve the grading record) and identifiable personal data (retained for bounded periods).

| Data field | While you are current keeper | After transfer / deactivation | On erasure request |
|---|---|---|---|
| Pseudonymous keeper identifier (e.g. "Keeper 3") | Retained | Retained indefinitely | Retained indefinitely (not personal data once anonymised) |
| Keeper period dates (from / to) | Retained | Retained indefinitely | Retained indefinitely |
| Event type (claim, transfer, freeze, deactivation) | Retained | Retained indefinitely | Retained indefinitely |
| Your public display name (if you opted in to show it) | Retained | Retained for 7 years from end of keeper period; then anonymised to "Former Keeper" | Anonymised on request |
| Your email address | Retained | Retained for 7 years from end of keeper period | Erased on request, subject to Art. 17(3) carve-outs |
| Your postal address and phone | Retained | Retained for 6 years post-submission (HMRC/Companies Act) | Erased after 6 years, subject to carve-outs |
| Logbook Version, Certificate ID, grade data, Card images, slab photographs | Retained | Retained indefinitely | Retained — Certificate data, not keeper personal data; legitimate interest of integrity |

**5.6** Seven-year window justification. We retain identifiable keeper data for 7 years after the end of the keeper relationship because: (a) limitation periods under the Limitation Act 1980 for contract disputes are 6 years, and longer for specialty contracts (12 years); (b) fraud, theft, and stolen-property investigations can surface years after the event with high-value collectibles; (c) 7 years aligns closely with related financial-record retention; (d) defence of legal claims (UK GDPR Art. 17(3)(e)) is a recognised ground for continued retention.

After 7 years, identifiable keeper data is anonymised. The pseudonymous record (Keeper N, date range, event type) remains, so the integrity of the Certificate history is preserved, but the personal data is removed.

**5.7** Pseudonymous identifiers and the 7-year window. During the 7-year identifiable-retention window described in 5.5–5.6, pseudonymous keeper identifiers ("Keeper 3", date ranges) remain personal data under UK GDPR Recital 26 because MintVault retains the mapping between the pseudonymous identifier and the identifiable keeper data. After the 7-year window expires and the identifiable keeper data is anonymised (mapping destroyed), the remaining pseudonymous identifiers cease to be personal data and become anonymous statistical record entries.

**5.8** Security logs and usage data.

| Data category | Retention period | Basis |
|---|---|---|
| Audit logs (truncated IP, user ID, action timestamps) | 12 months | Legitimate interests |
| Server access logs | 12 months | Legitimate interests |
| Aggregate analytics (non-identifiable) | Indefinite | Not personal data once aggregated |

> **SOLICITOR REVIEW FLAG — Section 5:** Please confirm the tiered retention schedule satisfies UK GDPR Art. 5(1)(e); particular attention to (i) the 7-year retention window for identifiable keeper data — is 7 years appropriate or should it be 6 or 10; (ii) the explicit acknowledgement in 5.7 that pseudonymous identifiers remain personal data during the mapping window.

## 6. Your data protection rights

**6.1** Under UK GDPR and the Data Protection Act 2018, you have the following rights.

**6.2** Summary of rights.

- **Right of access** (Art. 15) — to obtain a copy of the personal data we hold about you.
- **Right to rectification** (Art. 16) — to correct inaccurate or incomplete data.
- **Right to erasure / "right to be forgotten"** (Art. 17) — to request deletion, subject to the carve-outs in section 6.4.
- **Right to restriction of processing** (Art. 18) — to limit how we use your data in certain circumstances.
- **Right to data portability** (Art. 20) — to receive data you provided in a structured, machine-readable format.
- **Right to object** (Art. 21) — particularly to processing based on legitimate interests.
- **Right to withdraw consent** (Art. 7) — for processing based on consent.
- **Rights relating to automated decision-making** (Art. 22) — see section 11.
- **Right to complain to the ICO** (Art. 77) — details in section 6.7.

**6.3** How to exercise your rights. Contact us at support@mintvaultuk.com with "PRIVACY RIGHTS REQUEST" in the subject line. We will: (a) acknowledge within 3 working days; (b) verify your identity before processing the request; (c) respond within 1 month (UK GDPR Art. 12(3)); we may extend by a further 2 months for complex requests; (d) provide responses free of charge in most cases.

**6.4** Right to erasure — specific carve-outs.

Where you exercise your right to erasure under Article 17, we will erase your personal data unless we are required or permitted to retain it under Article 17(3). Specifically:

- Your public display name, email address, and postal address associated with Certificates of which you have been a Registered Keeper will be anonymised on request, subject to a seven-year retention period from the end of your keeper relationship for the purposes of defending legal claims (Art. 17(3)(e)) and investigating fraud. After 7 years, anonymisation is automatic unless a live dispute or investigation requires continued retention.
- Identity verification documents processed under MLR 2017 must be retained for 5 years from the end of the business relationship (Art. 17(3)(b) — legal obligation) and cannot be erased during that period.
- Financial records must be retained for 6 years under the Companies Act 2006 and HMRC requirements (Art. 17(3)(b)) and cannot be erased during that period.
- Pseudonymous keeper records are retained indefinitely as part of the integrity of the grading record. As explained in section 5.7, these records remain personal data during the 7-year identifiable-retention window and become non-personal-data thereafter.
- Certificate and Logbook data (grades, Card images, slab photographs, QR/NFC records) are retained indefinitely as Certificate records, not keeper personal data.

In all cases where we rely on a carve-out to refuse erasure, we will explain our reasoning and your right to complain to the ICO.

**6.5** Right to object — specific to legitimate-interests processing.

- **To fraud prevention and security monitoring:** we will generally continue processing where our legitimate interests are overriding, explaining our reasoning.
- **To R&D and machine-learning use of Submission Materials:** you can opt out under Submission Agreement clause 20.3 without affecting your grading service.
- **To aggregated population-report use:** continued processing of anonymised data is not subject to objection because anonymised data is not personal data.
- **To direct marketing:** your right to object is absolute (Art. 21(2)–(3)); we will stop marketing processing on request.

**6.6** Right to withdraw consent. Withdraw by emailing support@mintvaultuk.com or using the unsubscribe link in any marketing email.

**6.7** Right to complain to the ICO.

- Website: ico.org.uk
- Phone: 0303 123 1113
- Address: Information Commissioner's Office, Wycliffe House, Water Lane, Wilmslow, Cheshire SK9 5AF

We encourage you to contact us first so we have the opportunity to address your concerns directly.

> **SOLICITOR REVIEW FLAG — Section 6:** Please confirm Art. 17(3) carve-outs are correctly framed, particularly the interaction between the 7-year identifiable-keeper retention and the indefinite pseudonymous retention.

## 7. International transfers

**7.1** Most of MintVault's processing takes place in the UK or EEA. Where personal data is transferred outside the UK, we rely on approved transfer mechanisms.

**7.2** Transfer mechanisms used.

- UK Adequacy Decisions where applicable.
- UK International Data Transfer Agreement (IDTA) for transfers to non-adequate countries.
- UK Addendum to the EU Standard Contractual Clauses (SCCs) where the processor has SCCs already in place.

**7.3** US-based processors. Where we transfer personal data to US-based processors (Stripe, Resend, Anthropic, OpenAI, potentially the identity-verification provider), we use the UK IDTA or UK Addendum to SCCs. We have conducted transfer risk assessments considering US surveillance laws (including FISA 702) and applied supplementary measures where appropriate.

**7.4** AI service providers. AI-assisted grading may involve sending image and metadata to Anthropic (US) or OpenAI (US). Based on the current commercial terms of these providers' APIs as at the effective date of this Privacy Policy:

- **Anthropic** — customer data submitted via the API is not used to train Anthropic's models.
- **OpenAI** — customer data submitted via the API (on Enterprise or default API terms) is not used to train OpenAI's models.

We rely on these contractual commitments as part of our transfer risk assessment. If the relevant provider terms change, we will update this Privacy Policy and (where the change materially affects you) notify you in accordance with section 12.

**7.5** Your rights. You can request details of the specific transfer mechanism used for any transfer of your personal data by contacting support@mintvaultuk.com.

> **SOLICITOR REVIEW FLAG — Section 7:** Please confirm IDTA / UK Addendum approach is current; confirm the framing of the AI provider no-training commitment as based on current terms with an update obligation if terms change.

## 8. Security

**8.1** We take reasonable technical and organisational measures to protect your personal data, including:

- Encryption in transit (HTTPS / TLS) and at rest (database and R2 storage encryption)
- Access controls (role-based access, multi-factor authentication for staff)
- Regular software patching and security updates
- Audit logging with truncated IP addresses (/24 for IPv4, /64 for IPv6)
- Password hashing and salting
- Physical security of cards in custody (locked storage, controlled access)
- Regular backups with encryption
- Incident response procedures

**8.2** Breach notification. In the event of a personal-data breach likely to result in a risk to your rights and freedoms, we will:

- Notify the ICO within 72 hours of becoming aware (UK GDPR Art. 33).
- Notify affected individuals without undue delay where the breach is likely to result in a high risk (UK GDPR Art. 34).

## 9. Cookies and similar technologies

**9.1** The Site uses cookies and similar technologies. We distinguish between:

- **Strictly necessary cookies** — required for the Site to function. Set without consent.
- **Functional cookies** — remembering preferences. Set with consent.
- **Analytics cookies** — understanding Site usage. Set with consent.
- **Marketing cookies** — currently none; will only be set with consent if introduced in future.

**9.2** You can manage cookie preferences through the cookie consent banner on the Site, and at any time through the cookie preferences link in the footer.

**9.3** Our cookie consent approach complies with the Privacy and Electronic Communications Regulations 2003 (PECR) regulation 6 — non-essential cookies are set only with your affirmative consent, and we provide an equally prominent "reject" option at first interaction.

**9.4** A detailed list of specific cookies in use, their purposes, and their retention periods is available in our separate Cookies Policy at mintvaultuk.com/cookies, or on request.

> **SOLICITOR REVIEW FLAG — Section 9:** Please confirm this summary-plus-separate-Cookies-Policy approach is adequate, or advise whether cookies should be fully addressed within this Privacy Policy.

## 10. Children

**10.1** MintVault's services are not directed at children under the age of 18. We do not knowingly collect personal data from children under 18. If you believe a child under 18 has provided us with personal data, please contact support@mintvaultuk.com and we will take steps to delete it.

**10.2** Where a parent or guardian wishes to submit Cards held in trust for a child, the contracting party is the parent or guardian in their own name.

## 11. Automated decision-making

**11.1** MintVault does not currently use solely automated decision-making with legal or similarly significant effects on individuals (UK GDPR Art. 22).

**11.2** AI-assisted grading includes automated image analysis as part of the grading process, but all grading outcomes are reviewed or confirmed by human graders before issuance. The human grader is the decision-maker; AI output is a tool supporting that decision. Our internal grading procedures require graders to assess AI output independently against MintVault's published grading standards rather than rubber-stamping the AI's recommendation.

**11.3** If we introduce solely automated decision-making in future, we will update this Policy and provide the information required under Article 22 and Article 13(2)(f).

> **SOLICITOR REVIEW FLAG — Section 11:** Please confirm human review of AI grading output is sufficient to avoid Art. 22, given ICO guidance on "meaningful" review. If graders accept AI output above a certain percentage without independent assessment, does Art. 22 apply regardless of the policy wording?

## 12. Changes to this Policy

**12.1** We may update this Privacy Policy from time to time.

**12.2** Material changes. Material changes that affect your rights will be notified to you by email at least 30 days before taking effect.

**12.3** Non-material changes. Non-material changes (clarifications, updates to processor lists, correction of typographical errors) take effect on publication.

**12.4** The current version is always available at mintvaultuk.com/privacy. Previous versions are available on request.

## 13. Contact and complaints

**13.1** Privacy queries. support@mintvaultuk.com with "PRIVACY" in the subject line.

**13.2** Rights requests. support@mintvaultuk.com with "PRIVACY RIGHTS REQUEST" in the subject line.

**13.3** Complaints. We handle privacy complaints through our standard support process.

**13.4** ICO. ico.org.uk, 0303 123 1113.

**13.5** Postal address:

MintVault Ltd
**[REGISTERED OFFICE]**
Company number: **[COMPANY NUMBER]**
