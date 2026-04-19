export interface Guide {
  slug: string;
  title: string;
  excerpt: string;
  publishedDate: string;
  updatedDate?: string;
  author: string;
  metaTitle: string;
  metaDescription: string;
  body: string;
}

export const guides: Guide[] = [
  {
    slug: "how-to-grade-pokemon-cards-uk",
    title: "How to Grade Pokémon Cards in the UK",
    excerpt: "A complete step-by-step guide to getting your Pokémon cards professionally graded in the UK, from preparation to receiving your slabbed card.",
    publishedDate: "2025-01-10",
    author: "MintVault UK",
    metaTitle: "How to Grade Pokémon Cards in the UK | MintVault UK",
    metaDescription: "Learn how to grade Pokémon cards in the UK step by step. From choosing a grading company to submitting your cards and understanding your grade.",
    body: `
<h2>What Is Card Grading?</h2>
<p>Card grading is the process of having a professional third party assess the condition of your trading card and seal it in a tamper-evident plastic case (known as a slab) with a grade label. The grade reflects the card's condition on a scale of 1 to 10.</p>

<h2>Why Grade Your Pokémon Cards?</h2>
<p>Graded cards command significantly higher prices on the secondary market. A PSA 10 or GEM MT 10 Pokémon card can sell for many multiples of its raw (ungraded) value. Grading also protects your card permanently and provides authentication.</p>

<h2>Step 1: Choose the Right Cards to Grade</h2>
<p>Not every card is worth grading. Focus on cards that are valuable in raw condition — first editions, holofoils, rare promotional cards, and modern chase cards. A card worth £5 raw is unlikely to justify a grading fee.</p>

<h2>Step 2: Inspect Your Cards</h2>
<p>Before submitting, inspect each card carefully under good lighting. Look for whitening on edges and corners, scratches on the surface, print defects, and centering issues. Cards with visible damage are unlikely to score above 7.</p>

<h2>Step 3: Choose a Grading Service</h2>
<p>In the UK, you can use MintVault UK for fast, affordable grading without the delays and import costs associated with US-based graders like PSA or BGS. MintVault offers five service tiers with turnaround times from 2 to 60 working days.</p>

<h2>Step 4: Submit Online</h2>
<p>Visit the MintVault UK submission page, select your service tier, add your cards, and pay securely via Stripe. You will receive a confirmation email with packing instructions.</p>

<h2>Step 5: Pack and Post Your Cards</h2>
<p>Place each card in a penny sleeve, then a top loader or card saver. Wrap in bubble wrap and ship in a rigid box. Use a tracked and insured postal service — Royal Mail Special Delivery is recommended for high-value cards.</p>

<h2>Step 6: Track Your Submission</h2>
<p>Use your submission ID and email address to track your order on the MintVault website. You will receive email updates at each stage: received, in grading, and shipped.</p>

<h2>Step 7: Receive Your Graded Card</h2>
<p>Your card will be returned in a MintVault slab with a printed label showing the card name, set, grade, and subgrades. A QR code on the label links to the public certificate page.</p>
    `,
  },
  {
    slug: "what-pokemon-cards-are-worth-grading",
    title: "What Pokémon Cards Are Worth Grading?",
    excerpt: "Not every card deserves a slab. Learn which Pokémon cards are worth the cost of professional grading and which to leave raw.",
    publishedDate: "2025-01-15",
    author: "MintVault UK",
    metaTitle: "What Pokémon Cards Are Worth Grading? | MintVault UK",
    metaDescription: "Discover which Pokémon cards are worth grading professionally. Find out which sets, rarities, and conditions make grading financially worthwhile.",
    body: `
<h2>The Golden Rule: Value vs. Cost</h2>
<p>The basic rule of thumb is simple: if a card in gem mint condition is worth at least 3–5x the grading fee, it is worth grading. If the raw value is close to or below the grading fee, it almost certainly is not.</p>

<h2>Vintage Cards Worth Grading</h2>
<p>Base Set, Jungle, Fossil, and Team Rocket cards — especially holofoils and first editions — are consistently worth grading. A Base Set Charizard in near-mint condition could be worth thousands as a GEM MT 10.</p>

<h2>Modern Cards Worth Grading</h2>
<p>Modern Pokémon TCG has produced many high-value chase cards. Alternate art full arts, secret rares, and special illustration rares from sets like Crown Zenith, Obsidian Flames, and Paradox Rift can be worth grading if pulled in excellent condition.</p>

<h2>Promotional Cards</h2>
<p>Tournament promos, prerelease cards, and limited distribution promos often have low populations in high grades, making them excellent candidates for grading.</p>

<h2>Cards NOT Worth Grading</h2>
<p>Common and uncommon cards from modern sets are generally not worth grading unless they have a specific niche following. Heavily played or damaged cards should not be graded — they will receive low grades and will not recoup the grading fee.</p>

<h2>How to Estimate Potential Value</h2>
<p>Check recent eBay sold listings for graded versions of the card you are considering. Search for the card name plus "PSA 10" or "GEM MT" to see what graded copies are selling for. Compare this to the raw price and the grading fee to decide if it makes sense.</p>

<h2>Bulk Submissions</h2>
<p>If you have a large collection to grade, bulk discounts can make marginal cards more viable. MintVault UK offers discounts of up to 10% for submissions of 100 or more cards.</p>
    `,
  },
  {
    slug: "psa-vs-uk-card-grading-companies",
    title: "PSA vs UK Card Grading Companies: Which Should You Choose?",
    excerpt: "Comparing PSA, BGS, and UK-based graders like MintVault. Turnaround times, costs, recognition, and which is right for your collection.",
    publishedDate: "2025-01-20",
    author: "MintVault UK",
    metaTitle: "PSA vs UK Card Grading Companies | MintVault UK",
    metaDescription: "Compare PSA, Beckett, and UK card grading companies. Understand the differences in cost, turnaround, and resale value to make the right choice.",
    body: `
<h2>The Main Grading Companies</h2>
<p>The most well-known grading companies are PSA (Professional Sports Authenticator) and BGS (Beckett Grading Services), both based in the United States. In the UK, MintVault UK offers a fully domestic alternative.</p>

<h2>Cost Comparison</h2>
<p>PSA and BGS charge in USD and require you to factor in international shipping, import duties, and VAT. The total landed cost for a basic PSA submission can easily reach £30–£50 per card by the time your cards return to the UK. MintVault UK charges from £19 per card with no import costs.</p>

<h2>Turnaround Times</h2>
<p>PSA economy submissions currently run 6–12 months or more. MintVault UK offers turnarounds from 5 working days on the Express tier up to 40 working days on the Vault Queue tier.</p>

<h2>Market Recognition</h2>
<p>PSA and BGS graded cards carry significant brand recognition on platforms like eBay and TCGPlayer. MintVault graded cards are growing in recognition within the UK market and command strong premiums domestically.</p>

<h2>When to Use PSA or BGS</h2>
<p>If you have a very high-value vintage card (e.g. a Base Set Charizard) that you intend to sell internationally, PSA or BGS grading may maximise resale value despite the higher cost and longer wait.</p>

<h2>When to Use MintVault UK</h2>
<p>For modern cards, mid-range vintage, and any card where speed and cost matter, MintVault UK is the clear choice. Domestic turnaround, transparent pricing, and no import headaches make it ideal for UK collectors.</p>
    `,
  },
  {
    slug: "is-card-grading-worth-it-uk",
    title: "Is Card Grading Worth It in the UK?",
    excerpt: "An honest look at whether professional card grading is financially worthwhile for UK collectors, with real examples and a break-even analysis.",
    publishedDate: "2025-01-25",
    author: "MintVault UK",
    metaTitle: "Is Card Grading Worth It in the UK? | MintVault UK",
    metaDescription: "Is card grading worth the cost for UK collectors? We break down the numbers, look at real examples, and help you decide when grading makes financial sense.",
    body: `
<h2>The Short Answer</h2>
<p>For the right cards, yes — grading can significantly increase value and long-term protection. For the wrong cards, it is an unnecessary expense. The key is knowing which category your cards fall into.</p>

<h2>The Break-Even Calculation</h2>
<p>Take the grading fee (e.g. £19 on MintVault's Vault Queue tier). Your card needs to be worth at least £19 more after grading just to break even. In practice, gem mint grades can add 50–200% or more to a card's value.</p>

<h2>Real Examples</h2>
<p>A Charizard VMAX Alternate Art from Darkness Ablaze sells raw in near-mint condition for around £80. The same card graded GEM MT 10 regularly sells for £200–£300. After a £25 grading fee, the profit is clear.</p>

<h2>Cards Where Grading Pays Off</h2>
<p>High-demand chase cards, vintage holofoils, and limited promos consistently see large grading premiums. If you pulled a card worth £50+ raw and it is in excellent condition, grading is almost always worthwhile.</p>

<h2>The Non-Financial Benefits</h2>
<p>Beyond money, grading protects your card permanently from handling damage, UV degradation, and humidity. A graded card is also authenticated — important if you ever sell to a buyer who cannot inspect it in person.</p>

<h2>Verdict</h2>
<p>Card grading in the UK is absolutely worth it for valuable cards in excellent condition. With domestic graders like MintVault UK keeping costs low and turnaround times fast, the barriers that previously made grading impractical for UK collectors have been removed.</p>
    `,
  },
  {
    slug: "how-card-condition-affects-value",
    title: "How Card Condition Affects Value",
    excerpt: "Understanding the relationship between a card's physical condition and its market value, and why condition matters so much for graded cards.",
    publishedDate: "2025-02-01",
    author: "MintVault UK",
    metaTitle: "How Card Condition Affects Value | MintVault UK",
    metaDescription: "Learn how the condition of your trading card directly impacts its value. Understand grading scales and why gem mint cards command the highest premiums.",
    body: `
<h2>The Condition Premium</h2>
<p>In the trading card market, condition is everything. The difference in value between a card graded 9 (MINT) and a card graded 10 (GEM MT) can be 2–5x or more, even though they look nearly identical to the untrained eye.</p>

<h2>The Grading Scale</h2>
<p>MintVault UK grades cards on a 1–10 scale: PR (1), GOOD (2), VG (3), VG-EX (4), EX (5), EX-MT (6), NM (7), NM-MT (8), MINT (9), GEM MT (10). Each point on the scale represents meaningful differences in condition.</p>

<h2>The Four Subgrades</h2>
<p>Cards are assessed across four areas: Centering, Corners, Edges, and Surface. Each is graded independently, and the overall grade reflects performance across all four categories.</p>

<h2>Centering</h2>
<p>Centering refers to how evenly the printed image is positioned within the card border. A 10 requires near-perfect centering (typically 55/45 or better on both axes). Off-centre cards will be capped at lower grades regardless of other factors.</p>

<h2>Corners</h2>
<p>Corners are inspected for wear, fraying, and creasing. Even slight whitening on a corner can drop a card from a 10 to an 8 or 9. Corner wear is the most common reason cards miss gem mint.</p>

<h2>Edges</h2>
<p>Edge wear appears as small nicks, chips, or roughness along the card border. Like corners, minor edge wear has an outsized impact on grade.</p>

<h2>Surface</h2>
<p>Surface includes scratches on the card face, print defects, and any marks on the front or back. Print lines (small lines in the print pattern) are factory defects and can prevent a 10 grade.</p>

<h2>Why Gem Mint Commands a Premium</h2>
<p>GEM MT 10 is rare. On most modern sets, fewer than 50% of submitted cards achieve a 10 — for vintage cards it can be under 5%. Scarcity drives premiums, and collectors pay significantly more for the top grade.</p>
    `,
  },
  {
    slug: "pokemon-card-grading-costs-explained",
    title: "Pokémon Card Grading Costs Explained",
    excerpt: "A transparent breakdown of what card grading actually costs in the UK, including service fees, shipping, and insurance — with no hidden surprises.",
    publishedDate: "2025-02-05",
    author: "MintVault UK",
    metaTitle: "Pokémon Card Grading Costs Explained | MintVault UK",
    metaDescription: "Understand the full cost of grading Pokémon cards in the UK. Service fees, shipping, insurance, and bulk discounts explained clearly.",
    body: `
<h2>Service Tier Fees</h2>
<p>MintVault UK offers five grading tiers. Vault Queue tier (40 working days) starts at £19 per card. Standard is £25 (15 working days) and Express is £45 (5 working days). Choose based on how quickly you need your cards back and the value of the cards being graded.</p>

<h2>Bulk Discounts</h2>
<p>Submitting more cards reduces the per-card cost significantly. Discounts apply at 10 cards (3% off), 25 cards (5% off), 50 cards (7% off), and 100+ cards (10% off the service fee).</p>

<h2>Shipping to MintVault</h2>
<p>You pay for postage to send your cards to MintVault. We recommend Royal Mail Special Delivery for domestic submissions — typically £7–£10 depending on weight. Always use tracked and insured shipping.</p>

<h2>Return Shipping</h2>
<p>MintVault UK covers return shipping within the UK. Your slabbed cards are returned fully insured.</p>

<h2>Insurance Surcharge</h2>
<p>For high-value cards, a small insurance surcharge applies based on declared value per card: free for cards declared at £500 or less, £2 per card up to £1,500, £5 per card up to £3,000, and £10 per card up to £7,500.</p>

<h2>Total Cost Example</h2>
<p>Submitting 10 cards on the Vault Queue tier (£19/card) with a declared value under £500 each would cost: £19 × 10 = £190, minus 3% bulk discount = £184.30 in service fees, plus outbound shipping of ~£8. Total: approximately £192.</p>

<h2>Comparing to US Graders</h2>
<p>Sending 10 cards to PSA involves international tracked shipping (~£30), PSA fees (~$25/card = ~£200), return international shipping (~£30), and potential import duties (~20% VAT on fees). Total can exceed £300 — nearly twice the MintVault cost.</p>
    `,
  },
  {
    slug: "raw-vs-graded-pokemon-cards",
    title: "Raw vs Graded Pokémon Cards: What's the Difference?",
    excerpt: "Everything you need to know about raw and graded Pokémon cards — the differences in value, collectability, storage, and when to keep cards raw.",
    publishedDate: "2025-02-10",
    author: "MintVault UK",
    metaTitle: "Raw vs Graded Pokémon Cards | MintVault UK",
    metaDescription: "Raw vs graded Pokémon cards compared. Understand the value differences, storage benefits, and when it makes sense to grade or keep your cards raw.",
    body: `
<h2>What Is a Raw Card?</h2>
<p>A raw card is any ungraded trading card. It may be stored in a sleeve, top loader, or binder, but it has not been assessed or authenticated by a professional grading company.</p>

<h2>What Is a Graded Card?</h2>
<p>A graded card has been assessed by a professional company (like MintVault UK) and sealed in a tamper-evident plastic slab with a label showing the grade, card details, and a unique certificate number.</p>

<h2>Value Differences</h2>
<p>Graded cards — especially those receiving high grades — typically sell for significantly more than raw equivalents. The premium is largest for grades of 9 and 10, where condition is verified and guaranteed.</p>

<h2>Authentication</h2>
<p>Graded cards are authenticated as genuine. In a market where high-value fakes exist, a slab from a reputable grader gives buyers confidence. Raw cards cannot provide this assurance, especially in online sales.</p>

<h2>Protection</h2>
<p>Slabs protect cards from humidity, UV light, and handling damage permanently. Raw cards in sleeves or top loaders remain vulnerable to condition degradation over time.</p>

<h2>Liquidity</h2>
<p>Graded cards from well-known companies are easier to sell online because buyers trust the condition description. Raw card listings require detailed photos and description, and buyers factor in uncertainty when pricing.</p>

<h2>When to Keep Cards Raw</h2>
<p>Low-value cards, heavily played cards, and cards you intend to play with should stay raw. Grading is an investment — it only makes sense when the potential return justifies the cost.</p>
    `,
  },
  {
    slug: "how-to-send-cards-for-grading-safely",
    title: "How to Send Cards for Grading Safely",
    excerpt: "Step-by-step packing and shipping instructions to ensure your valuable cards arrive at the grading company in perfect condition.",
    publishedDate: "2025-02-15",
    author: "MintVault UK",
    metaTitle: "How to Send Cards for Grading Safely | MintVault UK",
    metaDescription: "Learn how to pack and ship trading cards safely for grading. Follow these steps to ensure your cards arrive undamaged and well-protected.",
    body: `
<h2>Why Packing Matters</h2>
<p>Cards damaged in transit cannot be graded for their true condition. Bent corners, surface scratches, or moisture damage caused during shipping directly affect your grade. Proper packing is essential.</p>

<h2>Step 1: Penny Sleeve</h2>
<p>Place each card in a soft penny sleeve first. This prevents surface scratches from the card making contact with harder materials.</p>

<h2>Step 2: Top Loader or Card Saver</h2>
<p>Slide the sleeved card into a rigid top loader (for cards up to standard size) or a semi-rigid card saver. Top loaders provide more rigidity; card savers are preferred by some graders as they are easier to remove cards from without damage.</p>

<h2>Step 3: Team Bag</h2>
<p>Place the top loader in a team bag and seal it. This prevents the top loader from sliding around and protects against moisture.</p>

<h2>Step 4: Bundle Multiple Cards</h2>
<p>If sending multiple cards, stack the top loaders together and wrap with rubber bands on the outside of the team bags. Do not let rubber bands touch the cards directly.</p>

<h2>Step 5: Bubble Wrap</h2>
<p>Wrap the card bundle in at least two layers of bubble wrap. The goal is to prevent any movement inside the outer box.</p>

<h2>Step 6: Rigid Box</h2>
<p>Place the bubble-wrapped bundle in a rigid cardboard box — not a padded envelope. Padded envelopes offer insufficient protection and can result in bent cards. Fill any remaining space with packing peanuts or additional bubble wrap.</p>

<h2>Step 7: Ship with Tracking and Insurance</h2>
<p>Always use a tracked and insured service. In the UK, Royal Mail Special Delivery is the gold standard — it is fully tracked, signed for, and insured up to £750 (or more with additional compensation). Never send valuable cards with standard post.</p>

<h2>Include Your Packing Slip</h2>
<p>Print and include the packing slip from your MintVault submission confirmation email. This identifies your submission and ensures your cards are matched to your order quickly upon arrival.</p>
    `,
  },
  {
    slug: "what-makes-a-card-gem-mint",
    title: "What Makes a Card Gem Mint?",
    excerpt: "Understanding the exacting standards required to achieve a GEM MT 10 grade — the highest possible score from a professional grading company.",
    publishedDate: "2025-02-20",
    author: "MintVault UK",
    metaTitle: "What Makes a Card Gem Mint 10? | MintVault UK",
    metaDescription: "Find out exactly what graders look for when awarding a Gem Mint 10 grade. Centering, corners, edges, and surface requirements explained in detail.",
    body: `
<h2>The GEM MT 10 Standard</h2>
<p>GEM MT (Gem Mint) 10 is the highest grade awarded by MintVault UK. It represents a card in virtually perfect condition — as close to factory fresh as possible. Only a small percentage of submitted cards achieve this grade.</p>

<h2>Centering Requirements</h2>
<p>For a 10, centering must be approximately 55/45 or better on both the front and back of the card. This means the printed area must be very close to perfectly centred within the border. Cards with obvious off-centering are immediately disqualified from a 10.</p>

<h2>Corner Requirements</h2>
<p>Corners must be sharp and free from any whitening, fraying, or creasing. Under magnification, corners should appear clean with no visible wear. Even one slightly soft corner can drop a card to a 9.</p>

<h2>Edge Requirements</h2>
<p>All four edges must be clean and free from nicks, chips, or roughness. The edge should feel smooth to the touch and appear clean under direct light.</p>

<h2>Surface Requirements</h2>
<p>The card surface — front and back — must be free from scratches, print lines, indentations, and staining. Holo surfaces are inspected particularly carefully as they show scratches more easily. Print defects from manufacturing can also prevent a 10.</p>

<h2>Why GEM MT Is Rare</h2>
<p>Most cards pick up minor imperfections during manufacturing, packing, distribution, and handling — even cards that have never been played. Achieving a 10 typically requires a card that was pulled and immediately protected without ever being touched on its surface.</p>

<h2>Improving Your Chances</h2>
<p>Handle cards by the edges only. Sleeve immediately on opening a pack. Store vertically in a rigid top loader. Avoid humidity and direct sunlight. The fewer times a card is handled, the better its chances of a 10.</p>
    `,
  },
  {
    slug: "best-pokemon-cards-worth-grading-this-year",
    title: "Best Pokémon Cards Worth Grading This Year",
    excerpt: "The top Pokémon cards that collectors and investors are sending for grading right now, based on current market trends and population data.",
    publishedDate: "2025-03-01",
    author: "MintVault UK",
    metaTitle: "Best Pokémon Cards Worth Grading This Year | MintVault UK",
    metaDescription: "Discover the best Pokémon cards to get graded right now. Based on current market demand, low pop counts, and strong grading premiums in the UK.",
    body: `
<h2>How We Pick These Cards</h2>
<p>The best cards to grade share three characteristics: strong raw value (£30+), significant grading premium (2x or more for a 10), and realistic chances of achieving a high grade from a pack-fresh copy.</p>

<h2>Modern Chases Worth Grading</h2>
<p>Special Illustration Rares and Hyper Rares from recent sets consistently attract grading premiums. Cards like Charizard ex Special Illustration Rare (Obsidian Flames), Pikachu ex Special Illustration Rare, and the Gardevoir ex from Scarlet & Violet have strong secondary market demand in graded form.</p>

<h2>Vintage Cards Always Worth Grading</h2>
<p>Base Set holofoils — Charizard, Blastoise, Venusaur, Chansey, Nidoking — remain the blue chips of Pokémon grading. Even mid-grade copies (7–8) of the Charizard command four-figure sums. If you have clean copies of these, grade them.</p>

<h2>First Edition Jungle and Fossil</h2>
<p>First Edition stamps on Jungle and Fossil set holofoils add significant value, particularly on Scyther, Clefable, Vaporeon, Gengar, and Lapras. Population counts for 10s on many of these are extremely low.</p>

<h2>Promotional Cards</html>
<p>Tournament promos, Staff promos, and regional distribution promos often have very low pop counts in any grade. The Tropical Wind promos and various regional championship cards are excellent grading candidates.</p>

<h2>Tracking the Market</h2>
<p>Use eBay sold listings to track what graded versions of specific cards are fetching right now. Markets move — cards that commanded huge premiums a year ago may have softened, while new sets create new opportunities.</p>
    `,
  },
  {
    slug: "uk-guide-to-trading-card-grading",
    title: "UK Guide to Trading Card Grading",
    excerpt: "The definitive UK collector's guide to professional trading card grading — covering all TCGs, the grading process, and choosing the right service.",
    publishedDate: "2025-03-05",
    author: "MintVault UK",
    metaTitle: "UK Guide to Trading Card Grading | MintVault UK",
    metaDescription: "The complete UK guide to professional trading card grading for Pokémon, Yu-Gi-Oh, Magic: The Gathering, and other TCGs. Everything you need to know.",
    body: `
<h2>Trading Card Grading in the UK</h2>
<p>The UK trading card market has grown enormously over the past decade, and professional grading has become an important part of collecting culture. This guide covers everything UK collectors need to know about getting cards graded.</p>

<h2>Which Games Can Be Graded?</h2>
<p>MintVault UK grades cards from all major trading card games, including Pokémon TCG, Yu-Gi-Oh!, Magic: The Gathering, Dragon Ball Super Card Game, One Piece Card Game, and Lorcana. Vintage sports cards are also accepted.</p>

<h2>The UK Grading Advantage</h2>
<p>Until recently, UK collectors had to send cards to US-based graders — incurring international shipping costs, long waits, and import duties on their return. UK-based graders like MintVault eliminate these barriers entirely.</p>

<h2>Understanding the Grade</h2>
<p>Cards are graded on a 1–10 scale, with 10 being gem mint. The four criteria assessed are centering, corners, edges, and surface. Each contributes to the overall grade, and a weakness in any one area will cap the total.</p>

<h2>Choosing a Service Tier</h2>
<p>Select your tier based on the value of your cards and how quickly you need them back. Higher-value cards that you want to sell quickly benefit from faster tiers despite the higher cost. Bulk submissions of lower-value cards are best suited to standard or economy tiers.</p>

<h2>The Resale Market</h2>
<p>eBay is the primary marketplace for graded cards in the UK. Graded listings with clear slab photos typically attract more bids and higher final prices than raw listings. Facebook Marketplace, Vinted, and specialist card shops also trade graded cards.</p>

<h2>Building a Graded Collection</h2>
<p>Many collectors build graded sets — attempting to obtain a high-grade copy of every card in a particular set. Registry sets (tracked on grading company websites) add a competitive element. High-grade registered sets can command significant premiums.</p>
    `,
  },
  {
    slug: "how-to-protect-pokemon-cards-before-grading",
    title: "How to Protect Pokémon Cards Before Grading",
    excerpt: "The right storage and handling practices to preserve your cards in peak condition before you send them for professional grading.",
    publishedDate: "2025-03-10",
    author: "MintVault UK",
    metaTitle: "How to Protect Pokémon Cards Before Grading | MintVault UK",
    metaDescription: "Learn the best ways to store and protect Pokémon cards before grading. Proper sleeves, top loaders, and storage conditions to maintain gem mint condition.",
    body: `
<h2>Why Pre-Grading Protection Matters</h2>
<p>A card can only be graded for its condition at the time of submission. Damage that occurs between pulling a card from a pack and sending it for grading permanently affects the grade. Good storage habits protect your investment.</p>

<h2>Sleeve Immediately</h2>
<p>The moment you pull a card worth grading, place it in a penny sleeve. Handle the card by its edges only, never touching the surface. Surface oils from fingerprints can leave permanent marks on holo finishes.</p>

<h2>Top Loaders and Card Savers</h2>
<p>After sleeving, place the card in a rigid top loader or semi-rigid card saver. This prevents bending and provides protection from impacts. Store top loaders upright — storing them flat with weight on top can cause subtle warping over time.</p>

<h2>Avoid Humidity</h2>
<p>High humidity causes cards to warp and can promote mould growth on the card surface. Store cards in a dry environment — ideally at 40–50% relative humidity. Silica gel packets in storage boxes help control moisture levels.</p>

<h2>Avoid UV Light</h2>
<p>Direct sunlight and UV light fade card colours and damage holo finishes over time. Store cards away from windows and direct light. UV-filtering sleeves and display cases are available for cards you want to display.</p>

<h2>Temperature Stability</h2>
<p>Avoid storing cards in environments with large temperature swings — garages, attics, and cars are poor choices. A stable room-temperature environment is ideal. Extreme heat can cause cards to warp permanently.</p>

<h2>Do Not Rubber-Band Cards</h2>
<p>Rubber bands leave indentations on card edges and borders. Never bind cards together directly with rubber bands. If bundling top loaders, wrap the rubber band around the outside only.</p>

<h2>Regular Inspection</h2>
<p>Periodically inspect stored cards for any signs of moisture, warping, or damage. Catching issues early — before they worsen — can save a grade.</p>
    `,
  },
  {
    slug: "why-graded-cards-sell-for-more",
    title: "Why Graded Cards Sell for More",
    excerpt: "The psychology and economics behind why professionally graded trading cards consistently achieve higher prices than their raw equivalents.",
    publishedDate: "2025-03-12",
    author: "MintVault UK",
    metaTitle: "Why Graded Cards Sell for More | MintVault UK",
    metaDescription: "Understand why graded trading cards command higher prices than raw cards. Trust, authentication, condition certainty, and collectability explained.",
    body: `
<h2>Trust and Authentication</h2>
<p>When a buyer purchases a raw card online, they must trust the seller's description and photos. A graded card from a reputable company removes this uncertainty entirely — the condition is independently verified and guaranteed. Buyers pay a premium for certainty.</p>

<h2>Condition Certainty</h2>
<p>Condition descriptions on raw cards ("near mint", "excellent") are subjective. A grade of 9 or 10 has a precise, universally understood meaning. Buyers know exactly what they are getting, which reduces the discount they demand for uncertainty.</p>

<h2>The Scarcity Premium</h2>
<p>High grades are genuinely rare. On many cards, fewer than 10% of submissions achieve a GEM MT 10. This documented scarcity — visible in population reports — creates real collector demand that drives prices above the raw equivalent.</p>

<h2>Long-Term Protection</h2>
<p>A slabbed card cannot be damaged by handling. Buyers know that a GEM MT 10 they purchase today will still be a GEM MT 10 in 10 years. The permanence of the grade adds to its value.</p>

<h2>Market Liquidity</h2>
<p>Graded cards are easier to sell quickly. Standardised grades make comparison shopping easy, and collectors searching specifically for high-grade copies come ready to pay market rates. Raw cards require more negotiation.</p>

<h2>Registry and Completionist Appeal</h2>
<p>Many serious collectors build grade registry sets, competing for the highest-graded copies of cards. This creates a floor of buyer demand even for cards that aren't individually famous.</p>

<h2>The Investment Angle</h2>
<p>High-grade examples of valuable cards have historically outperformed the raw card market during price increases. When Charizard prices spike, GEM MT 10s spike harder. The grade multiplies the upside.</p>
    `,
  },
  {
    slug: "beginners-guide-pokemon-card-collecting-uk",
    title: "Beginner's Guide to Pokémon Card Collecting in the UK",
    excerpt: "Just starting out? This guide covers everything a new UK collector needs to know about building a Pokémon card collection, from buying to storing to grading.",
    publishedDate: "2025-03-15",
    author: "MintVault UK",
    metaTitle: "Beginner's Guide to Pokémon Card Collecting UK | MintVault UK",
    metaDescription: "New to Pokémon card collecting in the UK? Learn how to buy, store, value, and grade your cards with this complete beginner's guide from MintVault UK.",
    body: `
<h2>Welcome to the Hobby</h2>
<p>Pokémon card collecting is one of the most popular hobbies in the UK, combining nostalgia, investment potential, and community. Whether you're here for fun or finance, this guide will help you get started on the right foot.</p>

<h2>Where to Buy Cards</h2>
<p>Cards can be purchased from official retailers (The Pokémon Center, Smyths, GAME), local card shops, online marketplaces (eBay, Vinted), and card-specific platforms. New collectors should start with modern booster packs to learn the sets before investing in singles.</p>

<h2>Understanding Card Rarity</h2>
<p>Pokémon cards come in several rarity tiers: Common (circle), Uncommon (diamond), Rare (star), Holo Rare, Ultra Rare, and the various "Special" rarities like Double Rare, Ultra Rare, Illustration Rare, Special Illustration Rare, and Hyper Rare. Rarer cards are generally more valuable.</p>

<h2>Learning Card Values</h2>
<p>Use eBay's completed listings feature to see what cards actually sell for. TCGPlayer and Cardmarket also provide pricing data. Values change constantly with set releases and market trends — keep checking regularly.</p>

<h2>Protecting Your Cards</h2>
<p>Always sleeve cards immediately. For commons and uncommons, penny sleeves work fine. For valuable cards, add a top loader or rigid binder page. Never leave valuable cards loose.</p>

<h2>When to Start Grading</h2>
<p>Once you've built some confidence in the hobby and identified cards worth more than £30–50 in excellent condition, grading makes sense. Start with a small submission to learn the process before sending larger quantities.</p>

<h2>Joining the Community</h2>
<p>UK collecting communities thrive on Reddit (r/PokemonTCG, r/pokemoncardcollectors), Discord servers, and local card shops. Fellow collectors are a great resource for pricing advice, trade opportunities, and general guidance.</p>
    `,
  },
  {
    slug: "understanding-card-centering-corners-edges-surface",
    title: "Understanding Card Grading: Centering, Corners, Edges & Surface",
    excerpt: "A deep dive into the four criteria used to grade trading cards — what graders look for and how each criterion affects your overall score.",
    publishedDate: "2025-03-18",
    author: "MintVault UK",
    metaTitle: "Card Grading: Centering, Corners, Edges & Surface Explained | MintVault UK",
    metaDescription: "Understand the four subgrades used in professional card grading: centering, corners, edges, and surface. Learn what graders look for and how to maximise your score.",
    body: `
<h2>The Four Pillars of Card Grading</h2>
<p>Every card submitted to MintVault UK is assessed across four criteria: Centering, Corners, Edges, and Surface. Each is evaluated independently, and your overall grade reflects your card's performance across all four. A weakness in any single area can significantly impact the final grade.</p>

<h2>Centering</h2>
<p>Centering measures how evenly the printed image is positioned within the card border. It is typically expressed as a ratio — for example, 60/40 means 60% of the border is on one side and 40% on the other.</p>
<p>For a GEM MT 10, centering needs to be approximately 55/45 or better on both the top-to-bottom and left-to-right axes. Cards with centering worse than 70/30 on either axis are typically capped at grade 7 or below.</p>
<p>Centering is a manufacturing defect — you cannot fix it after the fact. This is why condition-checking your card before submitting is important.</p>

<h2>Corners</h2>
<p>Corners are inspected for four types of damage: whitening (the most common), fraying, creasing, and blunting. Even a small amount of whitening — visible as a lighter area at the corner tip — can drop a card from a 10 to a 9 or 8.</p>
<p>Corners are where most cards lose their chance at a 10. The corner tips are the most vulnerable part of the card during handling and storage, which is why sleeving immediately is so important.</p>

<h2>Edges</h2>
<p>All four edges of the card are examined for nicks, chips, roughness, and colour loss. Edge wear often occurs during card shuffling (for played cards) or during pack opening and initial handling.</p>
<p>Edge damage is usually visible at slight angles under direct light. Small chips on the edge will typically result in a grade of 8 or lower depending on severity.</p>

<h2>Surface</h2>
<p>The surface grade covers both the front and back of the card. Graders look for scratches (particularly on holo surfaces), print lines, indentations, staining, and manufacturing defects.</p>
<p>Holo cards are particularly vulnerable to surface scratches — the reflective surface shows even fine scratches clearly when the card is tilted under light. Always handle holo cards by the edges only.</p>
<p>Print lines are a special case: these are fine lines in the card's print pattern caused during manufacturing. They are not the collector's fault, but they can prevent a 10 grade as they affect the surface presentation.</p>

<h2>How Subgrades Combine</h2>
<p>The overall grade is not simply an average of the four subgrades. A card with a single significant weakness in one area will typically be pulled down to reflect that weakness — for example, a card with perfect edges, corners, and surface but poor centering may still only achieve a 6 or 7 overall.</p>
    `,
  },
  {
    slug: "how-we-grade",
    title: "How MintVault Grades Your Card",
    excerpt: "A step-by-step look at exactly how MintVault's graders assess centering, corners, edges, and surface to produce an accurate, independent grade.",
    publishedDate: "2026-04-01",
    author: "MintVault UK",
    metaTitle: "How MintVault Grades Your Card | UK Card Grading Process Explained",
    metaDescription: "Discover exactly how MintVault grades trading cards in the UK. Learn about our independent grading process, the four assessment criteria, and how we calculate the overall grade.",
    body: `
<h2>Our Grading Philosophy</h2>
<p>At MintVault, grading is an independent, conflict-of-interest-free process. Our graders do not buy or sell cards. They assess each card on its own merits against a consistent, documented standard — not against the market value or what a customer might want to hear.</p>
<p>Every card submitted to MintVault is assessed by a trained grader using calibrated equipment. The process is the same whether the card is worth £5 or £5,000.</p>

<h2>Step 1: Receipt and Registration</h2>
<p>When your submission arrives at our facility, each card is logged against your submission ID and checked against your declared list. Cards are handled with cotton gloves from this point forward.</p>
<p>You will receive an email confirmation when your cards are received and registered in our system.</p>

<h2>Step 2: Pre-Grade Inspection</h2>
<p>Before formal grading begins, each card is cleaned of any surface dust using an air blower and inspected under UV light to check for printing anomalies, restoration, or alterations. Cards showing evidence of restoration are flagged for the Authentic Altered designation.</p>

<h2>Step 3: The Four Assessment Criteria</h2>
<p>Every card is assessed across four criteria. Each is scored independently before an overall grade is calculated.</p>

<h2>Centering</h2>
<p>Centering measures how evenly the printed image sits within the card's borders. We measure left-to-right and top-to-bottom ratios using calibrated gauges. A perfectly centred card scores 50/50 on both axes. MintVault uses the following thresholds:</p>
<ul>
  <li><strong>10:</strong> 55/45 or better on both axes</li>
  <li><strong>9:</strong> 60/40 or better</li>
  <li><strong>8:</strong> 65/35 or better</li>
  <li><strong>7:</strong> 70/30 or better</li>
  <li><strong>6 and below:</strong> beyond 70/30</li>
</ul>

<h2>Corners</h2>
<p>Corners are inspected under 10× magnification. Graders look for fraying, whitening, bending, or flattening at all four corners. A GEM MINT 10 card must have all four corners sharp and completely clean under magnification. Even microscopic whitening on a single corner can reduce a score to 9 or below.</p>

<h2>Edges</h2>
<p>Edges are inspected along all four sides of the card. Common issues include whitening (caused by shuffling or handling), chipping (small chunks of card material lost from the edge), and factory cut irregularities. Factory defects are noted but do not automatically lower a grade in the same way handling damage does.</p>

<h2>Surface</h2>
<p>Surface covers everything visible on the front and back faces of the card. Graders look for scratches, print lines, indentations, haze, loss of gloss, staining, and any other marks or damage. Holographic cards receive additional scrutiny for scratch patterns in the holo layer.</p>

<h2>Step 4: Overall Grade Calculation</h2>
<p>The overall grade is not a simple average of the four subgrades. The lowest subgrade has significant pull on the overall — a card with three 10s and one 7 centering score will not receive an overall 10. Our graders use professional judgement alongside a weighted formula to arrive at the final grade.</p>
<p>Non-numeric grades are assigned where appropriate: <strong>NO</strong> (Not Graded) for cards that cannot be graded due to damage or authenticity concerns, and <strong>AA</strong> (Authentic Altered) for cards with evidence of restoration or modification.</p>

<h2>Step 5: Encapsulation</h2>
<p>Once graded, each card is sealed in a MintVault precision slab with a printed label showing the card name, set, year, grade, and subgrades. The slab is UV-resistant and tamper-evident. An NFC chip and QR code are embedded for permanent verification.</p>

<h2>No Conflict of Interest</h2>
<p>MintVault graders are salaried employees — they have no financial stake in the grades they assign. This independence is fundamental to our credibility as a grading service. We do not offer "grade guarantees" or revise grades based on customer requests.</p>
    `,
  },
  {
    slug: "subgrades-explained",
    title: "Understanding Subgrades: Centering, Corners, Edges & Surface",
    excerpt: "What do the four subgrade numbers on a MintVault label actually mean? This guide explains each category and how they combine into your overall grade.",
    publishedDate: "2026-04-01",
    author: "MintVault UK",
    metaTitle: "Card Grading Subgrades Explained | Centering, Corners, Edges, Surface",
    metaDescription: "Understand what centering, corners, edges, and surface subgrades mean on a graded card. Learn how each subgrade is measured and how they affect the overall grade.",
    body: `
<h2>What Are Subgrades?</h2>
<p>Subgrades are individual scores for the four main quality criteria used in card grading: centering, corners, edges, and surface. They appear on the MintVault label alongside the overall grade and give collectors a more detailed picture of a card's condition.</p>
<p>Two cards can both receive an overall grade of 8, but one might have perfect centering and worn corners, while the other has excellent corners but surface scratches. Subgrades make this visible at a glance.</p>

<h2>Centering</h2>
<p>Centering describes how evenly the card image is positioned within its borders. It is expressed as a ratio — for example, 55/45 means the image sits 55% to one side and 45% to the other.</p>
<p>Centering is assessed separately for left-to-right and top-to-bottom alignment. Both must meet the threshold for a given score. A card with perfect left-right centering but poor top-bottom centering is limited by its worst axis.</p>
<p><strong>Why it matters:</strong> Centering is the most visible quality issue to the naked eye and has a significant effect on resale value, especially for vintage cards where factory centering was less consistent.</p>

<h2>Corners</h2>
<p>Corners are assessed under magnification — typically 10× — to detect any fraying, whitening, bending, or softening at each of the four corners.</p>
<p>A corner score of 10 requires all four corners to be perfectly sharp with no visible wear even under magnification. At score 9, extremely minor wear may be detectable only under close inspection. Scores of 8 and below reflect increasingly visible wear.</p>
<p><strong>Why it matters:</strong> Corners are the most commonly damaged part of a card through handling and storage. Cards stored loosely in binders or boxes almost always show corner wear.</p>

<h2>Edges</h2>
<p>Edges are assessed along all four sides of the card for whitening, chipping, or roughness. This is distinct from corners — edges cover the flat sides between corners.</p>
<p>Whitening on edges is caused by friction during handling, sliding cards in and out of sleeves, or shuffling. Factory cut quality also affects edge appearance, particularly for older sets where cutting precision was lower.</p>
<p><strong>Why it matters:</strong> Edge whitening is very common on handled cards and is one of the main reasons modern chase cards benefit from being sleeved immediately after opening packs.</p>

<h2>Surface</h2>
<p>Surface covers both faces of the card. Graders inspect for scratches, print lines, indentations, haze, cloudiness, staining, and any loss of gloss or finish.</p>
<p>For holographic cards, the holo layer receives additional scrutiny. Fine scratch patterns ("holo scratches") are often invisible at arm's length but clearly visible under light at an angle. These almost always reduce the surface score.</p>
<p><strong>Why it matters:</strong> Surface condition is particularly important for foil cards and modern special rarities. Factory defects like print lines or holo damage can affect cards that have never been removed from the pack.</p>

<h2>How Subgrades Combine Into the Overall Grade</h2>
<p>The overall grade is not a simple average of the four subgrades. The weakest subgrade exerts a strong downward pull — a card with three 10s and a centering score of 7 will not receive an overall 10. MintVault graders apply professional judgement alongside weighted criteria to determine the final grade.</p>
<p>As a general guide:</p>
<ul>
  <li><strong>GEM MINT 10:</strong> All four subgrades must be 9.5 or above</li>
  <li><strong>MINT 9:</strong> No subgrade below 8.5, with at least two at 9.5+</li>
  <li><strong>NM-MT 8:</strong> No subgrade below 7.5</li>
  <li><strong>7 and below:</strong> Visible wear in one or more categories</li>
</ul>

<h2>Reading a MintVault Label</h2>
<p>The four subgrade numbers appear on the bottom half of the front label, listed as C / Co / E / S (Centering / Corners / Edges / Surface). The overall grade is displayed in large type in the grade panel. A grading report with written commentary can also be viewed by scanning the QR code on the slab.</p>
    `,
  },
  {
    slug: "nfc-verification",
    title: "NFC Verification: How It Works and Why It Matters",
    excerpt: "Every MintVault slab contains an embedded NFC chip. Here's what it does, how to tap it, and why it adds a layer over a QR code alone.",
    publishedDate: "2026-04-01",
    author: "MintVault UK",
    metaTitle: "NFC Card Verification Explained | MintVault UK",
    metaDescription: "Learn how the NFC chip in every MintVault slab works. How to tap your phone to verify a graded card, what information it shows, and why NFC is more secure than QR alone.",
    body: `
<h2>What Is NFC?</h2>
<p>NFC stands for Near Field Communication — the same technology used in contactless card payments. It allows two devices to exchange data when they are held within a few centimetres of each other. Every modern smartphone (iPhone 7 and later, most Android phones from 2015 onward) can read NFC chips without any additional app.</p>
<p>Every MintVault slab contains an NFC chip embedded in the casing. The chip stores a URL that opens the certificate record on the MintVault registry.</p>

<h2>How to Tap a MintVault Slab</h2>
<p>Verification takes about two seconds:</p>
<ul>
  <li><strong>iPhone:</strong> Hold the top of your phone against the NFC area on the slab (usually near the bottom label). Your phone will display a notification — tap it to open the certificate.</li>
  <li><strong>Android:</strong> Enable NFC in your phone's settings if not already on. Hold the back of your phone against the NFC area on the slab. A notification will appear — tap to open.</li>
</ul>
<p>No app is required. The NFC chip opens a standard web URL that loads the MintVault certificate page in your browser.</p>

<h2>What You See When You Scan</h2>
<p>Tapping the NFC chip opens the certificate detail page for that specific card. You will see:</p>
<ul>
  <li>The card name, set, year, and game</li>
  <li>The overall grade and all four subgrades</li>
  <li>The certification number and date of grading</li>
  <li>The registry status (active, voided, or transferred)</li>
  <li>The grading report, if one has been written</li>
  <li>Photos of the card front and back (if uploaded)</li>
</ul>

<h2>Why NFC Is More Secure Than QR Alone</h2>
<p>QR codes can be photographed and reprinted onto any surface. A counterfeit slab with a photocopied QR code would pass a visual scan. NFC chips cannot be copied this way — they are physically embedded during slab encapsulation and can't be lifted or swapped without damaging the slab.</p>
<p>MintVault slabs contain both a QR code (for quick scanning with a camera) and an NFC chip (for higher-security verification). Together, they provide layered authentication.</p>

<h2>Ownership and NFC</h2>
<p>The NFC chip also supports MintVault's ownership registry. When you claim ownership of a graded card, the certificate record is linked to your identity. Anyone tapping the slab can see the registry status and, if ownership has been claimed, that the card has a verified owner. Ownership details are kept private — only the status is shown publicly.</p>

<h2>Troubleshooting</h2>
<p>If your phone doesn't read the NFC chip:</p>
<ul>
  <li>Check that NFC is enabled in your phone settings (Android only — on iPhone it is always on)</li>
  <li>Move your phone slowly across different parts of the slab to find the chip location</li>
  <li>Remove your phone case — thick or metal cases can block NFC signals</li>
  <li>Try the QR code as a fallback — scan the code on the front label with your camera app</li>
</ul>
<p>If neither the NFC nor QR code returns a result, contact MintVault with your certification number and we will investigate.</p>
    `,
  },
  {
    slug: "ownership-registry",
    title: "The MintVault Ownership Registry Explained",
    excerpt: "What is the MintVault ownership registry, how do you claim a card, and why does verified ownership matter when buying and selling graded cards?",
    publishedDate: "2026-04-01",
    author: "MintVault UK",
    metaTitle: "MintVault Ownership Registry Explained | Claim & Transfer Graded Cards",
    metaDescription: "Learn how the MintVault ownership registry works. How to claim ownership of your graded card, transfer it to a buyer, and why this protects collectors in the secondary market.",
    body: `
<h2>What Is the Ownership Registry?</h2>
<p>The MintVault ownership registry is a record of who owns each graded card. When a card is graded and certified, it is assigned a certificate number and registered in the MintVault database. By default, cards are unregistered — the slab exists and is verifiable, but no owner is recorded.</p>
<p>Any collector can claim ownership of a card using the unique claim code printed on the claim insert included with their slab. Once claimed, the certificate is linked to the owner's name and email, and the registry status changes from "Unclaimed" to "Registered".</p>

<h2>Why Ownership Registration Matters</h2>
<p>Registered ownership provides several important protections:</p>
<ul>
  <li><strong>Proof of ownership:</strong> The registry provides a verifiable record of who owns a card, useful in the event of theft, insurance claims, or disputes</li>
  <li><strong>Transfer trail:</strong> Every ownership transfer is recorded, creating a provenance history for the card</li>
  <li><strong>Buyer confidence:</strong> When buying a registered card, buyers can see that it has a documented ownership history — this reduces the risk of purchasing a stolen or fraudulently obtained card</li>
  <li><strong>Certificate PDF:</strong> Registered owners can download a formal Certificate of Authenticity PDF with their name and registration number</li>
</ul>

<h2>How to Claim Ownership</h2>
<p>Your slab comes with a claim insert card. This contains a unique claim code — a short alphanumeric code specific to your certificate. To claim ownership:</p>
<ol>
  <li>Visit <a href="/ownership" class="text-[#D4AF37] hover:underline">mintvaultuk.com/ownership</a> or scan the QR code on the insert</li>
  <li>Enter your certificate number and claim code</li>
  <li>Enter your full name and email address</li>
  <li>Submit — ownership is registered immediately</li>
</ol>
<p>You will receive a confirmation email with your Certificate of Authenticity PDF attached.</p>

<h2>How to Transfer Ownership</h2>
<p>If you sell or give away a registered card, you can transfer ownership to the new owner. This keeps the registry accurate and reassures the buyer.</p>
<ol>
  <li>Log in to your <a href="/dashboard" class="text-[#D4AF37] hover:underline">MintVault dashboard</a></li>
  <li>Find the certificate in your owned cards</li>
  <li>Click "Transfer Ownership" and enter the new owner's name and email address</li>
  <li>Both parties receive confirmation emails</li>
  <li>The new owner's details are recorded in the registry</li>
</ol>
<p>The old certificate is updated and a new Certificate of Authenticity is issued to the new owner.</p>

<h2>MintVault Is the Only UK Grader With Ownership Registration</h2>
<p>No other UK grading company currently offers a linked ownership registry. PSA and BGS do not offer verified ownership transfer. This makes MintVault cards uniquely verifiable in the secondary market — a buyer can confirm both the grade and the ownership history of a card before purchasing.</p>

<h2>Privacy</h2>
<p>Owner names and email addresses are never shown publicly. The public certificate page only shows whether a card is "Registered" or "Unregistered". Your personal details are stored securely and are only used for ownership verification purposes.</p>
    `,
  },
  {
    slug: "first-submission",
    title: "Submitting Your First Cards to MintVault: A Complete Walkthrough",
    excerpt: "Never submitted cards for grading before? This step-by-step guide walks you through everything from choosing a tier to packing your cards and what happens next.",
    publishedDate: "2026-04-01",
    author: "MintVault UK",
    metaTitle: "How to Submit Cards to MintVault UK | First Submission Guide",
    metaDescription: "A complete step-by-step guide to submitting trading cards to MintVault UK for professional grading. Choose a service tier, pack safely, and track your submission.",
    body: `
<h2>Before You Start: Is Your Card Worth Grading?</h2>
<p>The most common question from first-time submitters is: which cards should I send? The short answer is: cards in near-mint condition where the graded value would comfortably exceed the grading fee.</p>
<p>Check recent eBay sold listings for the card you are considering — search for the card name plus "PSA 10" or "GEM MT" to see what graded copies are selling for. If the graded value is at least 3–4× the grading fee, it is worth submitting.</p>
<p>See our full guide on <a href="/guides/what-pokemon-cards-are-worth-grading" class="text-[#D4AF37] hover:underline">which cards are worth grading</a> for more detail.</p>

<h2>Step 1: Choose Your Service Tier</h2>
<p>MintVault offers several service tiers at different price points and turnaround times. Visit the <a href="/pricing" class="text-[#D4AF37] hover:underline">pricing page</a> to see all options. For most first-time submitters, the Vault Queue tier (40 working days) is the most affordable option, while Standard (15 working days) offers a good balance of cost and speed.</p>
<p>If you have time-sensitive cards or are submitting ahead of a sale, consider Premier (10 working days) or Ultra (5 working days).</p>

<h2>Step 2: Fill in the Submission Form</h2>
<p>Go to the <a href="/submit" class="text-[#D4AF37] hover:underline">Submit Cards page</a> and complete the online form. You will need to provide:</p>
<ul>
  <li>The number of cards you are submitting</li>
  <li>Your service tier selection</li>
  <li>Your contact details and return address</li>
  <li>A declared value for insurance purposes (total estimated value of all cards)</li>
</ul>
<p>You do not need to list individual card details at this stage — you can add card information after we receive your submission.</p>

<h2>Step 3: Pay Securely Online</h2>
<p>Payment is taken at the time of submission via Stripe. All major credit and debit cards are accepted. You will receive a confirmation email with your submission tracking number immediately after payment.</p>

<h2>Step 4: Pack Your Cards Safely</h2>
<p>How you pack your cards has a direct effect on whether they arrive in the same condition they left. Follow this process:</p>
<ol>
  <li>Place each card in a penny sleeve (soft sleeve) to protect the surface</li>
  <li>Slide the penny-sleeved card into a rigid top loader (standard 3×4 inch for Pokémon and most TCGs)</li>
  <li>Tape the top of the top loader with artist's tape or masking tape — not sellotape, which can mark cards</li>
  <li>Stack your top-loaded cards and wrap them snugly in bubble wrap</li>
  <li>Place in a padded envelope or small cardboard box — the fit should be snug, not loose</li>
</ol>
<p>Never use regular sticky tape directly on cards or sleeves. Do not pack cards loosely — movement during transit causes damage.</p>

<h2>Step 5: Post to MintVault</h2>
<p>Use a tracked and insured postal service. For cards worth over £100 in total, we recommend Royal Mail Special Delivery. Write your submission tracking number clearly on the outside of the package so we can match it on arrival.</p>
<p>Our receiving address is provided in your confirmation email and on the submission tracking page.</p>

<h2>Step 6: Track Your Submission</h2>
<p>Once your cards arrive at our facility, you will receive an email confirmation. Use the <a href="/track" class="text-[#D4AF37] hover:underline">Track Submission page</a> with your submission ID and email to monitor progress. You will receive email updates when:</p>
<ul>
  <li>Your cards are received and logged</li>
  <li>Grading is complete</li>
  <li>Your order has been dispatched</li>
</ul>

<h2>Step 7: Receive Your Slabs</h2>
<p>Your cards are returned via fully insured Royal Mail Special Delivery. Each card arrives in a MintVault precision slab with a label showing the card name, set, grade, and subgrades. A QR code and NFC chip on each slab link to the permanent certificate record.</p>
<p>A claim insert is included with each slab so you can register ownership in the MintVault registry. See our <a href="/guides/ownership-registry" class="text-[#D4AF37] hover:underline">ownership registry guide</a> for instructions.</p>

<h2>What If I'm Unhappy With the Grade?</h2>
<p>Grades assigned by MintVault are final — we do not revise grades based on customer preference. If you believe a genuine administrative error has occurred (e.g. the wrong card was graded), contact us immediately with your certificate number and supporting photos.</p>
<p>For cards originally graded by another company, our Crossover service allows independent re-grading. If the MintVault grade is lower than expected, we offer a free-return guarantee on Crossover submissions.</p>
    `,
  },
];

export function getGuideBySlug(slug: string): Guide | undefined {
  return guides.find((g) => g.slug === slug);
}

export function getRelatedGuides(currentSlug: string, count = 3): Guide[] {
  return guides.filter((g) => g.slug !== currentSlug).slice(0, count);
}
