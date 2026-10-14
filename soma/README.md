# soma

三维人体解剖浏览器，面向医学生。world-sim 阶梯上的 L4：器官怎么合成一个活着的整体。

长期目标是外科训练用的模拟人：解剖结构在医学上可信，组织有物理性质，身体对疼痛有反应。现在完成的是第一步——把一个完整的人体拆成三千多个可以单独查看的部件，并标出它们之间的关系。

> 仅供教学使用，不是临床依据。几何来自公开数据集，源数据自身声明仍含错误；中文名称、功能关系和体表图都还没有经过医学专业人员审校。

[English version below](#english)

## 现在能做什么

- 男女两个体型。男性 3,352 个独立部件：骨、肌肉、血管段、器官、神经、韧带、淋巴结、皮下脂肪，按系统分组；女性 3,390 个（见下文，精度低得多）。
- 按系统显示或隐藏、调透明度；从皮肤到骨骼逐层剥离。
- 点选部件，查看中/英/拉丁名、FMA 编号、所属层级、相邻结构。
- 肌肉的起点、止点、神经支配、血供等关系，每条带出处，可点击跳转；神经列出它支配的结构，可一次全选。
- 体表图：皮节（31 区）和皮神经分布区（49 区）画在皮肤上，可以从皮肤区域跳到支配它的神经，也可以反过来。
- 每个部件标明几何的来源和许可，可按来源着色或筛选，一眼分清哪些是实测、哪些是推算或手绘。
- 隔离、只看相邻结构、爆炸视图、任意轴向剖切。
- 两棵层级树（分类 is-a、结构 part-of）和按名称或编号搜索。
- 男女切换保留视角和选中的结构；对照视图把两个体型的同一系统并排显示，视角联动。
- 表情与口形：21 种情绪表情（6 种基本、15 种复合）、25 个动作单元、17 个说话的口形，可与疼痛表情叠加；也可以选一段音频，让口形跟着声音走。
- "数据来源与声明"里有"标定对照"：关节、肌肉力臂、节段比例、器官体积和表情位移与外部开放模型逐项相比的表。
- 每个体型带一份"使用前请注意"，首次加载时显示。

### 对照视图、触屏和 WebGL2

- **对照视图**：姿势、呼吸、体型、疼痛表情、情绪表情和口形在左右两个窗格里同时生效。体型按"相对各自默认值的偏移"套到另一副身体上，并限制在它的可用范围内。
- **皮肤不透明时**隐藏哪些部件由每副人体的 `display.json` 给出（现在是外耳和深部的上、下唇，皮肤自己已经有这些形状；对照窗格用它自己那副人体的清单）；它们仍在结构树里，选中即可显示。眉毛跟皮肤一起画成不透明，用示意性的深色：它只比皮肤高出零点几毫米，半透明时几乎看不见。"显示"页有"皮肤不透明"开关。
- **触屏**：单指旋转、双指平移和捏合缩放、点按选取；手机上顶栏分两行，详情是底部抽屉。嵌入页里第一次触摸画布之后才接管手势，之前竖向滑动仍然滚动页面。只在设备模拟里验证过，没有在真机上测过。
- **WebGL2 回退**：每个系统里不透明的部件合成一次绘制（三千多次降到一百多次）；`?chunks=0` 可关掉用于对照。改变身高时相机跟随身体。

### 写实外观

皮肤不透明时默认用写实外观；"显示"页的"写实外观"开关或地址里的 `look=0` 改回解剖配色。皮肤半透明、显示体表图时总是解剖配色；对照窗格暂不画写实外观。

- **皮肤有了 UV。** UV 布局取自 MHR LOD0（Apache-2.0）。皮肤本来就是 MHR 的拓扑，发布的顶点经 `skin-source.u32` 指回 MHR 的顶点，所以 UV 能原样搬过来；简化把少数三角形拉过了接缝，这些三角形按一个有自己 UV 的角重新投影。移植片（CC0 的脚趾、外生殖器、过渡环）和开口构造的顶点没有 MHR 来源，投影到最近的 MHR 面上取 UV，形状不同处 UV 会折叠（男性约 1.5 万个三角形）；以后的皮肤细节在这些地方用不依赖 UV 的三平面映射。皮肤顶点的次序不变，写实皮肤是一层跟随皮肤的覆盖网格（接缝处一个皮肤顶点有两个副本），所以体型、表情、软组织偏移和姿势都照常生效。数据在 `public/anatomy/<人体>/look/skin-uv.*`。
- **肤色按数据标定。** 底色来自一个两层皮肤的光谱模型（Donner 等 2008 的表皮/真皮结构；黑色素、血红蛋白、胡萝卜素和基线吸收；两层用 Kubelka–Munk 合成，表面用 Saunderson 修正），按 NIST 人体皮肤反射参考数据（Cooksey 等 2017，100 人前臂内侧，400–778 nm）拟合：每人只拟合黑色素和真皮血量两个数，其余参数全体共用。真黑素在黑色素中的比例固定为 0.74（Del Bino 等 2015、2022：各种肤色都约 74% 真黑素、26% 褐黑素），表皮取前臂背侧活表皮的厚度 57 µm（Sandby-Møller 等 2003）。光谱 RMS（400–700 nm）平均 0.0102、最大 0.022；换成 D65 下的颜色，ΔE00 平均 1.06、最大 2.68——与同一人三次测量之间的差（平均 1.11）相当；ITA° < 28 的九人平均约 1.6。模型做成一张"黑色素 × 血量 → 线性 sRGB 底色"的 64×64 查找表（`look/skin-lut.bin`），取表再加回表面反射后 ΔE00 平均 1.25、最大 2.90。第一版让真黑素比例自由、表皮取 0.25 mm（Donner 等 2008），拟合把比例推到 0（全是褐黑素），深肤色因此偏橙；现在深肤色的色相角约 60°（原来约 67°），更偏红褐。散射幂律指数（0.36）仍比文献的皮肤平均值小，是等效值；模型只在 NIST 的范围内算是标定过的。
- **肤色滑块。** "显示"页写实外观开关下的"肤色"滑块（地址里 `tone=0–100`）改表皮黑色素，黑色素 = 0.33 ×（tone/100）²；缺省 23 是 NIST 100 人的中位数。NIST 里最深的是 ITA° 约 −21，tone 高于 62 是外推（滑块下会提示），最深一端约 ITA° −55。
- **分区的颜色。** 一张 1024² 的贴图（`look/skin-regions.png`，按 MHR 的 UV）给每处皮肤一个黑色素倍数、血量倍数、"手足掌"权重和粗糙度。额头、颊部、手背相对前臂内侧的差取自 Xiao 等 2017 的四个人群（用同一模型反推，残差额头 1.1–2.2、颊部 1.7–2.4 ΔE00），唇红相对颊部取自一项 202 人的测量（只读到摘要）；唇红用自己的查找表（`look/skin-lut-lip.bin`）：角质层薄、乳头层毛细血管离表面近，等效成 39 µm 的表皮（与血量一起反推），残差从 2.4 降到 1.5 ΔE00（试过减弱血管包装效应，反而更差）；手掌和足底的黑色素按 Phan 等 2022 拉向一个与肤色无关的浅值；鼻、耳、眼睑、指尖、甲床、乳晕、外生殖器、肘膝伸侧、前臂背侧和低频斑驳的倍数没有找到数值，是按定性描述设的假设。每个数在 `data/curated/look/skin-colour.json` 里标了 sourced / computed / assumed。部位都由静止姿势下的位置算（到唇、睑、乳头、关节、移植片的距离和法线朝向），岛外用推拉法填满，所以接缝处看不出线；移植片的 UV 投影在最近的 MHR 面上，取的就是那里的值。这些数据只在写实外观显示时才下载（每个人体约 0.3 MB）。
- **微细起伏。** 毛孔、皮沟和皮嵴是一张程序化生成、可平铺的高度贴图（`look/skin-micro.png`，一块代表 1 cm²，种子固定，测试会逐字节重新生成）：面部毛孔按 Flament 等 2015（2,585 名女性的颊部：密度约 10–80 个/cm²，平均面积 0.03–0.22 mm²）取 40 个/cm²、中位面积 0.08 mm²；身体是更细的毛孔加三组交叉皮沟；手掌和足底是周期 0.45 mm 的皮嵴；每个指腹另有一个涡心，按到涡心的距离画出一圈圈的嵴，再用平铺的皮嵴扰动出分叉（`look/skin-pads.png`；像涡纹，但不是真实指纹）；指甲与指腹之间的过渡放宽，不再有一圈硬边。各部位的幅度和类型在细节贴图里（`look/skin-detail.png`）；身体的细纹、皮沟深浅和面部以外的数都是假设。贴图不按 UV 取，而是在静止姿势的位置上做三平面映射，所以 UV 折叠的移植片也没问题；法线用 Mikkelsen 2010 的无参数化凹凸法改，叠在皱纹层的法线上，两个后端都一样；一个像素盖住的皮肤超过细节尺寸时逐渐淡出。
- **镜面。** 两个镜面瓣（粗糙度 ×0.75 占 0.85、×1.30 占 0.15，取 UE 次表面配置的缺省值，只借做法），第二瓣用 three 的清漆层；整体粗糙度按 Weyrich 等 2006 测得的面部粗糙度量级调高（唇、T 区更光，均为假设）；毛孔和皮沟里按深度遮掉一部分镜面和环境光；绒光按底色着色。深肤色因此不再像涂了一层塑料。
- **次表面。** 透光只在薄处：从每个 MHR 顶点沿内法线射线求出"往里有多厚"（`tools/look/thickness.ts`），透光按 exp(−厚度/光程) 衰减，红、绿、蓝光程 4、1.2、0.6 mm（红光穿透几毫米，Bashkatov 等 2005；具体数是假设）。手指、足趾背光时透出红光；MHR 的耳是贴在头侧的浅浮雕，没有游离的耳廓，所以耳处不透光。直射光的漫反射用预积分表（Penner 和 Borshukov 2011，按论文重写；剖面用 d'Eon 等 2007 的六个高斯），曲率离线算好放在细节贴图里：鼻、指、耳这类半径几毫米的地方明暗交界变软偏红，平坦处与朗伯相同。屏幕空间的分离式次表面散射留到以后。
- **代价。** 每个人体新增约 1.0 MB（细节贴图约 0.38 MB、微细起伏贴图 0.55 MB、预积分表 32 kB），只在写实外观显示时下载。无头 Chrome（Apple GPU，900×1000）里 `benchSync(120)` 的每帧时间：WebGPU 全身 1.25 ms（解剖配色 0.75 ms）、面部近景 1.42 ms（0.81 ms）；WebGL2 0.23 ms（0.19 ms）。`bench(5)` 两种情况都跑满 60 帧。
- **材质和光照。** 基于物理的材质：折射率 1.4（F0 ≈ 0.028）、一层随底色着色的淡绒光代表毳毛；环境光是 three 自带的程序化房间预滤波而成（不用外部 HDR 图），色调映射用 Khronos PBR Neutral。皱纹细节层在写实模式下换用同一套材质和细节。
- **写实的眼（构造物，不是解剖）。** 写实模式下扫描的眼球部件不画，换成一对为显示构造的眼（`src/look/eyes.ts`、`eyesFit.ts`），像游戏引擎那样画：球心和半径按扫描的巩膜拟合（男性左 / 右 12.62 / 12.59 mm，女性 12.39 / 12.03 mm），光轴取扫描角膜的顶点；角膜是半径 7.8 mm 的球冠（Le Grand 理论眼），在白到白 11.71 mm 的角膜缘处接上巩膜。虹膜不是几何：片元里把视线在角膜表面按折射率 1.376 折射，与虹膜面求交，在交点上程序化地画放射状纤维、隐窝、卷缩轮和瞳孔（直径缺省 4 mm），所以从侧面看虹膜也在角膜后面。还有角膜缘的暗环、内外眦附近的细血管、内眦处一点泪阜的粉色、沿睑缘的泪液线，以及睑缘在眼球上投下的阴影（"眼部遮蔽"，按此刻的睑缘位置在着色器里算，表情变了跟着变）。做法参照 Epic 公开文档里眼的着色模型和 MetaHuman 的眼部遮蔽、泪液层，没有用它们的资源。虹膜颜色可选棕（缺省）、深棕、榛色、绿、蓝、灰；这些颜色是对照 Wikimedia Commons 的眼部照片目测定的假设值。选中某一侧扫描的眼球部件时，那一侧改画解剖部件。
- **注视。** 缺省两眼看着相机（集合到相机上），也可以在"显示"页选"正前方"，或在地址里给固定角度 `gaze=yaw,pitch`。角度限在水平 ±45°、上 30°、下 35°（在 Goldmann 视野计测得的正常成人平均最大转动之内）；相机绕到头后时眼回到正前方。眼在静止空间里绕拟合的球心转，再随头骨关节蒙皮，所以跟着头部姿势走。上下睑跟着垂直注视移动：移动量取自 Mastropietro 等 2009 的测量（10 名正常人，−30° 到 +30°），在运行时加到表情的睑通道上（上睑提肌、眼轮匝肌睑部），没有改表情数据。通道的换算按每个通道在睑缘中点实际移动的距离标定（加载时从表情数据里量）。表情数据里没有降下睑的通道，向下看时下睑由"眼轮匝肌睑部（下睑）"的位移场反过来用（最多到两倍，外推）：男性在 −20°、−30° 时睑裂缩到原来的 0.79、0.69（文献 0.81、0.72），女性 0.79、约 0.61。
- **活的眼。** 自发眨眼：每分钟约 15 次（Doughty & Naase 2006 正视时平均 13.8 次/分；间隔的分布是假设），一次约 0.3 s，闭合比睁开快约 1.5 倍（Kwon 等 2013 的高速摄影）；眨眼按 AU43 的通道与表情逐项取较大者，不会超过完全闭合。注视相机时有微扫视（幅度 6–30 角分，每秒约 1.2 次；频率是假设）。时间表由种子确定，页面隐藏时停下；地址里 `blink=0` 或"显示"页的"眨眼"开关关掉它们（截图、测试用）。瞳孔跟着疼痛模型走：刺激进行时直接取模型的瞳孔输出，"保持"的疼痛按同一张自主体征表算（基线 4 mm，强度 6 时扩大 28%，数值来自麻醉下的病人），扩大快、回缩慢；场景光照固定，所以没有光照项。
- **头发、眉毛、睫毛。** 写实模式下用程序生成的发片代替原来的头发外壳和眉毛外壳；解剖模式不变，外壳仍在结构树里。生成（`tools/hair/`）：在每个人体自己的皮肤上定头部坐标（眦点、鼻根、颅顶、耳廓），发际线按额高（trichion–nasion 67 mm，Farkas 常模的转引；按竖直高度取男 64、女 61 mm，是假设）和耳廓的位置定，所以女性的发际线来自她自己的头。头皮按每平方厘米 226 根（白种人汇总均值，Leerunyakul 2020 的综述；颞部 0.85 倍，泰国人群的转引）撒毛囊单位，每单位 1–4 根、平均约 2 根（Bernstein 1998；各占多少是假设），男性约 14.8 万根、女性约 11.3 万根（文献 9–15 万）。纤维直径 74 µm、截面长短径比 1.40、曲率 0.042 /mm 取自 Lasisi 等 2016 的欧洲人样本，波长 6 cm 是假设。两种发型：男式短发（侧分，头顶约 4.5 cm、两侧 2 cm）和女式长发（近中分，剪齐到肩下约 7–10 cm），每个人体都有，默认男短女长。几条规则（分缝、发旋、长度场、梳理方向、重力）梳出引导发丝，再做离线的 PBD 沉降（不可伸长、弯曲、重力、与皮肤碰撞），高处的根在外层。长发的发片多而窄（第 0 层男性 3557 张、女性 2707 张，宽 5–14 mm），贴图里的发丝向梢收拢成缕；根部抬起 25°、最外层离头皮 30 mm；脸旁的波纹减到 40%；剪口每根差 ±1.2 cm，梢不齐成一条线；脸前有一块禁区（眉以下、脸宽以内），不会有一缕挂在眼前。高光：每根发丝的毛鳞片倾角在 2°±1.5° 之间（pbrt：一般 2–4°），粗糙度各差 ±15%（长发 0.48、短发 0.42），不再是一条整齐的亮带。眉毛形状取原眉毛外壳在皮肤上的投影，每侧约 270 根（只找到无出处的科普数字 250，算假设），中位长约 7.5 mm，方向按"内端朝上、上缘朝外下、下缘朝外上"（植发诊所的说明，转引）；睫毛沿每个人体自己的睑缘链长出，上睑每侧 120 根三排、下睑 77 根两排（StatPearls：90–160、75–80），中位长 7.5 mm 和 5.6 mm（维基百科转引：7–8、5–6 mm），弯曲角度是假设。发丝按 k 均值聚成发片，头发三级细节、眉睫两级；贴图集由这些发丝自己画成（覆盖率、根→梢、每根的随机数、深度、偏角），随项目数据以 CC BY-SA 4.0 发布。发片下面的头皮画一层深色、带发色的底色（游戏里常用的做法，按离头皮边界的距离淡入），发片之间和分缝里不露出亮的皮肤。遮盖率检查（`tools/hair/coverage.ts`，不用渲染）：在头皮上每平方厘米取 3 个点，从正面、两个 3/4、两侧、头顶、背面往相机方向射线，按贴图集的覆盖率累计不透明度；分缝两侧 4 mm 和发际线渐变带不计。每个视角被遮住（不透明度 ≥ 0.9）的比例都不低于 95%（短发 96–100%，长发 95.5–100%），数字记在 `hair.json`，测试会重算。每个人体一次下载约 3.2–4.4 MB，只在写实外观显示时才取。所有数值、出处和"转引 / 假设"的标记在 `data/curated/hair/hair.json`。
- **毛发着色。** Karis 2016（SIGGRAPH 课程《Physically Based Hair Shading in Unreal》）的 Marschner 式三瓣近似（R、TT、TRT）按论文和公开的文字说明在着色器里重新实现；纤维颜色由黑色素浓度算：真黑素、褐黑素每单位浓度的吸收系数取自 pbrt 第 4 版（Chiang 等 2016 的做法），黑 8、棕 1.3、金 0.3 是书中的浓度，深棕、红、灰白是假设；多次散射的反照率 exp(−2.6√σa) 的系数按观感定。透明用 alpha-to-coverage（多重采样覆盖），深度照常写入、不需要排序，WebGPU 和 WebGL2 一样。每张发片的根按重心坐标钉在皮肤三角形上，体型、表情、软组织偏移和姿势都跟着走；发片相对头是刚性的，还没有动力学。"显示"页可选发型（无 / 短 / 长）和发色（黑、深棕、棕、金、红、灰白）。阴毛仍是原来的外壳。
- **现在的局限。** 深肤色一端是外推；微细起伏是程序化的示意，不是扫描；耳没有游离的耳廓：MHR 的耳只是浅浮雕，而扫描的外耳部件（FJ2811）粗（每只约 185 个顶点），并且大半埋在这张皮肤里（男 / 女 63% / 82% 的顶点在皮肤内，最深 13 / 15 mm），要往外平移约 12 mm 才露得出来，那样耳根又和头侧脱开，所以写实模式下仍不画它；没有屏幕空间的次表面散射；没有衣服。这些按计划分步做：WebGPU 近景用真发丝和发丝动力学、按版型生成并做布料模拟的日常便装和运动服。MetaHuman 只参考它公开的技术文档，不用它的资产（其许可不允许把资产放进公开仓库）。

### 体型

"姿势"页的"体型"一节有四个滑块：身高、BMI、腿长比例、体型分布。BMI 只改变皮肤和皮下脂肪（肌肉、骨、内脏不变，内脏脂肪和乳房没有模拟）；身高和比例通过各关节的节段缩放实现。每个滑块只能在这副身体上可用的范围内移动，到头时会写明原因（例如男性不能低于 BMI 21.5，否则肌肉穿出皮肤）。回归公式来自人群测量数据，给出的是平均体型，不是对某个人的预测。

已知问题：缩短身高或改变比例时，皮下脂肪最多会穿出皮肤约 12 mm；"体型分布"的效果很弱；女性模型的默认 BMI 在数据中有 22.0 和 23.7 两个值，读数只是近似。

### 疼痛反应（表情与发声）

左侧"疼痛"面板演示疼痛行为：设定强度（0–10）和起病方式，点"触发"，面部动作单元按时间过程出现并消退，未静音时同时发声，张口与声音同步。"保持表情"把表情停在所设强度；"每次触发都出声"（默认关）让低强度时也发声；"单个动作单元"可以逐个演示 AU。

这是疼痛**行为**的计算模型，用于教学：被模拟的身体没有主观体验；"强度 → 表情"的数值是本项目的假设；声音是演员按指令表演的录音（没有录音包时改用参数合成）。表情由模型里的表情肌驱动（`tools/face/`、`data/curated/face/`）：闭眼时上睑沿眼球表面滑下，张口时露出牙和舌。

**施加刺激。** "疼痛"页顶部的刺激工具：选种类（针刺、钝压、捏夹、热、冷）、量值、时长、是否重复、刺激是否被固定；打开"在皮肤上施加"后点一下皮肤按设定时长施加，按住不动则施加到松手。摆了姿势或改了体型也可以。模拟人的反应包括：皮肤上的疼痛分布层、从皮肤到神经根的通路和沿它走的 Aδ / C 两个标记、退缩反射、表情和（打开声音后的）发声，以及监护条上的心率、血压、呼吸、瞳孔、皮肤电导。解释面板按九个步骤说明原因，每个数字都标明是有出处、是假设还是算出来的。监护条上的数是群体平均的效应量，不能用来推断疼痛。模型在 `src/painmodel/`，数据表和来源在 `data/curated/pain/`。

**有真实开口的皮肤。** 眼和口是真正的开口：皮肤不透明时，透过它们能看到眼球、牙、牙龈和舌（这些是解剖部件，不管所在系统开没开都会画出来）。口腔深处近黑色的壁（口腔袋）和睑缘向里卷的一圈是为开口构造的，不是解剖：口腔袋不能选取，也不上体表图。皮肤不透明时隐藏的部件由管线给出（外耳和深部的上唇、下唇，皮肤自己已经有）。选中皮肤，结构信息里列出它由哪几片拼成；"构造物"单独用一种颜色和虚线标出，不是解剖来源。疼痛页默认看皮肤。

**皱纹细节。** 皮肤不透明时，面部按表情强度叠加一层法线细节（眉间、鱼尾、下睑、鼻根、鼻唇沟、口角）；皱纹是程序化生成的，条数和尺寸是假设。

声音素材的许可见下文"疼痛声音包"。嵌入模式默认静音，任何声音都需要用户点击才会播放。

### 表情与口形

左侧"表情"面板：

- **情绪表情。** 21 种（高兴、悲伤、恐惧、愤怒、惊讶、厌恶 6 种基本情绪，加 15 种复合情绪），每种是一组面部动作单元（AU），带一个 0–1 的强度滑块。每种情绪用到哪些 AU 取自 Du、Tao、Martinez 2014；**各 AU 的强度是本项目的假设**。模拟人没有情绪，这只是把已发表的原型摆出来。
- **单个动作单元。** 25 个 AU 各一个滑块（0–5，对应 FACS 的 A–E 级），与"疼痛"页里的是同一组。
- **口形（视位）。** 22 个说话的口形（英语 17 个，加普通话专用的 5 个：撮口 ü、卷舌 zh ch sh r、龈腭 j q x、卷舌元音 er、软腭擦音 h），点一下保持、再点一下松开：双唇音合唇、唇齿音下唇碰上齿、圆唇、展唇、开口等；舌有五个示意姿势（舌尖、舌面前部、舌根上抬，舌放低，卷舌）。方法取自 JALI（Edwards 等 2016）。每个口形有两套数值，用"风格"开关选：
  - **正常**：朗读时的开度。**下颌开度是按实测标定的**：电磁发音仪量到的切牙开度，三位英语说话人的均值（USC-TIMIT 一位，CC BY 4.0；MOCHA-TIMIT 两位，**该语料只许研究、教育和个人使用，这里只用了本项目自己算的汇总量，没有带语料本身**）。开口的 a 切牙只分开约 5 毫米，多数辅音 1–3 毫米。部分舌位取自实测的线圈高度。**假设的部分**：唇的动作强度（只按实测的唇开度核对过次序）、舌尖的接触、把"说话时下颌的最高位置"当作闭口；普通话专用的 5 个口形没有任何实测数据。
  - **夸张**：校准之前的那套大口形（开口的 a 张到最大角的一半），**全部是假设**，好处是各口形分得开。
  - 开关在"缺省"时，口形按钮用夸张、说话用正常。每个数值的来历写在 `data/curated/face/visemes.json` 的 `calibration` 和各视位的 `provenance` 里。
- **说一句话（由音素带动口形）。** 一段带音素时间线的声音，口形由"现在在发哪个音"决定，不是从声音里猜的：音素 → 视位（`data/curated/face/phonemes-en.json`、`visemes-zh.json`）→ 协同发音（JALI 的习惯；普通话按音节分组，圆唇不跨音节）→ 口形，和声音走同一个时钟。面板上显示正在说的词和音。
  - 随仓库带了 12 句示范（英语、普通话各 6 句，`public/voice/tts-demo/`），**不需要后端**。
  - **真人朗读的示例**（"示例：真人朗读"下拉框，`public/voice/librispeech-demo/`）：LibriSpeech dev-clean 里的 10 句英语朗读（男女各 5 位说话人，每句 3–4.5 秒，CC BY 4.0），每句至少有一个双唇音、唇齿音、圆唇音和开口元音。音素时间线是 Montreal Forced Aligner 的**自动对齐**（Lugosch 2019），不是人工标注。同一段录音可以"按音素"或"按音频"带动口形，所以它也是音频分析（`mouthTrack`）随仓库附带的基准：`bun tools/voice/librispeech-demo.ts bench` 把两种方式的下颌角相关、双唇音中点的唇间隙写进清单。现在的结果：下颌角相关平均 0.46（0.32–0.63），按音频的约晚 60 毫秒；41 个双唇音按音素全部合上（唇间隙 ≤ 0.11 毫米），按音频只有 3 个合上（唇间隙中位数 3.2 毫米）。选段和生成见 `tools/voice/librispeech-demo.ts`。
  - 语音合成后端在的时候（见"运行"），可以自己输入一句英语或普通话，选声音和语速；后端的拒绝信息和提示原样显示。**声音是机器合成的**（Kokoro-82M，Apache-2.0），界面上写明。
  - 同一段声音可以切换"按音素"（准确）和"按音频"（对同一段声音的分析，近似），对比两者的差别；链接里用 `drive=audio`。
  - 没有用户手势时（由链接或卡片打开）浏览器不让出声：口形按页面时钟无声地走（嵌入时循环），点"声音"后带声音从头播一遍。
- **由音频带动口形。** 选择或拖入一个音频文件，在页面内解码并分析，点"播放"后口形跟着声音走，面板上有一条开口、圆唇、闭合的轨迹。文件不会上传。**从声音推出的口形只是近似**：开口度较可靠，圆唇一般，闭唇较弱（只当作一般的闭合），唇齿音（f、v）检测不出来。

疼痛、情绪和说话由同一个驱动合成（规则在 `tools/face/model.ts` 的 `blendFace`）：情绪和疼痛在同一个 AU 上取较大者；上半脸（眉、眼）只来自这组 AU；说话时表情的下半脸减弱到四成，再与口形在每个通道上取较大者；下颌取两者中较大的；闭唇的口形优先于张口的表情。下颌已经被姿势面板或反射张开时，闭唇和口角按总的下颌角来算，所以双唇音照样合上（总角不超过约 8.7° 时；再大唇就够不着了）。口形有三个来源，优先级从高到低：音素时间线、对音频的分析、保持的口形。

由音素带动时另有两处处理（`src/face/visemeTrack.ts`）：双唇音紧挨着唇齿音时（five more），闭唇和"下唇碰上齿"两个约束会同时接近满值，这里让大的那个胜出，否则唇合不上；闭唇时把"唇成漏斗状"（AU22）减掉，它会把合着的唇顶开约 1 毫米。已知的不足：闭唇按 120 毫秒消退，夹在两个双唇音之间的短元音（"妈妈"）张不开。

### 肌肉活动

"姿势"页的"肌肉活动"开关有两层，可信程度不同：

- **长度变化（几何，可靠）。** 每条肌肉的作用线在当前姿势下比静止姿势短了（暖色）或长了（冷色）多少。它不说明肌肉是否在用力。
- **负荷（估计）。** 身体静止、只受重力（可加手持重物）时，保持这个姿势所需的肌肉激活度：由皮肤围出的体积和组织密度算节段质量，沿骨架累加出各关节的重力力矩，由作用线求力臂（−∂长度/∂角度），最大肌力 = 肌肉体积 / 纤维长度 × 比张力，再求"激活度平方和最小"的分配（静力优化）。站立时体重由足底接触点承担；仰卧 / 俯卧时没动过的肢体由床面托住。肌肉给不出的力矩作为残差逐关节列出。
- **简化和假设。** 没有惯性、没有协同收缩、没有韧带的被动力（只有关节到头时算被动承担）；作用线多是直线：膝周肌肉的经过点取自绑定（股四头肌经股骨上的一点到髌骨），踝和腕的长肌腱各加一个经过点；绑定里只在缠绕时才用的点（股骨髁后面、髌骨轨道上）不进这里的路径，所以屈膝较深时这些肌肉的力臂仍不可靠；胸椎和肋当作刚性胸廓，肩带和距下关节不参与平衡，腰椎、颈椎各按一段平衡；比张力 61 N/cm² 和 247 / 333 条肌肉的纤维长度比例是假设。所以能看的是谁在用力，百分数本身不可信；力臂不可靠的肌肉在列表里带 ⚠。
- **检验。** 九个有已知答案的姿势 × 两副人体，只判名次和符号：16 / 18 通过（屈肘托前臂、手持 2 kg、举过头时肱三头肌接手、浅蹲、踮脚、前倾、躯干前屈、仰卧直腿抬高）；肩外展 90° 时冈上肌不亮，两副人体都不通过，原因是直线作用线在抬臂后没有外展力臂。屈肘力矩与 de Leva 节段参数算出的 m·g·d 之比为 0.88（男）、0.72（女）。数字见 `data/curated/activity/validation.json`。

数据由 `bun tools/activity/build.ts male`（female 同理）生成到 `public/anatomy/<人体>/activity.json`，参数和出处在 `data/curated/activity/`；绑定或几何重新生成之后要重跑，否则界面只显示长度变化。

膝周肌肉（腘绳肌、股薄肌、缝匠肌、腓肠肌两头、股四头肌）在绑定里有经过点（`MuscleLine.via`）：`tools/rig/via.ts` 按 `data/curated/rig/via.json` 的规则在本模型的骨面上放置——股骨髁后面的缠绕点（直线会穿进股骨髁时才用）、髌骨轨道上的点；折线用于长度、力臂和肌肉活动（`tools/rig/musclepath.ts`）。一部分肌肉的网格随路径变形：按横截面蒙皮（同一横截面的顶点用同一组平均权重，两端 2 cm 内渐渐改随附着的骨，投影落在端点之外的部分在 2 cm 内换回普通蒙皮），再按构建绑定时烘焙的表把每个横截面平移出膝周骨（屈膝不超过 90° 时也不让它比普通蒙皮更靠皮肤外；`tools/rig/viapush.ts`，表按膝屈伸角列出、存在 `MuscleLine.viaPush`，不随髋、踝和胫骨旋转）；体积修正仍按起止点直线，CPU 参考与着色器同一公式，静止姿势不变，没有经过点的肌肉逐位不变。`bun tools/rig/via-check.ts` 在屈膝 90°、135° 和下蹲下把它与普通蒙皮比：翻转的三角形、边拉伸（p99、最大值）、落在膝周骨（封闭网格上判断内外）里的肌肉顶点、皮肤外的顶点（个数、最远距离）、悬空（离骨、皮肤和其余肌肉的最远距离、超过 15 mm 的顶点数）都不多于普通蒙皮，股骨远端前面、髌骨和股骨髁后面的覆盖不少于普通蒙皮；覆盖只算射线碰到的第一个面是骨外的肌肉（以前的量把穿在骨里的肌肉和拉长的碎片也算作覆盖，工具仍并列报告旧值）。`tests/rig-via-check.test.ts` 守着这个门槛。过不了门槛的肌肉照旧普通蒙皮，列在 `data/curated/rig/via.json` 的 `meshPlain`（附理由）：股肌（两副身体）、男性的股二头肌短头和半膜肌、女性除股二头肌短头以外的全部。这只是运动学近似，不是接触模型：深屈时仍有网格在骨里。改了规则之后依次重跑 `bun tools/rig/run.ts <人体> --no-renders`、`bun tools/rig/shape-build.ts <人体> --no-renders`、`bun tools/face/run.ts <人体>`、`bun tools/calibrate/run.ts skeletal`、`bun tools/activity/build.ts <人体>`；`SOMA_RIG_DIR=<目录> bun tools/calibrate/run.ts skeletal` 可以对构建到别处（`--out <目录>/<人体>`）的绑定量力臂。

### 腔

"显示"页的"腔"一节（男性）。空腔器官的腔是 19 个部件：消化道从口到肛门连成一条（口腔、咽、食管、胃、十二指肠、空肠、回肠、升 / 横 / 降结肠、直肠、肛管），另有膀胱、输尿管、输精管和精囊的腔。女性有 19 个：消化道同样从口连到肛门，其中直肠一段是标本自己的直肠腔（不另建）；另有膀胱、左输尿管和两侧输卵管的腔（右输尿管和右输卵管在源数据里互相穿过，右输尿管的腔没有给出），以及标本自己的宫腔、宫颈管和阴道腔（由原来一个“子宫和阴道腔”部件按中心线分成三片，顶点未动）。她没有尿道腔。

- **怎么来的。** 不是扫描出来的：由器官外表面向内缩一个文献（或假设）的壁厚推出来；口腔和咽是周围真实部件之间剩下的空间。构造的部分（从唇到牙的一段、腭帆、肛管末段、器官之间的衔接）另用颜色标出。数据里现在只有每个部件各类顶点的个数，没有逐顶点的标记，所以着色按整个部件：全是构造的画成构造色，构造占一成以上的（口腔、咽）画成"部分构造"的中间色。
- **什么时候看得见。** 壁不透明时腔藏在里面不画。打开"显示空腔器官的腔"后，壁画成半透明、腔用单独的颜色；把所在系统调成半透明，或在结构树、搜索里选中一个腔，它也会显示。"只看消化道"隔离消化道的腔和壁并对准相机。
- **充盈。** 滑块 0–1：0 是出厂的静止状态（食管和胃塌陷、小肠很细、升结肠和横结肠充气），1 是壁允许的最大；每个腔的充盈度 f = 静止值 + 滑块 ×（1 − 静止值），选中一个腔可以单独调。位移在蒙皮之前加到顶点上（位置 = GLB 位置 + (f − 静止值) × 位移），所以和姿势叠加；法线按面积加权重算。**器官的壁不随充盈移动。** 口腔、咽、食管和输精管没有位移。选中一个腔时详情里给出此刻的体积：由网格的有符号体积算出，两端开口的管用端圈的质心扇形虚拟封口，是近似值（胃：静止约 21 cm³、充满约 440 cm³；管线报告为 20 / 420）。
- **内镜漫游。** 相机在腔里面沿消化道的中心线从口走到肛门，朝前看（视角 80°，近平面 0.4 毫米），底下显示所在的段、已走的距离和该处腔的直径；可以播放 / 暂停、反向、调速、拖动位置、跳到某一段。中心线由界面从网格算出：管线造的腔每站一圈 16 个顶点，按连接关系把顶点分成一圈一圈，取各圈的质心；口腔和咽是体素等值面，没有顶点圈，用 `lumen-path.json` 里的引导线。规则：漫游时消化道各段的充盈度至少取 0.5（整条一起）；仍窄于 6 毫米的地方按圈心撑开到 6 毫米——**只为看得见，不是数据**；漫游时不画壁（各片器官网格两端的封盖会横在腔里）。
- **已知的不足。** 咽腔在食管上方约 20 毫米处就止住了，食管从侧面进胃、回肠从侧面进升结肠，这三处相机会离开腔走一小段（约 14、49、26 毫米）；小肠的急弯处中心线会擦出腔外；口腔和咽里的引导线只是大致的中线。女性：她的皮肤在会阴处没有开口（皮肤包的外阴移植片没有接上），阴道腔是盲端，构造的肛管通到皮肤上没有开口的地方；标本自己的腔面（直肠、宫腔、宫颈管、阴道）没有充盈位移；她的漫游没有在界面里核对过。其余局限见"已知的缺口"。
- **数据。** `lumen-filling.json` / `.bin`（管线生成）给出各部件的静止充盈度和逐顶点位移；`lumen-path.json`（几 kB）由 `bun tools/lumenview/extract.ts male` 从 `pipeline-report.json` 取出：各段的次序、每个腔的壁部件、口腔和咽的引导线。重新生成几何之后要重跑它。

### 软组织物理：按压与体位

只对男性开放（女性没有跑过软组织物理，界面上关着并说明原因）。计算都在 Web Worker 里（`src/softbody/worker.ts`、`engine.ts`），主线程只收结果；界面每处都写明哪些验证过、哪些没有（`src/softbody/statements.ts`）。

- **按压。** "疼痛"页的刺激工具选"钝压"，勾选"物理按压"：选球形或平头压头、半径（2–15 mm）、给定力或给定深度，再点皮肤。worker 在点击处按需建一块细笼子（单元 ≈ 压头半径的三分之一，2–6 mm），跑 `press()`——与验证时同一段代码（`src/softbody/site.ts`），所以在验证过的前臂部位上结果逐位相同（测试里核对）。求解时每约 0.12 秒回传一次凹陷，边算边显示；结果报告压入深度、到达的力、平均和最大结点接触压强、接触面积、轴线最大压应变；力控被压溃闸（压应变超过 0.6）拦下时明说停在哪里、只到多少牛。
- **疼痛输入。** 疼痛模型的压强 = 刺激的 `forceN` ÷ `areaMm2`（模型原有的输入）。物理按压把到达的力和接触面积放进这两项，模型收到的就是算出的平均接触压强，取代名义上"1 cm² 探头上的力"（`src/pain/stim.ts` 的 `registerContactProvider`，`src/pain/stimulus.ts` 的 `Contact`）。例：前臂上半径 5 mm 的球要 1 N，压溃闸停在 5.23 mm、0.958 N，接触面积 73.6 mm²，平均 13.0 kPa、结点峰值 43.1 kPa，低于该处 369.5 kPa 的阈值，所以没有疼痛反应。接触量的口径（`press.ts` 的 `meanPressureKPa`）：平均 × 面积 = 力，峰值 ≥ 平均。平头和平板的面积是贴在端面上的采样面积；球形压头的线性单元贴不上球面，按采样点数会把面积少算几倍（原来报告 21.9 mm²、平均 43.68 kPa，比峰值还高），所以按受力结点算，面积是垂直于压入方向的投影面积。`validation-report.json` 里球形压头各行的面积、平均和峰值压强是按旧口径算的；深度和力不受影响。
- **凹陷的显示。** 位移加在蒙皮之前（与表情、体型同一条路径），所以和姿势叠加。皮肤网格太粗（前臂、胸部的边长约 12–17 mm，个别三角形几厘米），几毫米的凹陷落不到顶点上；所以压入点周围的皮肤三角形细分到约 1.5 mm（不细于半个单元）另画一层（`src/softbody/dentmesh.ts`、`src/viewer/dentPatch.ts`），凹陷在细分点上取，被它盖住的原三角形和皮下脂肪在显示时向里收（脂肪的网格同样粗，否则会从凹陷底下露出来）；皮肤画成半透明时不画这一层，只移动原顶点。刺激点的标记和神经通路绑在皮肤顶点上，凹陷显示时放回凹陷的表面（不跟着向里收；摆了姿势时这一修正没有随骨转动，是近似）。皮肤系统里的其他部件（皮下脂肪、皮肤的其他片）也跟着笼子走。刺激结束（或清除）时凹陷在 0.7 秒内回弹——这是显示的过渡，组织的蠕变恢复没有模拟。
- **体位。** "姿势"页的"体位与重力"：站立、仰卧、俯卧、左侧卧、右侧卧。worker 用收到的网格建全身 27 mm 笼子（约 1.8 秒），按体位转动重力（站立的平衡由预应力放在发布的形状上），卧位加一张过最低点的支撑面，按子步规则（男性 13 个子步）走到最大结点速度低于 2×10⁻⁴ m/s，然后显示皮肤相对站立的位移：皮肤移过去（0.9 秒过渡，可放大 3 倍显示），并按位移的模长着色（真实大小，固定量程 0–30 mm，`src/viewer/dispOverlay.ts`）。仰卧：755 帧，浏览器的 worker 里每帧约 100 ms（命令行约 59 ms），皮肤位移平均 3.3 mm、最大 23.3 mm；俯卧 760 帧，平均 4.3 mm、最大 27.8 mm；左侧卧 740 帧，平均 4.1 mm、最大 36.9 mm。仰卧时背部被支撑面托住，位移不到 1 mm。每个体位算一次后缓存。页面隐藏时求解暂停。**没有与实测数据对照过**；骨架保持静止姿势，没有肌张力；乳房没有验证。
- **地址参数。** `phys=sphere,5,1N@forearm_L` 一类给出一次按压（部位写法与 `stim=` 相同），`phys=1&grav=supine` 打开体位求解；`grav=` 与肌肉活动显示共用（它只认 `supine`、`prone`）。嵌入卡片自己开始，没有对话框。
- **耗时（本机 headless Chrome，WebGPU，嵌入卡片）。** 施加到第一次显示凹陷：前臂半径 5 mm 球 0.60 秒（同一 worker 第二次 0.41 秒），平头 26 mm 0.86 秒（0.55 秒），胸部 5 mm 球 0.90 秒（0.61 秒）。结果：前臂球 1 N 34 秒（2108 帧，每帧 16 ms，压溃闸停在 5.23 mm、0.958 N，与验证行相同），平头压 4.5 mm 12 秒（387 帧，每帧 30 ms，1.83 N，是实测 2.83 N 的 0.65 倍——验证时单元 4.30 mm 为 0.66 倍，界面的缺省单元是半径的三分之一 4.33 mm），胸部球 27 秒（压溃闸停在 4.41 mm、0.49 N）。体位：建笼子 1.8 秒，仰卧求解 75 秒，打开卡片到结果 84 秒。主线程：按压和体位求解期间帧间隔 p50 / p95 / p99 为 16.7 / 16.8 / 16.8 ms；页面上第一次按压或第一次体位求解开始时有一帧 0.1–0.7 秒的停顿（按需加载笼子要的骨骼、肌肉等系统的几何，含 57–115 ms 的长任务），之后、出结果和着色时都没有停顿。

### 标定对照

"数据来源与声明"对话框里的"查看对照表"打开一个只读视图：`data/curated/calibration/` 下的十张表（节段比例、活动范围、肱骨角度、肌肉附着点和力臂、器官体积、表情位移、面部控制的覆盖、量具自检）。每张表先给出容差内外各多少行、差得最多的几行，以及参照的名称、版本、许可和网址，可按人体筛选，整张表点开才显示。这些表（合计近 1 MB）是单独的代码块，打开时才下载。**它们是把外部的开放模型和已发表的统计当作量具所做的对照，不是临床人员的审核**；参照本身也是模型或群体平均，不是真值，容差是本项目定的。

## 运行

需要 [Bun](https://bun.sh)。

```sh
bun install
bun run dev        # http://localhost:5183
```

仓库里已经带了生成好的解剖数据（`public/anatomy/`），克隆后可以直接看。

**语音合成后端（可选）。** `server/` 是一个 FastAPI 服务（`POST /api/tts`、`GET /api/tts/voices`、`GET /api/health`），用开源模型 Kokoro-82M（英语 v1.0，普通话 v1.1-zh，都是 Apache-2.0）把一句话合成 24 kHz 的声音，并给出音素时间线。经统一入口（idea-loom）使用时它按需启动，不用管。开发时自己启动：

```sh
cd server
uv run --extra model python -m soma_tts.fetch --state <状态目录>      # 第一次：下载模型（约 0.6 GB，逐个校验 sha256），不进 git
WORLD_SIM_STATE=<状态目录> uv run --extra model uvicorn soma_tts.server:app --host 127.0.0.1 --port <端口>
cd .. && SOMA_API_PORT=<端口> bun run dev                              # 开发服务器把 /api 转给它
```

没有后端时界面照常能用："表情"面板里没有输入框，说明合成需要本机的服务，随附的 12 句示范和"选择音频文件"都还在；说话的卡片用的是随附的片段。

### 地址参数

视图状态都写在地址的查询参数里，所以任何一个画面都可以用一个链接直接打开。参数都可省略，省略即默认值；无效的值会被忽略并在控制台给出警告。

| 参数 | 取值示例 | 含义 |
|---|---|---|
| `body` | `male`（默认）、`female` | 体型 |
| `embed` | `1` | 嵌入模式：只留舞台和必要控件，不弹对话框 |
| `tab` | `d`、`t`、`p`、`n`、`e` | 左侧面板：显示、结构树、姿势、疼痛、表情 |
| `sys` | `ske,ner:60` | 可见的系统，可带不透明度百分数；未列出的隐藏。代码：`int mus ske cv ner res dig uri rep end lym oth` |
| `peel` | `2` | 剥离层数 |
| `iso` | `FMA7088,FJ1234` | 隔离显示：部件编号或概念编号（概念展开为其下全部部件） |
| `hide` | 同 `iso` | 隐藏 |
| `sel` | `FMA9611` 或 `FJ3259,FJ3260` | 选中：一个概念编号，或若干部件编号 |
| `adj` | `1` | 显示相邻结构 |
| `focus` | `1` | 加载后把相机对准所选（或隔离、可见）的结构 |
| `cam` | `px,py,pz,tx,ty,tz` | 相机位置与目标，单位米 |
| `cut` | `a620`、`c500f`、`s250` | 剖切：轴（`a` 横断、`c` 冠状、`s` 矢状）+ 位置千分比 + 可选的 `f` 翻转 |
| `xp` | `40` | 爆炸视图百分数 |
| `pose` | `squat` 或 `elbow_L.0:90,elbow_R.0:90` | 姿势：预设名，或"关节.自由度:角度"（度，相对静止姿势） |
| `breath` | `1` | 呼吸演示 |
| `map` | `d`、`n` | 体表图：皮节、皮神经分布区 |
| `reg` | `14,15` | 体表图中高亮的区域下标 |
| `see` | `1` | 显示体表图时皮肤半透明，露出其下的神经 |
| `src` | `1` | 按数据来源着色 |
| `cmp` | `ske` | 对照视图及其显示的系统 |
| `shape` | `h1.80,b28,l0,c0` | 体型：h 身高（米）、b BMI、l 腿长比例（SD）、c 体型分布（SD）；只写不在默认值的项，超出可用范围的值会被截断 |
| `stim` | `heat,48,8@forearm_L` | 施加刺激：`种类,量值,秒数[,x次数/频率][,held][,热斜率取法]@部位`。量值：针刺毫牛，钝压和捏夹牛，热和冷摄氏度。部位：`fingertip palm handback forearm cheek shin sole` 加 `_L`/`_R`，或静止姿势下的坐标（毫米）`p-182,1034,28` |
| `pain` | `7` | 把疼痛表情保持在该强度（0–10）；不会自动出声 |
| `au` | `4:3,43:5` | 手动设定面部动作单元，编号:强度（0–5）；与 `pain`、`expr` 逐项取较大者 |
| `expr` | `happy`、`fearful:0.6` | 情绪表情：表情 id，可带强度（0–1，省略为 1）。id：`happy sad fearful angry surprised disgusted`，以及 `happily_surprised happily_disgusted sadly_fearful sadly_angry sadly_surprised sadly_disgusted fearfully_angry fearfully_surprised fearfully_disgusted angrily_surprised angrily_disgusted disgustedly_surprised appalled hatred awed` |
| `vis` | `PBM` | 保持一个口形（视位）。id：`SIL PBM FV TH TDN L SZ SH KG R W UW OW IY EH AA AX`，以及普通话专用的 `YU ZHCHSH JQX ER HX` |
| `say` | `zh-03` | 说一句示范片段：`en-01`…`en-06`、`zh-01`…`zh-06`，或真人朗读的 `ls-<LibriSpeech 语句号>`（如 `ls-6241-61946-0017`，见 `public/voice/librispeech-demo/manifest.json`）。口形按音素时间线走；没有用户手势时无声地播，界面上有“声音”按钮。合成用的自由文字不进地址 |
| `drive` | `audio` | 和 `say` 一起用：口形由什么带动。`phone` 按音素时间线（缺省，不写进地址），`audio` 按对同一段声音的分析（近似） |
| `style` | `normal`、`clear` | 说话的风格：正常朗读（按实测标定）或夸张。省略时保持的口形用夸张、说话用正常 |
| `skin` | `1` | 不透明皮肤视图 |
| `look` | `0` | 不透明皮肤不用写实外观，改回解剖配色（缺省是写实） |
| `tone` | `0`–`100` | 写实皮肤的肤色（表皮黑色素）；缺省 23 是 NIST 的中位数，不写；62 以上是外推 |
| `iris` | `blue`、`dark`、`hazel`、`green`、`grey` | 写实的眼的虹膜颜色（缺省 `brown`，不写进地址） |
| `blink` | `0` | 写实的眼不眨眼、没有微扫视（截图和测试用；缺省是有，不写进地址） |
| `gaze` | `c`、`20,-10` | 写实的眼的注视：`c` 看着相机（缺省，不写进地址）；或固定角度 yaw,pitch（度；yaw 正 = 向人体左侧，pitch 正 = 向上），超出范围的值被截断 |
| `hair` | `none`、`short`、`long` | 写实模式的发型；缺省按人体（男短、女长），不写进地址 |
| `hc` | `black`、`darkbrown`、`brown`、`blonde`、`red`、`grey` | 写实模式的发色；缺省 `darkbrown`，不写进地址 |
| `act` | `len`、`load` | 肌肉活动：`len` 作用线长度变化（几何），`load` 抵抗重力所需的激活度（估计） |
| `load` | `2`、`2L`、`2R` | `act=load` 时手持的重物（千克）；`L` / `R` 只一只手，省略为两手各持 |
| `grav` | `supine`、`prone`、`left`、`right` | 体位：仰卧、俯卧、左侧卧、右侧卧；省略为站立。`act=load` 用它定重力方向（只认仰卧、俯卧）；`phys=1` 时软组织按它下垂 |
| `phys` | `1`、`sphere,5,1N@forearm_L`、`flat,13,4.5mm@p286.5,907.8,153.7` | 软组织物理（男性）：`1` 打开体位求解；或一次按压：`压头,半径毫米,目标@部位`，压头 `sphere` / `flat`，目标 `1N`（力控）或 `4.5mm`（深度控），部位写法同 `stim` |
| `lumen` | `1`、`canal` | "腔"显示：壁半透明、腔单独着色；`canal` 同时只看消化道（它的腔和壁，其余隐藏） |
| `fill` | `0.5`、`0.5,LUMEN_stomach:1` | 充盈：全局滑块 0–1（0 = 静止），后面可跟"部件 id:充盈度"单独设定某个腔 |
| `fly` | `esophagus`、`420` | 内镜漫游：段名（`oral_cavity pharynx esophagus stomach duodenum jejunum ileum ascending_colon transverse_colon descending_colon rectum anal_canal`）或部件 id，从那一段开始播放；或已走的毫米数，停在那里 |
| `renderer` | `webgl` | 强制用 WebGL2 后端 |

例：`/?body=male&sys=ske,ner&sel=FMA9611&focus=1`。完整定义见 `src/state/urlState.ts`。

## 测试

```sh
bunx vitest run    # 管线、知识层、体表图、图查询、显示规则
bunx tsc --noEmit
```

针对生成数据的测试检查的是不变量和解剖事实：每个部件恰好出现在一个 GLB 里，邻接关系对称，左股骨在身体左侧；18 项神经解剖标志（尺神经过内上髁后方、坐骨神经出梨状肌下孔、腓总神经绕腓骨颈等）；关键感觉点落在自己的皮节里；子宫在膀胱与直肠之间。

## 结构

```
src/anatomy/types.ts   数据契约：离线工具写，界面读
src/                   界面（React + three.js WebGPURenderer）
tools/pipeline/        几何管线：分类、分层、简化、邻接、配准、推导，输出 GLB
tools/knowledge/       知识层：名称和功能关系，按概念编号对齐
tools/skinmaps/        体表图：皮节与皮神经分布区
tools/zanatomy/        Z-Anatomy 与 Open3DModel 的读取和导入包
tools/register/        女性体型的锚点数据
tools/fixture/         开发用的合成数据集
data/curated/          提交进仓库的精编数据
public/anatomy/        生成的运行时数据
```

几何和知识分开来源：形状和位置只取自体数据重建的网格或由它们推导，名称和关系取自本体库、百科和开放资料。两边靠 FMA（Foundational Model of Anatomy）编号对上。

每个部件带来源标记：`scanned`（源数据原样）、`warped`（经配准变形得到）、`curated`（人工建模，或由本项目从相邻结构推导）。

## 重新生成数据

原始数据不在仓库里（`data/raw/` 被忽略），需要先下载。

```sh
# BodyParts3D 4.0：把 LATEST/ 下的表格和两个 zip 下载到 data/raw/bodyparts3d/ 并解压
#   https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/
bun run pipeline                 # 生成 public/anatomy/male/
bun run pipeline:female          # 生成 public/anatomy/female/，需要先有男性输出和女性锚点包（tools/register/run_anchors.sh）
bun tools/knowledge/run.ts       # 名称和关系；加 --refresh 重新查询 Wikidata
bun tools/skinmaps/run.ts male   # 体表图；female 同理
data/raw/bodyshape/.venv/bin/python -I tools/look/mhr_uv.py   # MHR LOD0 的 UV（要 MHR 资产和 pymomentum，见 tools/bodyshape/REPORT.md）
bun tools/look/uv.ts male        # 写实皮肤的 UV 网格；female 同理。皮肤或 skin-source.u32 变了要重跑
# 皮肤颜色：把下面四样放进 data/raw/skin/（地址见数据来源表）
#   nist/skinrefl-v3.csv（NIST 皮肤反射数据）、omlc/hemoglobin.txt（OMLC 血红蛋白表，页面上的表格存成文本）、
#   omlc/carotene.txt（OMLC 的 β-胡萝卜素吸收谱）、cie/CIE_xyz_1931_2deg.csv 和 cie/CIE_std_illum_D65.csv
data/raw/bodyshape/.venv/bin/python -I tools/look/skin_colour.py    # 拟合、查找表、部位倍数 → data/curated/look/skin-colour.json、look/skin-lut.bin、skin-lut-lip.bin
bun tools/look/thickness.ts                                        # 每个 MHR 顶点的厚度 → data/raw/skin/thickness-<人体>.f32（射线，约 1 分钟）
data/raw/bodyshape/.venv/bin/python -I tools/look/skin_regions.py   # 部位、细节和指腹贴图 → look/skin-regions.png、skin-detail.png、skin-pads.png、skin-colour.json（要皮肤包、mhr-lod0-uv.bin 和上一步的厚度）
bun tools/look/micro.ts                                            # 微细起伏贴图 → look/skin-micro.png（程序化，确定）
bun tools/look/preintegrated.ts                                    # 预积分皮肤散射表 → look/skin-preint.bin
bun tools/hair/build.ts male female   # 头发、眉毛、睫毛的发片和贴图集（每个人体约半分钟）；皮肤或 data/curated/hair/hair.json 变了要重跑
```

顺序有依赖：知识层和体表图读取几何管线的输出，女性体型读取男性体型的输出。

## 数据来源与许可

代码之外，本目录下的解剖数据（`public/anatomy/`、`data/curated/`）整体以 **CC BY-SA 4.0** 发布。

| 来源 | 用在哪里 | 许可 |
|---|---|---|
| [BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html) 4.0 | 男性体型的几何（2,220 个部件）与两棵层级树 | CC BY 4.0（"BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International"）。注意：该数据说明页写的是 CC BY 4.0，而 4.0 版 OBJ 文件头里写的是 CC BY-SA 2.1 日本版；两种表述都如实列在这里，两者都允许本项目的用法 |
| [Blender Studio Human Base Meshes](https://www.blender.org/download/demo-files/) v1.4.1 | 两个体型皮肤上分开的脚趾（美术建模的写实前足，按趾骨配准后移植），标记为 `curated` | CC0 |
| [Momentum Human Rig (MHR)](https://github.com/facebookresearch/MHR) v1.0.1（Meta） | 两个体型的皮肤表面（参数化体表按内部结构拟合）、皮肤的蒙皮权重、体型场、写实皮肤的 UV 布局 | Apache-2.0；许可全文和改动声明见 `public/anatomy/MHR-LICENSE.txt`、`MHR-NOTICE.txt` |
| [NIST 人体皮肤反射参考数据](https://doi.org/10.18434/M38597)（Cooksey、Allen、Tsai 2017，[J Res NIST 122:26](https://doi.org/10.6028/jres.122.026)） | 写实皮肤颜色模型的标定（100 人前臂内侧的反射光谱）。只提交由它算出的参数和误差，不分发原始数据 | 美国政府作品，[NIST 数据许可](https://www.nist.gov/open/license)：可自由使用，需注明 NIST 为来源 |
| [OMLC](https://omlc.org/spectra/) 血红蛋白和 β-胡萝卜素吸收谱（Prahl 汇编，源自 Gratzer、Kollias 和 PhotochemCAD） | 颜色模型里的吸收谱 | 页面没有写明许可：只在本地用，仓库里只有用它算出的数 |
| [CIE](https://cie.co.at/datatable/cie-1931-colour-matching-functions-2-degree-observer) 1931 2° 配色函数、D65 光源 | 光谱 → 颜色 | CC BY-SA 4.0；只在本地用 |
| 文献（只取数值，逐条注明在 `data/curated/look/skin-colour.json`） | 模型结构和吸收公式（Donner 和 Jensen 2006；Donner 等 2008；Jacques 2013；Svaasand 等 1995；Saunderson 1942），部位色差（Xiao 等 2017，[doi:10.1111/srt.12295](https://doi.org/10.1111/srt.12295)；《中国组织工程研究》唇红与面部肤色，WPRIM wpr-698623；Phan 等 2022，[doi:10.1117/1.JBO.27.3.036002](https://doi.org/10.1117/1.JBO.27.3.036002)），结构参数（Del Bino 等 2015、2022 真黑素比例；Sandby-Møller 等 2003 表皮厚度），定性依据（Lee 等 2024；Alaluf 等 2002；Pawson 和 Petrakis 1975；Silva 等 2020；Sun 等 2025），细节与光的传播（Flament 等 2015 面部毛孔，[doi:10.2147/CCID.S74401](https://doi.org/10.2147/CCID.S74401)，CC BY-NC 3.0 文章，只引数值；Mikkelsen 2010 凹凸法；Penner 和 Borshukov 2011 预积分皮肤；d'Eon、Luebke 和 Enderton 2007 皮肤剖面；Barré-Brisebois 和 Bouchard 2011 透光近似；Weyrich 等 2006 皮肤反射测量；Bashkatov 等 2005 皮肤光学参数；Unreal Engine 次表面配置文档，只借做法），色差公式（Sharma 等 2005），ITA° 分组（Chardon 等 1991；Del Bino 等 2006） | 事实和数值 |
| 眼的文献数值（只用数字）| 写实的眼：眼球横径 24.2 mm、范围 21–27 mm（Bekerman, Gottlieb & Vaiman 2014, *J Ophthalmol* 2014:503645）；角膜前表面曲率半径 7.8 mm、角膜厚 0.55 mm、前房深 3.05 mm（Le Grand 理论眼，见 Atchison & Smith, *Optics of the Human Eye*）；角膜折射率 1.376（Wikipedia "Cornea"）；白到白 11.71 mm（Rüfer, Schröder & Erb 2005, *Cornea* 24:259）；眼球最大转动（Goldmann 视野计，PubMed 9700009；Chamberlain 1971）；睑缘随垂直注视的位置（Mastropietro, Alves & Velasco e Cruz 2009, *Arq Bras Oftalmol* 72:771）；自发眨眼频率（Doughty & Naase 2006）；眨眼的运动学（Kwon 等 2013, *J R Soc Interface* 10:20130227）；微扫视的幅度和历时（Wikipedia "Microsaccade"；Martinez-Conde, Barrow Quarterly）。技术参照 Epic 公开的眼着色模型文档，不用其资产 | 引用的测量值 |
| 本项目自己生成的毛发（`public/anatomy/<人体>/hair/`） | 写实模式的头发、眉毛、睫毛的发片和贴图集；数值取自 `data/curated/hair/hair.json` 所列文献（只用数，不用任何外部的图或模型） | 随本项目数据 CC BY-SA 4.0 |
| BodyParts3D 3.0 | 4.0 里没有的 79 个部件：肺叶、腹壁肌、背阔肌、咀嚼肌和表情肌。经配准变形，标记为 `warped` | CC BY-SA 2.1 JP |
| [Z-Anatomy](https://github.com/Z-Anatomy) | 颅神经和躯干神经、脊神经根、脊髓、韧带、筋膜、关节囊、淋巴结群、甲状腺、腮腺。手工建模，标记为 `curated` | CC BY-SA 4.0（"Z-Anatomy - The libre 3D atlas of anatomy"） |
| [AnatomyTool Open3DModel](https://anatomytool.org/open3dmodel) | 四肢神经（右侧建模，左侧为镜像）、膝关节交叉韧带和半月板。手工建模，标记为 `curated` | CC BY-SA 4.0 |
| soma（推导） | 皮下脂肪、脏胸膜、心包囊：由本项目从相邻结构计算得出，标记为 `curated` | CC BY-SA 4.0 |
| [Visible Human Project](https://www.nlm.nih.gov/research/visible/visible_human.html) 女性 CT | 女性体型的骨骼和部分器官，由 TotalSegmentator 与 MOOSE 分割 | NLM 使用条款；Courtesy of the U.S. National Library of Medicine |
| [HRA](https://humanatlas.io) 女性参考器官 | 乳腺，以及子宫动静脉、卵巢系膜、卵巢悬韧带、膀胱子宫陷凹。重新建模过的几何，标记为 `curated` | CC BY 4.0 |
| Wu 等 2015 女性盆底（[doi:10.1371/journal.pone.0132226](https://doi.org/10.1371/journal.pone.0132226)，更正 [10.1371/journal.pone.0140736](https://doi.org/10.1371/journal.pone.0140736)） | 女性体型的盆底肌、肛门和尿道括约肌、会阴体、阴蒂和前庭球、阴道、子宫、输卵管、卵巢、直肠，共 51 个部件。来自另一位女性的标本，放大并按骨配准，标记为 `curated` | CC BY 4.0 |
| [丹佛大学 Visible Human 女性下肢模型](https://doi.org/10.1038/s41597-022-01905-2) | 女性体型的下肢肌肉、膝关节韧带、关节软骨、跗骨，共 100 个部件 | CC BY 4.0 |
| [FMA](http://si.washington.edu/projects/fma) 5.1.0 | 新增部件在分类树里的位置 | 见其发布页 |
| [Wikidata](https://www.wikidata.org) | 名称、功能关系、编号对照 | CC0 |
| [Wikipedia](https://en.wikipedia.org) 肌肉信息框 | 部分肌肉的起止点和神经支配，每条带修订版链接 | CC BY-SA 4.0 |
| ISNCSCI 关键感觉点、Lee 等 2008、Gray 1918 | 体表图的定义依据（只取事实，逐条注明） | 见 `data/curated/skinmaps/` |

名称数据里约三分之二的中文名是按术语表机器生成的，没有出处；`names.json` 的 `zhSource` 字段逐条标明了来源，全部条目的状态都是 `unreviewed`。

### 疼痛声音包（禁止商用，与解剖数据分开）

`public/voice/vivae-pain/` 是一个**独立的集合**，许可是 **CC BY-NC 4.0（仅限非商业使用）**，不属于上面 CC BY-SA 4.0 的解剖数据集，也不属于 MIT 许可的代码。

- 内容：VIVAE 语料库（Holz、Larrouy-Maestri、Poeppel，[doi:10.5281/zenodo.4066235](https://doi.org/10.5281/zenodo.4066235)）里"身体疼痛"类的 185 条录音，重采样到 24 kHz，另加本项目做的逐条分析。这些是按指令表演出来的发声，不是真实疼痛时的录音。署名、许可和改动清单在该目录的 `ATTRIBUTION.txt` 和 `LICENSE.txt` 里。
- 用法：`src/voice/` 在运行时加载它，在录音基础上做变化（换录音、小幅变调变速、连成持续性发声、由女声推出男声）。目录不存在时自动改用参数化合成器。
- **商业用途的构建或部署不得带这个目录。** 用 `SOMA_COMMERCIAL=1 bunx vite build` 构建：产物里不带 `voice/vivae-pain/`（`voice/tts-demo/` 和 `voice/librispeech-demo/` 的许可允许商用，照常保留），界面改用参数合成的声音，也不显示录音的署名。默认构建不变（带录音包）。
- `data/curated/voice/calibration.json` 只含由该语料统计出的汇总量，不含音频。

### 语音合成：模型、示范片段和口形的标定数据

- **模型**不进 git：Kokoro-82M v1.0（英语）和 Kokoro-82M-v1.1-zh（普通话），hexgrad，Apache-2.0。来源、固定的提交、读到的许可条款和每个文件的 sha256 在 `server/models.json`。
- **示范片段** `public/voice/tts-demo/`：12 句**机器合成**的声音和它们的音素时间线，由上面的模型生成，本项目没有附加限制；署名和生成方式见该目录的 `ATTRIBUTION.txt`、`LICENSE.txt`。没有真人录音。
- **真人朗读的示例** `public/voice/librispeech-demo/`：LibriSpeech（Panayotov、Chen、Povey、Khudanpur 2015，https://www.openslr.org/12/ ，CC BY 4.0；录音来自 LibriVox 的公有领域有声书）dev-clean 里的 10 句，和 LibriSpeech Alignments（Lugosch，Zenodo 2619474，CC BY 4.0，Montreal Forced Aligner 的自动对齐）里它们的音素时间线。逐句的说话人编号、章节、语句号、书名和转写见该目录的 `ATTRIBUTION.md`，许可见 `LICENSE`；不写朗读者的名字。许可允许商用，商业构建照常保留。重新生成：`bun tools/voice/librispeech-demo.ts fetch`（下载到 `data/raw/librispeech/`，不入库；对齐的 zip 只按 HTTP Range 取 dev-clean 那一段），然后 `build`、`bench`；需要 ffmpeg。
- **口形的标定数据**：`data/curated/reference/articulation-summary.json` 是本项目从两个发音语料算出的汇总量（各音的切牙开度、唇开度、线圈高度的均值）。USC-TIMIT 是 CC BY 4.0；**MOCHA-TIMIT 只许研究、教育和个人使用，未经许可不得商用**，仓库里没有它的原始数据，依赖它的数值在 `visemes.json` 里标了 `calibratedAgainstNonCommercialData`。

## 已知的缺口

完整的清单在每个体型数据的 `cautions` 字段里。主要的几条：

- 神经是手工绘制的示意性几何，粗细不是实测，位置经配准后误差中位数约 2 mm、下肢更大；约五分之一的中心线点被从骨和肌腹里推出过。
- 没有的神经：膈神经、颈丛、肋下神经、内脏神经、自主神经丛、喉神经。
- 没有壁胸膜、淋巴管、黄韧带、颅内脑膜；心包只是心脏的外包络；降结肠包含乙状结肠；脊髓是程序化生成的表面，止于 L2/L3。
- 皮下脂肪是从皮肤内壁和深层结构之间推导出来的，厚度按 3 mm 量化。
- 男性现在有空腔器官的“腔”（19 个部件，id 为 `LUMEN_…`）：消化道从口到肛门连成一条，另有膀胱、输尿管、输精管和精囊的腔。它们**不是扫描出来的**，是由器官外表面向内缩一个文献（或假设）的壁厚推出来的；旁边的 `lumen-filling.bin` 给出每个顶点随充盈度的位移。构造的部分：从唇到牙的一段、腭帆（一张构造的薄片，数据里没有软腭）、从直肠下端到皮肤的肛管末段。已知的局限：小肠的腔只占可用空间的约 55–59%，因为源数据里的肠段互相重叠；咽腔在食管上方约 20 mm 处就止住了；胃静止时的形状是假设；男性名为“Urethra”的部件有 12 mm 一段穿在阴茎海绵体的部件里。姿势下腔取壁上最近点的权重随壁运动，壁的权重变化急的地方个别顶点仍会出壁几毫米。女性现在也有（19 个部件，见上文“腔”一节）。
- 男性皮肤是拼成的，逐片标在数据里（选中皮肤可见）：按他的内部结构拟合的参数化体表（Meta MHR，Apache-2.0），不是他本人的皮肤；他自己扫描皮肤上的阴茎和阴囊皮肤，连同阴囊颈部和会阴缝（移植片；它与拟合体表之间的过渡面是构造的，阴囊后方的会阴顶是几块大平面）；CC0 写实人体网格的脚趾（不是他的脚，第 3–5 趾被拉长约 1.3–1.5 倍；第 2–5 趾近趾尖处有一圈浅台阶）；眼和口是剪开的真实开口，睑缘内沿和口腔袋是为此构造的，不是解剖。脐和乳头是从他的扫描皮肤转过来的浅浮雕，网格太粗，几乎看不出。腋窝从肱骨约 45% 处以下是打开的，其上手臂与腋襞本来相贴，皮肤在腋襞处有 15–27 cm² 互相遮挡并有小台阶。头显得又宽又高；眼球的颜色是示意性的。大幅度姿势下（肩外展 90°、前屈 160°、深蹲）皮肤仍有明显拉伸和皱缩。皮肤包不在仓库里，由 `tools/bodyshape/` 和 `tools/skinopen/` 的脚本生成到 `data/raw/bodyshape/out/`。
- 体表图的边界有 1–3 厘米的锯齿。体表图是构造出来的教学用图，皮节因人而异，已发表的图互相矛盾。
- 表情和口形：情绪原型的强度和视位的数值是假设；没有单侧动作；眼球只在写实模式下转动（构造的眼），解剖配色下扫描的眼球不转；舌只有四个示意姿势；下颌张到最大开口的一半以上时口角处仍有小的折叠（全开时约 35 mm²）；姿势面板或反射张开下颌时，界面还没有把这个角度传给口形（双唇音闭不严）；由音频得到的口形是近似的，唇齿音检测不出来，也没有在真人语音上系统地验证过。眉毛是贴到皮肤上的薄壳（内表面在皮肤下 0.5 毫米），头发仍是一个半透明的壳。
- 写实的眼是构造物，不是扫描数据：虹膜的颜色和纹理是程序化的假设，没有按测量标定；向下看时下睑靠反过来的下睑场下移，女性的场太弱，−30° 时睑裂仍比文献窄约 15%；向上看时女性的下睑抬不够（通道封顶），睑裂偏大；水平注视时睑不动；泪液线和睑缘阴影的宽度、深浅是目测的假设；眨眼的下睑动作取自 AU43（数据里没有 AU45）；没有大的注视跳动（只有微扫视），没有光照对瞳孔的影响；对照窗格不画写实的眼（要等写实皮肤也画进对照窗格）；在写实的眼上点选选不到眼球部件（从结构树选）；女性两眼的拟合半径不同（左 12.39、右 12.03 mm，扫描如此），构造的眼保留了这个差别。
- 男性的静止姿势被改过两次：肩带（原始扫描是仰卧耸肩，锁骨下降约 10°、肩胛骨沿胸廓转动，两肩关节中心间距 338 mm，没有达到 350 mm 的目标）；上肢在冠状面外展 6.5°，以便形成腋窝（肩胛骨保持不动是建模上的选择，没有打开过出处）。跨越肩部的肌肉、血管由 `scanned` 改标为 `warped`。
- 女性体型比男性粗糙得多：
  - 骨架来自 Visible Human 女性供体（59 岁、肥胖、六节腰椎），已按标准比例缩放到身高 1.606 m、五节腰椎，所以她的部件都不标为 `scanned`。踝仍偏高约 16 mm；左右肘关节的屈伸轴相差 22.5°（她两侧肱骨远端不同），屈肘时两前臂不对称；脚骨和手指是修正过的男性骨。
  - 大部分软组织是男性的结构配准到她的骨上，并按标准女性体表调整过分布；男性来源的肌肉体积不低于有出处的女/男比值（Janssen 等 2000）。上肢外展 7.5°。
  - 下肢的肌肉和膝关节韧带是她自己的（丹佛数据）。神经长度有 2.0% 在她的肌肉内，其中 1.8% 是止于肌肉的运动支，解释不了的 0.07%。
  - 盆底、阴道、子宫、附件和直肠来自另一位女性的标本（Wu 等 2015）。结构之间仍有少量穿插（最差的一对 3.8%）；膀胱（她自己的，空虚）与子宫之间有 16.6 mm 空隙；九条盆腔韧带只有三条（左右宫骶韧带、右主韧带）按两端重新配准放回，其余在现有器官之间没有位置。
  - 没有外阴形态：会阴处的皮肤是抬高过的平滑闭合面。标本的皮肤没能移植：收窄后的移植片边缘离她现在的皮肤中位数 11.6 mm（上限 5 mm），把皮肤抬到那里会让股薄肌露出皮肤。也没有尿道腔、卵巢和阴道血管、自主神经丛。
  - 皮肤同样是拼成的：标准女性体型（身高 1.606 m、BMI 21.6）的参数化体表，在肌肉仍超出处放宽，按体积算的 BMI 约 23.7；装入的皮肤身高 1.609 m（原 1.6155 m）。头的外形是这个参数化模型（Meta MHR，Apache-2.0）自己的女性头部轮廓，她的颅骨、下颌骨、牙和头部软组织变形进去（标为 `warped`，不是原来的形状；骨面最多移动约 20 mm，颅骨径线有几条变了 5% 以上）；牙整体缩小 0.974 倍（Silva 等 2019 荟萃分析的牙冠性别差异）；眉是男性的眉部件，移到按她的眶上缘定的线上（依据 Sclafani 和 Jung 2010 的摘要，毫米数和眉宽是假定）；两个眼球大小不同（左眼球大），按角膜顶点（不是球心）放到左右对称的位置；头发外壳仍是男性的部件，是占位的：贴到她的头皮上，外面不够的地方推到头皮外至少 1 mm（构造，只为头发里不露出皮肤），发际线的轮廓没变；写实模式下它被按她自己的头生成的头发代替（见“写实外观”）。眼和口是真实开口；脚趾来自 CC0 网格，第 2–5 趾近趾尖处有一圈浅台阶；原先露在脚趾之间和大腿根部的筋膜薄片已收进皮肤（薄层结构露出面积由 253 降到约 10 cm²，余下的在腋襞）。乳房每侧约 334 mL（中国女性的参考值），腺体部件缩到约 0.5 倍放入；脐是构造的。
  - 她的肋间神经是从男性变形来的；第 7–11 条出骨性胸廓以后的一段已按她自己的剑突和脐重排（T7 止于剑突尖下方，T10 止于脐；T8、T9、T11 的高度是等间隔插值，不是出处给的）。体表图上脐现在落在 T10；剑突处仍不对（左 T5、右 T7，教科书 T6–T7），右侧 T12 皮节分成两块。模型里没有肋下神经。
  - 右前臂和右手在 CT 里被裁切，用的是左侧镜像。
- 写实模式的毛发是第一步：只有发片，没有 WebGPU 近景的真发丝，也没有动力学（发片相对头刚性，长发在大幅姿势下会穿进肩背）；侧面发际线处看得到短发发片的末端；长发在肩前偶有一两缕窄的发片；纤维参数只取了欧洲人样本，没有别的人群的卷曲；文献数值有一半是转引或假设（见 `data/curated/hair/hair.json` 的 `status`）；对照窗格不画毛发；阴毛仍是外壳。

## 接下来

1. 毛发的第二步：WebGPU 近景用真发丝、发丝动力学；女性外阴；腋窝的两层皮碰撞求解；让神经和筋膜等薄结构与新皮肤、分开的脚趾相容。
2. 软组织物理：四面体化，XPBD，先在一个部位验证。代码在 `src/softbody/`、`tools/softbody/`，材料和对照数据在 `data/curated/softbody/`。按压（前臂）和体位已经接到界面上（见"软组织物理：按压与体位"）；还没有 WebGPU 求解器，女性没有跑过。第三、四阶段只用男性身体：零重力参考形状在全身笼子上反解收敛，受重力后皮肤离发布的网格不到 0.3 mm；一万帧稳定性、各区域体积和 CPU 耗时见 `validation-report.json`；按压接口 `press()` 有球形压头和平板，接触压强按结点计算；求解器可以用 Ogden 型脂肪，但没有默认启用。第四阶段找到了小压头"压溃"的主要原因：皮肤层原来按皮肤网格的顶点分到四面体，前臂上皮肤网格的边长中位数是 26 mm，2 mm 的细笼子在压头周围 8 mm 内只剩应有皮肤刚度的约 0.1 %（混合式里皮肤还多乘了一次体内比例）；现在按三角形面积细分后分配。另外，力控压到应变上限（0.6）时改为二分找最深处，不再退回上一步。结果：半径 5 mm 的球在前臂掌侧能压到约 1 N（原来 0.18 N），桡骨上方 2.0–2.6 N，胸部 0.5 N（原来 0.06 N）；直径 26 mm 平头压前臂为实测（forearm2026）的 0.66–0.83 倍（原来 0.54–0.64 倍）。子步数：偏量约束的乘子每个子步从零开始，刚度比大时稳态偏软、甚至停不下来或发散；`SoftBody` 不指定子步数时按刚度比定（男性全身笼子 13 个），全身仰卧位移在 4 个子步以上已收敛，2 个子步时大 14 %。乳房只在不读人体数据的体模上做：底面可以无摩擦滑动（周边钉住）或加一层筋膜（mira2018），重力是身体坐标系里的三维向量（站立、仰卧、俯卧、侧卧）。**与已发表数据仍不符或没有定论**：直径 9 mm 平头（zheng1999 的做法，从 0.5 N 预载起）的斜率为 0.64–0.70 N/mm，该文三名受试者放松时约 0.22 N/mm（0.14–0.30），示例受试者 0.35 N/mm，本模型这两处组织厚 12–13.5 mm、该文 16–20 mm；几牛顿的压力刺激要求超过 0.6 的压应变，模型只验证到 0.4，力控在接近上限时与路径有关；乳房俯卧到仰卧的位移取决于胸壁朝向、底面条件、皮肤和体积，体模从 6 mm 到 170 mm 都有（文献均值 69.7 mm，该文没有给出患者的乳房体积），滑动的算例在乳房边缘都有压扁或翻转的单元，数值不可信；全部肌肉同时完全激活时全身笼子停不下来；腹部压入（单元 7 mm）在 5 mm 处为实测的 0.81 倍、20 mm 处 1.43 倍。
3. 手术操作：切开、牵拉、出血、缝合。

---

<a id="english"></a>

# soma (English)

A 3D human anatomy browser for medical students. Level L4 on the world-sim ladder: how organs add up to one living body.

The long-term goal is a simulated patient for surgical training: anatomy that is medically credible, tissue with physical properties, a body that responds to pain. What exists now is the first step — a whole body taken apart into more than three thousand parts that can be inspected one by one, with the relations between them.

> For teaching only; not a clinical reference. The geometry comes from public datasets whose own release notes say they still contain errors. Chinese names, functional relations and skin maps have not been reviewed by a medical professional.

## What it does

- Two bodies. Male: 3,352 separate parts — bones, muscles, vessel segments, organs, nerves, ligaments, lymph nodes, subcutaneous fat — grouped by system. Female: 3,390 (far less accurate; see below).
- Show, hide and fade systems; peel layers from skin to skeleton.
- Select a part to see its Chinese / English / Latin names, FMA id, place in the hierarchies and adjacent structures.
- Origin, insertion, innervation, blood supply and other relations, each with its source, clickable; a nerve lists what it supplies and can select all of it at once.
- Skin maps: dermatomes (31 regions) and cutaneous-nerve territories (49 regions) painted on the skin; jump from a skin region to the nerve that supplies it and back.
- Every part states where its geometry came from and under which licence; colour or filter by provenance to tell measured from inferred or drawn.
- Isolate, show neighbours, exploded view, section plane on any axis.
- Two hierarchies (is-a and part-of) and search by name or id.
- Switching between male and female keeps the camera and the selection; the compare view shows one system of both bodies side by side with linked cameras.
- Expression and mouth shapes: 21 emotion expressions (6 basic, 15 compound), 25 action units and 17 mouth shapes of speech, which combine with the pain expression; an audio file can also drive the mouth.
- "Attribution & disclaimer" holds a "Calibration" view: tables comparing joints, muscle moment arms, segment proportions, organ volumes and expression displacement with open external models, item by item.
- Each body carries a list of cautions, shown on first load.

### Compare view, touch and WebGL2

- **Compare view**: pose, breathing, body shape, the pain expression, emotion expressions and mouth shapes apply in both panes. Shape is carried to the other body as offsets from its own defaults, within its valid range.
- **While the skin is opaque**, the parts to hide come from each body's `display.json` (at present the external ear and the deep upper and lower lip, shapes the skin has itself; the compare pane uses its own body's list); they stay in the tree and selecting one shows it. The eyebrows are drawn opaque with the skin, in an illustrative dark colour: they stand only a fraction of a millimetre proud of it and all but vanish when see-through. The Display tab has an "Opaque skin" switch.
- **Touch**: one finger orbits, two fingers pan and pinch-zoom, a tap picks; on phones the top bar takes two rows and details open as a bottom sheet. In an embed the canvas takes over gestures only after it is first touched; before that a vertical swipe still scrolls the page. Verified in device emulation only, not on a real device.
- **WebGL2 fallback**: opaque parts of each system are drawn in one call (from over three thousand draws to about a hundred); `?chunks=0` switches this off for comparison. The camera follows the body when stature changes.

### Lifelike look

An opaque skin takes the lifelike look by default; the "Lifelike look" switch on the Display tab or `look=0` in the address brings back the anatomical colours. A see-through skin and the skin maps always use the anatomical colours; the compare pane does not draw the lifelike look yet.

- **The skin has UVs.** The UV layout is MHR LOD0's (Apache-2.0). The skin is MHR topology already and the shipped vertices point back to MHR's through `skin-source.u32`, so the UVs carry over as they are; simplification pulled a few triangles across a seam, and those are re-projected about a corner that has its own UV. Grafts (the CC0 toes, the external genitalia, the blend rings) and the vertices built for the openings have no MHR origin: they take the UV of the nearest MHR face, which folds where the shapes differ (about 15 000 triangles on the male); later skin detail uses UV-free triplanar mapping there. The skin's vertex order is unchanged: the lifelike skin is an overlay that follows the skin (one skin vertex has two copies at a seam), so body shape, expression, soft-tissue offsets and pose all apply as before. The data are in `public/anatomy/<body>/look/skin-uv.*`.
- **Skin colour calibrated against data.** The albedo comes from a two-layer spectral skin model (the epidermis/dermis structure of Donner et al. 2008; melanin, haemoglobin, carotene and a baseline absorption; the layers combined by Kubelka–Munk, the surface by Saunderson's correction), fitted to the NIST reference data set of human skin reflectance (Cooksey et al. 2017; 100 subjects' inner forearm, 400–778 nm): each subject has only two numbers of their own, melanin and dermal blood, and the other parameters are shared. The eumelanin share of melanin is fixed at 0.74 (Del Bino et al. 2015, 2022: about 74% eumelanin and 26% pheomelanin in every skin tone) and the epidermis at the dorsal forearm's viable epidermis of 57 µm (Sandby-Møller et al. 2003). The spectral RMS (400–700 nm) is 0.0102 on average and 0.022 at most; as colour under D65, ΔE00 is 1.06 on average and 2.68 at most — about the difference between one subject's three scans (1.11 on average); the nine subjects with ITA° < 28 average about 1.6. The model is baked into a 64×64 "melanin × blood → linear-sRGB albedo" table (`look/skin-lut.bin`); looked up in the table with the surface reflection added back, ΔE00 is 1.25 on average and 2.90 at most. The first version left the eumelanin share free with a 0.25 mm epidermis (Donner et al. 2008): the fit drove the share to 0 (all pheomelanin), which made deep tones lean orange; deep tones now have a hue angle of about 60° (it was about 67°), a redder brown. The scattering power (0.36) is still below the literature's skin average and is an effective value; the model counts as calibrated only within the NIST range.
- **Skin tone slider.** The "Skin tone" slider under the lifelike switch on the Display tab (`tone=0–100` in the address) sets the epidermal melanin, melanin = 0.33 × (tone/100)²; the default 23 is the median of the 100 NIST subjects. The deepest NIST skin is about ITA° −21, so tone above 62 is extrapolated (the slider says so), and the deep end is about ITA° −55.
- **Regional colour.** A 1024² map (`look/skin-regions.png`, on MHR's UVs) gives every patch of skin a melanin multiplier, a blood multiplier, a palmoplantar weight and a roughness. Forehead, cheek and back of the hand relative to the inner forearm come from the four groups of Xiao et al. 2017 (inverted with the same model, leaving 1.1–2.2 ΔE00 on the forehead and 1.7–2.4 on the cheek), the vermilion relative to the cheek from a 202-person study (abstract only); the vermilion has a table of its own (`look/skin-lut-lip.bin`): its thin stratum corneum and papillary capillaries close to the surface are modelled as a 39 µm epidermis, inverted together with the blood, which brings the residual from 2.4 down to 1.5 ΔE00 (weaker vessel packaging was tried and made it worse); and the melanin of palms and soles is pulled to a light value independent of skin tone after Phan et al. 2022; nose, ears, eyelids, fingertips, nail beds, areolae, external genitalia, extensor elbows and knees, dorsal forearms and the low-frequency mottling have no published numbers that we found and are assumptions set from qualitative accounts. Every number is marked sourced / computed / assumed in `data/curated/look/skin-colour.json`. All regions are computed from rest-pose positions (distance to lips, lids, nipples, joints and grafts, and the normal direction) and the space outside the islands is filled by push-pull, so seams show no line; the grafts' UVs are projected onto the nearest MHR face and take its value. These data are downloaded only once the lifelike look shows (about 0.3 MB per body).
- **Micro-relief.** Pores, furrows and ridges are a procedurally generated, tileable height map (`look/skin-micro.png`, one tile = 1 cm², fixed seed; the tests regenerate it byte for byte). Facial pores follow Flament et al. 2015 (cheeks of 2,585 women: about 10–80 per cm², mean area 0.03–0.22 mm²) at 40 per cm² with a median area of 0.08 mm²; the body has finer pores plus three crossing families of furrows; palms and soles carry ridges with a 0.45 mm period, and each finger pad has its own whorl core, drawn as rings of ridges by the distance to it and broken up by the tiled ridges into bifurcations (`look/skin-pads.png`; whorl-like, not a real fingerprint); the transition between nail and pad is wider, so no hard ring shows. Amplitude and type per region are in the detail map (`look/skin-detail.png`); the body's fine relief, furrow depths and every number outside the face are assumptions. The map is not read through the UVs but triplanar on the rest-pose position, so grafts with folded UVs are fine; the normal is bent with Mikkelsen's 2010 bump mapping of unparametrised surfaces, stacked on the wrinkle layer's normal, alike on both backends, and the detail fades out once one pixel covers more skin than its size.
- **Specular.** Two specular lobes (roughness ×0.75 weighted 0.85 and ×1.30 weighted 0.15, the defaults of UE's subsurface profile, borrowed as a technique only), the second one being three's clearcoat layer; overall roughness raised to the order Weyrich et al. 2006 measured on faces (lips and the T-zone glossier, both assumed); pores and furrows occlude part of the specular and ambient light by depth; the sheen is tinted by the albedo. Deep tones therefore no longer look coated in plastic.
- **Subsurface.** Light comes through only where the body is thin: rays cast inward from every MHR vertex give how thick the body is under it (`tools/look/thickness.ts`), and transmission falls off as exp(−thickness / path), with paths of 4, 1.2 and 0.6 mm for red, green and blue (red light penetrates a few millimetres, Bashkatov et al. 2005; the exact values are assumed). Backlit fingers and toes glow red; MHR's ear is a shallow relief on the side of the head with no free auricle, so the ear lets no light through. Direct diffuse uses a pre-integrated table (Penner & Borshukov 2011, reimplemented from the paper, with the six-Gaussian profile of d'Eon et al. 2007), with curvature baked offline into the detail map: where the radius is a few millimetres (nose, fingers, ears) the terminator softens and reddens, and flat skin is exactly Lambert. Screen-space separable subsurface scattering is left for later.
- **Cost.** About 1.0 MB more per body (detail map about 0.38 MB, micro-relief tile 0.55 MB, pre-integrated table 32 kB), downloaded only once the lifelike look shows. Frame time from `benchSync(120)` in headless Chrome (Apple GPU, 900×1000): WebGPU 1.25 ms for the whole body (anatomical colours 0.75 ms) and 1.42 ms for a face close-up (0.81 ms); WebGL2 0.23 ms (0.19 ms). `bench(5)` holds 60 fps either way.
- **Material and light.** A physically based material: index of refraction 1.4 (F0 ≈ 0.028) and a faint albedo-tinted sheen for vellus hair; the image-based light is three's own procedural room, prefiltered (no external HDR image), with Khronos PBR Neutral tone mapping. In lifelike mode the wrinkle detail layer switches to the same material and detail.
- **Lifelike eyes (construction, not anatomy).** In lifelike mode the scanned eyeball parts are not drawn; a pair of eyes constructed for display takes their place (`src/look/eyes.ts`, `eyesFit.ts`), drawn the way game engines do: centre and radius fitted to the scanned sclera (male left / right 12.62 / 12.59 mm, female 12.39 / 12.03 mm), the optical axis through the scanned cornea's apex; the cornea is a 7.8 mm spherical cap (Le Grand's theoretical eye) meeting the sclera at a limbus 11.71 mm across (white to white). The iris is not geometry: in the fragment the view ray is refracted at the corneal surface with index 1.376 and met with the iris surface, where radial fibres, crypts, the collarette and the pupil (4 mm across by default) are drawn procedurally, so seen from the side the iris stays behind the cornea. There is also a dark limbal ring, fine vessels towards the canthi, a pink hint of the caruncle at the medial canthus, a tear line along the lid margins, and the shadow the lids cast on the eyeball ("eye occlusion", computed in the shader from where the lid margins are right now, so it follows the expression). The technique follows Epic's public documentation of the eye shading model and MetaHuman's eye occlusion and tear layer; none of their assets is used. Iris colours: brown (default), dark brown, hazel, green, blue, grey; these colours are assumptions picked by eye against eye photographs on Wikimedia Commons. Selecting a scanned eyeball part on one side draws that side's anatomical parts instead.
- **Gaze.** By default both eyes look at the camera (converging on it); the Display tab offers "straight ahead", and the address takes fixed angles `gaze=yaw,pitch`. The angles are held to ±45° horizontally, 30° up and 35° down (inside the mean maximal ductions of normal adults measured on a Goldmann perimeter); when the camera goes round behind the head the eyes return to straight ahead. The eye turns about the fitted centre in rest space and is then skinned by the skull joint, so it follows the head pose. The lids follow vertical gaze: the amounts come from the measurements of Mastropietro et al. 2009 (10 normal subjects, −30° to +30°) and are added at run time to the expression's lid channels (levator palpebrae, palpebral orbicularis oculi); the expression data are unchanged. Each channel is calibrated by how far it really moves the mid-margin (measured from the face data at load). The face data have no channel that lowers the lower lid, so looking down the lower lid is lowered by the palpebral (lower lid) field run backwards (up to twice, an extrapolation): at −20° and −30° the male fissure narrows to 0.79 and 0.69 of its size (literature 0.81, 0.72), the female's to 0.79 and about 0.61.
- **Living eyes.** Spontaneous blinks: about 15 a minute (Doughty & Naase 2006: 13.8 a minute on average in primary gaze; the distribution of the intervals is an assumption), about 0.3 s each, closing about 1.5 times faster than opening (Kwon et al. 2013, high-speed video); a blink merges with the expression through AU43's channels by maximum, so it never goes past full closure. While looking at the camera the eyes make microsaccades (6–30 arcmin, about 1.2 a second; the rate is an assumption). The schedules are fixed by a seed and stop while the page is hidden; `blink=0` in the address or the "Blinks" switch on the Display tab turns them off (for screenshots and tests). The pupil follows the pain model: during a stimulus it takes the model's pupil output as it is, and a held pain level goes through the same table of autonomic signs (baseline 4 mm, 28% wider at intensity 6, numbers from anaesthetised patients), widening fast and narrowing slowly; the scene's light is fixed, so there is no light term.
- **Hair, eyebrows and eyelashes.** In lifelike mode procedurally generated hair cards replace the old hair shell and eyebrow shell; the anatomical mode is unchanged and the shells stay in the tree. Generation (`tools/hair/`): a head frame is set on each body's own skin (canthi, nasion, vertex, auricles), and the hairline follows from the forehead height (trichion–nasion 67 mm, Farkas norms as quoted; used as a vertical rise of 64 mm male and 61 mm female, assumptions) and the auricles' position, so the female hairline comes from her own head. Follicular units are scattered over the scalp at 226 hairs per cm² (pooled Caucasian mean, Leerunyakul 2020 review; 0.85 of that at the temples, quoted from a Thai study), 1–4 hairs per unit and about 2 on average (Bernstein 1998; the shares are assumed): about 148 000 hairs on the male and 113 000 on the female (literature 90 000–150 000). Fibre diameter 74 µm, cross-section ratio 1.40 and curvature 0.042 /mm come from the European sample of Lasisi et al. 2016; the 6 cm wavelength is assumed. Two styles, both available on both bodies: a men's short cut (side part, about 4.5 cm on top, 2 cm at the sides) and women's long hair (near-centre part, cut level about 7–10 cm below the shoulders); short is the male default and long the female. A few rules (part, whorl, length field, comb direction, gravity) comb the guide strands, then an offline PBD settle (inextensible, bending, gravity, collisions with the skin) relaxes them, with higher roots on the outer layers. Long hair has many narrow cards (level 0: 3557 on the male, 2707 on the female, 5–14 mm wide), and the strands in its atlas gather into locks towards the tips; roots lift by 25° and the outermost layer stands 30 mm off the scalp; waves beside the face are cut to 40 %; the cut height varies ±1.2 cm per strand so the tips do not form a line; a keep-out in front of the face (below the brows, within the face's width) means no lock hangs in front of the eyes. Highlights: each strand's cuticle tilt lies within 2° ± 1.5° (pbrt: generally 2–4°) and its roughness varies ±15 % (0.48 for long hair, 0.42 for the short cut), so the highlight is no longer one tidy bright band. The eyebrow shape is the old eyebrow shell projected onto the skin, about 270 hairs a side (only an unsourced popular figure of 250 was found, so it counts as assumed), median length about 7.5 mm, directions after "the medial end points up, the top edge outward and down, the bottom edge outward and up" (a hair-transplant clinic's description, quoted); eyelashes grow along each body's own lid-margin chains, 120 per upper lid in three rows and 77 per lower lid in two (StatPearls: 90–160, 75–80), median length 7.5 and 5.6 mm (quoted by Wikipedia: 7–8, 5–6 mm), with an assumed curl. Strands are grouped into cards by k-means, three levels of detail for scalp hair and two for brows and lashes; the card atlas is drawn from these strands (coverage, root → tip, a random number per strand, depth, angle) and published with the project data under CC BY-SA 4.0. A dark, hair-coloured tint is drawn on the scalp under the cards (a common game technique, faded in by the distance from the scalp border), so no bright skin shows between the cards or in the part. A coverage check (`tools/hair/coverage.ts`, no rendering) takes 3 points per cm² of scalp, casts rays towards the camera from the front, both three-quarter views, both sides, the top and the back, and accumulates opacity through the cards by the atlas coverage; 4 mm either side of the part and the hairline ramp are not counted. In every view at least 95 % of the points are covered (opacity ≥ 0.9): 96–100 % for the short cut, 95.5–100 % for long hair; the numbers are recorded in `hair.json` and the tests recompute them. One download is about 3.2–4.4 MB per body, fetched only once the lifelike look shows. Every number, its source and its "quoted / assumed" status is in `data/curated/hair/hair.json`.
- **Hair shading.** The Marschner-style three-lobe approximation (R, TT, TRT) of Karis 2016 (SIGGRAPH course, "Physically Based Hair Shading in Unreal") is reimplemented in the shader from the paper and public written descriptions; the fibre colour comes from melanin concentrations: the absorption per unit concentration of eumelanin and pheomelanin is pbrt 4th edition's (the approach of Chiang et al. 2016), black 8, brown 1.3 and blonde 0.3 are the book's concentrations, dark brown, red and grey are assumptions; the factor of the multiple-scattering albedo exp(−2.6√σa) is set by eye. Transparency is alpha-to-coverage (multisample coverage): depth is written as usual and nothing needs sorting, on WebGPU and WebGL2 alike. Each card's root is pinned to a skin triangle by barycentric weights, so body shape, expression, soft-tissue offsets and pose carry it along; cards are rigid relative to the head, with no dynamics yet. The Display tab picks the style (none / short / long) and colour (black, dark brown, brown, blonde, red, grey). Pubic hair is still the old shell.
- **Current limits.** The deep end of the tone slider is extrapolated; the micro-relief is a procedural sketch, not a scan; the ear has no free auricle: MHR's ear is only a shallow relief, and the scanned external ear (FJ2811) is coarse (about 185 vertices per ear) and mostly buried in this skin (63% / 82% of its vertices inside the skin on the male / female, up to 13 / 15 mm deep); it would have to move out about 12 mm to show, which would part its root from the side of the head, so the lifelike mode still does not draw it; there is no screen-space subsurface scattering; there are no clothes. These come in steps: real hair strands close up on WebGPU with strand dynamics, and everyday and sports clothing generated from sewing patterns with cloth simulation. MetaHuman serves only through its published technical documentation; its assets are not used (their licence does not allow them in a public repository).

### Body shape

The "Body shape" section of the Pose tab has four sliders: stature, BMI, relative leg length and mass distribution. BMI changes only the skin and the fat under it (muscles, bones and viscera stay; visceral fat and the breasts are not modelled); stature and proportions are realised by per-joint segment scales. Each slider moves only within the range valid on this body and states the reason at its limit (the male, for example, cannot go below BMI 21.5 because muscle would come through the skin). The regressions come from population surveys and give average builds, not a prediction for a person.

Known problems: when the body is shortened or re-proportioned, subcutaneous fat comes through the skin by up to about 12 mm; "mass distribution" has only a weak effect; the female body's default BMI has two values in the data (22.0 and 23.7), so its readout is approximate.

### Pain response (expression and voice)

The "Pain" panel on the left demonstrates pain behaviour: set an intensity (0–10) and an onset, press Trigger, and the facial action units rise and fade over time, with a vocalisation unless muted and the mouth in step with the sound. "Hold" keeps the expression at the set intensity; "Always vocalise" (off by default) makes a sound at low intensities too; "Single action units" shows one AU at a time.

This is a computational model of pain **behaviour** for teaching: the simulated body has no subjective experience; the intensity-to-expression numbers are assumptions of this project; the sounds are recordings acted on instruction (or parametric synthesis when the pack is absent). The expression is driven by the facial muscles of the model (`tools/face/`, `data/curated/face/`): the upper lid slides down over the globe to close the eye, and an opened mouth shows teeth and tongue.

**Applying a stimulus.** The stimulus tool at the top of the Pain tab: pick the kind (pinprick, pressure, pinch, heat, cold), magnitude, duration, repeats and whether the stimulus is held; with "Apply on the skin" on, a click applies it for the set duration and pressing and holding applies it until release. It works on a posed or reshaped body. The response is shown as a pain map on the skin, the pathway from skin to nerve root with the Aδ and C markers travelling along it, the withdrawal reflex, the expression and (with sound on) the voice, and a monitor with heart rate, blood pressure, respiration, pupil and skin conductance. The explanation panel gives the reason in nine steps and marks every number as sourced, assumed or computed. The monitor shows group-average effect sizes that cannot be used to infer pain. The model is in `src/painmodel/`, its tables and sources in `data/curated/pain/`.

**A skin with real openings.** Eyes and mouth are real openings: with the skin opaque, the eyeballs, teeth, gingiva and tongue are seen through them (anatomical parts, drawn whatever their systems' switches say). The near-black wall deep in the mouth (the oral pouch) and the rim turned in at the lid margins were constructed for the openings and are not anatomy: the pouch cannot be picked and takes no skin-map colour. The parts hidden under an opaque skin come from the pipeline (the external ear and the deep upper and lower lip, which the skin has itself). Select the skin and its details list the pieces it is assembled from; "construction" has its own colour and a dashed mark and is not an anatomical provenance. The Pain tab defaults to the skin view.

**Wrinkle detail.** While the skin is opaque, the face gets a layer of normal detail blended by expression (glabella, crow's feet, lower lid, nasal root, nasolabial fold, lip corner); the wrinkles are procedural and their counts and sizes are assumptions.

For the licence of the sound material see "Pain sound pack" below. Embed mode is muted by default and any sound needs a click.

### Expression and mouth shapes

The "Expression" panel on the left:

- **Emotion expressions.** 21 of them (the six basic ones — happy, sad, fearful, angry, surprised, disgusted — and 15 compound ones), each a set of facial action units (AUs) with a strength slider from 0 to 1. Which AUs make up each emotion is from Du, Tao & Martinez 2014; **the intensity of each AU is an assumption of this project**. The simulated body has no emotions; published prototypes are merely posed.
- **Single action units.** A slider for each of the 25 AUs (0–5, FACS levels A–E), the same set as in the Pain tab.
- **Mouth shapes (visemes).** 22 mouth shapes of speech (17 for English plus 5 for Mandarin only: rounded front ü, retroflex zh ch sh r, alveolo-palatal j q x, the rhotic vowel er and the velar fricative h); click to hold, click again to release: lips sealed for bilabials, lower lip to the upper teeth for labiodentals, rounded, spread, open; the tongue has five schematic poses (tip, front and back raised, lowered, retroflex). The method is from JALI (Edwards et al. 2016). Every shape has two sets of numbers, chosen with the "Style" switch:
  - **Normal**: the openings of read speech. **The jaw openings are calibrated against measurements**: incisor openings from electromagnetic articulography, the mean of three English speakers (one from USC-TIMIT, CC BY 4.0; two from MOCHA-TIMIT, **a corpus licensed for research, educational and individual use only — only aggregates computed by this project are used and the corpus itself is not included**). An open a parts the incisors by only about 5 mm and most consonants by 1–3 mm. Some tongue weights come from measured coil heights. **What is assumed**: the lip action intensities (checked against the measured lip aperture for order only), contact of the tongue tip, and equating the highest jaw position reached in speech with a closed mouth; the 5 Mandarin-only shapes have no measurements behind them at all.
  - **Clear**: the wide shapes from before calibration (an open a at half the jaw's range), **assumptions throughout**; their merit is that the shapes can be told apart.
  - With the switch on "Default" the shape buttons use Clear and speech uses Normal. Where each number comes from is recorded under `calibration` and each viseme's `provenance` in `data/curated/face/visemes.json`.
- **Say something (phoneme-driven).** Audio that comes with a phoneme timeline; the mouth shape is set by which sound is being made, not guessed from the audio: phonemes → visemes (`data/curated/face/phonemes-en.json`, `visemes-zh.json`) → co-articulation (the JALI habits; Mandarin is grouped by syllable, so rounding does not cross a syllable boundary) → mouth shape, on the same clock as the audio. The panel shows the word and sound being spoken.
  - 12 demo sentences ship with the repository (6 English, 6 Mandarin, `public/voice/tts-demo/`) and **need no backend**.
  - **Real read-speech examples** (the "Examples: real read speech" list, `public/voice/librispeech-demo/`): 10 English sentences read aloud, from LibriSpeech dev-clean (5 female and 5 male speakers, 3–4.5 s each, CC BY 4.0); every one has at least one bilabial, labiodental, rounded sound and open vowel. The phoneme timelines are **automatic** Montreal Forced Aligner alignments (Lugosch 2019), not hand labels. The same recording can drive the mouth "By phoneme" or "By audio", so the pack is also a benchmark for the audio analysis (`mouthTrack`) that ships with the repository: `bun tools/voice/librispeech-demo.ts bench` writes the jaw-angle correlation of the two modes and the lip gap at the middle of each bilabial into the manifest. Current results: jaw-angle correlation 0.46 on average (0.32–0.63), with the audio route about 60 ms late; of 41 bilabials all close by phoneme (lip gap ≤ 0.11 mm) and only 3 by audio (median lip gap 3.2 mm). Selection and generation are in `tools/voice/librispeech-demo.ts`.
  - With the speech-synthesis backend present (see "Run") you can type an English or Mandarin sentence and choose a voice and a speed; the backend's refusals and warnings are shown verbatim. **The audio is machine-synthesized** (Kokoro-82M, Apache-2.0), and the UI says so.
  - The same audio can be switched between "By phoneme" (accurate) and "By audio" (an analysis of the same audio, approximate) to see the difference; in a link, `drive=audio`.
  - Without a user gesture (opened by a link or a card) browsers allow no sound: the mouth runs silently on the page clock (looping when embedded), and "Sound" replays it from the start with audio.
- **Speak from audio.** Choose or drop an audio file; it is decoded and analysed in the page, and after pressing Play the mouth follows the sound, with a strip showing opening, rounding and closure. The file is never uploaded. **Mouth shapes derived from sound are approximate**: opening is fairly reliable, rounding moderate, lip closure weak (treated as a generic closure), and labiodentals (f, v) are not detected.

Pain, emotion and speech are composed by one driver (the rule is `blendFace` in `tools/face/model.ts`): emotion and pain take the larger value of each AU; the upper face (brows, eyes) comes from that set alone; while speaking the expression's lower face is attenuated to four tenths and then combined with the mouth shape by taking the larger value per channel; the jaw is the larger of the two; a lip closure wins over an open-mouthed expression. When the pose panel or a reflex has already opened the jaw, lip seal and corner shaping are computed for the total jaw angle, so a bilabial still closes (while the total stays within about 8.7°; beyond that the lips cannot reach). The mouth shape has three sources, in falling precedence: a phoneme timeline, an analysis of audio, a held shape.

Phoneme-driven speech adds two treatments (`src/face/visemeTrack.ts`): where a bilabial touches a labiodental ("five more") the closure and lower-lip-to-teeth constraints both approach full value, and the larger one is made to win, as the lips would not close otherwise; and with the lips sealed the funnel (AU22) is taken off, because it pushes sealed lips apart by about 1 mm. A known shortcoming: the closure decays over 120 ms, so a short vowel between two bilabials (妈妈, "mama") does not open up.

### Muscle activity

The "Muscle activity" switch of the Pose tab has two layers of different standing:

- **Length change (geometry, reliable).** How much shorter (warm) or longer (cool) each muscle's line of action is in the current pose than at rest. It says nothing about effort.
- **Load (an estimate).** The activations needed to hold the pose with the body still under gravity (optionally with a load in the hand): segment masses from the volume the skin encloses and tissue densities, gravitational joint torques summed along the skeleton, moment arms from the lines of action (−∂length/∂angle), maximum force = muscle volume / fibre length × specific tension, then the sharing with the least sum of squared activations (static optimisation). Standing, body weight is carried at the sole contact points; supine or prone, limbs that were not moved rest on the couch. Torque the muscles cannot deliver is listed per joint as the residual.
- **Simplifications and assumptions.** No inertia, no co-contraction, no passive ligament force (only a joint at the end of its range is held passively); lines of action are mostly straight: the muscles round the knee take their fixed via points from the rig (the quadriceps through a point on the femur to the patella), and the long tendons at ankle and wrist get one via point each; the rig's points that are used only while wrapping (behind the femoral condyles, along the patellar track) are not in these paths, so the moment arms of those muscles stay unreliable in deeper knee flexion; the thoracic spine and ribs are a rigid cage, the shoulder girdle and subtalar joint are not balanced, the lumbar and cervical spine are each balanced as one stretch; the specific tension of 61 N/cm² and the fibre-length ratio of 247 of 333 muscles are assumptions. Read who works, not the percentages; muscles with unreliable moment arms carry ⚠ in the list.
- **Validation.** Nine poses with known answers on both bodies, judged by ranks and signs only: 16 of 18 pass (holding the forearm, holding 2 kg, triceps taking over overhead, shallow squat, tiptoe, forward lean, trunk flexion, supine straight leg raise); at 90° of abduction supraspinatus stays dark on both bodies, because a straight line has no abduction moment arm once the arm is raised. Elbow torque over m·g·d from de Leva's segment parameters is 0.88 (male) and 0.72 (female). Numbers are in `data/curated/activity/validation.json`.

The data is written by `bun tools/activity/build.ts male` (likewise female) to `public/anatomy/<body>/activity.json`, with parameters and sources under `data/curated/activity/`; rerun it after the rig or the geometry is rebuilt, otherwise the UI shows length change only.

The muscles round the knee (hamstrings, gracilis, sartorius, both heads of gastrocnemius, quadriceps) have via points in the rig (`MuscleLine.via`): `tools/rig/via.ts` places them on this model's bone surfaces by the rules in `data/curated/rig/via.json` — wrapping points behind the femoral condyles (used only when the line would pass into the condyles) and points along the patellar track. The polyline gives lengths, moment arms and muscle activity (`tools/rig/musclepath.ts`). The meshes of some of these muscles follow the path: they are skinned by cross-section (every vertex of a cross-section takes the same averaged weights, passing gradually to the bone of the attachment within 2 cm of either end, and the part projecting beyond an end passes back to plain skinning within 2 cm), and each cross-section is then translated out of the knee bones by a table baked when the rig is built (up to 90° of flexion it is also kept no further outside the skin than plain skinning; `tools/rig/viapush.ts`; the table runs over the knee flexion angle, is stored in `MuscleLine.viaPush`, and does not follow the hip, the ankle or tibial rotation). The volume correction stays about the straight line between the ends; the CPU reference and the shader use the same formula, the rest pose is unchanged, and muscles without via points are bit for bit unchanged. `bun tools/rig/via-check.ts` compares this with plain skinning at 90° and 135° of knee flexion and in the squat: no more inverted triangles, edge stretch (p99 and max), muscle vertices inside the knee bones (inside judged on the closed bone meshes), vertices outside the skin (count and largest distance) or stand-off (largest distance from bone, skin and other muscle, and the vertices beyond 15 mm), and no less coverage of the anterior distal femur, the patella and the posterior condyles. Coverage counts only when the first surface a ray meets is muscle lying outside the bone (the earlier measure also counted muscle running through the bone and stretched shards; the tool still reports it alongside). `tests/rig-via-check.test.ts` guards this gate. Muscles that do not pass it stay plainly skinned and are listed, with reasons, under `meshPlain` in `data/curated/rig/via.json`: the vasti (both bodies), the short head of biceps femoris and semimembranosus on the male, and all but the short head of biceps femoris on the female. It is a kinematic approximation, not a contact model: in deep flexion some mesh still lies inside the bones. After changing the rules, rerun `bun tools/rig/run.ts <body> --no-renders`, `bun tools/rig/shape-build.ts <body> --no-renders`, `bun tools/face/run.ts <body>`, `bun tools/calibrate/run.ts skeletal` and `bun tools/activity/build.ts <body>` in that order; `SOMA_RIG_DIR=<dir> bun tools/calibrate/run.ts skeletal` measures the moment arms of a rig built elsewhere (`--out <dir>/<body>`).

### Lumina

The "Lumina" section of the Display tab (male body). The lumina of the hollow organs are 19 parts: one alimentary lumen from mouth to anus (oral cavity, pharynx, oesophagus, stomach, duodenum, jejunum, ileum, ascending / transverse / descending colon, rectum, anal canal), and the lumina of the bladder, ureters, deferent ducts and seminal vesicles. The female has 19: the alimentary lumen likewise runs from mouth to anus, with the specimen's own rectal lumen as the rectal stretch (not rebuilt); the lumina of the bladder, the left ureter and both uterine tubes (her right ureter and right tube pass through each other in the source data, so no right ureteric lumen is given); and the specimen's own uterine cavity, cervical canal and vaginal lumen (one former "uterine and vaginal lumen" part split in three along its centreline, vertices untouched). She has no urethral lumen.

- **How they were made.** They are not scanned: each is the organ's outer surface moved inward by a wall thickness from the literature (or assumed); mouth and pharynx are the space left between the real parts around them. Construction (the stretch from lips to teeth, the velum, the end of the anal canal, the joins between organs) is coloured apart. The data at present gives only vertex counts per class for each part, not a per-vertex marking, so colouring is per part: an all-construction part takes the construction colour, and one with a tenth or more of construction (mouth, pharynx) an in-between "partly construction" colour.
- **When they show.** Inside an opaque wall a lumen is not drawn. With "Show the lumina of the hollow organs" on, walls go see-through and lumina take a colour of their own; a lumen also shows when its system is made see-through or when it is selected from the tree or the search. "Alimentary canal" isolates the canal's lumina and walls and frames the camera.
- **Filling.** A slider from 0 to 1: 0 is the resting state as shipped (oesophagus and stomach collapsed, small bowel thin, ascending and transverse colon gas-filled), 1 as full as the wall allows; each lumen's filling is f = rest + slider × (1 − rest), and a selected lumen can be set on its own. The displacement is added to the vertices before skinning (position = GLB position + (f − rest) × displacement), so it composes with poses; normals are recomputed, area-weighted. **The organ walls do not move with filling.** Mouth, pharynx, oesophagus and deferent ducts have no displacement. With a lumen selected the details give its volume at the current filling: the signed volume of the mesh, with open-ended tubes closed virtually by centroid fans over their end rings — an approximation (stomach: about 21 cm³ at rest and 440 cm³ full; the pipeline report says 20 / 420).
- **Fly-through.** The camera travels inside the lumen along the canal's centreline from mouth to anus, looking forward (field of view 80°, near plane 0.4 mm); the strip below names the segment, the distance covered and the lumen's diameter there, with play / pause, reverse, speed, a scrubber and a jump to any segment. The centreline is computed in the UI from the meshes: the pipeline's lumina have a ring of 16 vertices per station, so the vertices are sorted into rings by connectivity and the ring centroids taken; mouth and pharynx are voxel isosurfaces without rings and use the guide lines in `lumen-path.json`. The rules: while flying every segment of the canal is filled to at least 0.5 (the whole canal at once); what is still narrower than 6 mm is widened about its ring centres to 6 mm — **only so that it can be seen; it is not data**; and walls are not drawn (the end caps of the organ pieces' meshes would lie across the lumen).
- **Known shortcomings.** The pharyngeal cavity stops about 20 mm above the oesophageal lumen, the oesophagus enters the stomach from the side and the ileum the ascending colon likewise; at these three places the camera leaves the lumen for a short way (about 14, 49 and 26 mm). At sharp bends of the small bowel the centreline grazes outside the lumen, and the guide lines through mouth and pharynx are only a rough midline. Female: her skin has no opening at the perineum (the vulva graft of the skin package is not on it), so the vaginal lumen ends blind and the constructed anal canal runs to skin that is not open; the specimen's own lumen surfaces (rectum, uterine cavity, cervical canal, vagina) carry no filling displacement; her fly-through has not been checked in the viewer. For the other limits see "Known gaps".
- **Data.** `lumen-filling.json` / `.bin` (written by the pipeline) hold each part's rest filling and per-vertex displacement; `lumen-path.json` (a few kB) is extracted from `pipeline-report.json` by `bun tools/lumenview/extract.ts male`: the order of the segments, the wall parts of every lumen, and the guide lines through mouth and pharynx. Rerun it after the geometry is rebuilt.

### Soft-tissue physics: pressing and posture

Male only (the soft-tissue physics has not been run on the female, so it is off there and the UI says why). All computing happens in a Web Worker (`src/softbody/worker.ts`, `engine.ts`); the main thread only receives results. Every place in the UI states what is validated and what is not (`src/softbody/statements.ts`).

- **Pressing.** In the Pain tab's stimulus tool choose "Pressure" and tick "Physics press": pick a spherical or flat probe, a radius (2–15 mm) and a force or a depth, then click the skin. The worker builds a fine cage at the clicked site on demand (cell ≈ a third of the probe radius, 2–6 mm) and runs `press()` — the code the validation ran (`src/softbody/site.ts`), so at the validated forearm site the result is identical to the digit (checked in the tests). While it solves the dent comes back about every 0.12 s and is shown as it forms; the result gives indentation depth, the force reached, mean and peak nodal contact pressure, contact area and peak axial compressive strain; when the crush gate (compressive strain past 0.6) stops force control short, the UI says where it stopped and how many newtons it reached.
- **Pain input.** The pain model's pressure is the stimulus's `forceN` ÷ `areaMm2` (inputs it already had). The physics press puts the force reached and the contact area there, so the model receives the computed mean contact pressure instead of the nominal "force on a 1 cm² probe" (`registerContactProvider` in `src/pain/stim.ts`, `Contact` in `src/pain/stimulus.ts`). Example: a 5 mm sphere asked for 1 N on the forearm is stopped by the crush gate at 5.23 mm and 0.958 N, over a contact area of 73.6 mm², a mean of 13.0 kPa and a nodal peak of 43.1 kPa, below the 369.5 kPa threshold there, so there is no pain response. How the contact figures are counted (`meanPressureKPa` in `press.ts`): mean × area = force and peak ≥ mean. For a flat punch or plate the area is that of the samples lying on the end face; linear elements cannot follow a sphere, and counting samples undercounted its area several times over (it used to report 21.9 mm² and a mean of 43.68 kPa, above the peak), so for a sphere it is counted over the nodes carrying force, and the area is projected across the pressing axis. The area, mean and peak pressure of the sphere rows in `validation-report.json` were computed the old way; depth and force are unaffected.
- **Showing the dent.** The displacement is added before skinning (the path of expression and shape), so it composes with poses. The skin mesh is coarse (edges of about 12–17 mm on the forearm and chest, some triangles several cm), so a dent of a few mm falls between its vertices; the skin triangles round the site are therefore subdivided to about 1.5 mm (no finer than half a cell) and drawn as a layer of their own (`src/softbody/dentmesh.ts`, `src/viewer/dentPatch.ts`), the dent taken at the subdivided points, while the original triangles and the subcutaneous fat it covers are drawn inward for display (the fat's mesh is as coarse and would otherwise show through the bottom of the dent); with a see-through skin the layer is not drawn and only the original vertices move. The stimulus site marker and the nerve pathway are bound to skin vertices; while the dent is shown they are put back on the dented surface rather than drawn inward (in a pose this correction does not turn with the bones, an approximation). The integumentary system's other parts (subcutaneous fat, other skin pieces) follow the cage too. When the stimulus ends (or is cleared) the dent springs back over 0.7 s — a display transition; the tissue's creep recovery is not simulated.
- **Posture.** "Posture and gravity" in the Pose tab: standing, supine, prone, lying on the left side, lying on the right side. The worker builds the whole-body 27 mm cage from the meshes it receives (about 1.8 s), turns gravity for the posture (the pre-stress puts the standing equilibrium on the shipped shape), adds a support plane through the lowest point when lying, runs with the substep rule (13 substeps on the male) until the largest node speed is below 2×10⁻⁴ m/s, and then shows the skin's displacement relative to standing: the skin moves there (a 0.9 s transition; it can be shown ×3) and is coloured by the magnitude (true size, a fixed 0–30 mm scale; `src/viewer/dispOverlay.ts`). Supine: 755 frames at about 100 ms a frame in the browser's worker (about 59 ms on the command line), skin displacement mean 3.3 mm, largest 23.3 mm; prone 760 frames, mean 4.3 mm, largest 27.8 mm; on the left side 740 frames, mean 4.1 mm, largest 36.9 mm. Supine, the back rests on the support plane and moves less than 1 mm. Each posture is computed once and cached. The solve pauses while the page is hidden. **Not compared with measured data**; the skeleton stays in the rest pose and there is no muscle tone; the breast is not validated.
- **URL parameters.** `phys=sphere,5,1N@forearm_L` and the like give one press (sites written as in `stim=`); `phys=1&grav=supine` turns the posture solve on; `grav=` is shared with the muscle-activity display (which reads `supine` and `prone` only). Embed cards start by themselves, with no dialog.
- **Timings (headless Chrome on this machine, WebGPU, embed cards).** From applying the press to the first dent shown: 0.60 s for a 5 mm sphere on the forearm (0.41 s for a second press in the same worker), 0.86 s for the 26 mm flat punch (0.55 s), 0.90 s for a 5 mm sphere on the chest (0.61 s). Results: the forearm sphere at 1 N after 34 s (2108 frames at 16 ms; stopped by the crush gate at 5.23 mm and 0.958 N, the validated row), the flat punch to 4.5 mm after 12 s (387 frames at 30 ms; 1.83 N, 0.65 of the measured 2.83 N — validation had 0.66 with a 4.30 mm cell, the UI's default cell is a third of the radius, 4.33 mm), the chest sphere after 27 s (stopped by the crush gate at 4.41 mm and 0.49 N). Posture: cage built in 1.8 s, supine solved in 75 s, 84 s from opening the card to the result. Main thread: frame interval p50 / p95 / p99 of 16.7 / 16.8 / 16.8 ms during presses and the posture solve; one frame of 0.1–0.7 s at the start of the first press or the first posture solve on a page (loading, on demand, the geometry of the skeletal, muscular and other systems the cage needs, with long tasks of 57–115 ms); none after that, nor when the result arrives and is coloured.

### Calibration

"Open the calibration tables" in the "Attribution & disclaimer" dialog opens a read-only view of the ten tables under `data/curated/calibration/` (segment proportions, range of motion, humeral angles, muscle attachments and moment arms, organ volumes, expression displacement, coverage of facial controls, and an instrument check). Each table first shows how many rows fall within and outside tolerance, the largest disagreements, and each reference's name, version, licence and URL; rows can be filtered by body and the full table appears on demand. The tables (close to 1 MB together) are separate chunks fetched when the view opens. **They are comparisons with open external models and published statistics used as measuring instruments, not validation by a clinician**; the references are models or population averages themselves, not ground truth, and the tolerances were set by this project.

## Run

Requires [Bun](https://bun.sh).

```sh
bun install
bun run dev        # http://localhost:5183
```

The generated anatomy data (`public/anatomy/`) is in the repository, so a fresh clone runs as is.

**The speech-synthesis backend (optional).** `server/` is a FastAPI service (`POST /api/tts`, `GET /api/tts/voices`, `GET /api/health`) that synthesizes one sentence into 24 kHz audio with a phoneme timeline, using the open model Kokoro-82M (v1.0 for English, v1.1-zh for Mandarin, both Apache-2.0). Through the single entry point (idea-loom) it is started on demand and needs no attention. To start it yourself while developing:

```sh
cd server
uv run --extra model python -m soma_tts.fetch --state <state dir>      # first time: download the models (about 0.6 GB, each sha256 verified); not in git
WORLD_SIM_STATE=<state dir> uv run --extra model uvicorn soma_tts.server:app --host 127.0.0.1 --port <port>
cd .. && SOMA_API_PORT=<port> bun run dev                              # the dev server proxies /api to it
```

Without the backend the UI still works: the Expression panel has no text box and says that synthesis needs the local service, while the 12 shipped demo sentences and "choose an audio file" remain; the speech cards use the shipped clips.

### URL parameters

The whole view state lives in the query string, so any view can be opened by one link. Every parameter is optional and absent means the default; invalid values are ignored with a console warning.

| Parameter | Example values | Meaning |
|---|---|---|
| `body` | `male` (default), `female` | Which body |
| `embed` | `1` | Embed mode: stage and essential controls only, no dialogs |
| `tab` | `d`, `t`, `p`, `n`, `e` | Left panel: display, tree, pose, pain, expression |
| `sys` | `ske,ner:60` | Visible systems, each optionally with an opacity percent; unlisted ones are hidden. Codes: `int mus ske cv ner res dig uri rep end lym oth` |
| `peel` | `2` | Peel depth |
| `iso` | `FMA7088,FJ1234` | Isolate: part ids or concept ids (a concept expands to all its parts) |
| `hide` | as `iso` | Hide |
| `sel` | `FMA9611` or `FJ3259,FJ3260` | Selection: one concept id, or several part ids |
| `adj` | `1` | Show adjacent structures |
| `focus` | `1` | Frame the selected (or isolated, or visible) structures on load |
| `cam` | `px,py,pz,tx,ty,tz` | Camera position and target, in metres |
| `cut` | `a620`, `c500f`, `s250` | Section: axis (`a` axial, `c` coronal, `s` sagittal) + position per mille + optional `f` to flip |
| `xp` | `40` | Explode percent |
| `pose` | `squat` or `elbow_L.0:90,elbow_R.0:90` | Pose: a preset name, or `joint.dof:degrees` relative to rest |
| `breath` | `1` | Breathing demonstration |
| `map` | `d`, `n` | Skin map: dermatomes, cutaneous nerve territories |
| `reg` | `14,15` | Highlighted region indices of the skin map |
| `see` | `1` | Draw the skin see-through under a skin map, to reveal the nerves beneath |
| `src` | `1` | Colour by data source |
| `cmp` | `ske` | Compare view and the system it shows |
| `shape` | `h1.80,b28,l0,c0` | Body shape: h stature (m), b BMI, l leg length (SD), c mass distribution (SD); only non-default items are written and values outside the valid range are clamped |
| `stim` | `heat,48,8@forearm_L` | Apply a stimulus: `kind,magnitude,seconds[,xCount/Hz][,held][,heat reading]@site`. Magnitude: mN for pinprick, N for pressure and pinch, °C for heat and cold. Site: `fingertip palm handback forearm cheek shin sole` with `_L`/`_R`, or a rest-pose position in millimetres, `p-182,1034,28` |
| `pain` | `7` | Hold the pain expression at this level (0–10); never plays sound by itself |
| `au` | `4:3,43:5` | Manual facial action units, number:intensity (0–5); combined with `pain` and `expr` by maximum |
| `expr` | `happy`, `fearful:0.6` | Emotion expression: an expression id, optionally with a strength (0–1; 1 when omitted). Ids: `happy sad fearful angry surprised disgusted`, and `happily_surprised happily_disgusted sadly_fearful sadly_angry sadly_surprised sadly_disgusted fearfully_angry fearfully_surprised fearfully_disgusted angrily_surprised angrily_disgusted disgustedly_surprised appalled hatred awed` |
| `vis` | `PBM` | Hold one mouth shape (viseme). Ids: `SIL PBM FV TH TDN L SZ SH KG R W UW OW IY EH AA AX`, and the Mandarin-only `YU ZHCHSH JQX ER HX` |
| `say` | `zh-03` | Say a demo clip: `en-01`…`en-06`, `zh-01`…`zh-06`, or a real read-speech clip `ls-<LibriSpeech utterance id>` (e.g. `ls-6241-61946-0017`; see `public/voice/librispeech-demo/manifest.json`). The mouth follows the phoneme timeline; without a user gesture it plays silently and the UI shows a “Sound” button. Free text for synthesis never goes into the URL |
| `drive` | `audio` | With `say`: what drives the mouth. `phone` = the phoneme timeline (default, not written to the URL), `audio` = an analysis of the same audio (approximate) |
| `style` | `normal`, `clear` | Style of speech: normal read speech (calibrated against measurements) or exaggerated. When omitted, held shapes use clear and speech uses normal |
| `skin` | `1` | Opaque-skin view |
| `look` | `0` | An opaque skin without the lifelike look, in the anatomical colours (lifelike is the default) |
| `tone` | `0`–`100` | The lifelike skin tone (epidermal melanin); the default 23, the NIST median, is not written; above 62 is extrapolated |
| `iris` | `blue`, `dark`, `hazel`, `green`, `grey` | Iris colour of the lifelike eyes (default `brown`, not written to the URL) |
| `blink` | `0` | The lifelike eyes do not blink or make microsaccades (for screenshots and tests; on by default, not written to the URL) |
| `gaze` | `c`, `20,-10` | Gaze of the lifelike eyes: `c` at the camera (default, not written to the URL); or fixed angles yaw,pitch (degrees; positive yaw = towards the body's left, positive pitch = up), clamped to the range |
| `hair` | `none`, `short`, `long` | The lifelike hair style; the default is by body (short for the male, long for the female) and is not written |
| `hc` | `black`, `darkbrown`, `brown`, `blonde`, `red`, `grey` | The lifelike hair colour; the default `darkbrown` is not written |
| `act` | `len`, `load` | Muscle activity: `len` length change of the lines of action (geometry), `load` activation needed against gravity (an estimate) |
| `load` | `2`, `2L`, `2R` | With `act=load`, the load held in the hand (kg); `L` / `R` one hand, both when omitted |
| `grav` | `supine`, `prone`, `left`, `right` | The posture: supine, prone, lying on the left or right side; standing when omitted. `act=load` takes its gravity direction from it (supine and prone only); with `phys=1` the soft tissue sags under it |
| `phys` | `1`, `sphere,5,1N@forearm_L`, `flat,13,4.5mm@p286.5,907.8,153.7` | Soft-tissue physics (male): `1` turns the posture solve on; or one press: `probe,radius mm,target@site`, probe `sphere` / `flat`, target `1N` (force control) or `4.5mm` (depth control), sites written as in `stim` |
| `lumen` | `1`, `canal` | The lumina display: see-through walls and lumina in a colour of their own; `canal` also isolates the alimentary canal (its lumina and walls, everything else hidden) |
| `fill` | `0.5`, `0.5,LUMEN_stomach:1` | Filling: the global slider 0–1 (0 = resting), optionally followed by "part id:filling" for single lumina |
| `fly` | `esophagus`, `420` | Fly-through: a segment key (`oral_cavity pharynx esophagus stomach duodenum jejunum ileum ascending_colon transverse_colon descending_colon rectum anal_canal`) or part id to play from that segment's start; or the millimetres covered, to hold there |
| `renderer` | `webgl` | Force the WebGL2 backend |

Example: `/?body=male&sys=ske,ner&sel=FMA9611&focus=1`. The full definition is in `src/state/urlState.ts`.

## Test

```sh
bunx vitest run    # pipeline, knowledge layer, skin maps, graph queries, display rules
bunx tsc --noEmit
```

The tests on generated data check invariants and anatomical facts: every part appears in exactly one GLB, adjacency is symmetric, the left femur is on the body's left; 18 nerve landmarks (ulnar nerve behind the medial epicondyle, sciatic nerve leaving below piriformis, common fibular nerve round the fibular neck, …); key sensory points lie in their own dermatome; the uterus sits between bladder and rectum.

## Layout

```
src/anatomy/types.ts   data contract: offline tools write it, the UI reads it
src/                   UI (React + three.js WebGPURenderer)
tools/pipeline/        geometry: classification, layers, simplification, adjacency, registration, derived parts, GLB output
tools/knowledge/       names and functional relations, aligned by concept id
tools/skinmaps/        dermatomes and cutaneous-nerve territories
tools/zanatomy/        reading Z-Anatomy and Open3DModel, building the import package
tools/register/        anchor data for the female body
tools/fixture/         synthetic dataset for development
data/curated/          curated data checked into the repository
public/anatomy/        generated runtime data
```

Geometry and knowledge come from separate sources: shape and position only from meshes reconstructed from volume data, or derived from those; names and relations from ontologies, encyclopaedias and open literature. FMA (Foundational Model of Anatomy) ids join the two.

Each part carries a provenance: `scanned` (as in the source), `warped` (moved by non-rigid registration), `curated` (artist-modelled, or derived by this project from neighbouring structures).

## Regenerating the data

Raw data is not in the repository (`data/raw/` is ignored) and must be downloaded first.

```sh
# BodyParts3D 4.0: download the tables and both zips under LATEST/ into data/raw/bodyparts3d/ and extract
#   https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST/
bun run pipeline                 # writes public/anatomy/male/
bun run pipeline:female          # writes public/anatomy/female/; needs the male output and the female anchor package (tools/register/run_anchors.sh)
bun tools/knowledge/run.ts       # names and relations; --refresh re-queries Wikidata
bun tools/skinmaps/run.ts male   # skin maps; likewise for female
data/raw/bodyshape/.venv/bin/python -I tools/look/mhr_uv.py   # MHR LOD0's UVs (needs the MHR assets and pymomentum; see tools/bodyshape/REPORT.md)
bun tools/look/uv.ts male        # the lifelike skin's UV mesh; likewise for female. Rerun after the skin or skin-source.u32 changes
# skin colour: put these into data/raw/skin/ (addresses in the sources table)
#   nist/skinrefl-v3.csv (the NIST skin reflectance data), omlc/hemoglobin.txt (OMLC's haemoglobin table, saved from the page as text),
#   omlc/carotene.txt (OMLC's β-carotene spectrum), cie/CIE_xyz_1931_2deg.csv and cie/CIE_std_illum_D65.csv
data/raw/bodyshape/.venv/bin/python -I tools/look/skin_colour.py    # fit, tables, region multipliers → data/curated/look/skin-colour.json, look/skin-lut.bin, skin-lut-lip.bin
bun tools/look/thickness.ts                                        # thickness per MHR vertex → data/raw/skin/thickness-<body>.f32 (rays, about a minute)
data/raw/bodyshape/.venv/bin/python -I tools/look/skin_regions.py   # region, detail and pad maps → look/skin-regions.png, skin-detail.png, skin-pads.png, skin-colour.json (needs the skin package, mhr-lod0-uv.bin and the thickness above)
bun tools/look/micro.ts                                            # micro-relief tile → look/skin-micro.png (procedural, deterministic)
bun tools/look/preintegrated.ts                                    # pre-integrated skin scattering table → look/skin-preint.bin
bun tools/hair/build.ts male female   # hair, eyebrow and eyelash cards and the atlas (about half a minute per body); rerun after the skin or data/curated/hair/hair.json changes
```

Order matters: the knowledge layer and skin maps read the geometry pipeline's output, and the female body reads the male body's output.

## Sources and licences

Apart from the code, the anatomy data in this directory (`public/anatomy/`, `data/curated/`) is released as a whole under **CC BY-SA 4.0**.

| Source | Used for | Licence |
|---|---|---|
| [BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/desc.html) 4.0 | Geometry of the male body (2,220 parts) and both hierarchies | CC BY 4.0 ("BodyParts3D, © The Database Center for Life Science licensed under CC Attribution 4.0 International"). Note: the dataset's description page says CC BY 4.0 while the headers of the 4.0 OBJ files say CC BY-SA 2.1 Japan; both statements are recorded here, and both permit this project's use |
| [Blender Studio Human Base Meshes](https://www.blender.org/download/demo-files/) v1.4.1 | Separate toes on both skins (an artist-made realistic forefoot, registered to the toe bones and grafted), marked `curated` | CC0 |
| [Momentum Human Rig (MHR)](https://github.com/facebookresearch/MHR) v1.0.1 (Meta) | The skin surface of both bodies (the parametric surface fitted to the internal structures), the skin weights, the shape fields, and the UV layout of the lifelike skin | Apache-2.0; licence text and statement of changes in `public/anatomy/MHR-LICENSE.txt`, `MHR-NOTICE.txt` |
| [NIST reference data set of human skin reflectance](https://doi.org/10.18434/M38597) (Cooksey, Allen & Tsai 2017, [J Res NIST 122:26](https://doi.org/10.6028/jres.122.026)) | Calibration of the lifelike skin's colour model (reflectance spectra of 100 subjects' inner forearm). Only the parameters and errors computed from it are committed; the original data are not redistributed | US government work, [NIST data licence](https://www.nist.gov/open/license): free to use with NIST acknowledged as the source |
| [OMLC](https://omlc.org/spectra/) haemoglobin and β-carotene absorption (compiled by Prahl from Gratzer, Kollias and PhotochemCAD) | Absorption spectra in the colour model | No licence stated on the pages: used locally only; the repository holds only numbers computed with them |
| [CIE](https://cie.co.at/datatable/cie-1931-colour-matching-functions-2-degree-observer) 1931 2° colour matching functions, D65 illuminant | Spectrum → colour | CC BY-SA 4.0; used locally only |
| Literature (numbers only, cited per entry in `data/curated/look/skin-colour.json`) | Model structure and absorption formulas (Donner & Jensen 2006; Donner et al. 2008; Jacques 2013; Svaasand et al. 1995; Saunderson 1942), regional colour differences (Xiao et al. 2017, [doi:10.1111/srt.12295](https://doi.org/10.1111/srt.12295); Chinese Journal of Tissue Engineering Research on vermilion and facial colour, WPRIM wpr-698623; Phan et al. 2022, [doi:10.1117/1.JBO.27.3.036002](https://doi.org/10.1117/1.JBO.27.3.036002)), structural parameters (Del Bino et al. 2015, 2022 on the eumelanin share; Sandby-Møller et al. 2003 on epidermal thickness), qualitative grounds (Lee et al. 2024; Alaluf et al. 2002; Pawson & Petrakis 1975; Silva et al. 2020; Sun et al. 2025), detail and light transport (Flament et al. 2015 on facial pores, [doi:10.2147/CCID.S74401](https://doi.org/10.2147/CCID.S74401), a CC BY-NC 3.0 article cited for numbers only; Mikkelsen 2010 bump mapping; Penner & Borshukov 2011 pre-integrated skin; d'Eon, Luebke & Enderton 2007 skin profile; Barré-Brisebois & Bouchard 2011 transmission approximation; Weyrich et al. 2006 skin reflectance measurements; Bashkatov et al. 2005 skin optical properties; Unreal Engine's subsurface profile documentation, technique only), colour difference (Sharma et al. 2005), ITA° groups (Chardon et al. 1991; Del Bino et al. 2006) | facts and numbers |
| Literature values for the eye (numbers only) | The lifelike eyes: eyeball transverse diameter 24.2 mm, range 21–27 mm (Bekerman, Gottlieb & Vaiman 2014, *J Ophthalmol* 2014:503645); anterior corneal radius 7.8 mm, corneal thickness 0.55 mm, anterior chamber depth 3.05 mm (Le Grand's theoretical eye, see Atchison & Smith, *Optics of the Human Eye*); corneal index 1.376 (Wikipedia "Cornea"); white to white 11.71 mm (Rüfer, Schröder & Erb 2005, *Cornea* 24:259); maximal eye rotation (Goldmann perimeter, PubMed 9700009; Chamberlain 1971); lid margins against vertical gaze (Mastropietro, Alves & Velasco e Cruz 2009, *Arq Bras Oftalmol* 72:771); spontaneous blink rate (Doughty & Naase 2006); blink kinematics (Kwon et al. 2013, *J R Soc Interface* 10:20130227); microsaccade amplitude and duration (Wikipedia "Microsaccade"; Martinez-Conde, Barrow Quarterly). Technique after Epic's public documentation of the eye shading model, none of its assets | Cited measurements |
| This project's own generated hair (`public/anatomy/<body>/hair/`) | The lifelike hair, eyebrow and eyelash cards and atlas; numbers from the literature listed in `data/curated/hair/hair.json` (numbers only, no outside images or models) | CC BY-SA 4.0 with the project data |
| BodyParts3D 3.0 | 79 parts missing from 4.0: lung lobes, abdominal wall muscles, latissimus dorsi, muscles of mastication and facial expression. Registered into place, marked `warped` | CC BY-SA 2.1 JP |
| [Z-Anatomy](https://github.com/Z-Anatomy) | Cranial and trunk nerves, spinal roots, spinal cord, ligaments, fasciae, joint capsules, lymph node groups, thyroid, parotid. Artist-modelled, marked `curated` | CC BY-SA 4.0 ("Z-Anatomy - The libre 3D atlas of anatomy") |
| [AnatomyTool Open3DModel](https://anatomytool.org/open3dmodel) | Limb nerves (right side modelled, left mirrored), cruciate ligaments and menisci. Artist-modelled, marked `curated` | CC BY-SA 4.0 |
| soma (derived) | Subcutaneous fat, visceral pleura, pericardial sac: computed by this project from neighbouring structures, marked `curated` | CC BY-SA 4.0 |
| [Visible Human Project](https://www.nlm.nih.gov/research/visible/visible_human.html) female CT | Skeleton and some organs of the female body, segmented with TotalSegmentator and MOOSE | NLM terms; Courtesy of the U.S. National Library of Medicine |
| [HRA](https://humanatlas.io) female reference organs | Mammary glands, plus uterine artery and vein, mesovarium, suspensory ligament of ovary, uterovesical pouch. Remodelled geometry, marked `curated` | CC BY 4.0 |
| Wu et al. 2015 female pelvic floor ([doi:10.1371/journal.pone.0132226](https://doi.org/10.1371/journal.pone.0132226), correction [10.1371/journal.pone.0140736](https://doi.org/10.1371/journal.pone.0140736)) | The female body's pelvic floor muscles, anal and urethral sphincters, perineal body, clitoris and vestibular bulbs, vagina, uterus, uterine tubes, ovaries and rectum: 51 parts. From another woman's specimen, enlarged and fitted by bone, marked `curated` | CC BY 4.0 |
| [University of Denver Visible Human Female lower extremity](https://doi.org/10.1038/s41597-022-01905-2) | The female body's leg muscles, knee ligaments, articular cartilage and tarsal bones: 100 parts | CC BY 4.0 |
| [FMA](http://si.washington.edu/projects/fma) 5.1.0 | Placement of added parts in the is-a hierarchy | see its release page |
| [Wikidata](https://www.wikidata.org) | Names, functional relations, id crosswalks | CC0 |
| [Wikipedia](https://en.wikipedia.org) muscle infoboxes | Origin, insertion and innervation of some muscles, each with a revision link | CC BY-SA 4.0 |
| ISNCSCI key sensory points, Lee et al. 2008, Gray 1918 | Basis of the skin map definitions (facts only, cited per entry) | see `data/curated/skinmaps/` |

About two thirds of the Chinese names are machine-generated from a term lexicon and have no source; `zhSource` in `names.json` says where each came from, and every entry is `unreviewed`.

### Pain sound pack (non-commercial, separate from the anatomy data)

`public/voice/vivae-pain/` is a **separate collection** under **CC BY-NC 4.0 (non-commercial use only)**. It is not part of the CC BY-SA 4.0 anatomy dataset above and not part of the MIT-licensed code.

- Contents: the 185 physical-pain recordings of the VIVAE corpus (Holz, Larrouy-Maestri, Poeppel, [doi:10.5281/zenodo.4066235](https://doi.org/10.5281/zenodo.4066235)), resampled to 24 kHz, plus a per-clip analysis made by this project. They are vocalisations performed on instruction, not recordings of real pain. Attribution, licence and the list of changes are in `ATTRIBUTION.txt` and `LICENSE.txt` in that directory.
- Use: `src/voice/` loads it at run time and varies the recordings (clip choice, small pitch and time changes, sequences for sustained pain, a male voice derived from the female recordings). Without the directory it falls back to the parametric synthesizer.
- **A build or deployment for commercial use must not include this directory.** Build with `SOMA_COMMERCIAL=1 bunx vite build`: `dist/` then has no `voice/vivae-pain/` (`voice/tts-demo/` and `voice/librispeech-demo/` allow commercial use and stay), the app uses the parametric voice and the recordings' attribution is not shown. The default build is unchanged (it includes the pack).
- `data/curated/voice/calibration.json` holds only aggregates computed from the corpus, no audio.

### Speech synthesis: models, demo clips and the data behind the mouth shapes

- **The models** are not in git: Kokoro-82M v1.0 (English) and Kokoro-82M-v1.1-zh (Mandarin) by hexgrad, Apache-2.0. Source, pinned commit, the licence clauses as read and the sha256 of every file are in `server/models.json`.
- **The demo clips** in `public/voice/tts-demo/`: 12 **machine-synthesized** sentences with their phoneme timelines, generated with the models above; this project adds no restriction. Attribution and how they were made are in `ATTRIBUTION.txt` and `LICENSE.txt` in that directory. None is a recording of a person.
- **The real read-speech examples** in `public/voice/librispeech-demo/`: 10 sentences from LibriSpeech dev-clean (Panayotov, Chen, Povey & Khudanpur 2015, https://www.openslr.org/12/, CC BY 4.0; the recordings come from LibriVox's public-domain audiobooks) with their phoneme timelines from LibriSpeech Alignments (Lugosch, Zenodo 2619474, CC BY 4.0; automatic Montreal Forced Aligner alignments). Speaker number, chapter, utterance id, book and transcript of every clip are in `ATTRIBUTION.md` in that directory and the licence in `LICENSE`; readers' names are not given. The licence allows commercial use and the commercial build keeps the pack. To regenerate: `bun tools/voice/librispeech-demo.ts fetch` (downloads into `data/raw/librispeech/`, not committed; only the dev-clean stretch of the alignment zip is fetched with HTTP Range requests), then `build` and `bench`; ffmpeg is needed.
- **The data behind the mouth shapes**: `data/curated/reference/articulation-summary.json` holds aggregates this project computed from two articulatory corpora (mean incisor opening, lip aperture and coil heights per sound). USC-TIMIT is CC BY 4.0; **MOCHA-TIMIT is for research, educational and individual use only and not for commercial use without permission** — none of its raw data is in the repository, and the values depending on it are marked `calibratedAgainstNonCommercialData` in `visemes.json`.

## Known gaps

The full list is in each body's `cautions`. The main ones:

- Nerves are hand-drawn schematic geometry: calibre is not measured, position after registration is off by about 2 mm (median), more in the lower limb; about a fifth of centreline points were pushed out of bone and muscle bellies.
- Missing nerves: phrenic, cervical plexus, subcostal, splanchnic, autonomic plexuses, laryngeal.
- No parietal pleura, lymphatic vessels, ligamenta flava or cranial meninges; the pericardium is only an envelope of the heart; the descending colon includes the sigmoid; the spinal cord is a procedurally generated surface ending at L2/L3.
- Subcutaneous fat is derived from the space between the skin's inner wall and the deep structures; thickness is quantised to 3 mm.
- The male body now has the lumina of its hollow organs (19 parts with `LUMEN_…` ids): one continuous alimentary lumen from mouth to anus, and the lumina of bladder, ureters, deferent ducts and seminal vesicles. They are **not scanned**: each is derived from the organ's outer surface moved inward by a wall thickness from the literature (or an assumed one); `lumen-filling.bin` beside them holds a per-vertex displacement with filling. Construction: the stretch from the lips to the teeth, the velum (a constructed sheet; the data has no soft palate) and the tail of the anal canal from the lower end of the rectum to the skin. Known limits: the small-bowel lumen holds only about 55–59% of the available space, because the source's bowel pieces overlap; the pharyngeal cavity stops about 20 mm above the oesophagus; the resting shape of the stomach is an assumption; the male part named "Urethra" runs inside the corpus cavernosum part for 12 mm. In a pose a lumen follows its wall by taking the weights at the closest wall point; where the wall's own weights change sharply a few vertices still leave it by some millimetres. The female body now has them too (19 parts; see "Lumina" above).
- The male skin is assembled from pieces, each recorded in the data (select the skin to see them): a parametric body surface (Meta MHR, Apache-2.0) fitted to his internals, not his own skin; the penile and scrotal skin of his own scanned skin, with the neck of the scrotum and the perineal raphe (a graft; the blend surface between it and the fitted surface is constructed, and behind the scrotum the roof of the perineum is a few large flat facets); toes from a CC0 realistic body mesh (not his feet; toes 3–5 stretched about 1.3–1.5×; a shallow ring step near the tips of toes 2–5); eyes and mouth are real openings cut into the surface, with lid rims and an oral pouch constructed for them, which are not anatomy. Navel and nipples are low reliefs carried over from his scanned skin and barely visible at this mesh density. The axilla is open from about 45% of the humerus down; above that arm and axillary folds lie together, and 15–27 cm² of skin is covered at the folds, with small steps. The head looks broad and high; eye colours are illustrative. In large poses (90° abduction, 160° flexion, deep squat) the skin still stretches and crumples visibly. The skin package is not in the repository; scripts in `tools/bodyshape/` and `tools/skinopen/` write it to `data/raw/bodyshape/out/`.
- Skin map boundaries are jagged at 1–3 cm. The skin maps are constructed teaching maps; dermatomes vary between people and published maps disagree.
- Expression and mouth shapes: the intensities of the emotion prototypes and the viseme numbers are assumptions; there is no one-sided action; the eyes turn only in lifelike mode (the constructed eyes), while the scanned eyeballs of the anatomical colours do not; the tongue has four schematic poses only; beyond half of the widest jaw opening small folds remain at the mouth corners (about 35 mm² at full opening); when the pose panel or a reflex opens the jaw the interface does not yet pass that angle to the mouth shapes (a bilabial then does not close fully); mouth shapes from audio are approximate, labiodentals are not detected, and nothing has been validated systematically on real speech. The eyebrows are a thin shell fitted onto the skin (its inner face 0.5 mm below the surface), and the hair is still a see-through shell.
- The lifelike eyes are construction, not scan data: the iris colours and patterns are procedural assumptions, not calibrated against measurements; looking down, the lower lid drops through the lower-lid field run backwards, which is too weak on the female, so at −30° her fissure is still about 15% narrower than the literature; looking up, the female lower lid does not rise enough (the channel saturates), so her fissure is too wide; the lids do not move with horizontal gaze; the width and depth of the tear line and of the lid shadow are assumptions picked by eye; the lower-lid motion of a blink comes from AU43 (the data have no AU45); there are no large gaze shifts (only microsaccades) and no effect of light on the pupil; the compare pane does not draw the lifelike eyes (that waits for the lifelike skin to be drawn there); clicking a lifelike eye does not select an eyeball part (select it in the tree); the female's two eyes have different fitted radii (left 12.39, right 12.03 mm, as scanned), and the constructed eyes keep that difference.
- The male rest posture was changed twice: the shoulder girdle (the scan is supine with shrugged shoulders; clavicles lowered by about 10°, scapulae turned round the rib cage, glenohumeral centres 338 mm apart, short of the 350 mm target), and both upper limbs abducted 6.5° in the coronal plane so that an axilla exists (keeping the scapula fixed is a modelling choice with no opened source). Muscles and vessels spanning the shoulder changed from `scanned` to `warped`.
- The female body is far coarser than the male:
  - The skeleton is from the Visible Human Female donor (59 years old, obese, six lumbar vertebrae), rescaled to standard proportions at 1.606 m with five lumbar vertebrae, so none of her parts is marked `scanned`. The ankle is still about 16 mm too high; the flexion axes of her two elbows differ by 22.5° (her distal humeri differ), so the forearms do not move symmetrically; foot bones and fingers are corrected male bones.
  - Most soft tissue is male structure registered onto her bones and redistributed toward a standard female body surface; muscles of male origin are kept at or above a sourced female/male volume ratio (Janssen et al. 2000). Upper limbs abducted 7.5°.
  - Leg muscles and knee ligaments are her own (Denver data). 2.0% of nerve length lies inside her muscles, 1.8% of it motor branches ending in muscle and 0.07% unexplained.
  - Pelvic floor, vagina, uterus, adnexa and rectum come from another woman's specimen (Wu et al. 2015). Some interpenetration remains (worst pair 3.8%); there is a 16.6 mm gap between the bladder (her own, empty) and the uterus; of nine pelvic ligaments only three (both uterosacral, right cardinal) were re-fitted by their two ends, the others have no room between the present organs.
  - No vulvar anatomy: the perineal skin is a raised, smooth closed surface. The specimen's skin could not be grafted: the rim of the narrowed patch lies a median 11.6 mm from her present skin (limit 5 mm), and raising the skin to meet it would put the gracilis outside the skin. Also missing: urethral lumen, ovarian and vaginal vessels, autonomic plexuses.
  - Her skin is assembled likewise: a parametric surface of standard female shape (1.606 m, BMI 21.6) relaxed where muscle still lay outside, volume BMI about 23.7; the installed skin stands 1.609 m (1.6155 m before). The head's outer shape is that parametric model's own female head outline (Meta MHR, Apache-2.0), and her skull, mandible, teeth and the soft parts of her head are deformed to fit inside it (labelled `warped`, not their original shape; bone surface moved by up to about 20 mm, a few cranial dimensions changed by over 5%); the teeth are scaled by 0.974 as a whole (sex difference of crown widths in the meta-analysis of Silva et al. 2019); the eyebrows are the male eyebrow part moved onto a line set by her supraorbital rim (after the abstract of Sclafani & Jung 2010; the millimetre values and the width are assumptions); her two eyeballs differ in size (the left is larger) and are placed by the corneal apex, not the centre, at left–right symmetric positions; the hair shell is still the male part, a placeholder: it is fitted to her scalp, with its outer face pushed out to at least 1 mm outside the scalp where it fell short (construction, only so that no skin shows through the hair); the outline of the hairline is unchanged; in lifelike mode it is replaced by hair generated on her own head (see "Lifelike look"). Eyes and mouth are real openings; toes come from a CC0 mesh, with a shallow ring step near the tips of toes 2–5; the sheets of fascia that showed between the toes and at the root of the thighs are now inside the skin (thin structures outside went from 253 to about 10 cm², the rest at the axillary folds). Breasts are about 334 mL a side (a Chinese reference figure) with the gland parts scaled to about 0.5; the navel is constructed.
  - Her intercostal nerves are warped from the male; the stretch of nerves 7–11 beyond the bony thorax has been re-laid to her own xiphoid and navel (T7 ends just below the xiphoid tip, T10 at the navel; the levels of T8, T9 and T11 are evenly interpolated, not sourced). On the skin maps the umbilicus now lies in T10; the xiphoid is still off (left T5, right T7; textbook T6–T7) and the right T12 dermatome is in two pieces. The model has no subcostal nerve.
  - The right forearm and hand were clipped in the CT and are a mirrored left.
- The lifelike hair is a first step: cards only, without real strands for WebGPU close-ups and without dynamics (cards are rigid relative to the head, and long hair passes into the shoulders and back in large poses); card ends of the short cut show at the side hairline; long hair occasionally has one or two narrow cards in front of the shoulders; fibre parameters are from the European sample only, with no curl of other populations; half of the literature values are quoted or assumed (see `status` in `data/curated/hair/hair.json`); the compare pane draws no hair; pubic hair is still a shell.

## Next

1. Hair, step two: real strands for close-ups on WebGPU, strand dynamics; the female vulva; a two-sheet collision solve for the axillae; making thin structures such as nerves and fasciae consistent with the new skins and the separate toes.
2. Soft-tissue physics: tetrahedral meshes, XPBD, validated on one region first. The code is in `src/softbody/` and `tools/softbody/`, materials and reference data in `data/curated/softbody/`. Pressing (forearm) and posture are now wired into the UI (see "Soft-tissue physics: pressing and posture"); there is no WebGPU solver yet, and the female has not been run. Phases 3 and 4 use the male body only: the zero-gravity reference solves to convergence on the whole-body cage, and under gravity the skin lands within 0.3 mm of the shipped mesh; ten thousand frames of stability, volume by region and CPU timings are in `validation-report.json`; the pressing interface `press()` has a spherical probe and a flat plate with contact pressure per node; the solver can use an Ogden-type fat, not enabled by default. Phase 4 found the main cause of the "crushed" small probe: the skin layer was shared out to tetrahedra by skin-mesh vertex, the skin mesh has a median edge of 26 mm on the forearm, and a 2 mm fine cage kept about 0.1 % of the skin's stiffness within 8 mm of the probe (and the blend multiplied the skin by the fill share once more); it is now shared out by subdivided triangle area. In force control press() now bisects for the deepest depth within the strain limit (0.6) instead of falling back one step. Results: a 5 mm sphere reaches about 1 N on the volar forearm (0.18 N before), 2.0–2.6 N over the radius and 0.5 N on the chest (0.06 N before); a 26 mm flat punch on the forearm gives 0.66–0.83 of the measured force (forearm2026; 0.54–0.64 before). Substeps: the deviatoric multipliers restart from zero every substep, so with a large stiffness ratio the steady state is too soft, or never settles, or diverges; without a given count `SoftBody` picks it from the stiffness ratio (13 on the male whole-body cage), and the whole-body supine displacement has converged from 4 substeps on (14 % too large at 2). The breast is done on a phantom that reads no body data: the base may slide without friction (rim pinned) or carry a fascia layer (mira2018), and gravity is a 3D vector in the body frame (standing, supine, prone, lying on a side). **Still at odds with published data or unsettled**: a 9 mm flat punch (the protocol of zheng1999, from a 0.5 N preload) gives a slope of 0.64–0.70 N/mm against about 0.22 N/mm (0.14–0.30) for that paper's three subjects relaxed and 0.35 N/mm for its example subject, with 12–13.5 mm of tissue here against 16–20 mm there; a pressure stimulus of a few newtons needs compressive strain beyond 0.6 while the model is validated to 0.4, and force control near the limit depends on the path; prone-to-supine breast displacement depends on the orientation of the chest wall, the base condition, the skin and the volume, and the phantom gives anything from 6 to 170 mm (literature mean 69.7 mm; the paper gives no patient breast volumes), with crushed or inverted elements at the breast's rim in every sliding case, so those numbers are not to be trusted; with all muscles fully active at once the whole-body cage does not settle; abdominal indentation (7 mm cells) is 0.81 of the measured force at 5 mm and 1.43 at 20 mm.
3. Surgical actions: incision, retraction, bleeding, suturing.
