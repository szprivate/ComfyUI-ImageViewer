"""Matchmove: the camera solve and the object solve, in numpy.

From 2D tracks (plate pixels, the lens taken out first) to a camera per frame and a 3D point per track. Written
from the textbook methods, from scratch:
- two views to start: the essential matrix by the normalised eight-point method inside RANSAC (Sampson
  distance), split into its four motions and the one with the points in front kept;
- every further frame by resection (Gauss-Newton on the pose from the points it sees, from its neighbour's pose;
  a direct linear solve with RANSAC when that does not settle), new points by linear triangulation once they are
  seen from far enough apart;
- bundle adjustment: Levenberg-Marquardt over every key frame's pose, every point and (when asked) the focal
  length, the points eliminated by the Schur complement, Huber weights against what tracking got wrong;
- a camera that only turns (a tripod or nodal pan): the rotations alone and each point as a direction;
- an unknown focal length: the solve is tried over a range of fields of view and the best is refined.

Conventions: the camera looks down +Z with x right and y down (pixels); x_cam = R X + t. The page turns that into
the 3D space's (Y up, a camera looking down -Z). No ComfyUI here.
"""
from __future__ import annotations

import math

import numpy as np

from . import matchmove as MM

HUBER = 2.0          # pixels: a residual beyond this weighs less
MAX_KEYS = 60        # key frames bundle-adjusted together
MIN_TRACK = 5        # frames a track needs to be used


# ── rotations ────────────────────────────────────────────────────────────────

def skew(v):
    v = np.asarray(v, np.float64)
    z = np.zeros(v.shape[:-1])
    return np.stack([np.stack([z, -v[..., 2], v[..., 1]], -1),
                     np.stack([v[..., 2], z, -v[..., 0]], -1),
                     np.stack([-v[..., 1], v[..., 0], z], -1)], -2)


def rodrigues(w):
    """Rotation matrix of the axis-angle vector w (any leading shape)."""
    w = np.asarray(w, np.float64)
    th = np.linalg.norm(w, axis=-1, keepdims=True)
    small = th < 1e-12
    k = w / np.where(small, 1, th)
    K = skew(k)
    th = th[..., None]
    I = np.broadcast_to(np.eye(3), K.shape)
    R = I + np.sin(th) * K + (1 - np.cos(th)) * (K @ K)
    return np.where(small[..., None], I + skew(w), R)


def rot_log(R):
    R = np.asarray(R, np.float64)
    c = np.clip((np.trace(R) - 1) / 2, -1, 1)
    th = math.acos(c)
    if th < 1e-9:
        return np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / 2
    if abs(th - math.pi) < 1e-6:
        A = (R + np.eye(3)) / 2
        i = int(np.argmax(np.diag(A)))
        v = A[:, i] / math.sqrt(max(A[i, i], 1e-12))
        return v * th
    return th / (2 * math.sin(th)) * np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])


def orthonormal(M):
    U, _, Vt = np.linalg.svd(M)
    R = U @ Vt
    if np.linalg.det(R) < 0:
        R = U @ np.diag([1, 1, -1]) @ Vt
    return R


def kabsch(a, b):
    """The rotation R with R a ~ b for unit vectors a, b ([N, 3])."""
    H = a.T @ b
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T)) or 1
    return Vt.T @ np.diag([1, 1, d]) @ U.T


# ── two views ────────────────────────────────────────────────────────────────

def _norm_T(x):
    c = x.mean(0)
    d = np.sqrt(((x - c) ** 2).sum(1)).mean() or 1
    k = math.sqrt(2) / d
    return np.array([[k, 0, -k * c[0]], [0, k, -k * c[1]], [0, 0, 1]])


def essential_8pt(x1, x2, raw=False):
    """E from 8 or more matches in normalised camera coordinates ([N, 2]); ``raw`` = the least-squares matrix
    before it is made an essential one (a narrow view - an object far off - makes that step move it a lot, so
    matches are judged by the raw one and the motion taken from the made one, which the bundle adjusts)."""
    T1, T2 = _norm_T(x1), _norm_T(x2)
    a = (T1 @ np.c_[x1, np.ones(len(x1))].T).T
    b = (T2 @ np.c_[x2, np.ones(len(x2))].T).T
    A = np.c_[b[:, 0:1] * a, b[:, 1:2] * a, a]
    _, _, vt = np.linalg.svd(A)
    E = vt[-1].reshape(3, 3)
    E = T2.T @ E @ T1
    if raw:
        return E
    U, s, Vt = np.linalg.svd(E)
    return U @ np.diag([1, 1, 0]) @ Vt


def sampson(E, x1, x2):
    a = np.c_[x1, np.ones(len(x1))]
    b = np.c_[x2, np.ones(len(x2))]
    Ea = a @ E.T
    Etb = b @ E
    num = (b * Ea).sum(1) ** 2
    den = Ea[:, 0] ** 2 + Ea[:, 1] ** 2 + Etb[:, 0] ** 2 + Etb[:, 1] ** 2
    return num / np.maximum(den, 1e-30)


def ransac_essential(x1, x2, thresh, iters=400, rng=None):
    rng = rng or np.random.default_rng(7)
    n = len(x1)
    best, best_in = None, np.zeros(n, bool)
    if n < 8:
        return None, best_in
    for _ in range(iters):
        s = rng.choice(n, 8, replace=False)
        try:
            E = essential_8pt(x1[s], x2[s], raw=True)
        except np.linalg.LinAlgError:
            continue
        inl = sampson(E, x1, x2) < thresh * thresh
        if inl.sum() > best_in.sum():
            best, best_in = E, inl
            if inl.mean() > 0.95:
                break
    if best is not None and best_in.sum() >= 8:
        raw = essential_8pt(x1[best_in], x2[best_in], raw=True)
        best_in = sampson(raw, x1, x2) < thresh * thresh
        best = essential_8pt(x1[best_in], x2[best_in]) if best_in.sum() >= 8 else None
    return best, best_in


def triangulate_pair(R1, t1, R2, t2, x1, x2):
    P1 = np.c_[R1, t1]
    P2 = np.c_[R2, t2]
    out = np.zeros((len(x1), 3))
    for i in range(len(x1)):
        A = np.stack([x1[i, 0] * P1[2] - P1[0], x1[i, 1] * P1[2] - P1[1],
                      x2[i, 0] * P2[2] - P2[0], x2[i, 1] * P2[2] - P2[1]])
        _, _, vt = np.linalg.svd(A)
        X = vt[-1]
        out[i] = X[:3] / (X[3] if abs(X[3]) > 1e-12 else 1e-12)
    return out


def triangulate(Ps, xs):
    """One point from several views: Ps [k, 3, 4], xs [k, 2] (normalised)."""
    A = np.concatenate([xs[:, 0:1] * Ps[:, 2] - Ps[:, 0], xs[:, 1:2] * Ps[:, 2] - Ps[:, 1]])
    _, _, vt = np.linalg.svd(A)
    X = vt[-1]
    if abs(X[3]) < 1e-12:
        return None
    return X[:3] / X[3]


def motion_from_E(E, x1, x2):
    """(R, t, points, in front mask) of the four splits of E, the one with most points in front of both."""
    U, _, Vt = np.linalg.svd(E)
    if np.linalg.det(U) < 0:
        U = -U
    if np.linalg.det(Vt) < 0:
        Vt = -Vt
    W = np.array([[0, -1, 0], [1, 0, 0], [0, 0, 1.0]])
    best = None
    for R in (U @ W @ Vt, U @ W.T @ Vt):
        for t in (U[:, 2], -U[:, 2]):
            X = triangulate_pair(np.eye(3), np.zeros(3), R, t, x1, x2)
            z1 = X[:, 2]
            z2 = (X @ R.T + t)[:, 2]
            front = (z1 > 0) & (z2 > 0)
            if best is None or front.sum() > best[3].sum():
                best = (R, t, X, front)
    return best


# ── one camera from points ───────────────────────────────────────────────────

def project(R, t, X, f, c):
    p = X @ R.T + t
    z = p[:, 2]
    return f * p[:, :2] / z[:, None] + c, z


def pnp_dlt(X, x):
    """A pose from 6 or more 3D points and their normalised image points: (R, t) or None."""
    n = len(X)
    if n < 6:
        return None
    A = np.zeros((2 * n, 12))
    Xh = np.c_[X, np.ones(n)]
    A[0::2, 0:4] = Xh
    A[0::2, 8:12] = -x[:, 0:1] * Xh
    A[1::2, 4:8] = Xh
    A[1::2, 8:12] = -x[:, 1:2] * Xh
    _, _, vt = np.linalg.svd(A)
    P = vt[-1].reshape(3, 4)
    M = P[:, :3]
    U, s, Vt = np.linalg.svd(M)
    scale = s.mean()
    R = U @ Vt
    t = P[:, 3] / scale
    if np.linalg.det(R) < 0:
        R, t = -R, -t
    if ((X @ R.T + t)[:, 2] > 0).mean() < 0.5:
        R, t = -R, -t
        R = orthonormal(R)
    return orthonormal(R), t


def refine_pose(R, t, X, uv, f, c, iters=15, rotation_only=False):
    """Gauss-Newton (damped) on one camera's pose with the points fixed; Huber weights. -> (R, t, rms)."""
    R, t = R.copy(), t.copy()
    lam = 1e-3

    def cost(R, t):
        pr, z = project(R, t, X, f, c)
        r = (pr - uv)
        e = np.sqrt((r * r).sum(1))
        w = np.where(e < HUBER, 1, HUBER / np.maximum(e, 1e-12))
        bad = z <= 1e-9
        return float((w * e * e).sum() + bad.sum() * 1e6), r, w, z
    c0, r, w, z = cost(R, t)
    for _ in range(iters):
        p = X @ R.T + t
        z = p[:, 2]
        iz = 1 / np.where(np.abs(z) < 1e-9, 1e-9, z)
        J = np.zeros((len(X), 2, 6))
        dpi = np.zeros((len(X), 2, 3))
        dpi[:, 0, 0] = f * iz
        dpi[:, 0, 2] = -f * p[:, 0] * iz * iz
        dpi[:, 1, 1] = f * iz
        dpi[:, 1, 2] = -f * p[:, 1] * iz * iz
        RX = X @ R.T
        J[:, :, :3] = dpi @ -skew(RX)
        J[:, :, 3:] = dpi
        if rotation_only:
            J = J[:, :, :3]
        Jw = J * w[:, None, None]
        H = np.einsum("nki,nkj->ij", Jw, J)
        g = np.einsum("nki,nk->i", Jw, r)
        ok = False
        for _ in range(6):
            try:
                d = -np.linalg.solve(H + lam * np.diag(np.diag(H) + 1e-9), g)
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            R2 = rodrigues(d[:3]) @ R
            t2 = t + d[3:] if not rotation_only else t
            c1, r1, w1, z1 = cost(R2, t2)
            if c1 < c0:
                R, t, c0, r, w = R2, t2, c1, r1, w1
                lam = max(lam / 3, 1e-9)
                ok = True
                break
            lam *= 4
        if not ok or np.abs(d).max() < 1e-10:
            break
    pr, _ = project(R, t, X, f, c)
    e = np.sqrt(((pr - uv) ** 2).sum(1))
    return R, t, float(np.sqrt(np.mean(e * e))) if len(e) else 0.0


def resect(X, uv, f, c, guess=None, rotation_only=False, rng=None):
    """A camera's pose from the points it sees: from ``guess`` (R, t) by Gauss-Newton, else (or when that does
    not settle) a direct linear solve with RANSAC. -> (R, t, rms, inliers)."""
    xn = (uv - c) / f
    tries = []
    if guess is not None:
        tries.append(refine_pose(guess[0], guess[1], X, uv, f, c, rotation_only=rotation_only))
    if not rotation_only and (not tries or tries[0][2] > 3.0) and len(X) >= 6:
        rng = rng or np.random.default_rng(3)
        best = None
        n = len(X)
        for _ in range(min(120, 10 + n * 2)):
            s = rng.choice(n, 6, replace=False)
            pose = pnp_dlt(X[s], xn[s])
            if pose is None:
                continue
            pr, z = project(pose[0], pose[1], X, f, c)
            e = np.sqrt(((pr - uv) ** 2).sum(1))
            inl = (e < 4) & (z > 0)
            if best is None or inl.sum() > best[1].sum():
                best = (pose, inl)
        if best is not None and best[1].sum() >= 6:
            pose = pnp_dlt(X[best[1]], xn[best[1]]) or best[0]
            tries.append(refine_pose(pose[0], pose[1], X, uv, f, c))
    if not tries:
        return None
    R, t, rms = min(tries, key=lambda r: r[2])
    pr, z = project(R, t, X, f, c)
    e = np.sqrt(((pr - uv) ** 2).sum(1))
    return R, t, rms, (e < max(4.0, 3 * rms)) & (z > 0)


# ── bundle adjustment ────────────────────────────────────────────────────────

def bundle_adjust(Rs, ts, X, obs, f, c, fixed=(0,), refine_f=False, tripod=False, iters=25, progress=None):
    """Levenberg-Marquardt over cameras (Rs [C, 3, 3], ts [C, 3]), points X [P, 3] and f.

    ``obs`` = (ci [N], pi [N], uv [N, 2]). Cameras in ``fixed`` do not move; a tripod solve moves only the
    rotations and keeps the points on the unit sphere. Returns (Rs, ts, X, f, rms)."""
    ci, pi, uv = obs
    Rs, ts, X = Rs.copy(), ts.copy(), X.copy()
    C, P = len(Rs), len(X)
    cp = 3 if tripod else 6
    free_cams = [j for j in range(C) if j not in set(fixed)]
    col = {j: k * cp for k, j in enumerate(free_cams)}
    nc = len(free_cams) * cp + (1 if refine_f else 0)
    fcol = nc - 1 if refine_f else None
    cam_col = np.array([col.get(j, -1) for j in range(C)])
    order = np.argsort(pi, kind="stable")
    ci_s, pi_s = ci[order], pi[order]
    starts = np.searchsorted(pi_s, np.arange(P + 1))

    def residuals(Rs, ts, X, f):
        p = np.einsum("nij,nj->ni", Rs[ci], X[pi]) + ts[ci]
        z = p[:, 2]
        iz = 1 / np.where(np.abs(z) < 1e-9, 1e-9, z)
        pr = f * p[:, :2] * iz[:, None] + c
        return pr - uv, p, iz, z

    def cost_of(r, z):
        e = np.sqrt((r * r).sum(1))
        w = np.where(e < HUBER, 1, HUBER / np.maximum(e, 1e-12))
        return float((w * e * e).sum() + (z <= 1e-9).sum() * 1e6), w

    r, p, iz, z = residuals(Rs, ts, X, f)
    cost, w = cost_of(r, z)
    lam = 1e-3
    for it in range(iters):
        N = len(ci)
        dpi = np.zeros((N, 2, 3))
        dpi[:, 0, 0] = f * iz
        dpi[:, 0, 2] = -f * p[:, 0] * iz * iz
        dpi[:, 1, 1] = f * iz
        dpi[:, 1, 2] = -f * p[:, 1] * iz * iz
        RX = np.einsum("nij,nj->ni", Rs[ci], X[pi])
        Jc = np.zeros((N, 2, cp))
        Jc[:, :, :3] = dpi @ -skew(RX)
        if not tripod:
            Jc[:, :, 3:] = dpi
        Jp = dpi @ Rs[ci]
        Jf = (p[:, :2] * iz[:, None])[:, :, None]
        wv = w[:, None, None]
        # blocks
        Ucc = np.einsum("nki,nkj->nij", Jc * wv, Jc)       # per obs, summed per camera below
        Wcp = np.einsum("nki,nkj->nij", Jc * wv, Jp)
        Vpp = np.einsum("nki,nkj->nij", Jp * wv, Jp)
        gc = np.einsum("nki,nk->ni", Jc * wv, r)
        gp = np.einsum("nki,nk->ni", Jp * wv, r)
        V = np.zeros((P, 3, 3))
        np.add.at(V, pi, Vpp)
        G = np.zeros((P, 3))
        np.add.at(G, pi, gp)
        A = np.zeros((nc, nc))
        b = np.zeros(nc)
        for j in free_cams:
            sel = ci == j
            k = col[j]
            A[k:k + cp, k:k + cp] += Ucc[sel].sum(0)
            b[k:k + cp] += gc[sel].sum(0)
        if refine_f:
            Wfc = np.einsum("nki,nkj->nij", Jf * wv, Jc)[:, 0, :]    # [N, cp]
            Wfp = np.einsum("nki,nkj->nij", Jf * wv, Jp)[:, 0, :]    # [N, 3]
            A[fcol, fcol] += float((Jf * wv * Jf).sum())
            b[fcol] += float(np.einsum("nki,nk->", Jf * wv, r))
            for j in free_cams:
                sel = ci == j
                k = col[j]
                v = Wfc[sel].sum(0)
                A[fcol, k:k + cp] += v
                A[k:k + cp, fcol] += v
            Fp = np.zeros((P, 3))
            np.add.at(Fp, pi, Wfp)
        ok = False
        for _ in range(8):
            Vd = V + lam * (np.diagonal(V, axis1=1, axis2=2)[:, :, None] * np.eye(3) + 1e-9 * np.eye(3))
            try:
                Vi = np.linalg.inv(Vd)
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            S = A + lam * np.diag(np.diag(A) + 1e-9)
            rhs = b.copy()
            # the Schur complement: each point's columns taken out
            Wc_s = Wcp[order]
            for i in range(P):
                a0, a1 = starts[i], starts[i + 1]
                if a1 <= a0:
                    continue
                cams = ci_s[a0:a1]
                cols = cam_col[cams]
                live = cols >= 0
                Bt = Wc_s[a0:a1][live]                     # [m, cp, 3]
                rows = (cols[live][:, None] + np.arange(cp)[None, :]).ravel()
                Bm = Bt.reshape(-1, 3)
                if refine_f:
                    Bm = np.r_[Bm, Fp[i][None, :]]
                    rows = np.r_[rows, fcol]
                if not len(rows):
                    continue
                BV = Bm @ Vi[i]
                S[np.ix_(rows, rows)] -= BV @ Bm.T
                rhs[rows] -= BV @ G[i]
            try:
                dz = -np.linalg.solve(S, rhs) if nc else np.zeros(0)
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            # back to the points: dX_i = -V_i^-1 (g_i + B_i' dz)
            dX = np.zeros((P, 3))
            corr = np.zeros((P, 3))
            for i in range(P):
                a0, a1 = starts[i], starts[i + 1]
                if a1 <= a0:
                    continue
                cams = ci_s[a0:a1]
                cols = cam_col[cams]
                live = cols >= 0
                Bt = Wc_s[a0:a1][live]
                if live.any():
                    dzs = np.stack([dz[cc:cc + cp] for cc in cols[live]])     # [m, cp]
                    corr[i] = np.einsum("mij,mi->j", Bt, dzs)
                if refine_f:
                    corr[i] += Fp[i] * dz[fcol]
            dX = -np.einsum("pij,pj->pi", Vi, G + corr)
            Rs2, ts2 = Rs.copy(), ts.copy()
            for j in free_cams:
                k = col[j]
                Rs2[j] = rodrigues(dz[k:k + 3]) @ Rs[j]
                if not tripod:
                    ts2[j] = ts[j] + dz[k + 3:k + 6]
            X2 = X + dX
            if tripod:
                X2 = X2 / np.maximum(np.linalg.norm(X2, axis=1, keepdims=True), 1e-12)
            f2 = f + (dz[fcol] if refine_f else 0)
            if f2 <= 1:
                lam *= 4
                continue
            r2, p2, iz2, z2 = residuals(Rs2, ts2, X2, f2)
            c2, w2 = cost_of(r2, z2)
            if c2 < cost:
                done = (cost - c2) < 1e-7 * cost
                Rs, ts, X, f, r, p, iz, z, cost, w = Rs2, ts2, X2, f2, r2, p2, iz2, z2, c2, w2
                lam = max(lam / 3, 1e-9)
                ok = True
                break
            lam *= 4
        if progress:
            progress(it)
        if not ok or done:
            break
    e = np.sqrt((r * r).sum(1))
    return Rs, ts, X, f, float(np.sqrt(np.mean(e * e))) if len(e) else 0.0


# ── the solve ────────────────────────────────────────────────────────────────

class Obs:
    """Every frame's undistorted track positions: per frame {track index: (u, v)}."""

    def __init__(self, tracks, lens, w, h, frames=None):
        self.tracks = [t for t in tracks if t.get("on", True) and len(t["keys"]) >= MIN_TRACK]
        self.by_frame = {}
        lo, hi = (frames or (None, None))
        for ti, t in enumerate(self.tracks):
            ks = [k for k in t["keys"] if (lo is None or k[0] >= lo) and (hi is None or k[0] <= hi)]
            if len(ks) < 2:
                continue
            xy = MM.undistort_points(np.asarray([[k[1], k[2]] for k in ks]), lens, w, h)
            for k, p in zip(ks, xy):
                self.by_frame.setdefault(int(k[0]), {})[ti] = p
        self.frames = sorted(self.by_frame)

    def common(self, a, b):
        A, B = self.by_frame.get(a, {}), self.by_frame.get(b, {})
        ids = sorted(set(A) & set(B))
        return ids, np.asarray([A[i] for i in ids]).reshape(-1, 2), np.asarray([B[i] for i in ids]).reshape(-1, 2)


def _pick_keys(frames, most=MAX_KEYS):
    if len(frames) <= most:
        return list(frames)
    step = (len(frames) - 1) / (most - 1)
    return sorted({frames[int(round(i * step))] for i in range(most)})


def _homography(P, Q):
    """The projective map P -> Q, least squares on normalised points (the normal equations' smallest
    eigenvector: quick for many matches)."""
    Tp, Tq = _norm_T(P), _norm_T(Q)
    p = (Tp @ np.c_[P, np.ones(len(P))].T).T
    q = (Tq @ np.c_[Q, np.ones(len(Q))].T).T
    n = len(P)
    A = np.zeros((2 * n, 9))
    A[0::2, 0:3] = -p
    A[0::2, 6:9] = q[:, 0:1] * p
    A[1::2, 3:6] = -p
    A[1::2, 6:9] = q[:, 1:2] * p
    _, vec = np.linalg.eigh(A.T @ A)
    H = np.linalg.inv(Tq) @ vec[:, 0].reshape(3, 3) @ Tp
    return H / H[2, 2] if abs(H[2, 2]) > 1e-15 else None


def _apply_h(H, P):
    a = np.c_[P, np.ones(len(P))] @ H.T
    return a[:, :2] / a[:, 2:3]


def _parallax(x1, x2):
    """How much the matches move apart from a projective map of one onto the other (median px, after dropping
    the worst twice)."""
    if len(x1) < 8:
        return 0.0
    keep = np.ones(len(x1), bool)
    r = None
    for _ in range(3):
        if keep.sum() < 8:
            break
        H = _homography(x1[keep], x2[keep])
        if H is None:
            return 0.0
        r = np.sqrt(((_apply_h(H, x1) - x2) ** 2).sum(1))
        keep = r <= max(1.5, 3 * float(np.median(r[keep])))
    return float(np.median(r)) if r is not None else 0.0


def _initial_pair(obs, keys, min_common=12):
    best, best_s = None, -1
    n = len(keys)
    # pairs a few key frames apart, at most ~200 of them
    reach = min(n - 1, 16)
    stride = max(1, int(math.ceil(n * reach / 200)))
    for i in range(0, n, stride):
        for j in range(i + 1, min(n, i + reach + 1), max(1, stride // 2)):
            ids, x1, x2 = obs.common(keys[i], keys[j])
            if len(ids) < min_common:
                if j > i + 1:
                    break
                continue
            par = _parallax(x1, x2)
            s = par * min(1.0, len(ids) / 40.0)
            if s > best_s:
                best, best_s = (keys[i], keys[j]), s
    return best, best_s


def _solve_free(obs, keys, f, c, refine_f, progress=None, cancel=None):
    """Incremental structure from motion over the key frames. -> dict or None."""
    pair, par = _initial_pair(obs, keys)
    if pair is None or par < 1.0:
        return None
    a, b = pair
    ids, x1, x2 = obs.common(a, b)
    n1, n2 = (x1 - c) / f, (x2 - c) / f
    E, inl = ransac_essential(n1, n2, 1.5 / f)
    if E is None or inl.sum() < 8:
        return None
    R, t, Xp, front = motion_from_E(E, n1[inl], n2[inl])
    good_ids = [ids[k] for k, m in zip(np.nonzero(inl)[0], front) if m]
    pts = {ti: X for ti, X, m in zip([ids[k] for k in np.nonzero(inl)[0]], Xp, front) if m}
    if len(pts) < 8:
        return None
    poses = {a: (np.eye(3), np.zeros(3)), b: (R, t)}
    pending = [k for k in keys if k not in poses]

    def triangulate_new():
        reg = sorted(poses)
        for ti in range(len(obs.tracks)):
            if ti in pts:
                continue
            seen = [fr for fr in reg if ti in obs.by_frame.get(fr, {})]
            if len(seen) < 2:
                continue
            Ps = np.stack([np.c_[poses[fr][0], poses[fr][1]] for fr in seen])
            xs = np.stack([(obs.by_frame[fr][ti] - c) / f for fr in seen])
            X = triangulate(Ps, xs)
            if X is None:
                continue
            # in front, close to its views, and seen from far enough apart
            ok = True
            rays = []
            for fr in seen:
                Rr, tt = poses[fr]
                pc = Rr @ X + tt
                if pc[2] <= 0:
                    ok = False
                    break
                pr = f * pc[:2] / pc[2] + c
                if np.hypot(*(pr - obs.by_frame[fr][ti])) > 4:
                    ok = False
                    break
                rays.append((X + Rr.T @ tt) / max(1e-12, np.linalg.norm(X + Rr.T @ tt)))
            if not ok:
                continue
            rays = np.asarray(rays)
            ang = math.degrees(math.acos(np.clip(np.min(rays @ rays.T), -1, 1)))
            if ang >= 1.0:
                pts[ti] = X

    def ba(fix):
        nonlocal f
        regs = sorted(poses)
        idx = {fr: k for k, fr in enumerate(regs)}
        pid = sorted(pts)
        pix = {ti: k for k, ti in enumerate(pid)}
        ci, pi, uv = [], [], []
        for fr in regs:
            for ti, p in obs.by_frame.get(fr, {}).items():
                if ti in pix:
                    ci.append(idx[fr])
                    pi.append(pix[ti])
                    uv.append(p)
        if not ci:
            return 0.0
        Rs = np.stack([poses[fr][0] for fr in regs])
        ts = np.stack([poses[fr][1] for fr in regs])
        X = np.stack([pts[ti] for ti in pid])
        Rs, ts, X, f2, rms = bundle_adjust(Rs, ts, X, (np.asarray(ci), np.asarray(pi), np.asarray(uv)), f, c,
                                           fixed=(idx[fix],), refine_f=refine_f and len(regs) >= 4)
        f = f2
        for fr in regs:
            poses[fr] = (Rs[idx[fr]], ts[idx[fr]])
        for ti in pid:
            pts[ti] = X[pix[ti]]
        return rms

    triangulate_new()
    ba(a)
    added = 0
    while pending:
        if cancel and cancel():
            return None
        # the next frame: next to one already solved, seeing the most points
        cand = []
        for fr in pending:
            seen = [ti for ti in obs.by_frame.get(fr, {}) if ti in pts]
            near = min(poses, key=lambda k: abs(k - fr))
            cand.append((len(seen), -abs(near - fr), fr, near, seen))
        cand.sort(reverse=True)
        nseen, _, fr, near, seen = cand[0]
        if nseen < 6:
            break
        X = np.stack([pts[ti] for ti in seen])
        uv = np.stack([obs.by_frame[fr][ti] for ti in seen])
        got = resect(X, uv, f, c, guess=poses[near])
        pending.remove(fr)
        if got is None or got[2] > 8:
            continue
        poses[fr] = (got[0], got[1])
        added += 1
        triangulate_new()
        if added % 5 == 0:
            ba(a)
        if progress:
            progress(len(poses), len(keys))
    rms = ba(a)
    # drop what does not fit, then once more
    drop = _outliers(obs, poses, pts, f, c, rms)
    for ti in drop:
        pts.pop(ti, None)
    if drop:
        rms = ba(a)
    return {"poses": poses, "pts": pts, "f": f, "rms": rms, "pair": pair}


def _outliers(obs, poses, pts, f, c, rms):
    lim = max(3.0, 4 * rms)
    bad = []
    for ti, X in pts.items():
        es = []
        for fr, (R, t) in poses.items():
            p = obs.by_frame.get(fr, {}).get(ti)
            if p is None:
                continue
            pc = R @ X + t
            if pc[2] <= 0:
                es.append(1e9)
                continue
            es.append(float(np.hypot(*(f * pc[:2] / pc[2] + c - p))))
        if es and (np.median(es) > lim):
            bad.append(ti)
    return bad


def _solve_tripod(obs, keys, f, c, refine_f):
    """Only turning: rotations chained frame to frame, then adjusted with each point as a direction."""
    poses = {keys[0]: (np.eye(3), np.zeros(3))}
    for a, b in zip(keys, keys[1:]):
        ids, x1, x2 = obs.common(a, b)
        if len(ids) < 4:
            return None
        d1 = np.c_[(x1 - c) / f, np.ones(len(ids))]
        d2 = np.c_[(x2 - c) / f, np.ones(len(ids))]
        d1 /= np.linalg.norm(d1, axis=1, keepdims=True)
        d2 /= np.linalg.norm(d2, axis=1, keepdims=True)
        Rab = kabsch(d1, d2)
        poses[b] = (Rab @ poses[a][0], np.zeros(3))
    pts = {}
    for ti in range(len(obs.tracks)):
        for fr in keys:
            p = obs.by_frame.get(fr, {}).get(ti)
            if p is not None:
                d = np.r_[(p - c) / f, 1.0]
                pts[ti] = poses[fr][0].T @ (d / np.linalg.norm(d))
                break
    regs = sorted(poses)
    idx = {fr: k for k, fr in enumerate(regs)}
    pid = sorted(pts)
    pix = {ti: k for k, ti in enumerate(pid)}
    ci, pi, uv = [], [], []
    for fr in regs:
        for ti, p in obs.by_frame.get(fr, {}).items():
            if ti in pix:
                ci.append(idx[fr])
                pi.append(pix[ti])
                uv.append(p)
    Rs = np.stack([poses[fr][0] for fr in regs])
    ts = np.zeros((len(regs), 3))
    X = np.stack([pts[ti] for ti in pid])
    Rs, ts, X, f, rms = bundle_adjust(Rs, ts, X, (np.asarray(ci), np.asarray(pi), np.asarray(uv)), f, c,
                                      fixed=(0,), refine_f=refine_f, tripod=True)
    return {"poses": {fr: (Rs[idx[fr]], np.zeros(3)) for fr in regs},
            "pts": {ti: X[pix[ti]] for ti in pid}, "f": f, "rms": rms, "pair": None}


def solve(tracks, w, h, lens=None, focal_px=None, mode="free", refine_focal=None, frames=None,
          progress=None, cancel=None):
    """The camera of a plate from its tracks.

    ``tracks`` as matchmove.clean_tracks gives them (the camera's: group "camera"); ``lens`` the Comp
    LensDistortion numbers; ``focal_px`` the focal length in pixels when known (else it is searched); ``mode``
    free | tripod | auto (free, and tripod when the camera hardly moves). Returns {frames: {f: {R, t}}, focal_px,
    points: [{id, X, error}], rms, per_frame: {f: rms}, mode, notes} or {error, notes}."""
    notes = []
    tracks = [t for t in tracks if (t.get("group") or "camera") == "camera"]
    obs = Obs(tracks, lens, w, h, frames)
    if len(obs.frames) < 2:
        return {"error": "Not enough tracked frames: track the plate first.", "notes": notes}
    cnt = [len(obs.by_frame[fr]) for fr in obs.frames]
    thin = [fr for fr, n in zip(obs.frames, cnt) if n < 8]
    if thin:
        notes.append(f"{len(thin)} frame(s) see fewer than 8 tracks (first: {thin[0]}); the camera may jump there.")
    c = np.array(lens.get("center") if lens and lens.get("center") else [w / 2, h / 2], np.float64)
    keys = _pick_keys(obs.frames)
    known = bool(focal_px)
    refine = (not known) if refine_focal is None else bool(refine_focal)
    stage = {"n": 0}

    def prog(done, total):
        if progress:
            progress("keys", done, total)

    def attempt(fpx, m, kk, ref):
        if m == "tripod":
            return _solve_tripod(obs, kk, fpx, c, ref)
        return _solve_free(obs, kk, fpx, c, ref, progress=prog, cancel=cancel)

    want = mode if mode in ("free", "tripod") else "free"
    if known:
        res = attempt(float(focal_px), want, keys, refine)
    else:
        # the field of view is not known: try a range and refine the best
        coarse = _pick_keys(obs.frames, 16)
        best = None
        for fov in (12, 18, 25, 33, 42, 52, 63, 75, 90):
            fpx = (w / 2) / math.tan(math.radians(fov) / 2)
            r = attempt(fpx, want, coarse, True)
            if progress:
                progress("focal", fov, 90)
            if r and (best is None or r["rms"] < best[1]["rms"]):
                best = (r["f"], r)
            if cancel and cancel():
                return {"error": "stopped", "notes": notes}
        res = attempt(best[0], want, keys, True) if best else None
    if res is None and want == "free":
        if mode == "auto" or mode == "free":
            notes.append("The camera hardly moves (no parallax): solved as a camera that only turns (tripod).")
            if known:
                res = attempt(float(focal_px), "tripod", keys, refine)
            else:
                best = None
                for fov in (12, 18, 25, 33, 42, 52, 63, 75, 90):
                    fpx = (w / 2) / math.tan(math.radians(fov) / 2)
                    r = attempt(fpx, "tripod", keys, True)
                    if r and (best is None or r["rms"] < best["rms"]):
                        best = r
                res = best
            want = "tripod"
    if res is None:
        return {"error": "The solve did not find a camera: add tracks that last longer and spread over the frame.",
                "notes": notes}
    f = res["f"]
    pts, kposes = res["pts"], res["poses"]
    # every frame: a resection from the points, starting from the nearest solved frame
    all_poses = dict(kposes)
    per = {}
    order = sorted(obs.frames, key=lambda fr: min(abs(fr - k) for k in kposes))
    for fr in order:
        if cancel and cancel():
            return {"error": "stopped", "notes": notes}
        seen = [ti for ti in obs.by_frame.get(fr, {}) if ti in pts]
        if len(seen) < (3 if want == "tripod" else 6):
            continue
        X = np.stack([pts[ti] for ti in seen])
        uv = np.stack([obs.by_frame[fr][ti] for ti in seen])
        near = min(all_poses, key=lambda k: abs(k - fr))
        got = resect(X, uv, f, c, guess=all_poses[near], rotation_only=want == "tripod")
        if got is None:
            continue
        all_poses[fr] = (got[0], got[1])
        per[fr] = round(got[2], 4)
    missing = [fr for fr in obs.frames if fr not in all_poses]
    if missing:
        notes.append(f"{len(missing)} frame(s) could not be solved (first: {missing[0]}).")
    # the world: the first solved frame's camera at the origin; scale = the points' median distance from it is 10
    f0 = min(all_poses)
    R0, t0 = all_poses[f0]
    if want == "tripod":
        s = 10.0
    else:
        C0 = -R0.T @ t0
        d = [np.linalg.norm(X - C0) for X in pts.values()]
        s = 10.0 / (float(np.median(d)) or 1.0)
    frames_out = {}
    for fr, (R, t) in sorted(all_poses.items()):
        # X_world = R0' (X_old ... ) : re-base so that frame f0's camera is the identity
        Rn = R @ R0.T
        tn = (t - Rn @ t0) * s
        frames_out[int(fr)] = {"R": Rn.round(9).tolist(), "t": tn.round(6).tolist()}
    points = []
    for ti, X in pts.items():
        Xn = (R0 @ X + t0) * s if want != "tripod" else (R0 @ X) * s
        errs = []
        for fr, p in obs.by_frame.items():
            if ti in p and fr in all_poses:
                R, t = all_poses[fr]
                pc = R @ X + t
                if pc[2] > 0:
                    errs.append(float(np.hypot(*(f * pc[:2] / pc[2] + c - p[ti]))))
        points.append({"id": obs.tracks[ti]["id"], "X": Xn.round(6).tolist(),
                       "error": round(float(np.sqrt(np.mean(np.square(errs)))) if errs else 0.0, 4)})
    allerr = [p["error"] for p in points]
    rms = float(np.sqrt(np.mean(np.square(list(per.values()))))) if per else res["rms"]
    if rms > 1.5:
        notes.append(f"The solve's error is {rms:.2f} px: delete the worst tracks (the list is sorted) and solve again.")
    fov_h = 2 * math.degrees(math.atan(w / 2 / f))
    return {"frames": frames_out, "focal_px": round(f, 4), "fov_h": round(fov_h, 4),
            "fov_v": round(2 * math.degrees(math.atan(h / 2 / f)), 4), "center": c.round(4).tolist(),
            "points": points, "rms": round(rms, 4), "per_frame": per, "mode": want,
            "key_frames": len(kposes), "notes": notes, "used_tracks": len(pts),
            "worst": sorted(points, key=lambda p: -p["error"])[:20] if allerr else []}


def solve_object(tracks, obj_id, camera, w, h, lens=None, scale=None, progress=None, cancel=None):
    """An object's motion: its tracks (group = obj_id) solved as if the camera moved round a still object, then
    put into the world through the solved camera. ``camera`` is solve()'s answer. ``scale`` is the object's size
    against the world's (None: its points at the depth of the scene's points behind them). Returns {frames:
    {f: {R, t}} (object -> world), points: [{id, X (object space)}], rms, notes}."""
    notes = []
    mine = [t for t in tracks if t.get("group") == obj_id]
    if len(mine) < 6:
        return {"error": "An object needs 6 or more tracks on it.", "notes": notes}
    f = float(camera["focal_px"])
    obs = Obs(mine, lens, w, h)
    keys = _pick_keys(obs.frames)
    c = np.array(camera.get("center") or [w / 2, h / 2], np.float64)
    res = _solve_free(obs, keys, f, c, False, cancel=cancel)
    if res is None:
        return {"error": "The object did not solve: it needs tracks that last and that see it turn or move in depth.",
                "notes": notes}
    pts = res["pts"]
    poses = dict(res["poses"])
    for fr in obs.frames:
        if fr in poses:
            continue
        seen = [ti for ti in obs.by_frame.get(fr, {}) if ti in pts]
        if len(seen) < 6:
            continue
        near = min(poses, key=lambda k: abs(k - fr))
        got = resect(np.stack([pts[ti] for ti in seen]), np.stack([obs.by_frame[fr][ti] for ti in seen]), f, c,
                     guess=poses[near])
        if got is not None:
            poses[fr] = (got[0], got[1])
    cams = {int(k): (np.asarray(v["R"]), np.asarray(v["t"])) for k, v in camera["frames"].items()}
    both = [fr for fr in sorted(poses) if fr in cams]
    if not both:
        return {"error": "The object's frames have no solved camera.", "notes": notes}
    # how big: the object's points at the depth of the scene's points that are near them on the picture
    if scale is None:
        f0 = both[0]
        Ra, ta = poses[f0]
        depth_obj = float(np.median([(Ra @ X + ta)[2] for X in pts.values()]))
        Rc, tc = cams[f0]
        uvs = np.asarray([obs.by_frame[f0][ti] for ti in pts if ti in obs.by_frame.get(f0, {})])
        depth_scene = None
        if len(uvs) and camera.get("points"):
            lo, hi = uvs.min(0), uvs.max(0)
            pad = (hi - lo) * 0.5 + 20
            ds = []
            for p in camera["points"]:
                pc = Rc @ np.asarray(p["X"]) + tc
                if pc[2] <= 0:
                    continue
                q = f * pc[:2] / pc[2] + c
                if (q >= lo - pad).all() and (q <= hi + pad).all():
                    ds.append(pc[2])
            if ds:
                depth_scene = float(np.median(ds))
        if depth_scene is None:
            depth_scene = 10.0
            notes.append("No scene points near the object: its distance is a guess - set its scale.")
        scale = depth_scene / (depth_obj or 1)
    s = float(scale)
    frames_out = {}
    for fr in both:
        Ra, ta = poses[fr]
        Rc, tc = cams[fr]
        Ro = Rc.T @ Ra
        to = Rc.T @ (s * ta - tc)
        frames_out[int(fr)] = {"R": Ro.round(9).tolist(), "t": to.round(6).tolist()}
    points = [{"id": obs.tracks[ti]["id"], "X": (X * s).round(6).tolist()} for ti, X in pts.items()]
    return {"frames": frames_out, "points": points, "rms": round(res["rms"], 4), "scale": round(s, 6),
            "notes": notes}
