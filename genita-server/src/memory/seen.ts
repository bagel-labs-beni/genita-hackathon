import { safeMemoryText } from "./extract.ts";

/** Trusted F5/SAM adapter output, NOT a public client payload. The adapter must
 * inspect the cropped pixels for excluded content before setting safeObject.
 * No original bytes, URL or frame id can enter this contract. */
export type SeenCandidate = {
  object: string;
  line: string;
  crop: {
    image_ref: string;
    width: number;
    height: number;
    source: "sam-3.1";
    box: [number, number, number, number]; // normalized SAM box in source frame
    safeObject: boolean; // no people/faces, documents, money or addresses
  };
};
export type SeenContext = { sessionId: string; discussedText: string };
const EXCLUDED = /\b(?:people|person|face|portrait|selfie|document|paper|receipt|passport|id card|money|cash|coin|banknote|address|letter|screen)\b|사람|얼굴|서류|문서|영수증|신분증|여권|돈|지폐|동전|주소/iu;
export const validCropRef = (ref: string) => /^sam-crops\/[a-zA-Z0-9_-]+\.(?:jpg|jpeg|png)$/.test(ref);

export function validSeen(candidate: SeenCandidate, context: SeenContext): boolean {
  const c = candidate?.crop;
  const label = candidate?.object?.trim().toLowerCase();
  return !!c && !!label && label.length <= 80 && safeMemoryText(candidate.line) && !EXCLUDED.test(candidate.line + " " + label)
    && context.discussedText.toLowerCase().includes(label)
    && c.source === "sam-3.1" && c.safeObject === true && validCropRef(c.image_ref)
    && Number.isInteger(c.width) && Number.isInteger(c.height) && c.width > 0 && c.height > 0 && Math.max(c.width, c.height) <= 480
    && Array.isArray(c.box) && c.box.length === 4 && c.box.every((n) => Number.isFinite(n) && n >= 0 && n <= 1) && c.box[0] < c.box[2] && c.box[1] < c.box[3];
}
