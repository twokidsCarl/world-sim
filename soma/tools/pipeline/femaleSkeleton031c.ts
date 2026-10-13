// 骨架 031ce88117d19693 的各骨包围盒（毫米，取整）：体形目标包 female-target 和 female-face-target 是按这副骨架做的。
// 由那一版构建的 anatomy.json 抄录（输出的骨网格是简化过的，个别小骨的包围盒与未简化的相差几毫米，所以要与同样简化过的比），供 femaleShape.ts 核对
// “现在的骨架与目标包所依据的骨架相差多少”。骨架换代、目标包重做之后，这个文件即可删除。
// Bounding boxes (mm, rounded) of every bone of skeleton 031ce88117d19693, the one the body-shape target
// packages female-target and female-face-target were made for. Copied from the anatomy.json of that build
// (shipped bone meshes are simplified, and the box of a small bone can be millimetres off the unsimplified one, so the comparison must be made on equally simplified meshes), so that
// femaleShape.ts can check how far the present skeleton is from the one a target package was made for.
// Once the skeleton moves on and the target packages are re-made this file can go.

export const SKELETON_031C_KEY = '031ce88117d19693'

/** 骨部件 id → [x0, y0, z0, x1, y1, z1]（毫米） / bone part id → [x0, y0, z0, x1, y1, z1] (mm) */
export const SKELETON_031C_BOXES_MM: Record<string, readonly [number, number, number, number, number, number]> = {
  VD_calcaneus_left: [71, -62, 14, 129, -9, 93], // Left calcaneus
  VD_calcaneus_right: [-130, -70, 21, -74, -16, 100], // Right calcaneus
  VD_cuboid_left: [102, -44, 81, 140, -15, 110], // Left cuboid bone
  VD_cuboid_right: [-144, -50, 86, -105, -22, 115], // Right cuboid bone
  VD_intermediatecuneiform_left: [101, -32, 107, 123, -9, 130], // Left intermediate cuneiform bone
  VD_intermediatecuneiform_right: [-127, -38, 113, -105, -16, 138], // Right intermediate cuneiform bone
  VD_lateralcuneiform_left: [109, -36, 100, 134, -11, 123], // Left lateral cuneiform bone
  VD_lateralcuneiform_right: [-139, -42, 106, -113, -17, 130], // Right lateral cuneiform bone
  VD_medialcuneiform_left: [88, -43, 107, 112, -13, 140], // Left medial cuneiform bone
  VD_medialcuneiform_right: [-118, -50, 112, -92, -20, 147], // Right medial cuneiform bone
  VD_navicular_left: [80, -33, 92, 117, -1, 118], // Navicular bone of left foot
  VD_navicular_right: [-121, -39, 98, -84, -8, 124], // Navicular bone of right foot
  VD_talus_left: [68, -23, 41, 111, 13, 104], // Left talus
  VD_talus_right: [-114, -31, 48, -71, 2, 110], // Right talus
  VF_clavicula_left: [18, 1220, 52, 153, 1248, 119], // Left clavicle
  VF_clavicula_right: [-154, 1214, 46, -10, 1249, 117], // Right clavicle
  VF_femur_left: [41, 343, 42, 154, 753, 107], // Left femur
  VF_femur_right: [-155, 337, 43, -42, 751, 110], // Right femur
  VF_fibula_left: [94, -14, 33, 137, 329, 64], // Left fibula
  VF_fibula_right: [-140, -24, 38, -96, 325, 71], // Right fibula
  VF_hip_left: [1, 666, -8, 131, 876, 128], // Left hip bone
  VF_hip_right: [-130, 664, -8, -1, 876, 126], // Right hip bone
  VF_humerus_left: [155, 929, 36, 247, 1223, 86], // Left humerus
  VF_humerus_right: [-247, 928, 37, -153, 1224, 87], // Right humerus
  VF_hyoid: [-24, 1321, 96, 21, 1340, 129], // Hyoid bone
  VF_mandible: [-56, 1326, 86, 59, 1402, 172], // Mandible
  VF_patella_left: [67, 348, 107, 112, 397, 131], // Left patella
  VF_patella_right: [-112, 345, 109, -67, 392, 134], // Right patella
  VF_radius_left: [230, 731, 53, 289, 937, 117], // Left radius
  VF_radius_right: [-302, 737, 53, -241, 943, 114], // Right radius
  VF_rib_left_1: [38, 1212, 44, 78, 1279, 118], // Left first rib
  VF_rib_left_10: [38, 953, -11, 137, 1087, 82], // Left tenth rib
  VF_rib_left_11: [37, 927, -11, 129, 1057, 76], // Left eleventh rib
  VF_rib_left_12: [35, 930, -4, 106, 1023, 28], // Left twelfth rib
  VF_rib_left_2: [36, 1187, 24, 105, 1267, 129], // Left second rib
  VF_rib_left_3: [36, 1163, 7, 123, 1249, 135], // Left third rib
  VF_rib_left_4: [39, 1133, -2, 128, 1231, 140], // Left fourth rib
  VF_rib_left_5: [38, 1094, -3, 133, 1210, 139], // Left fifth rib
  VF_rib_left_6: [38, 1067, -8, 136, 1187, 135], // Left sixth rib
  VF_rib_left_7: [38, 1004, -10, 134, 1163, 134], // Left seventh rib
  VF_rib_left_8: [38, 1022, -11, 137, 1139, 120], // Left eighth rib
  VF_rib_left_9: [40, 977, -11, 142, 1115, 111], // Left ninth rib
  VF_rib_right_1: [-74, 1207, 46, -31, 1276, 116], // Right first rib
  VF_rib_right_10: [-131, 945, -11, -32, 1084, 95], // Right tenth rib
  VF_rib_right_11: [-120, 921, -11, -30, 1054, 80], // Right eleventh rib
  VF_rib_right_12: [-97, 918, -2, -30, 1016, 34], // Right twelfth rib
  VF_rib_right_2: [-101, 1182, 27, -33, 1261, 127], // Right second rib
  VF_rib_right_3: [-114, 1151, 13, -31, 1243, 131], // Right third rib
  VF_rib_right_4: [-120, 1118, 3, -33, 1223, 136], // Right fourth rib
  VF_rib_right_5: [-122, 1086, -2, -31, 1204, 138], // Right fifth rib
  VF_rib_right_6: [-125, 1059, -8, -31, 1180, 135], // Right sixth rib
  VF_rib_right_7: [-123, 996, -9, -31, 1156, 134], // Right seventh rib
  VF_rib_right_8: [-125, 1014, -11, -31, 1133, 122], // Right eighth rib
  VF_rib_right_9: [-131, 969, -11, -33, 1109, 112], // Right ninth rib
  VF_sacrum: [-52, 731, -23, 54, 855, 60], // Sacrum
  VF_scapula_left: [69, 1086, -23, 178, 1232, 85], // Left scapula
  VF_scapula_right: [-179, 1084, -23, -75, 1236, 84], // Right scapula
  VF_tibia_left: [48, -2, 37, 125, 349, 102], // Left tibia
  VF_tibia_right: [-127, -11, 43, -49, 345, 103], // Right tibia
  VF_ulna_left: [208, 735, 31, 253, 966, 109], // Left ulna
  VF_ulna_right: [-268, 740, 28, -220, 972, 104], // Right ulna
  VF_vertebrae_C1: [-40, 1360, 54, 36, 1382, 100], // Atlas
  VF_vertebrae_C2: [-29, 1344, 48, 23, 1382, 97], // Axis
  VF_vertebrae_C3: [-29, 1329, 52, 25, 1348, 94], // Third cervical vertebra
  VF_vertebrae_C4: [-30, 1314, 52, 25, 1335, 91], // Fourth cervical vertebra
  VF_vertebrae_C5: [-30, 1300, 48, 27, 1323, 87], // Fifth cervical vertebra
  VF_vertebrae_C6: [-29, 1285, 36, 27, 1310, 81], // Sixth cervical vertebra
  VF_vertebrae_C7: [-32, 1268, 18, 33, 1298, 76], // Seventh cervical vertebra
  VF_vertebrae_L2: [-32, 958, -23, 41, 1008, 62], // First lumbar vertebra
  VF_vertebrae_L3: [-39, 919, -21, 44, 972, 64], // Second lumbar vertebra
  VF_vertebrae_L4: [-39, 889, -10, 45, 941, 70], // Third lumbar vertebra
  VF_vertebrae_L5: [-38, 861, -3, 43, 910, 73], // Fourth lumbar vertebra
  VF_vertebrae_L6: [-44, 835, 0, 43, 880, 71], // Fifth lumbar vertebra
  VF_vertebrae_T1: [-36, 1250, 6, 37, 1283, 68], // First thoracic vertebra
  VF_vertebrae_T10: [-27, 1049, -24, 34, 1089, 48], // Tenth thoracic vertebra
  VF_vertebrae_T11: [-24, 1025, -21, 31, 1064, 48], // Eleventh thoracic vertebra
  VF_vertebrae_T12: [-21, 997, -19, 28, 1040, 51], // Twelfth thoracic vertebra
  VF_vertebrae_T2: [-32, 1229, -2, 34, 1267, 61], // Second thoracic vertebra
  VF_vertebrae_T3: [-30, 1209, -11, 31, 1246, 56], // Third thoracic vertebra
  VF_vertebrae_T4: [-27, 1187, -17, 31, 1225, 53], // Fourth thoracic vertebra
  VF_vertebrae_T5: [-27, 1161, -19, 31, 1203, 48], // Fifth thoracic vertebra
  VF_vertebrae_T6: [-27, 1137, -22, 31, 1182, 48], // Sixth thoracic vertebra
  VF_vertebrae_T7: [-29, 1112, -22, 30, 1159, 44], // Seventh thoracic vertebra
  VF_vertebrae_T8: [-27, 1089, -23, 31, 1136, 44], // Eighth thoracic vertebra
  VF_vertebrae_T9: [-27, 1070, -22, 34, 1112, 46], // Ninth thoracic vertebra
  W_FJ3153: [3, 1091, 134, 21, 1113, 148], // Xiphoid process
  W_FJ3178: [-9, 1108, 122, 29, 1198, 149], // Body of sternum
  W_FJ3179: [145, -48, 219, 155, -41, 231], // Distal phalanx of left second toe
  W_FJ3180: [158, -46, 210, 166, -41, 221], // Distal phalanx of left third toe
  W_FJ3181: [165, -46, 195, 173, -40, 205], // Distal phalanx of left fourth toe
  W_FJ3182: [117, -55, 209, 138, -45, 233], // Distal phalanx of left big toe
  W_FJ3183: [308, 592, 160, 318, 604, 177], // Distal phalanx of left index finger
  W_FJ3184: [231, 605, 161, 238, 617, 175], // Distal phalanx of left little finger
  W_FJ3185: [172, -48, 178, 179, -43, 187], // Distal phalanx of left little toe
  W_FJ3186: [280, 584, 169, 289, 596, 186], // Distal phalanx of left middle finger
  W_FJ3187: [256, 594, 170, 263, 603, 185], // Distal phalanx of left ring finger
  W_FJ3188: [315, 645, 146, 329, 665, 161], // Distal phalanx of left thumb
  W_FJ3189: [-167, -53, 222, -157, -46, 234], // Distal phalanx of right second toe
  W_FJ3190: [-177, -51, 213, -168, -46, 223], // Distal phalanx of right third toe
  W_FJ3191: [-183, -52, 197, -175, -46, 207], // Distal phalanx of right fourth toe
  W_FJ3192: [-150, -61, 215, -129, -51, 238], // Distal phalanx of right big toe
  W_FJ3193: [-331, 597, 155, -322, 610, 172], // Distal phalanx of right index finger
  W_FJ3194: [-251, 610, 156, -243, 622, 170], // Distal phalanx of right little finger
  W_FJ3195: [-187, -56, 180, -179, -51, 189], // Distal phalanx of right little toe
  W_FJ3196: [-302, 588, 165, -293, 601, 181], // Distal phalanx of right middle finger
  W_FJ3197: [-276, 599, 165, -268, 608, 180], // Distal phalanx of right ring finger
  W_FJ3198: [-343, 651, 142, -329, 672, 157], // Distal phalanx of right thumb
  W_FJ3199: [-18, 1398, 118, 22, 1433, 165], // Ethmoid
  W_FJ3200: [-56, 1423, 106, 59, 1521, 172], // Frontal bone
  W_FJ3240: [283, 681, 118, 312, 715, 143], // Left first metacarpal bone
  W_FJ3241: [95, -62, 128, 121, -20, 190], // Left first metatarsal bone
  W_FJ3243: [272, 646, 110, 297, 707, 131], // Left second metacarpal bone
  W_FJ3244: [112, -58, 122, 136, -15, 187], // Left second metatarsal bone
  W_FJ3246: [263, 648, 106, 278, 707, 131], // Left third metacarpal bone
  W_FJ3247: [119, -57, 119, 148, -18, 181], // Left third metatarsal bone
  W_FJ3249: [250, 653, 108, 264, 708, 132], // Left fourth metacarpal bone
  W_FJ3250: [124, -56, 108, 157, -24, 171], // Left fourth metatarsal bone
  W_FJ3252: [237, 661, 112, 257, 711, 135], // Left fifth metacarpal bone
  W_FJ3253: [130, -57, 90, 168, -30, 159], // Left fifth metatarsal bone
  W_FJ3257: [263, 704, 103, 279, 728, 121], // Left capitate
  W_FJ3261: [249, 705, 103, 265, 726, 125], // Left hamate
  W_FJ3263: [5, 1385, 132, 16, 1400, 165], // Left inferior nasal concha
  W_FJ3265: [9, 1399, 150, 20, 1428, 163], // Left lacrimal bone
  W_FJ3266: [105, -65, 171, 112, -59, 182], // Sesamoid bone of left foot
  W_FJ3268: [251, 722, 100, 269, 735, 119], // Left lunate
  W_FJ3269: [0, 1369, 123, 47, 1432, 174], // Left maxilla
  W_FJ3270: [113, -65, 167, 121, -59, 181], // Sesamoid bone of left foot
  W_FJ3272: [0, 1406, 165, 11, 1432, 179], // Left nasal bone
  W_FJ3273: [0, 1371, 105, 28, 1414, 150], // Left palatine bone
  W_FJ3274: [-6, 1417, -1, 70, 1527, 129], // Left parietal bone
  W_FJ3276: [245, 715, 117, 253, 728, 127], // Left pisiform
  W_FJ3278: [264, 717, 102, 286, 735, 121], // Left scaphoid
  W_FJ3281: [13, 1374, 41, 68, 1448, 131], // Left temporal bone
  W_FJ3283: [279, 705, 112, 293, 727, 129], // Left trapezium
  W_FJ3284: [274, 704, 107, 286, 716, 122], // Left trapezoid
  W_FJ3285: [246, 714, 104, 257, 729, 120], // Left triquetral
  W_FJ3287: [32, 1383, 121, 60, 1435, 159], // Left zygomatic bone
  W_FJ3290: [-19, 1190, 97, 27, 1240, 134], // Manubrium
  W_FJ3291: [253, 599, 148, 264, 622, 172], // Middle phalanx of left ring finger
  W_FJ3292: [-277, 604, 143, -266, 627, 167], // Middle phalanx of right ring finger
  W_FJ3293: [138, -47, 207, 151, -39, 222], // Middle phalanx of left second toe
  W_FJ3294: [151, -46, 199, 163, -39, 214], // Middle phalanx of left third toe
  W_FJ3295: [160, -47, 186, 171, -40, 198], // Middle phalanx of left fourth toe
  W_FJ3296: [300, 600, 142, 315, 619, 162], // Middle phalanx of left index finger
  W_FJ3297: [231, 616, 147, 241, 635, 164], // Middle phalanx of left little finger
  W_FJ3298: [169, -49, 174, 177, -42, 181], // Middle phalanx of left little toe
  W_FJ3299: [275, 592, 148, 288, 616, 172], // Middle phalanx of left middle finger
  W_FJ3300: [-163, -54, 210, -149, -46, 226], // Middle phalanx of right second toe
  W_FJ3301: [-173, -54, 201, -161, -46, 216], // Middle phalanx of right third toe
  W_FJ3302: [-180, -55, 189, -169, -46, 200], // Middle phalanx of right fourth toe
  W_FJ3303: [-329, 606, 137, -315, 625, 157], // Middle phalanx of right index finger
  W_FJ3304: [-255, 620, 142, -244, 639, 159], // Middle phalanx of right little finger
  W_FJ3305: [-184, -58, 177, -177, -52, 183], // Middle phalanx of right little toe
  W_FJ3306: [-302, 597, 144, -289, 622, 167], // Middle phalanx of right middle finger
  W_FJ3309: [-56, 1377, -5, 56, 1476, 104], // Occipital bone
  W_FJ3310: [-142, -70, 191, -112, -51, 223], // Proximal phalanx of right big toe
  W_FJ3311: [140, -55, 176, 157, -40, 202], // Proximal phalanx of left third toe
  W_FJ3312: [149, -54, 167, 166, -40, 189], // Proximal phalanx of left fourth toe
  W_FJ3313: [286, 614, 123, 308, 650, 147], // Proximal phalanx of left index finger
  W_FJ3314: [234, 632, 129, 246, 664, 151], // Proximal phalanx of left little finger
  W_FJ3315: [158, -55, 153, 176, -43, 176], // Proximal phalanx of left little toe
  W_FJ3316: [265, 613, 124, 284, 652, 154], // Proximal phalanx of left middle finger
  W_FJ3317: [250, 618, 126, 262, 657, 153], // Proximal phalanx of left ring finger
  W_FJ3318: [302, 660, 133, 323, 687, 153], // Proximal phalanx of left thumb
  W_FJ3319: [-156, -62, 188, -136, -47, 214], // Proximal phalanx of right second toe
  W_FJ3320: [-167, -63, 180, -148, -47, 205], // Proximal phalanx of right third toe
  W_FJ3321: [-175, -63, 170, -156, -48, 191], // Proximal phalanx of right fourth toe
  W_FJ3322: [-323, 620, 119, -301, 656, 142], // Proximal phalanx of right index finger
  W_FJ3323: [-262, 636, 124, -247, 668, 145], // Proximal phalanx of right little finger
  W_FJ3324: [-183, -65, 156, -165, -53, 179], // Proximal phalanx of right little toe
  W_FJ3325: [-299, 618, 120, -282, 657, 149], // Proximal phalanx of right middle finger
  W_FJ3326: [-277, 623, 121, -265, 661, 148], // Proximal phalanx of right ring finger
  W_FJ3327: [-336, 667, 131, -315, 695, 150], // Proximal phalanx of right thumb
  W_FJ3328: [127, -55, 184, 146, -40, 210], // Proximal phalanx of left second toe
  W_FJ3329: [103, -62, 184, 131, -45, 218], // Proximal phalanx of left big toe
  W_FJ3350: [-325, 689, 113, -296, 721, 140], // Right first metacarpal bone
  W_FJ3351: [-129, -69, 132, -101, -26, 197], // Right first metatarsal bone
  W_FJ3352: [-313, 652, 105, -287, 712, 127], // Right second metacarpal bone
  W_FJ3353: [-145, -66, 125, -116, -21, 191], // Right second metatarsal bone
  W_FJ3354: [-294, 653, 100, -277, 712, 127], // Right third metacarpal bone
  W_FJ3355: [-156, -65, 122, -124, -26, 186], // Right third metatarsal bone
  W_FJ3356: [-278, 658, 103, -266, 713, 127], // Right fourth metacarpal bone
  W_FJ3357: [-164, -66, 112, -128, -32, 175], // Right fourth metatarsal bone
  W_FJ3358: [-271, 665, 106, -252, 716, 129], // Right fifth metacarpal bone
  W_FJ3359: [-174, -67, 94, -134, -40, 162], // Right fifth metatarsal bone
  W_FJ3361: [-293, 709, 99, -277, 733, 118], // Right capitate
  W_FJ3367: [-279, 709, 99, -264, 731, 121], // Right hamate
  W_FJ3369: [-14, 1382, 127, -1, 1400, 164], // Right inferior nasal concha
  W_FJ3371: [-14, 1403, 150, -4, 1428, 163], // Right lacrimal bone
  W_FJ3372: [-120, -72, 177, -113, -66, 188], // Sesamoid bone of right foot
  W_FJ3374: [-282, 726, 95, -265, 740, 115], // Right lunate
  W_FJ3375: [-42, 1369, 125, 2, 1432, 175], // Right maxilla
  W_FJ3376: [-129, -72, 172, -121, -66, 188], // Sesamoid bone of right foot
  W_FJ3378: [-5, 1405, 165, 2, 1432, 180], // Right nasal bone
  W_FJ3379: [-25, 1372, 105, 2, 1413, 150], // Right palatine bone
  W_FJ3380: [-69, 1416, 0, 5, 1528, 127], // Right parietal bone
  W_FJ3382: [-267, 720, 113, -259, 732, 123], // Right pisiform
  W_FJ3383: [-299, 722, 98, -278, 740, 118], // Right scaphoid
  W_FJ3386: [-66, 1376, 42, -10, 1448, 133], // Right temporal bone
  W_FJ3388: [-306, 710, 107, -293, 732, 125], // Right trapezium
  W_FJ3389: [-300, 709, 102, -288, 721, 118], // Right trapezoid
  W_FJ3390: [-271, 718, 100, -259, 734, 115], // Right triquetral
  W_FJ3392: [-57, 1386, 122, -30, 1435, 159], // Right zygomatic bone
  W_FJ3394: [-50, 1382, 93, 52, 1445, 142], // Sphenoid bone
  W_FJ3395: [-5, 1379, 111, 6, 1417, 162], // Vomer
}
