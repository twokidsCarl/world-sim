# 用 MuJoCo 求 MyoFullBody 的参照量：关节（位置、轴、范围）、肌腱两端的附着点、肌腱长度—关节角曲线。
# Evaluates the reference quantities of MyoFullBody with MuJoCo: joints (position, axis, range), the two end sites of every
# tendon, and tendon length versus joint angle.
#
# 用法 / usage:  <venv>/bin/python -I tools/calibrate/myo_dump.py <out.json>
# 需要 data/raw/calibration/.venv 里装有 mujoco 和 myo-sim（Apache-2.0）。输出写到 data/raw/calibration/ 下，不入库。
# Needs mujoco and myo-sim (Apache-2.0) in data/raw/calibration/.venv. The output goes under data/raw/calibration/ and is not committed.
import json
import sys
from importlib import metadata

import mujoco
import myo_sim
import numpy as np

STEPS = 12  # 每条曲线的区间数 / intervals per curve


def main(out_path: str) -> None:
    loaded = myo_sim.load("myofullbody")
    m = loaded[0] if isinstance(loaded, tuple) else loaded
    d = mujoco.MjData(m)
    name = lambda kind, i: mujoco.mj_id2name(m, kind, i) or f"#{i}"
    J, B, T, S, E = (mujoco.mjtObj.mjOBJ_JOINT, mujoco.mjtObj.mjOBJ_BODY, mujoco.mjtObj.mjOBJ_TENDON, mujoco.mjtObj.mjOBJ_SITE, mujoco.mjtEq.mjEQ_JOINT)

    # 关节耦合（等式约束）：q1 − q1₀ = Σ aₖ (q2 − q2₀)ᵏ / joint couplings (equality constraints)
    couplings = []
    for e in range(m.neq):
        if m.eq_type[e] != E or not m.eq_active0[e]:
            continue
        j1, j2 = int(m.eq_obj1id[e]), int(m.eq_obj2id[e])
        if j2 < 0:
            continue
        couplings.append((j1, j2, [float(x) for x in m.eq_data[e][:5]]))
    dependent = {c[0] for c in couplings}

    def settle(q: np.ndarray) -> None:
        # 耦合可能成链，迭代几次 / couplings may chain, so iterate a few times
        for _ in range(4):
            for j1, j2, a in couplings:
                a1, a2 = m.jnt_qposadr[j1], m.jnt_qposadr[j2]
                x = q[a2] - m.qpos0[a2]
                q[a1] = m.qpos0[a1] + a[0] + a[1] * x + a[2] * x**2 + a[3] * x**3 + a[4] * x**4

    def lengths(q: np.ndarray) -> np.ndarray:
        d.qpos[:] = q
        mujoco.mj_kinematics(m, d)
        mujoco.mj_comPos(m, d)
        mujoco.mj_tendon(m, d)
        return d.ten_length.copy()

    q0 = m.qpos0.copy()
    settle(q0)
    rest = lengths(q0)
    hinge = [j for j in range(m.njnt) if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE]

    joints = []
    for j in range(m.njnt):
        joints.append({
            "name": name(J, j), "type": int(m.jnt_type[j]), "body": name(B, m.jnt_bodyid[j]),
            "limited": bool(m.jnt_limited[j]), "rangeDeg": [float(np.degrees(x)) for x in m.jnt_range[j]] if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE else [float(x) for x in m.jnt_range[j]],
            "anchor": [float(x) for x in d.xanchor[j]], "axis": [float(x) for x in d.xaxis[j]], "dependent": j in dependent,
        })
    bodies = [{"name": name(B, b), "parent": name(B, m.body_parentid[b]), "pos": [float(x) for x in d.xpos[b]]} for b in range(m.nbody)]

    # 肌腱的端点：缠绕序列里第一个和最后一个 site / tendon ends: first and last site of the wrap sequence
    tendons = []
    for t in range(m.ntendon):
        adr, num = m.tendon_adr[t], m.tendon_num[t]
        sites = [int(m.wrap_objid[k]) for k in range(adr, adr + num) if m.wrap_type[k] == mujoco.mjtWrap.mjWRAP_SITE]
        if len(sites) < 2:
            continue
        end = lambda s: {"site": name(S, s), "body": name(B, m.site_bodyid[s]), "pos": [float(x) for x in d.site_xpos[s]]}
        tendons.append({"name": name(T, t), "id": t, "restLength": float(rest[t]), "origin": end(sites[0]), "insertion": end(sites[-1]), "sites": len(sites), "wraps": int(num - len(sites))})

    # 逐个独立的铰链关节扫过它的范围，其余在零位；记录长度有变化的肌腱
    # sweep every independent hinge over its range with the others at zero; keep tendons whose length changes
    curves = []
    # 躯干主坐标实际让胸廓相对骶骨转了多少（腰椎各节是耦合的）/ how far the thorax really turns against the sacrum for a trunk master coordinate (the lumbar joints are coupled)
    trunk = {}
    bid = lambda n: mujoco.mj_name2id(m, B, n)
    relative = lambda: d.xmat[bid("sacrum")].reshape(3, 3).T @ d.xmat[bid("torso")].reshape(3, 3)
    rel0 = relative().copy()
    jid = lambda n: mujoco.mj_name2id(m, J, n)
    # 另加：肩在矢状面内抬高（抬高平面角 = 90°），即前屈 / in addition: shoulder elevation in the sagittal plane (plane of elevation = 90°), i.e. flexion
    sweeps = [(j, {}, name(J, j)) for j in hinge if j not in dependent and m.jnt_limited[j]]
    for side in ("r", "l"):
        if jid(f"shoulder_elv_{side}") >= 0 and jid(f"elv_angle_{side}") >= 0:
            sweeps.append((jid(f"shoulder_elv_{side}"), {jid(f"elv_angle_{side}"): np.radians(90)}, f"shoulder_elv_{side}@elv_angle=90"))
    for j, fixed, label in sweeps:
        lo, hi = m.jnt_range[j]
        angles = np.linspace(lo, hi, STEPS + 1)
        table = []
        turn = []
        for a in angles:
            q = q0.copy()
            for fj, fv in fixed.items():
                q[m.jnt_qposadr[fj]] = fv
            q[m.jnt_qposadr[j]] = a
            settle(q)
            table.append(lengths(q))
            turn.append(round(float(np.degrees(np.arccos(np.clip((np.trace(rel0.T @ relative()) - 1) / 2, -1, 1)))), 3))
        table = np.array(table)
        if label in ("flex_extension", "lat_bending", "axial_rotation"):
            trunk[label] = {"anglesDeg": [round(float(np.degrees(a)), 3) for a in angles], "thoraxVsSacrumDeg": turn}
        for t in tendons:
            col = table[:, t["id"]]
            if np.ptp(col) < 2e-4:
                continue
            curves.append({"tendon": t["name"], "joint": label, "anglesDeg": [round(float(np.degrees(a)), 3) for a in angles], "lengthMm": [round(float(1000 * x), 3) for x in col]})

    out = {
        "model": "myofullbody", "myoSim": metadata.version("myo-sim"), "mujoco": mujoco.__version__,
        "counts": {"joints": int(m.njnt), "actuators": int(m.nu), "tendons": int(m.ntendon), "bodies": int(m.nbody), "dof": int(m.nv)},
        "joints": joints, "bodies": bodies, "trunk": trunk, "tendons": tendons, "curves": curves,
    }
    with open(out_path, "w") as f:
        json.dump(out, f)
    # 这个目录的来历说明 / where this directory comes from
    import os
    with open(os.path.join(os.path.dirname(os.path.abspath(out_path)), "SOURCE.txt"), "w") as f:
        f.write(
            "Name: quantities evaluated from MyoFullBody (MyoHub/myo_sim) by tools/calibrate/myo_dump.py\n"
            "URL: https://github.com/MyoHub/myo_sim (PyPI: https://pypi.org/project/myo-sim/)\n"
            f"Version: myo-sim {metadata.version('myo-sim')} from PyPI, evaluated with MuJoCo {mujoco.__version__}\n"
            "Licence: Apache-2.0 (myo-sim: LICENSE in the package and repository; MuJoCo: Apache-2.0)\n"
            "Clause: Apache License 2.0, section 2: \"each Contributor hereby grants to You a perpetual, worldwide, non-exclusive, no-charge, royalty-free, irrevocable copyright license to reproduce, prepare Derivative Works of, publicly display, publicly perform, sublicense, and distribute the Work\"\n"
            "Use: local comparison only (tools/calibrate). Nothing in this directory is committed or redistributed.\n"
        )
    print(f"myo_dump: {len(joints)} joints, {len(tendons)} tendons, {len(curves)} curves -> {out_path}")


if __name__ == "__main__":
    main(sys.argv[1])
