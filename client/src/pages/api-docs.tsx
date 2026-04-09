import SeoHead from "@/components/seo-head";

const EXAMPLE_RESPONSE = JSON.stringify(
  {
    verified: true,
    certId: "MV42",
    status: "active",
    cardGame: "Pokemon",
    cardName: "Charizard",
    cardSet: "Base Set Unlimited",
    cardYear: "1999",
    cardNumber: "4/102",
    language: "English",
    grade: "9 — Mint",
    gradeNumeric: 9,
    gradedDate: "2026-03-14",
    ownershipStatus: "claimed",
    verifyUrl: "https://mintvaultuk.com/cert/MV42",
  },
  null,
  2
);

const ERROR_RESPONSE = JSON.stringify({ verified: false, error: "Certificate not found" }, null, 2);

export default function ApiDocsPage() {
  return (
    <>
      <SeoHead
        title="Public Verification API | MintVault UK"
        description="Use the MintVault public API to verify the authenticity of any graded certificate by cert ID. Free, no auth required, 100 req/min."
        canonical="https://mintvaultuk.com/api-docs"
      />
      <div className="max-w-3xl mx-auto px-4 py-12">

        {/* Page header */}
        <div className="mb-10">
          <p className="text-[#D4AF37] text-xs uppercase tracking-widest font-bold mb-2">Developer Reference</p>
          <h1 className="text-3xl font-bold text-[#1A1A1A] mb-3">Public Verification API</h1>
          <p className="text-[#666666] text-sm leading-relaxed">
            Instantly verify any MintVault certificate from your own application, eBay listing, Discord bot, or marketplace integration.
            No API key required. Completely free.
          </p>
        </div>

        {/* Quick facts */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-10">
          {[
            { label: "Auth required", value: "None" },
            { label: "Rate limit", value: "100 / min" },
            { label: "Response format", value: "JSON" },
            { label: "CORS", value: "Open (*)" },
          ].map((f) => (
            <div key={f.label} className="border border-[#D4AF37]/20 rounded-lg p-3 bg-[#D4AF37]/5 text-center">
              <p className="text-[#D4AF37] text-xs uppercase tracking-widest mb-1">{f.label}</p>
              <p className="text-[#1A1A1A] font-bold text-sm">{f.value}</p>
            </div>
          ))}
        </div>

        {/* Endpoint */}
        <Section title="Endpoint">
          <div className="flex items-center gap-3 mb-4">
            <span className="bg-emerald-50 text-emerald-700 font-bold text-xs px-2 py-1 rounded border border-emerald-300">GET</span>
            <code className="text-[#D4AF37] font-mono text-sm">https://mintvaultuk.com/api/v1/verify/:certId</code>
          </div>
          <p className="text-[#666666] text-sm">
            Replace <code className="text-[#D4AF37] font-mono">:certId</code> with any valid MintVault cert ID, e.g.{" "}
            <code className="text-[#D4AF37] font-mono">MV42</code> or <code className="text-[#D4AF37] font-mono">MV-0000000042</code>.
            Both formats are accepted.
          </p>
        </Section>

        {/* Example request */}
        <Section title="Example Request">
          <CodeBlock>{`curl https://mintvaultuk.com/api/v1/verify/MV42`}</CodeBlock>
        </Section>

        {/* Success response */}
        <Section title="Success Response — 200 OK">
          <CodeBlock>{EXAMPLE_RESPONSE}</CodeBlock>
        </Section>

        {/* Field reference */}
        <Section title="Response Fields">
          <div className="border border-[#D4AF37]/15 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#D4AF37]/15 bg-[#D4AF37]/5">
                  <th className="text-left px-4 py-2.5 text-[#D4AF37] text-xs uppercase tracking-wider font-bold">Field</th>
                  <th className="text-left px-4 py-2.5 text-[#D4AF37] text-xs uppercase tracking-wider font-bold">Type</th>
                  <th className="text-left px-4 py-2.5 text-[#D4AF37] text-xs uppercase tracking-wider font-bold">Description</th>
                </tr>
              </thead>
              <tbody>
                {FIELDS.map((f, i) => (
                  <tr key={f.name} className={`border-b border-[#E8E4DC] last:border-0 ${i % 2 === 0 ? "" : "bg-[#FAFAF8]"}`}>
                    <td className="px-4 py-2.5 font-mono text-[#D4AF37] text-xs whitespace-nowrap">{f.name}</td>
                    <td className="px-4 py-2.5 text-[#999999] text-xs whitespace-nowrap">{f.type}</td>
                    <td className="px-4 py-2.5 text-[#444444] text-xs">{f.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>

        {/* Error responses */}
        <Section title="Error Responses">
          <div className="space-y-4">
            <div>
              <p className="text-xs text-[#999999] mb-2">404 — Certificate not found</p>
              <CodeBlock>{ERROR_RESPONSE}</CodeBlock>
            </div>
            <div>
              <p className="text-xs text-[#999999] mb-2">429 — Rate limit exceeded</p>
              <CodeBlock>{JSON.stringify({ error: "Too many requests. Limit: 100 per minute per IP." }, null, 2)}</CodeBlock>
            </div>
          </div>
        </Section>

        {/* Use cases */}
        <Section title="Use Cases">
          <ul className="space-y-3 text-sm text-[#666666]">
            {[
              { title: "eBay & marketplace listings", body: "Show a verified badge alongside your listing by fetching grade and card details at runtime." },
              { title: "Discord bots", body: "Let your community verify slabs instantly with a bot command — no manual lookup needed." },
              { title: "Card portfolio trackers", body: "Pull live grade data into your own collection management tools." },
              { title: "Physical NFC integration", body: "NFC tags on MintVault slabs already redirect to the certificate page. Use the API to build your own reader app." },
            ].map((u) => (
              <li key={u.title} className="border border-[#E8E4DC] rounded-lg p-4 bg-[#FAFAF8]">
                <p className="text-[#1A1A1A] font-semibold mb-1">{u.title}</p>
                <p>{u.body}</p>
              </li>
            ))}
          </ul>
        </Section>

        {/* Code snippets */}
        <Section title="Code Examples">
          <div className="space-y-6">
            <div>
              <p className="text-xs text-[#999999] uppercase tracking-wider mb-2">JavaScript / Fetch</p>
              <CodeBlock>{JS_EXAMPLE}</CodeBlock>
            </div>
            <div>
              <p className="text-xs text-[#999999] uppercase tracking-wider mb-2">Python</p>
              <CodeBlock>{PYTHON_EXAMPLE}</CodeBlock>
            </div>
          </div>
        </Section>

        {/* Fair use */}
        <div className="border border-[#E8E4DC] rounded-lg p-5 bg-[#FFF9E6] text-sm text-[#666666]">
          <p className="text-[#D4AF37] font-semibold mb-2">Fair Use</p>
          <p>
            This API is free and requires no registration. We ask that you cache responses where possible and stay within the 100 request/minute limit.
            Automated bulk scraping of the full certificate database is not permitted.
            If you need higher limits or a dedicated integration, contact us at{" "}
            <span className="text-[#D4AF37]">mintvaultuk@gmail.com</span>.
          </p>
        </div>
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-10">
      <h2 className="text-lg font-bold text-[#1A1A1A] mb-4 border-b border-[#E8E4DC] pb-2">{title}</h2>
      {children}
    </div>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="bg-[#FAFAF8] border border-[#E8E4DC] rounded-lg p-4 text-xs font-mono text-[#444444] overflow-x-auto whitespace-pre">
      {children}
    </pre>
  );
}

const FIELDS = [
  { name: "verified", type: "boolean", desc: "Always true on a successful response." },
  { name: "certId", type: "string", desc: "Normalised certificate ID, e.g. MV42." },
  { name: "status", type: "string", desc: "active, suspended, or voided." },
  { name: "cardGame", type: "string | null", desc: "Trading card game, e.g. Pokemon, Magic: The Gathering." },
  { name: "cardName", type: "string | null", desc: "Name of the card." },
  { name: "cardSet", type: "string | null", desc: "Set or expansion the card belongs to." },
  { name: "cardYear", type: "string | null", desc: "Year of print." },
  { name: "cardNumber", type: "string | null", desc: "Card number within the set." },
  { name: "language", type: "string | null", desc: "Language of the card." },
  { name: "grade", type: "string", desc: "Human-readable grade label, e.g. 9 — Mint." },
  { name: "gradeNumeric", type: "number | null", desc: "Numeric grade (1–10) or null for non-numeric grades (NO, AA)." },
  { name: "gradedDate", type: "string | null", desc: "ISO 8601 date the cert was issued, e.g. 2026-03-14." },
  { name: "ownershipStatus", type: "string", desc: "unclaimed or claimed. No personal ownership data is exposed." },
  { name: "verifyUrl", type: "string", desc: "Direct link to the certificate page on mintvaultuk.com." },
];

const JS_EXAMPLE = `const res = await fetch("https://mintvaultuk.com/api/v1/verify/MV42");
const cert = await res.json();

if (cert.verified) {
  console.log(\`\${cert.cardName} — Grade: \${cert.grade}\`);
  // "Charizard — Grade: 9 — Mint"
} else {
  console.log("Certificate not found");
}`;

const PYTHON_EXAMPLE = `import requests

r = requests.get("https://mintvaultuk.com/api/v1/verify/MV42")
data = r.json()

if data.get("verified"):
    print(f"{data['cardName']} — Grade: {data['grade']}")
    # "Charizard — Grade: 9 — Mint"
else:
    print("Certificate not found")`;
