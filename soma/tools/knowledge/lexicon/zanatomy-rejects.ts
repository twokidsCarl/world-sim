// Z-Anatomy attachment patches that are NOT emitted, after a manual check against standard
// anatomy (Gray / Terminologia-level knowledge; unreviewed like the rest of this layer).
// The geometry test (which bone a patch lies on) is usually right; what goes wrong is the atlas's
// origin/insertion labelling, which for many trunk, neck and suboccipital muscles is the reverse
// of the textbook convention, plus a few patches that sit on a neighbouring bone.
//
// Key: muscle name as in attachments.json, lower-case, without parentheses. `bone` (lower-case
// substring of the bone name) limits the rejection to patches on that bone.
export interface PatchReject {
  muscle: string
  kind: 'origin' | 'insertion'
  bone?: string
  reason: string
}

const REVERSED = 'origin and insertion are the reverse of the textbook convention'

export const ZANATOMY_REJECTS: PatchReject[] = [
  // trapezius: the scapula/clavicle end is the insertion; "ascending part" patches lie on the upper fibres
  { muscle: 'ascending part of trapezius muscle', kind: 'origin', reason: `${REVERSED} (clavicle is an insertion) and the patch belongs to the upper fibres` },
  { muscle: 'ascending part of trapezius muscle', kind: 'insertion', reason: `${REVERSED} (occipital bone is an origin of the upper fibres)` },
  { muscle: 'descending part of trapezius muscle', kind: 'origin', reason: `${REVERSED} (scapula is the insertion)` },
  { muscle: 'transverse part of trapezius muscle', kind: 'origin', reason: `${REVERSED} (scapula is the insertion)` },
  { muscle: 'latissimus dorsi muscle', kind: 'insertion', reason: 'inserts on the humerus (intertubercular sulcus); the scapular slip is an origin' },
  { muscle: 'pectoralis minor muscle', kind: 'origin', reason: `${REVERSED} (coracoid process is the insertion)` },
  { muscle: 'pectoralis minor muscle', kind: 'insertion', reason: `${REVERSED} (ribs 3-5 are the origin)` },
  { muscle: 'serratus anterior muscle', kind: 'origin', reason: `${REVERSED} (scapula is the insertion)` },
  { muscle: 'serratus anterior muscle', kind: 'insertion', reason: `${REVERSED} (ribs are the origin)` },
  { muscle: 'sternocostal head of pectoralis major muscle', kind: 'insertion', reason: `${REVERSED} (sternum and costal cartilages are the origin)` },
  { muscle: 'subclavius muscle', kind: 'origin', reason: `${REVERSED} (clavicle is the insertion; origin is the first rib)` },
  { muscle: 'scalenus anterior muscle', kind: 'origin', reason: `${REVERSED} (first rib is the insertion)` },
  { muscle: 'scalenus anterior muscle', kind: 'insertion', reason: `${REVERSED} (cervical vertebrae are the origin)` },
  { muscle: 'scalenus medius muscle', kind: 'origin', reason: `${REVERSED} (first rib is the insertion)` },
  { muscle: 'scalenus medius muscle', kind: 'insertion', reason: `${REVERSED} (cervical vertebrae are the origin)` },
  { muscle: 'scalenus posterior muscle', kind: 'insertion', reason: `${REVERSED} (cervical vertebrae are the origin)` },
  { muscle: 'thyrohyoid muscle', kind: 'origin', reason: `${REVERSED} (hyoid bone is the insertion)` },
  { muscle: 'thyrohyoid muscle', kind: 'insertion', reason: `${REVERSED} (thyroid cartilage is the origin)` },
  { muscle: 'anterior belly of digastric muscle', kind: 'insertion', reason: 'the digastric fossa of the mandible is conventionally the origin of the anterior belly' },
  { muscle: 'longus capitis muscle', kind: 'origin', reason: `${REVERSED} (occipital bone is the insertion)` },
  { muscle: 'obliquus inferior capitis muscle', kind: 'origin', reason: `${REVERSED} (atlas is the insertion)` },
  { muscle: 'obliquus inferior capitis muscle', kind: 'insertion', reason: `${REVERSED} (axis is the origin)` },
  { muscle: 'obliquus superior capitis muscle', kind: 'origin', reason: `${REVERSED} (occipital bone is the insertion)` },
  { muscle: 'rectus anterior capitis muscle', kind: 'origin', reason: `${REVERSED} (occipital bone is the insertion)` },
  { muscle: 'rectus anterior capitis muscle', kind: 'insertion', reason: `${REVERSED} (atlas is the origin)` },
  { muscle: 'rectus lateralis capitis muscle', kind: 'origin', reason: `${REVERSED} (occipital bone is the insertion)` },
  { muscle: 'rectus posterior major capitis muscle', kind: 'origin', reason: `${REVERSED} (occipital bone is the insertion)` },
  { muscle: 'rectus posterior major capitis muscle', kind: 'insertion', reason: `${REVERSED} (axis is the origin)` },
  { muscle: 'rectus posterior minor capitis muscle', kind: 'origin', reason: `${REVERSED} (occipital bone is the insertion)` },
  { muscle: 'rectus posterior minor capitis muscle', kind: 'insertion', reason: `${REVERSED} (atlas is the origin)` },
  { muscle: 'rectus abdominis muscle', kind: 'origin', reason: `${REVERSED} (costal cartilages 5-7 are the insertion; origin is the pubis)` },
  { muscle: 'external abdominal oblique muscle', kind: 'origin', bone: 'hip bone', reason: 'the iliac crest is an insertion of the external oblique' },
  { muscle: 'internal abdominal oblique muscle', kind: 'origin', bone: 'rib', reason: 'the lower ribs and costal cartilages are the insertion of the internal oblique' },
  // limbs
  { muscle: 'extensor carpi ulnaris', kind: 'insertion', reason: 'inserts on the base of the fifth metacarpal; the patch was matched to the triquetrum' },
  { muscle: 'adductor pollicis', kind: 'insertion', bone: 'capitate', reason: 'the capitate is an origin of the oblique head, not an insertion' },
  { muscle: 'extensor hallucis longus', kind: 'insertion', reason: 'inserts on the distal phalanx of the great toe; the patch was matched to the proximal phalanx' },
  { muscle: 'transverse head of adductor hallucis', kind: 'origin', reason: `${REVERSED} (sesamoid / proximal phalanx is the insertion)` },
  { muscle: 'transverse head of adductor hallucis', kind: 'insertion', reason: `${REVERSED} (the metatarsophalangeal ligaments of toes 3-5 are the origin)` },
  { muscle: 'opponens digiti minimi muscle of foot', kind: 'origin', reason: 'the fifth metatarsal is the insertion' },
  // head
  { muscle: 'lateral pterygoid muscle', kind: 'origin', reason: 'arises from the sphenoid (greater wing, lateral pterygoid plate); the patches were matched to maxilla / palatine bone' },
  { muscle: 'nasalis muscle', kind: 'origin', reason: 'arises from the maxilla; the patch was matched to the nasal bone' },
  { muscle: 'procerus muscle', kind: 'origin', reason: 'arises from the nasal bone; the patch was matched to the frontal bone' },
  { muscle: 'frontalis muscle', kind: 'origin', reason: 'arises from the epicranial aponeurosis, not from bone' },
  { muscle: 'orbicularis oris muscle', kind: 'origin', reason: 'has no direct bony origin (modiolus and neighbouring muscles)' },
]

/**
 * Atlas "muscles" that are a functional group: their patches count as whole-muscle patches of
 * the listed muscles (and of those muscles' named parts). Lower-case names.
 */
export const ZANATOMY_GROUPS: Record<string, string[]> = {
  'triceps surae': ['gastrocnemius', 'soleus'],
  'quadriceps femoris': ['rectus femoris', 'vastus lateralis', 'vastus medialis', 'vastus intermedius'],
  iliopsoas: ['iliacus', 'psoas major'],
}
