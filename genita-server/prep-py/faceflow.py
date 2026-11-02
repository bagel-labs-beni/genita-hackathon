#!/usr/bin/env python3
"""Face-set flow prep (Genita "B": full-face Muse keys + classical optical-flow morph).

Classical computer vision only (no ML): ECC affine registration, feathered lower-face composite with a
low-frequency colour match, OpenCV DIS dense optical flow (both directions), float16 export.

  faceflow.py --neutral neutral.webp --keys MBP=MBP.webp,AH=AH.webp,... --face x1,y1,x2,y2
              --mouth x1,y1,x2,y2 [--nose x1,y1,x2,y2] --kind human|animal|character --out DIR

Writes into DIR:  <key>.jpg (ROI crop at the face set's resolution, composited onto neutral inside the
mask), <key>.nk.f16 / <key>.kn.f16 (LE float16, interleaved dx,dy, row-major, flowSize w x h; vectors
in ROI pixels at `size` scale; src(x) ~ dst(x + f(x)); nk = neutral->key), mask.png (ROI, 8-bit:
lower-face ellipse x below-subnasale ramp = blend AND lock mask), flow.json (manifest `flow` block).
Above the subnasale line the mask, every flow and every key are exactly neutral (nose/eyes locked).
"""
import argparse, json, os, sys, time
import cv2
import numpy as np

WORK_H = 960          # flow / registration working height
RAMP_PX = 8           # lock ramp below the subnasale line, at WORK_H
FLOW_SCALE = 0.5      # stored flow grid vs working ROI

# How a LipTimeline frame maps onto keys (runtime reads this; reference: the prototype runtime render.py).
# 11/3 sweep winner (critic-ranked against the old lip-sync baseline; sweep s21 + snap blink):
# vowel keys as the backbone, stability from timing: MMS phoneme timings, lookahead 40 ms, slew 0.25/frame,
# MBP fully closed >= 2 frames, jaw-open floor 0.6 between syllables, snap dissolve (no cross-dissolve
# between vowels), focus 6, no yawn-sized A for humans. Keys a set lacks resolve through `fallback`.
BASE_MAP = {
    'ladder': {'viseme': 'A', 'steps': [['MID', 0.0], ['AH', 0.2], ['AH2', 0.45]], 'gain': [0.8, 0.4]},
    'mix': {'O': {'keys': [['OH', 0.6], ['O', 0.4]], 'gain': [0.75, 0.5]},
            'EI': {'keys': [['EH', 0.5], ['EI', 0.5]], 'gain': [0.75, 0.5]}},
    'consonant': {'MBP': 1.0, 'FV': 0.9, 'TH': 0.85, 'L': 0.9, 'WQ': 0.8, 'U': 0.9, 'CDG': 0.9},
    'consonantJaw': {'key': 'MID', 'from': 0.3, 'gain': 0.8},
    'fallback': {'TH': 'CDG', 'L': 'CDG', 'U': 'OH', 'WQ': 'O', 'FV': 'MBP', 'CDG': 'MID', 'AH': 'A', 'AH2': 'A',
                 'MID': 'CDG', 'EH': 'EI', 'OH': 'O', 'O': 'OH', 'EI': 'EH', 'A': 'AH2'},
    'smoothing': {'fps': 25, 'attack': 0.75, 'release': 0.5},
    'slew': 0.25,                 # max change of one key amount per frame
    'instantKeys': ['MBP'],       # attack 1 (closures land on the frame)
    'holdFrames': {'MBP': 2},     # a closure stays fully closed at least this long
    'focus': 6.0,                 # winner-take-most across keys (total kept)
    'gain': 1.3,                  # vowel amount scale (baseline-like opening)
    'lookaheadMs': 40,            # mouth leads the sound
    'dissolve': {'mode': 'snap', 'ms': 40, 'minAmount': 0.3},  # one texture at a time, 1-frame switch (no grey teeth)
    'colourEdge': 0.35,           # only for mode 'smooth'
    # coarticulation: a frame whose dominant shape is a consonant other than MBP/FV keeps `share` of the
    # neighbouring vowel frames' key amounts (linear between the nearest vowel frames within windowMs)
    'jawFloor': {'share': 0.6, 'windowMs': 160, 'vowels': ['A', 'O', 'EI', 'U'], 'closed': ['MBP', 'FV', 'rest']},
    'blink': {'mode': 'snap', 'frames': 3, 'perTenSeconds': 5},  # eyes fully closed for 3 frames, no half frames
    # optional per-key cap applied LAST (after focus, which would otherwise restore it); remainder -> neutral.
    'maxAmount': {'AH2': 0.85},
    # --- v16 (critic 8.5/10 vs the old lip-sync baseline; prototype runtime flags row v16) ---
    # key colour only inside files[k].lip (lips + opening hull, prep-baked); outside it the neutral texture,
    # warped by the same output->neutral flow GN (skin / beard / wrinkles never pop between keys)
    'lipMask': True,
    # cheeks / nasolabial follow the mouth corners: corner displacement d = -GN(corner); V = sum over sides of
    # w_cheek * (spread * d[t - delayFrames] + (0, -lift * (EH + EI amounts))) - w_corner * pull * d; out(p) = frame(p - V(p))
    'cheek': {'spread': 0.8, 'pull': 0.0, 'cheek': 1.3, 'naso': 0.4, 'lift': 3.0, 'delayFrames': 1, 'cornerRef': 3.36,
              'roundNoInward': ['O', 'OH', 'U', 'WQ']},
    'consonantOverride': {'U': 0.55, 'WQ': 0.55},
    'brow': {'px': 2.5}, 'nod': {'px': 5.0, 'width': 2.0}, 'stress': {'topShare': 0.3, 'minGapMs': 450, 'leadMs': 80},
    # whole-face life (v41): head drift / roll multipliers on the alive base, stress nods
    'alive': {'headX': 3.0, 'headRoll': 1.5, 'nodPx': 5.0, 'nodWidth': 2.0, 'browPx': 2.5},
}
PROFILE = {
    'human': {},
    # per-category overrides (merged over BASE_MAP); the non-human lane owns animal / character3d / character2d
    'animal': {'gain': 1.0, 'ladder': {'viseme': 'A', 'steps': [['MID', 0.0], ['AH', 0.25], ['AH2', 0.55]], 'gain': [0.8, 0.4]}},
    'character': {'gain': 1.2, 'ladder': {'viseme': 'A', 'steps': [['MID', 0.0], ['AH', 0.2], ['AH2', 0.45]], 'gain': [0.8, 0.4]}},
}
PROFILE['character3d'] = PROFILE['character']
PROFILE['character2d'] = PROFILE['character']


# Non-human lane profiles (animal / cat_override / character3d / character2d): keys, Muse prompts, prep and
# runtime fields. Runtime fields merge over BASE_MAP; `prep` drives this script; `prompts` are read by prep/face.ts.
PROFILES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'profiles.json')
NON_MAP = {'keys', 'prompts', 'prep', '_v8', '_when', '_fields', '_note'}


def profiles():
    try:
        return json.load(open(PROFILES_PATH))
    except (OSError, ValueError):
        return {}


def deep_merge(a, b):
    """b over a; nested dicts merge key by key (codex P2: cat's `jaw` must keep animal's `floor`)."""
    out = json.loads(json.dumps(a))
    for k, v in b.items():
        out[k] = deep_merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else json.loads(json.dumps(v))
    return out


def profile_of(name):
    """Merged profile dict for human | animal | cat | character3d | character2d (cat = animal + cat_override)."""
    P = profiles()
    if name == 'cat':
        return deep_merge(P.get('animal', {}), P.get('cat_override', {}))
    if name == 'toy':
        return deep_merge(P.get('character3d', {}), P.get('toy_override', {}))
    return json.loads(json.dumps(P.get(name, {})))


def lip_map(kind):
    m = json.loads(json.dumps(BASE_MAP))
    m.update(json.loads(json.dumps(PROFILE.get(kind, {}))))
    if kind != 'human':
        m.update({k: v for k, v in profile_of(kind).items() if k not in NON_MAP and not k.startswith('_')})
    mo = profiles().get('motion', {})
    if isinstance(mo, dict):
        mk = kind if kind in mo else {'cat': 'animal', 'toy': 'character3d', 'character': 'character3d'}.get(kind)
        if mk in mo:
            m['motion'] = {k: v for k, v in mo[mk].items() if not k.startswith('_')}   # v2 runtime coefficients (prototype names)
            if 'motionV2' not in m and isinstance(m['motion'].get('motionV2'), dict):
                m['motionV2'] = m['motion']['motionV2']                                # the block GenitaKit reads (#267)
    # cheek field names: the app reads cheekW / nasoW; keep cheek / naso for older readers
    ch = m.get('cheek')
    if isinstance(ch, dict):
        if 'cheekW' not in ch and 'cheek' in ch: ch['cheekW'] = ch['cheek']
        if 'nasoW' not in ch and 'naso' in ch: ch['nasoW'] = ch['naso']
        if 'cheek' not in ch and 'cheekW' in ch: ch['cheek'] = ch['cheekW']
        if 'naso' not in ch and 'nasoW' in ch: ch['naso'] = ch['nasoW']
    if kind == 'human':
        # lip rig (v41, critic 8.5, blind ~5:5): cross-blended lips + slow chin channel + opaque teeth layer from the top key
        m['rig'] = {'chinLpHz': 2.0, 'chinGain': 0.3, 'chinRamp': [0.035, 0.03], 'blendFloor': [0.04, 0.16],
                    'teethTop': {'hyst': 0.05, 'min': 0.08, 'alpha': [0.06, 0.12], 'fade': [0.1, 0.3], 'cavity': [52, 28, 30]},
                    'lipFlowPx': 1.2, 'lipFlowSigma': 0.012, 'lipTex': 0.15}
    m['profile'] = kind
    return m


# Human colour-only post (critic 11/3: v7 + this = 7.5/10 vs the old baseline): same transform on every key and the neutral
# ROI, so it never flickers. Lifts grey teeth inside the lip hull, pulls the lips toward the photo's pink.
COLORFIX = {'human': (1.15, 0.88, 1.0)}
LIP_MATCH = True   # key lips take the neutral's lip colour (all skin tones)
LOWER_V = 1.0    # lower-half darkening (0.85) measured worse (critic v13 7.0 < v12 7.5): openings read bigger; off


def lips_lab_mask(img, mouth_px):
    """Lips = redder (Lab a*) than the skin in the mouth box; robust across skin tones."""
    lab = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    bx1, by1, bx2, by2 = mouth_px
    mw, mh = bx2 - bx1, max(1, by2 - by1)
    box = np.zeros(lab.shape[:2], np.uint8)
    box[max(0, by1 - mh):by2 + max(3 * mh, int(0.4 * mw)), max(0, bx1 - mw // 6):bx2 + mw // 6] = 1   # open keys: lower lip far below
    if not box.any():
        return lab, box.astype(np.float32)
    skin_a = np.median(lab[..., 1][box > 0])
    return lab, (((lab[..., 1] > skin_a + 6) & (box > 0)).astype(np.float32))


def lip_match(key, neutral, mouth_px):
    """Move the key's lip colour (L*, a*, b* means) onto the neutral's lips, so a key never changes lip colour
    (critic 11/3: dark-skin open keys turned the lower lip lighter and redder)."""
    lk, mk = lips_lab_mask(key, mouth_px)
    ln, mn = lips_lab_mask(neutral, mouth_px)
    if mk.sum() < 20 or mn.sum() < 20:
        return key
    d = ln[mn > 0].mean(0) - lk[mk > 0].mean(0)
    m = cv2.GaussianBlur(mk, (0, 0), 1.5)[..., None]
    out = np.clip(lk + d[None, None, :] * m, 0, 255).astype(np.uint8)
    return cv2.cvtColor(out, cv2.COLOR_LAB2BGR).astype(np.float32)


def lip_hull_mask(img, mouth_px, dilate_px):
    """Lips + mouth opening of a key (ROI): the two largest redder-than-skin blobs in the mouth box, convex hull,
    dilated `dilate_px` above the hull's middle and half that below (beard: no bare-skin band), feathered."""
    lab, lips = lips_lab_mask(img, mouth_px)
    lb = (lips > 0).astype(np.uint8)
    n, lab_, st, _ = cv2.connectedComponentsWithStats(lb)
    keep = np.zeros_like(lb)
    if n > 1:
        order = np.argsort(-st[1:, cv2.CC_STAT_AREA])[:2] + 1
        for c in order:
            if st[c, cv2.CC_STAT_AREA] > 0.2 * st[order[0], cv2.CC_STAT_AREA]:
                keep[lab_ == c] = 1
    hull = np.zeros_like(keep)
    cs, _ = cv2.findContours(keep, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cs:
        cv2.fillConvexPoly(hull, cv2.convexHull(np.vstack(cs)), 1)
    if len(cs) < 2:
        # no or only one lip found (grey photo, pale lower lip): the mouth box ellipse reaching down, so the key's
        # opening still shows (codex P2 x2). With one lip found, only the ellipse's dark (opening) pixels are added,
        # so skin below the mouth keeps the neutral's texture.
        bx1, by1, bx2, by2 = [int(v) for v in mouth_px]
        mh_ = max(1, by2 - by1)   # the key's jaw may be lowered by more than the closed mouth's height
        el = np.zeros_like(hull)
        cv2.ellipse(el, ((bx1 + bx2) // 2, (by1 + by2) // 2 + mh_), (max(1, (bx2 - bx1) // 2), max(1, 2 * mh_)), 0, 0, 360, 1, -1)
        if cs:
            L_ = lab[..., 0]; lipL_ = float(np.median(L_[keep > 0]))
            hs_ = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_BGR2HSV)
            teeth_ = (hs_[..., 1] < 0.35 * 255) & (L_ > lipL_ + 10)
            el = el * ((L_ < lipL_ - 15) | teeth_).astype(np.uint8)        # the opening: dark cavity or teeth (codex P2)
            el = cv2.morphologyEx(el, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
        hull = np.maximum(hull, el)
    d = max(1, int(dilate_px)); dl = max(1, d // 2)
    up = cv2.dilate(hull, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * d + 1, 2 * d + 1)))
    lo = cv2.dilate(hull, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dl + 1, 2 * dl + 1)))
    ys = np.where(hull.any(1))[0]
    if len(ys):
        mid = int((ys.min() + ys.max()) / 2)
        up[mid:] = lo[mid:]
    return cv2.GaussianBlur(up.astype(np.float32), (0, 0), max(1.0, 0.6 * d))


# Mouth interior tone (critic 11/3, sweep v25/v26: 7.5 -> 8.5 vs the reference): the Muse open keys show grey teeth and
# a grey cavity. Inside each key's lip hull (lips excluded), the upper 60 % low-saturation teeth lift halfway to white
# (a band 70 % of the hull width, dimmer off-centre), everything else in the opening becomes a warm dark maroon with a
# faint tongue tone in the lower third. Colour only; no geometry. Teeth white scales with skin lightness.
INTERIOR = {'human': {'lift': 0.65, 'vlo': 105, 'vhi': 240, 'split': 0.6, 'band': 0.7, 'mix': 1.0, 'greyDark': 0.5}}


def interior_tone(img, mouth_px, spec, scale, neutral=None):
    lab, lips = lips_lab_mask(img, mouth_px)
    lb = (lips > 0).astype(np.uint8)
    n, lab_, st, _ = cv2.connectedComponentsWithStats(lb)
    keep = np.zeros_like(lb)
    if n > 1:
        order = np.argsort(-st[1:, cv2.CC_STAT_AREA])[:2] + 1
        for c in order:
            if st[c, cv2.CC_STAT_AREA] > 0.2 * st[order[0], cv2.CC_STAT_AREA]:
                keep[lab_ == c] = 1
    cs, _ = cv2.findContours(keep, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cs:
        return img
    hull = np.zeros_like(keep)
    cv2.fillConvexPoly(hull, cv2.convexHull(np.vstack(cs)), 1)
    k3 = np.ones((max(3, int(round(3 * scale)) | 1),) * 2, np.uint8)
    inn = (cv2.erode(hull, k3) * (1 - cv2.dilate(keep, k3))).astype(np.float32)
    # never on lip-coloured skin: a big lip hull can cover part of the lower lip (critic: dark tick on darkskin / woman)
    bx1, by1, bx2, by2 = mouth_px
    mw_, mh_ = bx2 - bx1, max(1, by2 - by1)
    box = np.zeros(inn.shape, bool); box[max(0, by1 - mh_):by2 + 3 * mh_, max(0, bx1 - mw_ // 6):bx2 + mw_ // 6] = True
    skin_a = float(np.median(lab[..., 1][box])) if box.any() else 128.0
    lipL = float(np.median(lab[..., 0][keep > 0]))
    hsv0 = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_BGR2HSV)
    lipish = (lab[..., 1] > skin_a + 6) & (hsv0[..., 1] > 0.2 * 255) & (lab[..., 0] > 0.7 * lipL)
    inn = inn * (1 - lipish).astype(np.float32)
    # the opening is one big region between the lips; small islands are lip patches the lip mask missed (darkskin tick).
    # an opening cuts thin bridges first, so a patch hanging off the opening by a few pixels becomes its own island
    inn = cv2.morphologyEx(inn, cv2.MORPH_OPEN, k3)
    n_, lab2, st2, _ = cv2.connectedComponentsWithStats((inn > 0).astype(np.uint8))
    if n_ > 2:
        big = st2[1:, cv2.CC_STAT_AREA].max()
        inn = inn * np.isin(lab2, [c for c in range(1, n_) if st2[c, cv2.CC_STAT_AREA] >= 0.3 * big]).astype(np.float32)
    # recolouring below touches only low-saturation pixels (teeth / grey film), never coloured lip or skin
    hsv1 = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
    lipV = float(np.median(hsv1[..., 2][keep > 0]))
    inn = cv2.GaussianBlur(inn, (0, 0), max(1.0, 1.0 * scale)) * (inn > 0)
    ys, xs = np.where(inn > 0.05)
    if len(ys) < 10:
        return img
    H, W = inn.shape
    fe = max(0.8, 0.8 * scale)
    hsv = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_BGR2HSV).astype(np.float32)
    S, V = hsv[..., 1] / 255, hsv[..., 2]
    skinL = np.median(lab[max(0, by1 - (by2 - by1)):max(1, by1), max(0, bx1):max(1, bx2), 0]) if by1 > 0 else 170
    vhi = spec['vhi'] - 40 * (1 - float(np.clip(skinL / 170.0, 0.3, 1.0)))       # darker skin: less glaring white
    # teeth threshold relative to this key: top 30 % of the low-saturation interior (dim teeth on older / glasses faces)
    cand = V[(inn > 0) & (S < 0.42)]
    vlo = float(np.clip(min(spec['vlo'], np.percentile(cand, 70)) if len(cand) > 20 else spec['vlo'], 60, spec['vlo']))
    # teeth area 10-40 % of the opening (older: no white paint over everything; glasses: some teeth at all)
    vin = V[inn > 0]; sin_ = S[inn > 0]
    if len(vin) > 30:
        frac = lambda t: float(((vin > t) & (sin_ < 0.42)).mean())
        if frac(vlo) > 0.4: vlo = float(np.percentile(vin, 60))
        elif frac(vlo) < 0.1: vlo = max(60.0, float(np.percentile(vin, 90)))
    r = ((np.arange(H, dtype=np.float32) - ys.min()) / max(1, ys.max() - ys.min()))[:, None]
    up = np.clip((spec['split'] - r) / 0.15, 0, 1)
    cx, hw = (xs.min() + xs.max()) / 2, max(1, (xs.max() - xs.min()) / 2)
    dx = (np.abs(np.arange(W, dtype=np.float32) - cx) / hw)[None, :]
    band = np.clip((spec['band'] - dx) / 0.1, 0, 1) * (1 - 0.45 * np.clip(dx / spec['band'], 0, 1))
    th = np.clip((0.38 - S) / 0.1, 0, 1) * np.clip((V - vlo) / 12, 0, 1) * inn
    th = np.maximum(th, band * np.clip((0.42 - S) / 0.1, 0, 1) * np.clip((V - (vlo - 15)) / 12, 0, 1) * inn) * up
    th = cv2.GaussianBlur(th, (0, 0), fe)
    hsv[..., 2] = np.clip(V + (vhi - V) * spec['lift'] * th, 0, 255)
    hsv[..., 1] = np.clip(hsv[..., 1] * (1 - 0.4 * th), 0, 255)
    out = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32)
    # every darkening below only where the key CHANGED vs the neutral (Lab distance): lips and skin that are still the
    # neutral's (incl. dark / low-saturation lips the lip mask missed) are never touched (critic darkskin, codex P2)
    if neutral is not None:
        labn = cv2.cvtColor(np.clip(neutral, 0, 255).astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
        chg = np.clip((np.linalg.norm(lab - labn, axis=2) - 12) / 10, 0, 1)
    else:
        chg = np.ones(inn.shape, np.float32)
    notc = 1 - np.clip(th * 1.5, 0, 1)
    # the real opening = dark cavity or tooth pixels, in the components that cross the middle of the mouth; a patch on the
    # lower lip (not dark, not a tooth, or off to the side on its own) is outside it (critic darkskin)
    core = ((inn > 0.05) & ((V < 0.75 * lipV) | ((S < 0.35) & (V > 0.9 * lipV) & (up > 0.5)))).astype(np.uint8)
    nc_, lc_, stc_, _ = cv2.connectedComponentsWithStats(core)
    mid0, mid1 = int(cx - 0.4 * hw), int(cx + 0.4 * hw)
    keepc = [c for c in range(1, nc_) if stc_[c, cv2.CC_STAT_LEFT] <= mid1 and stc_[c, cv2.CC_STAT_LEFT] + stc_[c, cv2.CC_STAT_WIDTH] >= mid0]
    core = np.isin(lc_, keepc).astype(np.uint8) if keepc else np.zeros_like(core)
    near = cv2.dilate(core, np.ones((5, 5), np.uint8)).astype(np.float32)
    chg = chg * near
    lows = np.clip((0.3 - S) / 0.1, 0, 1)                    # low saturation only: coloured lip / tongue keep their colour
    # grey film -> warm and darker. Upper part: not the bright teeth (V cap); lower part (lower teeth, film): all of it
    vcap = np.clip((vlo + 10 - V) / 20, 0, 1)
    vcap2 = np.clip((min(vlo + 50, 200) - V) / 20, 0, 1)      # lower part: never a bright lip highlight (specular, low-sat)
    grey = lows * np.clip((V - 0.35 * lipV) / 15, 0, 1) * (up * vcap + (1 - up) * vcap2)
    g = cv2.GaussianBlur(inn * chg * grey * notc, (0, 0), fe)[..., None] * spec['mix']
    dark = out * spec.get('greyDark', 0.62) * np.array([0.85, 0.85, 1.08], np.float32)
    out = out * (1 - g) + dark * g
    # tongue shadow: the lower third of the opening x .7, changed pixels only
    low3 = cv2.GaussianBlur(inn * chg * np.clip((r - 0.62) / 0.15, 0, 1), (0, 0), fe)[..., None]
    return out * (1 - 0.3 * low3)


def interior_mask(img, mouth_px, scale):
    """Mouth interior of a key (lip rig teeth layer, v41): lip hull minus the lips, 1 px grown, 1 px feather (0..1)."""
    lab, lips = lips_lab_mask(img, mouth_px)
    lb = (lips > 0).astype(np.uint8)
    n, lab_, st, _ = cv2.connectedComponentsWithStats(lb)
    keep = np.zeros_like(lb)
    if n > 1:
        order = np.argsort(-st[1:, cv2.CC_STAT_AREA])[:2] + 1
        for c in order:
            if st[c, cv2.CC_STAT_AREA] > 0.2 * st[order[0], cv2.CC_STAT_AREA]:
                keep[lab_ == c] = 1
    cs, _ = cv2.findContours(keep, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull = np.zeros_like(keep)
    k3 = np.ones((max(3, int(round(3 * scale)) | 1),) * 2, np.uint8)
    if cs:
        cv2.fillConvexPoly(hull, cv2.convexHull(np.vstack(cs)), 1)
        inn = cv2.erode(hull, k3) * (1 - cv2.dilate(keep, k3))
    else:
        # no red lips (grey photo): the lowered mouth-box ellipse, only its dark (cavity) or bright near-grey (tooth) pixels (codex P2)
        bx1, by1, bx2, by2 = [int(v) for v in mouth_px]
        mh_ = max(1, by2 - by1)
        cv2.ellipse(hull, ((bx1 + bx2) // 2, (by1 + by2) // 2 + mh_), (max(1, (bx2 - bx1) // 2), max(1, 2 * mh_)), 0, 0, 360, 1, -1)
        L_ = lab[..., 0]; Lm = float(np.median(L_[hull > 0])) if hull.any() else 128.0
        hs_ = cv2.cvtColor(np.clip(img, 0, 255).astype(np.uint8), cv2.COLOR_BGR2HSV)
        inn = hull * ((L_ < 0.6 * Lm) | ((hs_[..., 1] < 0.25 * 255) & (L_ > Lm + 15))).astype(np.uint8)
    inn = cv2.dilate(inn, k3).astype(np.float32)
    return cv2.GaussianBlur(inn, (0, 0), max(1.0, scale))


def colorfix(img, mouth_px, spec):
    tg, ls, lv = spec
    u8 = np.clip(img, 0, 255).astype(np.uint8)
    # teeth lift scales with skin lightness (dark skin: bright-white teeth read as pasted on)
    bx1_, by1_, bx2_, by2_ = mouth_px
    skinL = np.median(cv2.cvtColor(u8, cv2.COLOR_BGR2LAB)[max(0, by1_ - (by2_ - by1_)):max(1, by1_), max(0, bx1_):max(1, bx2_), 0]) if by1_ > 0 else 170
    tg = 1 + (tg - 1) * float(np.clip(skinL / 170.0, 0.3, 1.0))
    hsv = cv2.cvtColor(u8, cv2.COLOR_BGR2HSV).astype(np.float32)
    H_, S_, V_ = hsv[..., 0], hsv[..., 1] / 255, hsv[..., 2]
    bx1, by1, bx2, by2 = mouth_px
    mw = bx2 - bx1
    pad = max(2, int(0.05 * mw))
    mb = np.zeros(V_.shape, np.float32)
    mb[max(0, by1 - pad):by2 + 4 * pad, max(0, bx1 - pad):bx2 + pad] = 1
    mb = cv2.GaussianBlur(mb, (0, 0), max(1.0, 0.02 * mw))
    lips = (((H_ < 12) | (H_ > 160)) & (S_ > 0.22) & (V_ > 80)).astype(np.float32) * mb
    lb = (lips > 0.5).astype(np.uint8)
    cs, _ = cv2.findContours(lb, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    hull = np.zeros_like(lb)
    if cs:
        cs = sorted(cs, key=cv2.contourArea, reverse=True)[:2]
        cs = [c for c in cs if cv2.contourArea(c) > 0.25 * cv2.contourArea(cs[0])]
        cv2.fillConvexPoly(hull, cv2.convexHull(np.vstack(cs)), 1)
    tight = np.zeros_like(lb)
    tight[max(0, by1 + pad):by2 + pad, max(0, bx1 + 2 * pad):bx2 - 2 * pad] = 1
    k = max(3, int(0.03 * mw) | 1)
    inner = cv2.erode(hull, np.ones((k, k), np.uint8)) * (1 - cv2.dilate(lb, np.ones((3, 3), np.uint8))) * tight
    grey = ((S_ < 0.30) & (V_ > 105)).astype(np.float32) * inner
    # upper half of the mouth opening = upper teeth: lift; lower half (lower teeth / tongue film): darken (critic 11/3)
    rows = np.where(inner.any(1))[0]
    upper = np.zeros_like(grey)
    if len(rows):
        mid = int((rows.min() + rows.max()) / 2)
        upper[:mid + 1] = 1
    teeth = cv2.GaussianBlur(grey * (upper if LOWER_V < 1 else 1.0), (0, 0), 0.8)   # v12: lift the whole opening
    lower = cv2.GaussianBlur(grey * (1 - upper), (0, 0), 0.8)
    lips = cv2.GaussianBlur(lips, (0, 0), 1.5)
    hsv[..., 2] = np.clip(V_ * (1 + (tg - 1) * teeth) * (1 - (1 - LOWER_V) * lower) * (1 + (lv - 1) * lips), 0, 255)
    hsv[..., 1] = np.clip(S_ * (1 - 0.5 * teeth) * (1 + (ls - 1) * lips) * 255, 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR).astype(np.float32)


# Mask shape per kind: ellipse radii as a fraction of the face box, centre below the mouth.
DIFF_MASK = {'character2d': (1.05, 0.10, 0.03, 28)}   # 2D: limit ellipse (x mouth width), dilation, feather, threshold
SHAPE = {'human': (0.40, 0.30, 0.08), 'animal': (0.30, 0.42, 0.14), 'cat': (0.30, 0.42, 0.14), 'character': (0.36, 0.30, 0.08),
         'character3d': (0.36, 0.30, 0.08), 'character2d': (0.36, 0.30, 0.08), 'toy': (0.36, 0.30, 0.08)}


def feature_init(gN, gK, reg):
    """Similarity neutral->key from ORB matches in the registration region (identity if too few). Muse sometimes
    re-frames a key (zoom .93-.96, shift 40-64 px on a plush toy); ECC from identity then lands on a wrong solution."""
    orb = cv2.ORB_create(1500)
    a, b = gN.astype(np.uint8), gK.astype(np.uint8)
    ka, da = orb.detectAndCompute(a, reg)
    kb, db = orb.detectAndCompute(b, None)
    I = np.eye(2, 3, dtype=np.float32)
    if da is None or db is None or len(ka) < 12 or len(kb) < 12:
        return I
    m = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(da, db)
    if len(m) < 12:
        return I
    pa = np.float32([ka[x.queryIdx].pt for x in m]); pb = np.float32([kb[x.trainIdx].pt for x in m])
    A, inl = cv2.estimateAffinePartial2D(pa, pb, method=cv2.RANSAC, ransacReprojThreshold=3.0)
    if A is None or inl is None or inl.sum() < 10:
        return I
    return A.astype(np.float32)


def sane(Wm, w, h):
    sc = np.sqrt(abs(np.linalg.det(Wm[:, :2])))
    return 0.8 < sc < 1.25 and abs(Wm[0, 2]) < 0.2 * w and abs(Wm[1, 2]) < 0.2 * h


def box(s):
    return [float(v) for v in s.split(',')] if s else None


def lock_line(face, mouth, nose):
    """Normalised y of the subnasale (nose base): SAM nose box bottom, else the upper-lip top minus 6.5%
    of the face height (T9 human, dog and clay: within 0.002 of the SAM / hand-measured nose base).
    Never below the upper lip, never more than 12% of the face above it."""
    fh = face[3] - face[1]
    est = mouth[1] - 0.065 * fh
    if nose and mouth[1] - 0.12 * fh < nose[3] < mouth[1]:
        return float(nose[3]), 'sam'
    return est, 'face-geometry'


def build_mask(h, w, face, mouth, lock_y, kind, scale):
    """Float mask at (h, w): feathered lower-face ellipse x vertical lock ramp (0 above lock_y)."""
    rx, ry, dy = SHAPE.get(kind, SHAPE['human'])
    fw, fh = (face[2] - face[0]) * w, (face[3] - face[1]) * h
    cx, cy = (mouth[0] + mouth[2]) / 2 * w, (mouth[1] + mouth[3]) / 2 * h + dy * fh
    m = np.zeros((h, w), np.float32)
    cv2.ellipse(m, (int(cx), int(cy)), (int(rx * fw), int(ry * fh)), 0, 0, 360, 1.0, -1)
    m = cv2.GaussianBlur(m, (0, 0), max(1.0, 0.05 * fw))
    ys = (np.arange(h, dtype=np.float32) + 0.5)[:, None]
    ly, ramp = lock_y * h, RAMP_PX / scale
    t = np.clip((ys - ly) / ramp, 0, 1)
    m *= t * t * (3 - 2 * t)
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--neutral', required=True)
    ap.add_argument('--keys', required=True, help='NAME=path,...')
    ap.add_argument('--face', required=True)
    ap.add_argument('--mouth', required=True)
    ap.add_argument('--nose')
    ap.add_argument('--kind', default='human', help='profile: human | animal | cat | character3d | character2d | toy (character = character3d)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--jpeg', type=int, default=90)
    a = ap.parse_args()
    t0 = time.time()
    kind = 'character3d' if a.kind == 'character' else a.kind
    prof = profile_of(kind) if kind != 'human' else {}
    prep = prof.get('prep') or {}
    os.makedirs(a.out, exist_ok=True)
    face, mouth, nose = box(a.face), box(a.mouth), box(a.nose)
    N = cv2.imread(a.neutral, cv2.IMREAD_COLOR)
    if N is None:
        sys.exit('faceflow: unreadable neutral')
    H, W = N.shape[:2]
    s = WORK_H / H                       # full -> work
    w, h = int(round(W * s)), WORK_H
    lock_y, lock_src = lock_line(face, mouth, nose)
    if isinstance(prep.get('mask'), dict):
        mk = prep['mask']; SHAPE[kind] = (mk['rx'], mk['ry'], mk['dy'])

    # 1) register every key to the neutral on the eyes + nose bridge (inside the face box, above the lock line)
    nw = cv2.resize(N, (w, h), interpolation=cv2.INTER_AREA)
    gN = cv2.cvtColor(nw, cv2.COLOR_BGR2GRAY).astype(np.float32)
    reg = np.zeros((h, w), np.uint8)
    fy1 = face[1] + 0.12 * (face[3] - face[1])
    reg[int(fy1 * h):int(lock_y * h), int((face[0] + 0.12 * (face[2] - face[0])) * w):int((face[2] - 0.12 * (face[2] - face[0])) * w)] = 255
    ALN, diag = {}, {}
    for spec in a.keys.split(','):
        name, path = spec.split('=', 1)
        K = cv2.imread(path, cv2.IMREAD_COLOR)
        if K is None:
            diag[name] = {'error': 'unreadable'}; continue
        if K.shape[:2] != (H, W):
            K = cv2.resize(K, (W, H), interpolation=cv2.INTER_AREA)
        gK = cv2.cvtColor(cv2.resize(K, (w, h), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
        Wm = feature_init(gN, gK, reg)          # ORB + RANSAC similarity first (non-human lane, 11/3)
        W0 = Wm.copy()
        try:
            _, Wm = cv2.findTransformECC(gN, gK, Wm.copy(), cv2.MOTION_AFFINE,
                                         (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-6), reg, 5)
        except cv2.error:
            Wm = W0
        if not sane(Wm, w, h) or np.abs(Wm - W0).max() > 0.05 * h:
            Wm = W0 if sane(W0, w, h) else np.eye(2, 3, dtype=np.float32)
        Wf = Wm.copy(); Wf[:, 2] /= s
        al = cv2.warpAffine(K, Wf, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        ALN[name] = al
        diag[name] = {'shift': [round(float(Wf[0, 2]), 2), round(float(Wf[1, 2]), 2)],
                      'scale': round(float(np.sqrt(abs(np.linalg.det(Wm[:, :2])))), 4)}

    # 2) character3d: squash a key's mouth opening toward the upper lip (classical remap, smooth falloff)
    if prep.get('squash'):
        fwp, fhp = (face[2] - face[0]) * W, (face[3] - face[1]) * H
        anc = mouth[1] * H
        mcx_ = (mouth[0] + mouth[2]) / 2 * W
        gy_, gx_ = np.mgrid[0:H, 0:W].astype(np.float32)
        wt = np.zeros((H, W), np.float32)
        cv2.ellipse(wt, (int(mcx_), int(anc + 0.06 * fhp)), (int(0.2 * fwp), int(0.14 * fhp)), 0, 0, 360, 1.0, -1)
        wt = cv2.GaussianBlur(wt, (0, 0), 0.05 * fwp) * (gy_ > anc)
        for nm, sy in prep['squash'].items():
            if nm in ALN:
                my = gy_ + wt * ((anc + (gy_ - anc) / float(sy)) - gy_)
                ALN[nm] = cv2.remap(ALN[nm], gx_, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    # 2b) 3D: lift pitch-black mouth interiors to a dark warm red-brown (profiles prep.interior = B,G,R; classical)
    if prep.get('interior'):
        tgt = np.array([float(v) for v in prep['interior']], np.float32)
        mw_ = (mouth[2] - mouth[0]) * W; fwp_ = (face[2] - face[0]) * W
        lim_ = np.zeros((H, W), np.float32)
        r_ = max(mw_, 0.2 * fwp_)
        cv2.ellipse(lim_, (int((mouth[0] + mouth[2]) / 2 * W), int((mouth[1] + mouth[3]) / 2 * H + 0.3 * mw_)), (int(r_), int(0.9 * r_)), 0, 0, 360, 1.0, -1)
        lim_ = cv2.GaussianBlur(lim_, (0, 0), 0.05 * fwp_)
        LN_ = cv2.cvtColor(np.clip(N, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
        for nm in list(ALN):
            al = ALN[nm]
            L = cv2.cvtColor(np.clip(al, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
            new_ = np.clip((LN_ - L - 15) / 20, 0, 1)        # only the new opening (darker than the neutral): dark fur / cloth stay
            wv = np.clip((tgt.mean() * 1.4 - L) / (tgt.mean() * 1.4), 0, 1) * 0.85 * lim_ * new_
            wv = cv2.GaussianBlur(wv, (0, 0), 1.2)[..., None]
            ALN[nm] = al * (1 - wv) + np.maximum(al, tgt) * wv

    # 3) blend mask (= lock mask). character2d: only where a key's drawing differs, after fitting each drawn mouth
    #    onto a clean plate (the closed line painted out); others: lower-face ellipse x lock ramp.
    base = N.astype(np.float32)
    if prep.get('mask') == 'diff' and ALN:
        fit = {k: float(v) for k, v in (prep.get('fit') or {}).items()}
        mw = max((mouth[2] - mouth[0]) * W, float(prep.get('mouthWidthMin', 0.12)) * (face[2] - face[0]) * W)   # chibi: a dot-sized closed mouth
        mcx, mcy = (mouth[0] + mouth[2]) / 2 * W, (mouth[1] + mouth[3]) / 2 * H
        Nl = cv2.cvtColor(N, cv2.COLOR_BGR2GRAY).astype(np.float32)
        lim = np.zeros((H, W), np.uint8)
        cv2.ellipse(lim, (int(mcx), int(mcy + 0.2 * mw)), (int(1.1 * mw), int(0.75 * mw)), 0, 0, 360, 1, -1)
        if prep.get('cleanPlate', True):
            skin = np.median(Nl[lim > 0])
            line = cv2.dilate(((Nl < skin - 35) & (lim > 0)).astype(np.uint8), cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
            N0 = cv2.inpaint(N, line, 7, cv2.INPAINT_TELEA).astype(np.float32)
        else:
            N0 = base
        for name in list(ALN):
            al = ALN[name]
            Kl = cv2.cvtColor(np.clip(al, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32)
            dk = ((Nl - Kl > 40) & (lim > 0)).astype(np.uint8)
            n, lab, st, _ = cv2.connectedComponentsWithStats(dk)
            if n < 2: continue
            reg_ = np.zeros_like(dk)
            for i in range(1, n):
                if st[i, cv2.CC_STAT_AREA] > 0.004 * mw * mw: reg_[lab == i] = 1
            if not reg_.any(): continue
            kk = max(3, int(0.06 * mw) | 1)
            reg_ = cv2.morphologyEx(reg_, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kk * 3, kk * 3)))
            ff = reg_.copy(); fm = np.zeros((ff.shape[0] + 2, ff.shape[1] + 2), np.uint8)
            cv2.floodFill(ff, fm, (0, 0), 1); reg_ = reg_ | (1 - ff)
            ys_, xs_ = np.where(reg_ > 0)
            bx1, bx2, by1, by2 = xs_.min(), xs_.max(), ys_.min(), ys_.max()
            bw_, bh_ = bx2 - bx1 + 1, by2 - by1 + 1
            sc = min(1.0, fit.get(name, 0) * mw / bw_) if fit.get(name, 0) > 0 else 1.0
            kcx, kcy = (bx1 + bx2) / 2, (by1 + by2) / 2
            tcx, tcy = mcx, mcy + 0.2 * bh_ * sc
            A = np.float32([[sc, 0, tcx - sc * kcx], [0, sc, tcy - sc * kcy]])
            pk = cv2.dilate(reg_, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kk, kk))).astype(np.float32)
            pk = cv2.GaussianBlur(cv2.warpAffine(pk, A, (W, H), flags=cv2.INTER_LINEAR), (0, 0), max(1.0, 0.012 * mw))[..., None]
            ALN[name] = N0 * (1 - pk) + cv2.warpAffine(al, A, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE) * pk
            diag[name]['fit'] = {'w_x': round(bw_ / mw, 2), 'scale': round(sc, 2)}
        big, dil, fe, thr = DIFF_MASK['character2d']
        lim2 = np.zeros((H, W), np.float32)
        cv2.ellipse(lim2, (int(mcx), int(mcy + 0.1 * mw)), (int(big * mw), int(0.6 * big * mw)), 0, 0, 360, 1.0, -1)
        Nb = cv2.GaussianBlur(base, (0, 0), 1.5)
        d = np.zeros((H, W), np.float32)
        for al in ALN.values():
            d = np.maximum(d, np.abs(cv2.GaussianBlur(al, (0, 0), 1.5) - Nb).max(2))
        d = ((d > thr) & (lim2 > 0)).astype(np.uint8)
        n, lab, st, _ = cv2.connectedComponentsWithStats(d)
        keep = np.zeros_like(d)
        for i in range(1, n):
            if st[i, cv2.CC_STAT_AREA] > 0.002 * mw * mw: keep[lab == i] = 1
        k = int(dil * mw) | 1
        keep = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
        keep = cv2.morphologyEx(keep, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k * 2 + 1, k * 2 + 1)))
        Mfull = cv2.GaussianBlur(keep.astype(np.float32), (0, 0), max(1.0, fe * mw))
        ys0 = (np.arange(H, dtype=np.float32) + 0.5)[:, None]
        t_ = np.clip((ys0 - lock_y * H) / (RAMP_PX / s), 0, 1)
        Mfull = Mfull * t_ * t_ * (3 - 2 * t_)
        if Mfull.max() < 0.01:
            Mfull = build_mask(H, W, face, mouth, lock_y, kind, s)
    else:
        Mfull = build_mask(H, W, face, mouth, lock_y, kind, s)

    ys, xs = np.where(Mfull > 0.004)
    pad = int(4 / s)
    X1, Y1 = max(0, xs.min() - pad), max(0, ys.min() - pad)
    X2, Y2 = min(W, xs.max() + pad + 1), min(H, ys.max() + pad + 1)
    roiF = (slice(Y1, Y2), slice(X1, X2))
    RW, RH = X2 - X1, Y2 - Y1
    rw, rh = int(round(RW * s)), int(round(RH * s))
    Mw = cv2.resize(Mfull[roiF], (rw, rh), interpolation=cv2.INTER_AREA)

    # 4) neutral ROI (+ human colour fix, applied identically to the neutral and every key)
    cfx = COLORFIX.get(kind)
    mouth_px = (int(mouth[0] * W) - X1, int(mouth[1] * H) - Y1, int(mouth[2] * W) - X1, int(mouth[3] * H) - Y1)
    Mr = Mfull[roiF][..., None]
    NR = base[roiF]
    if cfx:
        NR = NR * (1 - Mr) + colorfix(NR, mouth_px, cfx) * Mr
    lbst = prep.get('lineBoost')
    if lbst:
        # cat: crisper closed-mouth line on the neutral texture (dark local detail x k in a mouth ellipse; classical)
        k_, sg = float(lbst.get('k', 1.2)), float(lbst.get('sigmaPx1024', 3)) * W / 1024.0
        L = cv2.cvtColor(np.clip(NR, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY).astype(np.float32) + 1
        dd = np.minimum(L - cv2.GaussianBlur(L, (0, 0), sg), 0)
        bx1, by1, bx2, by2 = mouth_px
        mw_ = bx2 - bx1
        E = np.zeros(L.shape, np.float32)
        cv2.ellipse(E, (int((bx1 + bx2) / 2), int((by1 + by2) / 2)), (int(0.75 * mw_), int(0.45 * mw_)), 0, 0, 360, 1.0, -1)
        E = cv2.GaussianBlur(E, (0, 0), max(1.0, 0.12 * mw_))
        NR = np.clip(NR * (np.maximum(L + k_ * dd * E, 1) / L)[..., None], 0, 255)

    # 5) composite each key onto the neutral inside the mask; DIS flow both ways (none for character2d)
    use_flow = not (prof.get('flow') is False or prep.get('mask') == 'diff')
    band = (Mfull > 0.05) & (Mfull < 0.5)
    m3 = Mfull[..., None]
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setFinestScale(0)
    dis.setGradientDescentIterations(25)
    dis.setVariationalRefinementIterations(10)
    gNr = cv2.cvtColor(cv2.resize(np.clip(NR, 0, 255).astype(np.uint8), (rw, rh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    fw_, fh_ = max(8, int(rw * FLOW_SCALE)), max(8, int(rh * FLOW_SCALE))
    to_size = np.array([RW / rw, RH / rh], np.float32)   # work px -> `size` px
    # flow grid rows whose cell lies entirely above the lock line (cell j spans Y1 + [j, j+1] * RH / fh_)
    lock_rows = max(0, int(np.floor((lock_y * H - Y1) / (RH / fh_))))
    files, nbytes = {}, 0
    mask_w3 = Mw[..., None]
    for name, al in ALN.items():
        off = (base[band] - al[band]).mean(0) if band.any() else np.zeros(3, np.float32)
        comp = base * (1 - m3) + np.clip(al + off, 0, 255) * m3
        cr = comp[roiF]
        if cfx:
            cr = NR * (1 - Mr) + colorfix(cr, mouth_px, cfx) * Mr
        if kind == 'human' and LIP_MATCH:
            cr = NR * (1 - Mr) + lip_match(cr, NR, mouth_px) * Mr
        if INTERIOR.get(kind) and name != 'MBP':
            cr = interior_tone(cr, mouth_px, INTERIOR[kind], W / 540.0, NR)
        crop = np.clip(cr, 0, 255).astype(np.uint8)
        cv2.imwrite(os.path.join(a.out, f'{name}.jpg'), crop, [cv2.IMWRITE_JPEG_QUALITY, a.jpeg])
        ent = {'key': f'{name}.jpg'}
        if kind == 'human':
            # 6 px at a 540-wide frame, scaled to this face set's resolution
            lm = lip_hull_mask(crop.astype(np.float32), mouth_px, 6 * W / 540.0)
            cv2.imwrite(os.path.join(a.out, f'{name}.lip.png'), np.clip(lm * 255 + 0.5, 0, 255).astype(np.uint8))
            ent['lip'] = f'{name}.lip.png'
            if name != 'MBP':   # lip rig teeth layer (v41): where this key's teeth / cavity may show, same size as the lip mask
                im_ = interior_mask(crop.astype(np.float32), mouth_px, W / 540.0)
                cv2.imwrite(os.path.join(a.out, f'{name}.interior.png'), np.clip(im_ * 255 + 0.5, 0, 255).astype(np.uint8))
                ent['interior'] = f'{name}.interior.png'
        gKr = cv2.cvtColor(cv2.resize(crop, (rw, rh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        for tag, (src, dst) in (('nk', (gNr, gKr)), ('kn', (gKr, gNr))):
            if not use_flow:
                continue                                           # 2D: snap between drawings, no motion field
            if use_flow:
                f = dis.calc(src, dst, None)
                f = cv2.GaussianBlur(f, (0, 0), 2.0) * mask_w3      # zero outside the lower face and above the lock line
                f = cv2.resize(f, (fw_, fh_), interpolation=cv2.INTER_AREA) * to_size
                f[:lock_rows] = 0                                  # exact lock: no grid row above the subnasale line moves
                b = f.astype('<f2').tobytes()
            open(os.path.join(a.out, f'{name}.{tag}.f16'), 'wb').write(b)
            nbytes += len(b); ent[tag] = f'{name}.{tag}.f16'
        files[name] = ent
        diag[name]['colour'] = [round(float(v), 1) for v in off]
    cv2.imwrite(os.path.join(a.out, 'mask.png'), np.clip(Mfull[roiF] * 255 + 0.5, 0, 255).astype(np.uint8))
    cv2.imwrite(os.path.join(a.out, 'neutral.jpg'), np.clip(NR, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, a.jpeg])
    flow = {'version': 1, 'roi': [round(X1 / W, 5), round(Y1 / H, 5), round(X2 / W, 5), round(Y2 / H, 5)],
            'size': [int(RW), int(RH)], 'flowSize': [fw_, fh_], 'keys': list(files), 'files': files,
            'mask': 'mask.png', 'neutralRoi': 'neutral.jpg', 'lockY': round(lock_y, 5), 'lockSource': lock_src,
            'kind': kind, 'flowUsed': use_flow, 'colorfix': list(cfx) if cfx else None, 'map': lip_map(kind)}
    json.dump(flow, open(os.path.join(a.out, 'flow.json'), 'w'), indent=1)
    print(json.dumps({'ok': True, 'ms': int((time.time() - t0) * 1000), 'flowBytes': nbytes, 'keys': len(files),
                      'lockY': flow['lockY'], 'lockSource': lock_src, 'kind': kind, 'diag': diag}))


if __name__ == '__main__':
    main()
