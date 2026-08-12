import type { Sharp } from "sharp";

/**
 * LiDE 400 cards are placed upright for the person opening the lid, while
 * the hardware raster is inverted. Preserve that hardware TIFF unchanged as
 * evidence; all browser/operator derivatives use this explicit transform.
 */
export const LIDE_400_PRESENTATION_ROTATION_DEGREES = 180;

export function orientLide400Presentation(image: Sharp): Sharp {
  return image.rotate(LIDE_400_PRESENTATION_ROTATION_DEGREES);
}
