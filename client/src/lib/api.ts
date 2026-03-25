import type { CardMaster } from "@shared/schema";

export interface AutofillResult {
  match: CardMaster | null;
  matchType: "exact" | "fallback_language" | "none";
  setName: string | null;
  suggestions?: CardMaster[];
}

export async function autofillCard({
  setId,
  cardNumber,
  language,
  allowFallbackLanguage = false,
}: {
  setId: string;
  cardNumber: string;
  language: string;
  allowFallbackLanguage?: boolean;
}): Promise<AutofillResult> {
  const params = new URLSearchParams({
    setId: setId.trim(),
    number: cardNumber.trim(),
    language: language.trim(),
  });
  if (allowFallbackLanguage) {
    params.set("allowFallbackLanguage", "1");
  }
  const res = await fetch(`/api/cards/autofill?${params}`, {
    credentials: "include",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Autofill request failed");
  }
  return res.json();
}
