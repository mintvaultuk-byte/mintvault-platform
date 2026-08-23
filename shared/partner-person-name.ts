/**
 * THE one rule for turning a Partner user's stored name into something to address them by.
 *
 * There is exactly one of these because an invitation email, a resend of that same invitation and
 * any future notice must not disagree about what a person is called. It never invents a name and
 * never returns an empty string: an email that opens "Hello ," is worse than one that opens with
 * the address the invitation was sent to.
 */
export function partnerDisplayName(person: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}): string {
  const full = [person.firstName, person.lastName]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join(" ");
  if (full) return full;
  // No stored name. The local part of the address is the only honest fallback we hold.
  const email = (person.email ?? "").trim();
  const local = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
  return local || "there";
}
