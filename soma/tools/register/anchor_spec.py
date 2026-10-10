"""Which segmented structures go into the female anchor package, and which male parts each one
corresponds to.

Every entry: task (label map), label name(s), anchor name, side, kind, and a regular expression
over the male part names of public/anatomy/male/anatomy.json (lower-case, with a leading
"left "/"right " removed) restricted to one male system. Side is matched on the male part's own
`side` field. An entry whose regex is None has no male counterpart.
"""
import re

ORD = "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth".split()

MOOSE_CLASSES = ("carpal_left carpal_right clavicle_left clavicle_right femur_left femur_right fibula_left "
                 "fibula_right fingers_left fingers_right humerus_left humerus_right metacarpal_left "
                 "metacarpal_right metatarsal_left metatarsal_right patella_left patella_right radius_left "
                 "radius_right scapula_left scapula_right skull tarsal_left tarsal_right tibia_left tibia_right "
                 "toes_left toes_right ulna_left ulna_right").split()
MOOSE_MAP = {i + 1: n for i, n in enumerate(MOOSE_CLASSES)}
L6_ID = 118

CRANIAL = (r"^(ethmoid|frontal bone|parietal bone|occipital bone|temporal bone|sphenoid bone|maxilla|zygomatic bone|"
           r"nasal bone|lacrimal bone|palatine bone|vomer|inferior nasal concha)$")


def E(task, label, name, side, kind, msys=None, mrx=None, **kw):
    d = dict(task=task, labels=[label] if isinstance(label, (str, int)) else list(label), name=name, side=side,
             kind=kind, male_system=msys, male_regex=mrx)
    d.update(kw)
    return d


def sided(task, stem, name, kind, msys, mrx, fmt="{stem}_{side}", **kw):
    return [E(task, fmt.format(stem=stem, side=s), f"{s} {name}", s[0].upper(), kind, msys, mrx, **kw)
            for s in ("left", "right")]


def build():
    S = []
    # ── axial skeleton ────────────────────────────────────────────────────────────────────────
    S.append(E("total", "vertebrae_C1", "atlas (C1)", "M", "bone", "skeletal", r"^atlas$"))
    S.append(E("total", "vertebrae_C2", "axis (C2)", "M", "bone", "skeletal", r"^axis$"))
    for n in range(3, 8):
        S.append(E("total", f"vertebrae_C{n}", f"{ORD[n - 1]} cervical vertebra", "M", "bone", "skeletal",
                   rf"^{ORD[n - 1]} cervical vertebra$"))
    for n in range(1, 13):
        S.append(E("total", f"vertebrae_T{n}", f"{ORD[n - 1]} thoracic vertebra", "M", "bone", "skeletal",
                   rf"^{ORD[n - 1]} thoracic vertebra$"))
    # Six lumbar vertebrae in the donor, five in the male. Identity is anchored at both ends (T12
    # by its rib, S1 by the sacro-iliac joint); female L2..L6 map to male L1..L5 counted upward
    # from the sacrum, and female L1 (directly below T12) is donor-specific with no counterpart.
    S.append(E("total", "vertebrae_L1", "first lumbar vertebra (of six)", "M", "bone", None, None,
               note="supernumerary lumbar vertebra of this donor; no male counterpart", relabelled=True))
    for n in range(2, 7):
        lab = f"vertebrae_L{n}" if n < 6 else L6_ID
        S.append(E("total", lab, f"{ORD[n - 1]} lumbar vertebra (of six)", "M", "bone", "skeletal",
                   rf"^{ORD[n - 2]} lumbar vertebra$", relabelled=True,
                   note=f"female L{n} of 6 corresponds to male L{n - 1} of 5 (counted from the sacrum)"))
    S.append(E("total", "sacrum", "sacrum and coccyx", "M", "bone", "skeletal", r"^sacrum$", relabelled=True,
               note="TotalSegmentator S1 merged in; coccyx included"))
    for n in range(1, 13):
        S += sided("total", f"rib_{{side}}_{n}", f"{ORD[n - 1]} rib", "bone", "skeletal", rf"^{ORD[n - 1]} rib$",
                   fmt="{stem}")
    for e in S:
        if e["labels"][0] and isinstance(e["labels"][0], str) and "{side}" in e["labels"][0]:
            e["labels"] = [e["labels"][0].format(side="left" if e["side"] == "L" else "right")]
    S.append(E("total", "sternum", "sternum", "M", "bone", "skeletal", r"^(body of sternum|manubrium|xiphoid process)$"))
    S.append(E("total", "costal_cartilages", "costal cartilages", "M", "cartilage", "skeletal", r"costal cartilage$"))
    S.append(E("derived", "cranium", "cranium (skull without mandible)", "M", "bone", "skeletal", CRANIAL))
    S.append(E("craniofacial_structures", "mandible", "mandible", "M", "bone", "skeletal", r"^mandible$"))
    S.append(E("craniofacial_structures", "teeth_lower", "lower teeth", "M", "tooth", "digestive", r"^lower .* tooth$"))
    S.append(E("headneck_bones_vessels", "hyoid", "hyoid bone", "M", "bone", "skeletal", r"^hyoid bone$"))
    S.append(E("headneck_bones_vessels", "thyroid_cartilage", "thyroid cartilage", "M", "cartilage", "respiratory", r"^thyroid cartilage$"))
    S.append(E("headneck_bones_vessels", "cricoid_cartilage", "cricoid cartilage", "M", "cartilage", "respiratory", r"^cricoid cartilage$"))
    # ── appendicular skeleton ─────────────────────────────────────────────────────────────────
    for stem, nm in (("clavicula", "clavicle"), ("scapula", "scapula"), ("humerus", "humerus"), ("hip", "hip bone"),
                     ("femur", "femur")):
        S += sided("total", stem, nm, "bone", "skeletal", rf"^{nm}$")
    for stem in ("patella", "tibia", "fibula", "radius", "ulna"):
        S += sided("moose_peripheral_bones", stem, stem, "bone", "skeletal", rf"^{stem}$")
    S += sided("moose_peripheral_bones", "carpal", "carpal bones", "bone-group", "skeletal",
               r"^(scaphoid|lunate|triquetral|pisiform|trapezium|trapezoid|capitate|hamate)$")
    S += sided("moose_peripheral_bones", "metacarpal", "metacarpal bones", "bone-group", "skeletal", r"metacarpal bone$")
    S += sided("moose_peripheral_bones", "fingers", "phalanges of hand", "bone-group", "skeletal",
               r"phalanx of .*(finger|thumb)$")
    S += sided("moose_peripheral_bones", "tarsal", "tarsal bones", "bone-group", "skeletal",
               r"^(calcaneus|talus|cuboid bone|navicular bone of .* foot|.* cuneiform bone)$")
    S += sided("moose_peripheral_bones", "metatarsal", "metatarsal bones", "bone-group", "skeletal", r"metatarsal bone$")
    S += sided("moose_peripheral_bones", "toes", "phalanges of foot", "bone-group", "skeletal", r"phalanx of .* toe$")
    # ── organs ────────────────────────────────────────────────────────────────────────────────
    S.append(E("total", "brain", "brain", "M", "organ", "nervous", "@tissue=brain"))
    S.append(E("total", "spinal_cord", "spinal cord (canal contents)", "M", "organ", None, None))
    for lab, nm, rx in (("lung_upper_lobe_left", "upper lobe of left lung", r"^upper lobe of left lung$"),
                        ("lung_lower_lobe_left", "lower lobe of left lung", r"^lower lobe of left lung$"),
                        ("lung_upper_lobe_right", "upper lobe of right lung", r"^upper lobe of right lung$"),
                        ("lung_middle_lobe_right", "middle lobe of right lung", r"^middle lobe of lung$"),
                        ("lung_lower_lobe_right", "lower lobe of right lung", r"^lower lobe of right lung$")):
        S.append(E("total", lab, nm, "L" if "left" in lab else "R", "organ", "respiratory", rx, full_name_regex=True))
    S.append(E("total", "heart", "heart", "M", "organ", "cardiovascular", "@tissue=heart"))
    S.append(E("total", "liver", "liver", "M", "organ", "digestive", r"^(hepatovenous segment .*|caudate lobe of liver)$"))
    S.append(E("total", "spleen", "spleen", "M", "organ", "lymphatic", r"^spleen$"))
    S += sided("total", "kidney", "kidney", "organ", "urinary", r"^kidney$")
    S += sided("total", "adrenal_gland", "adrenal gland", "organ", "endocrine", r"^adrenal gland$")
    S.append(E("total", "pancreas", "pancreas", "M", "organ", "digestive", r"^pancreas$"))
    S.append(E("total", "gallbladder", "gallbladder", "M", "organ", "digestive", r"^gallbladder$"))
    S.append(E("total", "stomach", "stomach", "M", "organ", "digestive", r"^stomach$"))
    S.append(E("total", "esophagus", "esophagus", "M", "organ", "digestive", r"^esophagus$"))
    S.append(E("total", "duodenum", "duodenum", "M", "organ", "digestive", r"^duodenum$"))
    S.append(E("total", "small_bowel", "jejunum and ileum", "M", "organ", "digestive", r"part of (jejunum|ileum)$"))
    S.append(E("total", "colon", "colon and rectum", "M", "organ", "digestive",
               r"^(ascending colon|transverse colon|descending colon|rectum)$"))
    S.append(E("total", "urinary_bladder", "urinary bladder", "M", "organ", "urinary", r"^urinary bladder$"))
    S.append(E("total", "thyroid_gland", "thyroid gland", "M", "organ", None, None))
    S.append(E("total", "trachea", "trachea", "M", "organ", "respiratory", r"^trachea$"))
    # ── vessel trunks ─────────────────────────────────────────────────────────────────────────
    S.append(E("total", "aorta", "aorta", "M", "vessel", "cardiovascular",
               r"^(ascending aorta|arch of aorta|descending thoracic aorta|abdominal aorta)$"))
    S.append(E("total", "superior_vena_cava", "superior vena cava", "M", "vessel", "cardiovascular", r"^superior vena cava$"))
    S.append(E("total", "inferior_vena_cava", "inferior vena cava", "M", "vessel", "cardiovascular", r"^inferior vena cava$"))
    S.append(E("total", "portal_vein_and_splenic_vein", "portal and splenic veins", "M", "vessel", "cardiovascular",
               r"^(hepatic portal vein|splenic vein)$"))
    S.append(E("total", "pulmonary_vein", "pulmonary veins", "M", "vessel", "cardiovascular", r"^(superior|inferior) pulmonary vein$"))
    S.append(E("total", "brachiocephalic_trunk", "brachiocephalic trunk", "M", "vessel", "cardiovascular", r"^brachiocephalic artery$"))
    for stem, nm, rx in (("subclavian_artery", "subclavian artery", r"^subclavian artery$"),
                         ("common_carotid_artery", "common carotid artery", r"^common carotid artery$"),
                         ("brachiocephalic_vein", "brachiocephalic vein", r"^brachiocephalic vein$"),
                         ("iliac_artery", "common iliac artery", r"^common iliac artery$"),
                         ("iliac_vena", "common iliac vein", r"^common iliac vein$")):
        S += sided("total", stem, nm, "vessel", "cardiovascular", rx)
    S += sided("headneck_bones_vessels", "internal_jugular_vein", "internal jugular vein", "vessel", "cardiovascular",
               r"^internal jugular vein$")
    S += sided("headneck_bones_vessels", "internal_carotid_artery", "internal carotid artery", "vessel", "cardiovascular",
               r"^internal carotid artery$")
    # ── muscle groups ─────────────────────────────────────────────────────────────────────────
    for stem in ("gluteus_maximus", "gluteus_medius", "gluteus_minimus"):
        S += sided("total", stem, stem.replace("_", " "), "muscle", "muscular", rf"^{stem.replace('_', ' ')}$")
    S += sided("abdominal_muscles", "psoas_major", "psoas major", "muscle", "muscular", r"^psoas major$")
    S += sided("derived", "iliacus", "iliacus", "muscle", "muscular", r"^iliacus$",
               note="TotalSegmentator iliopsoas minus abdominal_muscles psoas major")
    for stem, nm, rx in (("pectoralis_major", "pectoralis major", r"part of .*pectoralis major$|^pectoralis major$"),
                         ("rectus_abdominis", "rectus abdominis", r"^rectus abdominis$"),
                         ("serratus_anterior", "serratus anterior", r"^serratus anterior$"),
                         ("latissimus_dorsi", "latissimus dorsi", r"^latissimus dorsi$"),
                         ("external_oblique", "external oblique", r"^external oblique$"),
                         ("internal_oblique", "internal oblique", r"^internal oblique$"),
                         ("erector_spinae", "erector spinae", r"^(iliocostalis|longissimus|spinalis)( (lumborum|thoracis|cervicis))?$"),
                         ("transversospinalis", "transversospinalis", r"^(multifidus|semispinalis thoracis|lumbar rotator|thoracic rotator)$"),
                         ("quadratus_lumborum", "quadratus lumborum", r"^quadratus lumborum$")):
        S += sided("abdominal_muscles", stem, nm, "muscle", "muscular", rx)
    S += sided("derived", "trapezius", "trapezius", "muscle", "muscular", r"part of .*trapezius$|^trapezius$",
               note="union of the abdominal_muscles and headneck_muscles trapezius labels")
    for stem, nm, rx in (("sternocleidomastoid", "sternocleidomastoid", r"^sternocleidomastoid$"),
                         ("levator_scapulae", "levator scapulae", r"^levator scapulae$"),
                         ("anterior_scalene", "scalenus anterior", r"^scalenus anterior$"),
                         ("middle_scalene", "scalenus medius", r"^scalenus medius$"),
                         ("posterior_scalene", "scalenus posterior", r"^scalenus posterior$"),
                         ("platysma", "platysma", r"^platysma$"),
                         ("sterno_thyroid", "sternothyroid", r"^sternothyroid$"),
                         ("prevertebral", "prevertebral muscles", r"^longus capitis$|longus colli$")):
        S += sided("headneck_muscles", stem, nm, "muscle", "muscular", rx)
    S.append(E("headneck_muscles", "inferior_pharyngeal_constrictor", "inferior pharyngeal constrictor", "M", "muscle",
               "muscular", r"^inferior pharyngeal constrictor$"))
    # ── surface and donor soft tissue (valid only as scanned) ────────────────────────────────
    S.append(E("derived", "body_surface", "body surface (skin outline)", "M", "surface", "integumentary", r"^skin$",
               pose="scanned-only"))
    S += sided("derived", "breast", "breast", "surface", None, None, pose="scanned-only",
               note="TotalSegmentator `breasts` label split at the midline; supine, flattened")
    return S


# Manual quality overrides: label-name pattern -> (flag, reason)
QUALITY = [
    (r"^lung_", "poor", "post-mortem lung: collapsed, fluid-filled, fragmented label"),
    (r"^heart$", "usable", "post-mortem heart; unenhanced CT, no chamber detail"),
    (r"^(esophagus|trachea)$", "usable", "collapsed lumen, fragmented label"),
    (r"^(small_bowel|colon|stomach|duodenum)$", "usable", "hollow viscus in a supine cadaver; hands rest on the abdomen"),
    (r"^(radius|ulna)_right$", "poor", "clipped by the 480 mm field of view at the right elbow"),
    (r"^humerus_right$", "usable", "distal end touches the field-of-view edge"),
    (r"^(fingers|toes)_", "usable", "group label; digits curled, individual phalanges not separated"),
    (r"^(carpal|metacarpal|tarsal|metatarsal)_", "usable", "group label, bones not individually separated"),
    (r"^external_oblique", "usable", "thin sheet muscle, fragmented label"),
    (r"^(platysma|sterno_thyroid|posterior_scalene|prevertebral|inferior_pharyngeal)", "usable", "small thin muscle at 1 mm resolution"),
    (r"^body_surface$", "usable", "supine; arms fused to trunk and hands to pelvis; laterally clipped by the field of view"),
    (r"^breast_", "usable", "supine, gravity-flattened; as-scanned only"),
    (r"^(femur)_", "good", "crosses the corrected mid-thigh seam (0.4 mm residual)"),
    (r"^spinal_cord$", "usable", "label covers the dural sac contents, not the cord alone"),
    (r"^teeth_lower$", "usable", "group label"),
    (r"^(internal_carotid_artery|common_carotid_artery|brachiocephalic_trunk|pulmonary_vein|subclavian_artery)", "usable", "small vessel on unenhanced CT"),
    (r"^costal_cartilages$", "usable", "single label for all cartilages; partly calcified, fragmented"),
    (r"^(latissimus_dorsi|pectoralis_major|trapezius)_", "usable", "attaches to the re-posed humerus/scapula; shape is as scanned"),
]


def quality_for(label):
    for rx, flag, why in QUALITY:
        if re.search(rx, str(label)):
            return flag, why
    return None
