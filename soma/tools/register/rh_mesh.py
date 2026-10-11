#!/usr/bin/env python3
"""U3D 中 RHAdobeMeshResource 网格块的解码器（位置与三角形；不解码法线）。

依据：
  - Adobe《U3D Supported Elements》（Acrobat 8.1 SDK，2007 年 4 月）第 2 章与附录 A：
    块布局、浮点量化、整数编码类型 0-10、RH39 与 UIC1 的参考实现。
  - ECMA-363（Universal 3D）第 10 节的算术编码器；实现参照 Intel“Universal 3D Sample
    Software”中的 IFXBitStreamX / IFXHistogramDynamic（Apache-2.0）。
规范没有写明的三点，取自公开项目 peterdoubell/Primer 的实验性笔记（只取事实，未复制代码），
并由本文件的自检加以验证（解码后索引不越界、数据恰好用尽、网格闭合）：
  1. 编码类型 >= 2 时，类型字节之后是长度字段（宽度由类型字节的第 6、7 位决定），其后才是数据；
  2. UIC1 的“先前值”数组初值为 back(i) = i；面索引的“垂直前值”是 3 个位置之前的值；
  3. 算术编码（类型 9，动态上下文）的转义值按最大值选 16 位或 32 位读取；类型 8 使用
     范围为 最大值+1 的静态上下文。

Decoder for RHAdobeMeshResource mesh blocks in U3D (positions and triangles; normals are skipped).

Sources:
  - Adobe "U3D Supported Elements" (Acrobat 8.1 SDK, April 2007), chapter 2 and appendix A:
    chunk layout, float quantisation, integer encodings 0-10, reference code for RH39 and UIC1.
  - The arithmetic coder of ECMA-363 (Universal 3D) section 10, implemented after IFXBitStreamX /
    IFXHistogramDynamic of Intel's "Universal 3D Sample Software" (Apache-2.0).
Three points the specification leaves open were taken as facts (no code copied) from the
experimental notes of the public project peterdoubell/Primer, and are validated by this file's own
checks (decoded indices in range, payload consumed exactly, closed meshes):
  1. for encoding types >= 2 the type byte is followed by a size field (width from bits 6-7 of
     the type byte) and only then by the data;
  2. the UIC1 "previous values" array starts as back(i) = i, and the "previous vertical" value
     of a face index is the value three positions earlier;
  3. arithmetic coding (type 9, dynamic context) reads escaped values as 16 or 32 bits depending
     on the maximum; type 8 uses a static context of range maximum + 1.

Usage:
  python -I rh_mesh.py FILE.u3d OUT_DIR      # writes one OBJ per structure + structures.tsv
"""
import os
import struct
import sys

import numpy as np

REV16 = None


def _rev15():
    global REV16
    if REV16 is None:
        a = np.arange(1 << 15, dtype=np.uint32)
        r = np.zeros_like(a)
        for i in range(15):
            r |= ((a >> i) & 1) << (14 - i)
        REV16 = r.tolist()
    return REV16


class Fenwick:
    """动态直方图：符号 0 为转义符号，初始频数 1。Dynamic histogram; symbol 0 is the escape, initial count 1."""
    LIMIT = 0x1FFF           # 总频数达到该值时全部减半 / halve all counts when the total reaches this
    SIZE = 1 << 16

    def __init__(self):
        self.freq = {0: 1}
        self.total = 1
        self.tree = [0] * (self.SIZE + 1)
        self._add(0, 1)

    def _add(self, s, n):
        i = s + 1
        tree = self.tree
        while i <= self.SIZE:
            tree[i] += n
            i += i & -i

    def add(self, s):
        if s > 0xFFFF:
            return
        if self.total >= self.LIMIT:
            self.freq = {k: v >> 1 for k, v in self.freq.items() if v >> 1}
            self.freq[0] = self.freq.get(0, 0) + 1          # 转义符号不能丢 / never lose the escape
            self.total = sum(self.freq.values())
            self.tree = [0] * (self.SIZE + 1)
            for k, v in self.freq.items():
                self._add(k, v)
        self.freq[s] = self.freq.get(s, 0) + 1
        self.total += 1
        self._add(s, 1)

    def below(self, s):
        """小于 s 的符号的频数之和 / sum of the counts of symbols below s"""
        out, tree = 0, self.tree
        while s:
            out += tree[s]
            s -= s & -s
        return out

    def find(self, cum):
        """累计频数区间包含 cum 的符号 / symbol whose cumulative interval contains cum"""
        i, step, tree = 0, self.SIZE, self.tree
        while step:
            j = i + step
            if j <= self.SIZE and tree[j] <= cum:
                cum -= tree[j]
                i = j
            step >>= 1
        return i


class ArithmeticReader:
    """ECMA-363 第 10 节的 16 位算术解码器。位序为字节内低位在前。
    16-bit arithmetic decoder of ECMA-363 section 10; bits are taken LSB-first within each byte."""
    STATIC = 0x400            # 上下文 >= 0x400：均匀分布，范围 = 上下文 - 0x400 / static context of range ctx - 0x400

    def __init__(self, data):
        self.data = data + b"\0" * 16
        self.pos = 0
        self.low, self.high, self.underflow = 0, 0xFFFF, 0
        self.hist = {}
        self.rev = _rev15()

    def _window(self, p, n):
        b = p >> 3
        return (int.from_bytes(self.data[b:b + 5], "little") >> (p & 7)) & ((1 << n) - 1)

    def symbol(self, ctx):
        first = (self.data[self.pos >> 3] >> (self.pos & 7)) & 1
        code = (first << 15) | self.rev[self._window(self.pos + 1 + self.underflow, 15)]
        span = self.high - self.low + 1
        if ctx > self.STATIC:
            total = ctx - self.STATIC
            cum = (total * (code - self.low + 1) - 1) // span
            sym, below, freq, h = cum + 1, cum, 1, None
        else:
            h = self.hist.get(ctx)
            if h is None:
                h = self.hist[ctx] = Fenwick()
            total = h.total
            cum = (total * (code - self.low + 1) - 1) // span
            sym = h.find(cum)
            below, freq = h.below(sym), h.freq[sym]
        low = self.low
        self.high = low + span * (below + freq) // total - 1
        self.low = low + span * below // total
        if h is not None:
            h.add(sym)
        shift = 0
        while not (self.low ^ self.high) & 0x8000:           # 最高位相同：移出 / equal top bits: shift out
            self.low = (self.low << 1) & 0xFFFF
            self.high = ((self.high << 1) | 1) & 0xFFFF
            shift += 1
        if shift:
            self.pos += shift + self.underflow
            self.underflow = 0
        while self.low & 0x4000 and not self.high & 0x4000:   # 下溢位 / underflow bits
            self.low = (self.low & 0x3FFF) << 1
            self.high = ((self.high & 0x3FFF) << 1) | 0x8001
            self.underflow += 1
        return sym

    def u8(self):
        v = self.symbol(self.STATIC + 256) - 1
        return int(f"{v:08b}"[::-1], 2)                       # 字节内位序反转 / bits are swapped within the byte

    def u16(self):
        return self.u8() | (self.u8() << 8)

    def u32(self):
        return self.u16() | (self.u16() << 16)


class Reader:
    def __init__(self, buf):
        self.b, self.p = buf, 0

    def take(self, n):
        if self.p + n > len(self.b):
            raise ValueError("truncated data")
        v = self.b[self.p:self.p + n]
        self.p += n
        return v

    def u(self, n=1):
        return int.from_bytes(self.take(n), "little")

    def f32(self):
        return struct.unpack("<f", self.take(4))[0]


def rh39(buf, count):
    """规范附录 A.1 的 RH39 解码 / RH39 decoding after appendix A.1 of the specification"""
    r, out, offset = Reader(buf), [], 0
    while len(out) < count:
        c = r.u()
        op, n = (c >> 4) & 7, c & 15
        n = 17 + (n << 8) + r.u() if c & 0x80 else n + 1
        if op == 7:
            offset = r.u(n)
            continue
        if len(out) + n > count:
            raise ValueError("RH39 run exceeds the expected count")
        if op == 1:
            b = r.take((n + 1) // 2)
            out += [offset + ((b[i // 2] >> (4 * (i % 2))) & 15) for i in range(n)]
        elif op == 5:
            out += [offset] * n
        else:
            width = {0: 4, 2: 1, 3: 2, 4: 2, 6: 1}[op]
            base = offset if op in (2, 3) else 0
            out += [base + r.u(width) for _ in range(n)]
    if r.p != len(buf):
        raise ValueError("RH39 trailing data")
    return out


def uic1(buf, count, vertical):
    """规范附录 A.2 的 UIC1 解码 / UIC1 decoding after appendix A.2 of the specification"""
    r = Reader(buf)
    vals = [(-i) % 32 for i in range(32)]        # back(i) == i
    deltas = [0] * 32
    vp = dp = queue = qi = cur = 0
    out = []
    const = (0, 1, 2, 3, 4, 0xFF, 0xFF00, 0xFF0000, 0xFF000000, 0xFFFFFF, 0xFFFFFFFF)
    for i in range(count):
        prev = cur
        vert = out[i - 3] if (vertical and i >= 3) else 0
        if queue:
            queue -= 1
            cur = vals[(vp - qi) % 32]
        else:
            c = r.u()
            op, a = c & 15, c >> 4
            if op == 0:
                cur = vals[(vp - a) % 32]
            elif op == 5:
                cur = vals[(vp - 16 - a) % 32]
            elif op == 13:
                cur = vals[(vp - (a >> 2)) % 32]
                queue, qi = 1, a & 3
            elif op == 14:
                cur = vals[vp]
                queue, qi = a + 2, 0
            elif op == 6:
                cur += deltas[(dp - a) % 32]
            elif op == 1:
                cur += (a >> 1) + 1 if a & 1 else -((a >> 1) + 1)
            elif op == 3:
                cur = vert + a + 1
            elif op == 4:
                cur = vert - a - 1
            elif op == 7:
                cur = vert + a + 17
            elif op == 8:
                cur = vert - a - 17
            elif op == 9:
                cur += a + (r.u() << 4) + 3
            elif op == 10:
                cur -= a + (r.u() << 4) + 3
            elif op == 11:
                cur = a + (r.u() << 4)
            elif op == 12:
                cur = a + (r.u(2) << 4)
            elif op == 15:
                if a < len(const):
                    cur = const[a]
                elif a == 11:
                    cur = r.u(3)
                elif a == 12:
                    cur = r.u(4)
                elif a == 13:
                    queue, qi = r.u(2) + 36, 0                 # 当前值不变 / the current value is kept
                else:
                    raise ValueError("undefined extended UIC1 command")
            else:
                raise ValueError("undefined UIC1 command 2")
        cur &= 0xFFFFFFFF
        vp = (vp + 1) % 32
        vals[vp] = cur
        d = cur - prev
        if d and abs(d) < 0x7FFFFFFF:
            dp = (dp + 1) % 32
            deltas[dp] = d
        out.append(cur)
    if queue or r.p != len(buf):
        raise ValueError(f"UIC1 did not consume its payload exactly ({r.p} of {len(buf)}, queue {queue})")
    return out


def ints(r, count, maximum, vertical=False, log=None):
    """整数数组 / integer array ("Integer data encoding", spec p. 30)"""
    t = r.u()
    typ = t & 63
    if typ == 0:
        v = [0] * count
    elif typ == 1:
        v = [r.u(4)] * count
    else:
        size = r.u((t >> 6) + 1)
        buf = r.take(size)
        if typ == 2:
            v = [(buf[i // 2] >> (4 * (i % 2))) & 15 for i in range(count)]
        elif 3 <= typ <= 6:
            w = typ - 2
            v = [int.from_bytes(buf[i * w:(i + 1) * w], "little") for i in range(count)]
        elif typ == 7:
            v = rh39(buf, count)
        elif typ == 8:
            ar = ArithmeticReader(buf)
            v = [ar.symbol(ArithmeticReader.STATIC + maximum + 1) - 1 for _ in range(count)]
        elif typ == 9:
            ar, v = ArithmeticReader(buf), []
            wide = maximum > 0xFFFF
            for _ in range(count):
                s = ar.symbol(1)
                if s:
                    v.append(s - 1)
                else:
                    a = ar.u32() if wide else ar.u16()
                    ar.hist[1].add(a + 1)
                    v.append(a)
        elif typ == 10:
            v = uic1(buf, count, True)        # “垂直前值”对所有数组都取 3 个位置之前 / the vertical value is 3 back for every array
        else:
            raise ValueError(f"unknown integer encoding {typ}")
    if len(v) != count or (count and not 0 <= min(v) <= max(v) <= maximum):
        raise ValueError(f"integer array out of range (encoding {typ}, count {count}, maximum {maximum})")
    if log is not None:
        log.append(typ)
    return v


def floats(r, count, dims, log=None):
    """浮点数组，按 XXX…YYY…ZZZ… 排列 / float array, stored axis by axis (spec p. 28)"""
    if count == 0:
        return np.zeros((0, dims))
    typ = r.u()
    cols = []
    if typ == 0:
        for _ in range(dims):
            cols.append(np.frombuffer(r.take(4 * count), dtype="<f4").astype(np.float64))
    elif typ == 2:
        for _ in range(dims):
            lo, hi = r.f32(), r.f32()
            if lo == hi:
                cols.append(np.full(count, lo))
            else:
                n = r.u(4)
                q = np.array(ints(r, count, n, log=log), dtype=np.float64)
                cols.append(lo + q * (hi - lo) / n)
    else:
        raise ValueError(f"unsupported float data type {typ}")
    return np.stack(cols, axis=1)


def decode_mesh(body):
    """一个 RHAdobeMeshResource 块 -> (名称, 顶点 Nx3, 三角形 Mx3, 信息)
    one RHAdobeMeshResource block -> (name, vertices Nx3, triangles Mx3, info)"""
    r = Reader(body)
    name = r.take(r.u(2)).decode("utf8", "replace")
    flags = r.u()
    if flags & 0x3F:
        raise ValueError("chunk version / sub-chunks / skeleton are not supported")
    mc = r.u({1: 1, 2: 2, 3: 4}[flags >> 6]) if flags >> 6 else 1
    for _ in range(mc):
        mf = r.u()
        layers = r.u(((mf >> 4) & 3) + 1)
        r.u(((mf >> 2) & 3) + 1)                               # OriginalShadingID
        if layers > 1:
            r.take((layers - 1 + 3) // 4)
    vf = r.u()
    w = (vf >> 6) + 1
    nf, npos, nn, nd, ns, nt = [r.u(w) if vf & (1 << i) else 0 for i in range(6)]
    log = []
    pos = floats(r, npos, 3, log)
    # 法线：只跳过，不解码 / normals: skipped, not decoded
    if nn:
        ntype = r.b[r.p]
        if ntype == 3:
            r.u()
            r.u(4)
            # 本文件中 alpha 与 theta 合在同一个编码块里（与规范正文写的两个数组不同）
            # in this file alpha and theta share ONE encoded block (the specification text lists two arrays)
            t = r.u()
            if (t & 63) == 1:
                r.take(4)
            elif (t & 63) >= 2:
                r.take(r.u((t >> 6) + 1))
        else:
            floats(r, nn, 3)
    if nd or ns or nt:
        raise ValueError("vertex colours / texture coordinates are not supported")
    if mc > 1:
        ints(r, nf, mc - 1)
    faces = np.array(ints(r, nf * 3, npos - 1, vertical=True, log=log), dtype=np.int64).reshape(-1, 3)
    if nn:
        t = r.u()                                              # 法线索引：跳过 / normal indices: skipped
        if (t & 63) == 1:
            r.take(4)
        elif (t & 63) >= 2:
            r.take(r.u((t >> 6) + 1))
    return name, pos, faces, {"encodings": log, "consumed": r.p, "size": len(body), "normals": nn}


def blocks(buf):
    p = 0
    while p + 12 <= len(buf):
        t, ds, ms = struct.unpack_from("<III", buf, p)
        yield t, buf[p + 12:p + 12 + ds]
        p = (p + 12 + ds + ms + 3) & ~3


def read_u3d(data):
    """返回 [(结构名, 顶点, 三角形, 信息)]，顶点已乘以模型节点的变换矩阵。
    Returns [(structure name, vertices, triangles, info)]; vertices carry the model node transform."""
    meshes, nodes, new_type = {}, [], None
    for t, body in blocks(data):
        if t != 0xFFFFFF14:
            continue
        n = struct.unpack_from("<H", body, 0)[0]
        q = 2 + n
        _, attr = struct.unpack_from("<II", body, q)
        q += 8 + (16 if attr & 1 else 0) + (24 if attr & 2 else 0)
        q = ((q + 3) & ~3) + 4
        for t2, b2 in blocks(body[q:]):
            if t2 == 0xFFFFFF16:
                k = struct.unpack_from("<H", b2, 0)[0]
                if b2[2:2 + k] != b"RHAdobeMeshResource":
                    continue
                new_type = struct.unpack_from("<I", b2, 2 + k + 4 + 16)[0]
            elif t2 == 0xFFFFFF22:
                k = struct.unpack_from("<H", b2, 0)[0]
                name = b2[2:2 + k].decode("utf8", "replace")
                p = 2 + k
                pc = struct.unpack_from("<I", b2, p)[0]
                p += 4
                M = np.eye(4)
                for _ in range(pc):
                    k2 = struct.unpack_from("<H", b2, p)[0]
                    p += 2 + k2
                    M = np.array(struct.unpack_from("<16f", b2, p), dtype=float).reshape(4, 4).T @ M
                    p += 64
                k3 = struct.unpack_from("<H", b2, p)[0]
                nodes.append((name, b2[p + 2:p + 2 + k3].decode("utf8", "replace"), M))
            elif new_type is not None and t2 == new_type:
                nm, v, f, info = decode_mesh(b2)
                meshes[nm] = (v, f, info)
    out = []
    for name, res, M in nodes:
        if res in meshes:
            v, f, info = meshes[res]
            out.append((name, v @ M[:3, :3].T + M[:3, 3], f, dict(info, identity_transform=bool(np.allclose(M, np.eye(4))))))
    return out


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    res = read_u3d(open(src, "rb").read())
    with open(os.path.join(out, "structures.tsv"), "w") as tsv:
        tsv.write("file\tstructure\tvertices\ttriangles\tencodings\tpayload_consumed\n")
        for i, (name, v, f, info) in enumerate(res):
            fn = f"{i:02d}_" + "".join(c if c.isalnum() else "_" for c in name) + ".obj"
            with open(os.path.join(out, fn), "w") as fh:
                fh.write(f"# {name}\no {name}\n")
                fh.write("".join(f"v {a:.4f} {b:.4f} {c:.4f}\n" for a, b, c in v))
                fh.write("".join(f"f {a + 1} {b + 1} {c + 1}\n" for a, b, c in f))
            tsv.write(f"{fn}\t{name}\t{len(v)}\t{len(f)}\t{','.join(map(str, info['encodings']))}\t{info['consumed']}/{info['size']}\n")
    print(len(res), "structures,", sum(len(v) for _, v, _, _ in res), "vertices,", sum(len(f) for _, _, f, _ in res), "triangles")


if __name__ == "__main__":
    main()
