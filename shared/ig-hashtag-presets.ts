/**
 * Instagram hashtag preset bundles.
 *
 * Used by the admin "Apply preset" dropdown in client/src/pages/admin-instagram.tsx,
 * served via GET /api/admin/ig/hashtag-presets. Each bundle is a single
 * space-separated string of hashtags — that matches the storage format
 * already in ig_post_queue.hashtags.
 *
 * Hashtag selection draws from the existing base set in
 * server/ig/caption-generator.ts BASE_HASHTAGS plus tier/era/grade-specific
 * tags. 15–20 tags per bundle (Instagram's 30-tag cap leaves headroom for
 * card-specific additions on top).
 *
 * Adding a bundle: add a new key here and it's automatically picked up by
 * the dropdown — no code changes elsewhere needed.
 */

export const IG_HASHTAG_PRESETS = {
  // Broad daily-driver mix. Closest to BASE_HASHTAGS in caption-generator.ts —
  // the safest catch-all for any post.
  base:
    "#PokemonCards #PokemonGrading #PSAGrading #CGCCards #MintVault " +
    "#GradedCards #PokemonCollector #TCGGrading #PokemonTCG #CardGrading " +
    "#UKPokemon #VaultClub #GradedPokemon #PokemonInvestor #CardCollector",

  // 1996–2003 WOTC / EX-era / pre-Diamond&Pearl reissues.
  vintage:
    "#WOTC #BaseSet #PokemonVintage #1stEdition #ShadowlessPokemon " +
    "#NeoGenesis #JungleSet #FossilSet #TeamRocket #GymHeroes " +
    "#VintagePokemon #PokemonClassic #ShinyHolofoil #BlackStarRare #PSAVintage " +
    "#PokemonHistory #MintCondition",

  // Sword & Shield, Scarlet & Violet, modern era.
  modern:
    "#ModernPokemon #ScarletViolet #SwordShield #SurgingSparks " +
    "#PaldeanFates #StellarCrown #PaldeaEvolved #ObsidianFlames " +
    "#TwilightMasquerade #PokemonModern #PokemonNewSet #PrismaticEvolutions " +
    "#PokemonReleases #PokemonPulls #ModernGraded #SVE #CrownZenith",

  // 9.5+, GEM MT 10, perfect-grade slabs.
  high_grade:
    "#GemMint #GemMt10 #PSA10 #BGS10 #PerfectGrade #PokemonPSA10 " +
    "#GemMintPokemon #PristineSlab #FlawlessGrade #PokemonMint " +
    "#TopPopGraded #HighGradedPokemon #SlabbedAndGraded #InvestmentGrade " +
    "#PokemonGemMint #VaultGrade #BlackLabel",

  // Alt arts, secret rares, special illustration rares, chase cards.
  rare_pulls:
    "#AltArt #SecretRare #SpecialIllustrationRare #ChaseCard #UltraRare " +
    "#FullArt #RainbowRare #GoldRare #HyperRare #PokemonChase " +
    "#PokemonPulls #PulledIt #PokemonHits #IllustrationRare #PokemonAltArt " +
    "#FullArtTrainer #PokemonRare",

  // Subscription / collecting community tags.
  vault_club:
    "#VaultClub #PokemonCollectors #UKCardCollector #CardSubscription " +
    "#GradingService #PokemonCommunity #CollectorLife #PokemonHobby " +
    "#TCGCommunity #PokemonUK #PokemonInvestor #CardInvestor " +
    "#CollectorClub #PokemonMembership #GradingUK #PokemonSlabClub " +
    "#MintVaultMember",

  // Grading service / submission tags (for service_explainer posts).
  service:
    "#CardGradingUK #GradingService #GetYourCardsGraded #PokemonGrading " +
    "#CardSubmission #MintVault #PSAvsCGC #UKGrading #GradingTurnaround " +
    "#PokemonSlab #ProfessionalGrading #VaultQueue #BlackLabelReview " +
    "#PokemonSubmissions #GradingResults #PokemonAuthentication #TCGAuthentication",
} as const;

export type IgHashtagPresetKey = keyof typeof IG_HASHTAG_PRESETS;
