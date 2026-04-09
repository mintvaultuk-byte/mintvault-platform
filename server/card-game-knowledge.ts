/**
 * MintVault Card Game Knowledge Modules
 * Appended to the grading prompt based on detected/selected card game.
 */

export const CARD_GAME_MODULES: Record<string, string> = {
  pokemon: `
POKÉMON-SPECIFIC GRADING NOTES:
- Rounded corners are by design. Grade the consistency and sharpness of the rounded cut, not squareness.
- Blue paint on card backs is extremely fragile. Whitening dots on back corners and edges are the most common flaw.
- A SINGLE white dot on a back corner typically caps the card at 9.0 for corners.
- Whitening on top/bottom corners is more impactful than left/right edges because the slab cannot mask corner whitening.
- Evolving Skies set: known for excessive print lines on holo rares — these are still defects even though they are common in this set.
- Japanese cards: different card stock, slightly different surface texture and finish. This is normal manufacturing variation, NOT a defect. Japanese cards often have tighter centering.
- Reverse holo cards: the holo pattern covers the entire front surface. Check the ENTIRE front for scratching, not just the artwork area.
- Full art / VMAX / VSTAR / Alt Art cards: textured surfaces. Surface defects are harder to spot on textured cards — examine very carefully in greyscale.
- Base Set 1st Edition and Unlimited (1999): expect age-appropriate card stock. Slight yellowing of white borders may be acceptable for high grades on vintage cards. Check for "shadowless" variants.
- Modern cards (2020+): held to stricter standards due to improved printing quality and newer card stock.
- Special Illustration Rare (SIR) and Illustration Rare (IR): full-art with unique textures. These are high-value cards — grade with extra care.
- Trainer Gallery cards: unique subset with different art styles.
`,

  yugioh: `
YU-GI-OH SPECIFIC GRADING NOTES:
- Cards have sharper, more squared corners than Pokémon. Evaluate corner sharpness against the square-cut standard.
- Brown/tan card backs show whitening differently than Pokémon blue backs — look for lighter spots at edges and corners.
- Ultra Rare and Secret Rare cards have foil patterns that show scratches very easily — examine greyscale carefully.
- 1st Edition cards from early sets (LOB, MRD, PSV, etc.) have different card stock and printing quality. Grade relative to era standards.
- Starlight Rares have intentional textured surfaces — do NOT mistake texture for surface damage.
- Gold Rare cards have metallic surfaces that scratch easily.
- Card backs should show the consistent brown/tan swirl pattern. Any colour variation or staining is a defect.
- Be aware of "miscuts" which are factory errors affecting centering significantly.
`,

  mtg: `
MAGIC: THE GATHERING SPECIFIC GRADING NOTES:
- Rounded corners. Black-bordered cards show whitening much more prominently than white-bordered cards.
- Foil cards are prone to curling and warping — a slight curve is very common but IS a condition flaw.
- Alpha (1993): cards have more rounded corners than later sets. Different cutting standard — grade Alpha corners relative to Alpha standards.
- Beta (1993): slightly different corner rounding than Alpha. Still vintage standards apply.
- Older cards (pre-1995): may show age-related yellowing of borders. Minor yellowing is expected and may be acceptable for high grades.
- Modern foils and etched foils have different surface textures — learn each type.
- Double-faced cards (DFCs): BOTH faces are effectively front surfaces and should be graded as such.
- Extended art and borderless cards: centering assessment uses the artwork edges relative to the card edges.
- Collector Boosters and Set Boosters may have different card stock than Draft Boosters within the same set.
`,

  onepiece: `
ONE PIECE CARD GAME SPECIFIC GRADING NOTES:
- Relatively new card game (2022+). Cards should generally be in excellent condition given their age.
- Leader cards and Special Art (SA) cards have unique textures and finishes.
- Card backs are uniform across all cards — check for print consistency and colour accuracy.
- Manga Rare cards have distinctive art styles — do not confuse stylistic choices with printing defects.
- The card stock is generally high quality but can show edge whitening similar to Pokémon.
`,

  sports: `
SPORTS CARD SPECIFIC GRADING NOTES:
- Chrome and Prizm cards: extremely susceptible to surface scratching. These MUST be checked thoroughly in greyscale. Even factory-fresh chrome cards often have micro-scratches.
- Vintage cards (pre-1980): grade relative to era manufacturing standards. Expect rougher cuts, less consistent centering, and different card stock.
- Thick cards (jersey/patch relics, memorabilia cards): may have different flex characteristics and thickness variations. Grade the card portions normally.
- Autograph cards: the signature quality is NOT graded — only the card's physical condition matters.
- Refractor and parallel cards: different surface finishes that show defects differently.
- Rookie cards (RC): no different grading standard, but note that these are typically higher value and warrant extra care in analysis.
- Panini, Topps, Upper Deck each have slightly different card stock and printing quality.
`
};
