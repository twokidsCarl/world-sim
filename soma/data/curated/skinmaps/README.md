# 皮肤分区图的定义文件

本目录是皮节图和皮神经分布区图的全部“可审校内容”。改这里的 JSON 后运行
`bun tools/skinmaps/run.ts male`（或 `female`）即可重建，无需改代码。

**这些是为教学而构建的示意图。** 皮节因人而异，各家发表的图谱互有出入，相邻区域实际相互重叠；
全部内容均未经临床医师审校（`status: unreviewed`）。

| 文件 | 内容 |
|---|---|
| `landmarks.json` | 体表标志和肢体坐标架，由模型的具名骨骼计算 |
| `dermatomes.json` | 皮节图：方案说明、出处、屏障（轴线）、各皮节的种子和关键感觉点、独立检查点 |
| `cutaneous.json` | 皮神经分布区图：各区的神经部件、种子、节段来源及出处、分布描述及出处 |
| `innervation.<body>.json` | 由程序生成的对照表（皮节 → 神经根/神经节部件；分布区 → 神经部件 → 上级神经链 → 节段），供日后的疼痛模型使用 |

## 语法

`{side}` 在左侧代入 `left`、右侧代入 `right`。方向词：`lat`（该侧自身的外侧）、`med`、`sup`、`inf`、
`ant`、`post`，可用 `+` 组合并加权，如 `post+0.7*inf`。偏移量为 `[外侧, 上, 前]`，单位米。

三维点（PointExpr）：

- `"名称"`：引用 `landmarks.json` 中的点
- `{ "part": 部件名, "pick": "centroid" }`：部件顶点的平均位置（缺省）
- `{ "part": …, "pick": { "extreme": 方向, "within": { "axis": 方向, "frac": [a, b] }, "half": true } }`：
  沿某方向最远的顶点；`within` 先把部件限制在沿 `axis` 的一段（0 为该方向最远端）；`half` 只取本侧一半（用于正中的骨）
- `{ "part": …, "pick": { "slice": { "axis": 方向, "frac": [a, b] } } }`：该段顶点的平均位置
- `{ "lerp": [A, B, t] }`、`{ "xyz": [A, B, C] }`（x 取自 A，y 取自 B，z 取自 C）、`{ "offset": [A, [外, 上, 前]] }`
- `{ "shift": [A, from, to] }`：把 A 平移 (to − from)，用于把一处量得的位移照搬到另一处
- `{ "frame": 坐标架, "t": t }`：坐标架轴线上的点（0 起点，1 终点）
- `{ "nervePoint": 神经部件名, "x": A, "back": true }`：神经中心线与过 A 的矢状面的交点

皮肤上的点（SkinExpr）：

- `{ "at": 点, "to": "nearest" }`：该点位于其下方的最近皮肤顶点；`"nearestAny"` 不要求在其下方
- `{ "at": 点, "to": 方向 }`：自该点沿方向发出射线，取与皮肤外壁的第一个交点
- `{ "frame": 坐标架, "t": t, "deg": 角度 }`：自肢体轴线向外的射线；0° 前（屈侧；手为掌侧、足为足背），
  90° 外侧，180° 后，270° 内侧。`{ "at": 点, "frame": …, "deg": … }` 以给定点为起点
- `{ "nerveCross": 神经部件名, "x": A }`：神经的体表投影与过 A 的矢状面在躯干前面的交点
- `{ "dimple": { "between": [A, B], "minDepthMm": 5, "near": 点, "withinMm": 50, "fallback": SkinExpr } }`：前正中线上 A、B 之间最深的凹点（脐）；凹陷不足 minDepthMm（皮肤上没有做出脐），或其高度与 `near` 相差超过 `withinMm`（找到的是别的凹陷）时用 fallback
- `{ "frameScan": { "frame": …, "deg": …, "t": [a, b], "maxMm": 80 } }`：沿轴线自 a 向 b，第一个沿该方向 maxMm 内有皮肤的位置（如腋窝顶）
- `{ "first": [SkinExpr, …] }`：依次尝试，取第一个能求出的（语法仍在；腋窝顶 `K_T2` 原先用它为没有腋窝的占位皮肤留退路，现已不用）
- 坐标架表达式中的 `t` 也可写成 `{ "from": 标志点, "plus": 0.06 }`：相对某标志点沿轴的位置

射线自体内发出，取的是它穿出皮肤的那一点（皮肤法线与射线同向）；两处皮肤互相贴合或穿插时（上臂内侧对胸壁），先碰到的另一处皮肤的背面会被跳过。
躯干坐标架的 `armLimit` / `armLimitAbove`：在 armLimitAbove 的高度以上（躯干与上臂连成一体），径向投影落在 armLimit 以外侧的不算躯干皮肤。

种子（每个分区的 `seeds`）：

- `{ "curve": [SkinExpr 或 { "nerve": 名称, "project": "trunkRadial", "clip": … }, …] }`：依次相连的曲线
- `{ "nerve": [名称…], "maxDepthMm": 15, "where": { "frame": …, "t": [a, b] } }`：神经中心线距皮肤不超过给定深度的部分
- 可选：`"pin": true`（关键点，保持标签）、`"widthMm"`（带宽度的种子）、`"offsetMm"`（让先/让后）
- 神经种子可加 `"facing": { "frame": …, "deg": … }`：只取投影到朝向该方向的皮肤上的点（如手的 180 = 手背）
- 神经种子可加 `"clip": { "dir": 方向, "beyond": 点, "before": 点 }`，或这样的对象组成的数组（逐个生效）：只取神经的某一段（通常是终末段）；`maxDepthMm` 在整条神经都更深时自动放宽到其最浅处 + 5 mm
- 神经种子可加 `"bridge": true`：在该分支第一个和最后一个够浅的点之间，沿神经走行连成一条种子线（中间一度变深也不断开）；只用于穿出深筋膜后一直走在皮下的皮神经
- `{ "tags": [1] }`：带有这些标签的皮肤顶点作种子（开口皮肤包的 vertex-tags.u8：1 上唇缘，2 下唇缘，4/6 上睑缘，5/7 下睑缘）。没有标签的皮肤上为空。用来让分区止于口裂和睑裂
- 任何种子可加 `"ifPart": 部件名` / `"unlessPart": 部件名`：只在模型里有 / 没有该部件时使用（男性外生殖器的种子以阴茎头、睾丸定位；没有这些部件的人体用按耻骨联合定位的通用种子）

开口的皮肤（有 `skin-source.u32` 的人体）：睑缘内卷（标签 8、9）和口腔袋（10–12）是头内的构造面，不参与分区，在 `skinmaps.bin` 里恒为 255；上、下唇缘的顶点重合但不相连，分区止于口裂。

`dermatomes.json` 的 `checks`（独立检查点）中，`at` 可以是皮肤上的一点，也可以是 `{ "over": 部件名 }`：
取该部件正前方皮肤中面积最大的皮节。`landmarks.json` 的 `notes` 说明个别标志的取法。

`barriers` 是标签扩散不能越过的曲线（肢体的腹侧、背侧轴线）。

---

# Definition files of the skin maps

This directory holds everything a reviewer may want to correct in the dermatome map and the
cutaneous nerve territory map. Edit the JSON, run `bun tools/skinmaps/run.ts male` (or `female`),
and the maps are rebuilt; no code change is needed.

**These are constructed teaching maps.** Dermatomes vary between people, published maps disagree,
and neighbouring areas really overlap; nothing here has been reviewed by a clinician
(`status: unreviewed`).

| File | Content |
|---|---|
| `landmarks.json` | Surface landmarks and limb frames, computed from the model's named bones |
| `dermatomes.json` | Dermatome map: scheme, sources, barriers (axial lines), seeds and key sensory point of every dermatome, independent checkpoints |
| `cutaneous.json` | Cutaneous nerve territories: nerve parts, seeds, root values with source, territory description with source |
| `innervation.<body>.json` | Generated lookup tables (dermatome → root / ganglion parts; territory → nerve parts → parent chain → segments) for the later pain model |

## Grammar

`{side}` becomes `left` or `right`. Directions: `lat` (each side's own lateral), `med`, `sup`,
`inf`, `ant`, `post`, combined and weighted with `+`, e.g. `post+0.7*inf`. Offsets are
`[lateral, superior, anterior]` in metres.

3D points (PointExpr):

- `"name"`: a point of `landmarks.json`
- `{ "part": name, "pick": "centroid" }`: mean position of the part's vertices (default)
- `{ "part": …, "pick": { "extreme": dir, "within": { "axis": dir, "frac": [a, b] }, "half": true } }`:
  the vertex furthest along a direction; `within` first restricts the part to a stretch along
  `axis` (0 = far end in that direction); `half` keeps this side's half only (midline bones)
- `{ "part": …, "pick": { "slice": { "axis": dir, "frac": [a, b] } } }`: mean position of that stretch
- `{ "lerp": [A, B, t] }`, `{ "xyz": [A, B, C] }` (x from A, y from B, z from C), `{ "offset": [A, [lat, sup, ant]] }`
- `{ "shift": [A, from, to] }`: A moved by (to − from), to carry a displacement measured in one place over to another
- `{ "frame": frame, "t": t }`: point on a frame's axis (0 origin, 1 end)
- `{ "nervePoint": nerve part, "x": A, "back": true }`: where a nerve's centreline crosses the sagittal plane through A

Points on the skin (SkinExpr):

- `{ "at": point, "to": "nearest" }`: nearest skin vertex that the point lies under; `"nearestAny"` drops that condition
- `{ "at": point, "to": dir }`: first hit on the outer skin of a ray from the point
- `{ "frame": frame, "t": t, "deg": angle }`: ray outwards from a limb's axis; 0° anterior (flexor
  side; palmar on the hand, dorsal on the foot), 90° lateral, 180° posterior, 270° medial.
  `{ "at": point, "frame": …, "deg": … }` starts from a given point
- `{ "nerveCross": nerve part, "x": A }`: where a nerve's skin projection crosses the sagittal plane through A on the front of the trunk
- `{ "dimple": { "between": [A, B], "minDepthMm": 5, "near": point, "withinMm": 50, "fallback": SkinExpr } }`: deepest dimple of the anterior midline between A and B (umbilicus); the fallback is used when it is shallower than minDepthMm (a skin without a modelled umbilicus) or its height differs from that of `near` by more than `withinMm` (some other hollow was found)
- `{ "frameScan": { "frame": …, "deg": …, "t": [a, b], "maxMm": 80 } }`: going along the axis from a to b, the first position with skin within maxMm in that direction (e.g. the apex of the axilla)
- `{ "first": [SkinExpr, …] }`: tried in order, the first that can be evaluated is taken (the grammar remains; the axilla key point `K_T2` used it as a fallback for the placeholder skin without an axilla and no longer does)
- `t` in a frame expression may also be `{ "from": landmark, "plus": 0.06 }`: a position along the axis relative to a landmark

A ray starts inside the body and the point taken is where it leaves the skin (skin normal along the ray); where two stretches of skin touch or interpenetrate (medial arm against chest wall) the back of the other one, met first, is skipped.
`armLimit` / `armLimitAbove` of the trunk frame: above the height of armLimitAbove (where trunk and arm are one mass) a radial projection landing lateral to armLimit is not trunk skin.

Seeds (`seeds` of every region):

- `{ "curve": [SkinExpr or { "nerve": name, "project": "trunkRadial", "clip": … }, …] }`: a curve through the items in order
- `{ "nerve": [names…], "maxDepthMm": 15, "where": { "frame": …, "t": [a, b] } }`: the part of the nerves' centrelines within the given depth of the skin
- optional: `"pin": true` (key point, keeps its label), `"widthMm"` (seed with width), `"offsetMm"` (head start / handicap)
- a nerve seed may carry `"facing": { "frame": …, "deg": … }`: only points that project onto skin facing that direction (e.g. 180 on the hand = dorsal)
- a nerve seed may carry `"clip": { "dir": dir, "beyond": point, "before": point }`, or an array of such objects (each applies): only one stretch of the nerve (usually the terminal one); `maxDepthMm` is relaxed to the nerve's own smallest depth + 5 mm when the whole nerve lies deeper
- a nerve seed may carry `"bridge": true`: between the first and last shallow enough point of a branch the seed follows the nerve's course as one line (it is not broken where the nerve dips deeper); only for cutaneous nerves that stay subcutaneous once through the deep fascia
- `{ "tags": [1] }`: the skin vertices carrying these tags as a seed (vertex-tags.u8 of the opened skin package: 1 upper lip margin, 2 lower lip margin, 4/6 upper lid margin, 5/7 lower lid margin). Empty on a skin without tags. It makes a map stop at the oral and palpebral fissures
- any seed may carry `"ifPart": part name` / `"unlessPart": part name`: used only when the body has / lacks that part (the seeds of the male external genitalia are placed from the glans and testes; a body without them uses the generic seeds placed from the pubic symphysis)

An opened skin (a body with `skin-source.u32`): lid rims (tags 8, 9) and the oral pouch (10–12) are construction surfaces inside the head, take no part in the partition and are always 255 in `skinmaps.bin`; the vertices of the upper and lower lip margins coincide but are not connected, so the maps stop at the oral fissure.

In the `checks` of `dermatomes.json` (independent checkpoints) `at` is a point on the skin or
`{ "over": part name }`: the dermatome with the largest share of the skin in front of that part.
`notes` in `landmarks.json` explains how particular landmarks are taken.

`barriers` are curves that labels cannot spread across (the ventral and dorsal axial lines of the limbs).
