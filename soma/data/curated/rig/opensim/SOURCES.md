# OpenSim 模型文件的来源与许可 / Sources and licences of the OpenSim model files

## 中文

这两个文件只用于验证（`tools/rig/validate.ts`）：从肌肉路径点直接计算“肌腱单元长度—关节角”曲线，作为本骨架肌肉长度变化的独立参照。没有运行 OpenSim，文件内容未作改动。

| 文件 | 来源 | 许可 |
|---|---|---|
| `gait2392_thelen2003muscle.osim` | opensim-org/opensim-models（提交 `d9b05d47`），`Models/Gait2392_Simbody/` | CC BY 3.0（见文件内 `<credits>`） |
| `arm26.osim` | opensim-org/opensim-models（提交 `d9b05d47`），`Models/Arm26/` | CC BY 3.0（见文件内 `<credits>`） |

署名：gait2392 — Delp S.L., Loan J.P., Hoy M.G., Zajac F.E., Topp E.L., Rosen J.M., Thelen D.G., Anderson F.C., Seth A.（Delp 等 1990；Yamaguchi 与 Zajac 1989；Anderson 与 Pandy 1999、2001）。arm26 — OpenSim 开发组（Reinbolt J., Seth A., Habib A., Hamner S.），改编自 Kate Holzbaur 的模型（Holzbaur、Murray、Delp 2005）。

## English

These two files are used for validation only (`tools/rig/validate.ts`): muscle-tendon length versus joint angle is computed straight from the muscle path points, as an independent reference for the length changes of the muscles in this rig. OpenSim itself is not run and the files are unmodified.

| File | Source | Licence |
|---|---|---|
| `gait2392_thelen2003muscle.osim` | opensim-org/opensim-models (commit `d9b05d47`), `Models/Gait2392_Simbody/` | CC BY 3.0 (see `<credits>` in the file) |
| `arm26.osim` | opensim-org/opensim-models (commit `d9b05d47`), `Models/Arm26/` | CC BY 3.0 (see `<credits>` in the file) |

Attribution: gait2392 — Delp S.L., Loan J.P., Hoy M.G., Zajac F.E., Topp E.L., Rosen J.M., Thelen D.G., Anderson F.C., Seth A. (Delp et al. 1990; Yamaguchi & Zajac 1989; Anderson & Pandy 1999, 2001). arm26 — the OpenSim development team (Reinbolt J., Seth A., Habib A., Hamner S.), adapted from a model by Kate Holzbaur (Holzbaur, Murray & Delp 2005).
