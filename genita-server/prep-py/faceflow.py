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

# How a LipTimeline frame maps onto keys (runtime reads this; reference: _qa-scripts/genita-mouth-proto/render.py).
# 11/3 sweep winner (critic-ranked vs Peter, sweep s21 + snap blink; _qa-scripts/genita-mouth-compare/sweep/README.md):
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
    'gain': 1.3,                  # vowel amount scale (Peter-like opening)
    'lookaheadMs': 40,            # mouth leads the sound
    'dissolve': {'mode': 'snap', 'ms': 40, 'minAmount': 0.3},  # one texture at a time, 1-frame switch (no grey teeth)
    'colourEdge': 0.35,           # only for mode 'smooth'
    # coarticulation: a frame whose dominant shape is a consonant other than MBP/FV keeps `share` of the
    # neighbouring vowel frames' key amounts (linear between the nearest vowel frames within windowMs)
    'jawFloor': {'share': 0.6, 'windowMs': 160, 'vowels': ['A', 'O', 'EI', 'U'], 'closed': ['MBP', 'FV', 'rest']},
    'blink': {'mode': 'snap', 'frames': 3},  # eyes fully closed for 3 frames, no half frames
    # applied LAST (after focus, which would otherwise restore it); the remainder goes to neutral
    'maxAmount': {'AH2': 0.7},
}
PROFILE = {
    'human': {},
    # per-category overrides (merged over BASE_MAP); the non-human lane owns animal / character3d / character2d
    'animal': {'gain': 1.0, 'ladder': {'viseme': 'A', 'steps': [['MID', 0.0], ['AH', 0.25], ['AH2', 0.55]], 'gain': [0.8, 0.4]}},
    'character': {'gain': 1.2, 'ladder': {'viseme': 'A', 'steps': [['MID', 0.0], ['AH', 0.2], ['AH2', 0.45]], 'gain': [0.8, 0.4]}},
}
PROFILE['character3d'] = PROFILE['character']
PROFILE['character2d'] = PROFILE['character']


def lip_map(kind):
    m = json.loads(json.dumps(BASE_MAP))
    m.update(json.loads(json.dumps(PROFILE.get(kind, {}))))
    return m


# Mask shape per kind: ellipse radii as a fraction of the face box, centre below the mouth.
SHAPE = {'human': (0.40, 0.30, 0.08), 'animal': (0.30, 0.34, 0.08), 'character': (0.36, 0.30, 0.08),
         'character3d': (0.36, 0.30, 0.08), 'character2d': (0.36, 0.30, 0.08)}


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
    ap.add_argument('--kind', default='human')
    ap.add_argument('--out', required=True)
    ap.add_argument('--jpeg', type=int, default=90)
    a = ap.parse_args()
    t0 = time.time()
    os.makedirs(a.out, exist_ok=True)
    face, mouth, nose = box(a.face), box(a.mouth), box(a.nose)
    N = cv2.imread(a.neutral, cv2.IMREAD_COLOR)
    if N is None:
        sys.exit('faceflow: unreadable neutral')
    H, W = N.shape[:2]
    s = WORK_H / H                       # full -> work
    w, h = int(round(W * s)), WORK_H
    lock_y, lock_src = lock_line(face, mouth, nose)

    Mfull = build_mask(H, W, face, mouth, lock_y, a.kind, s)
    ys, xs = np.where(Mfull > 0.004)
    pad = int(4 / s)
    X1, Y1 = max(0, xs.min() - pad), max(0, ys.min() - pad)
    X2, Y2 = min(W, xs.max() + pad + 1), min(H, ys.max() + pad + 1)
    roiF = (slice(Y1, Y2), slice(X1, X2))
    RW, RH = X2 - X1, Y2 - Y1
    # working ROI (same normalised rect)
    x1, y1 = X1 * s, Y1 * s
    rw, rh = int(round(RW * s)), int(round(RH * s))
    Mw = cv2.resize(Mfull[roiF], (rw, rh), interpolation=cv2.INTER_AREA)

    # Registration region: eyes + nose bridge (inside the face box, above the lock line).
    nw = cv2.resize(N, (w, h), interpolation=cv2.INTER_AREA)
    gN = cv2.cvtColor(nw, cv2.COLOR_BGR2GRAY).astype(np.float32)
    reg = np.zeros((h, w), np.uint8)
    fy1 = face[1] + 0.12 * (face[3] - face[1])
    reg[int(fy1 * h):int(lock_y * h), int((face[0] + 0.12 * (face[2] - face[0])) * w):int((face[2] - 0.12 * (face[2] - face[0])) * w)] = 255

    Nf = N.astype(np.float32)
    band = (Mfull > 0.05) & (Mfull < 0.5)
    m3 = Mfull[..., None]
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setFinestScale(0)
    dis.setGradientDescentIterations(25)
    dis.setVariationalRefinementIterations(10)
    gNr = cv2.cvtColor(cv2.resize(N[roiF], (rw, rh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    fw_, fh_ = max(8, int(rw * FLOW_SCALE)), max(8, int(rh * FLOW_SCALE))
    to_size = np.array([RW / rw, RH / rh], np.float32)   # work px -> `size` px
    # flow grid rows whose cell lies entirely above the lock line (cell j spans Y1 + [j, j+1] * RH / fh_)
    lock_rows = max(0, int(np.floor((lock_y * H - Y1) / (RH / fh_))))
    files, diag, nbytes = {}, {}, 0
    mask_w3 = Mw[..., None]
    for spec in a.keys.split(','):
        name, path = spec.split('=', 1)
        K = cv2.imread(path, cv2.IMREAD_COLOR)
        if K is None:
            diag[name] = {'error': 'unreadable'}; continue
        if K.shape[:2] != (H, W):
            K = cv2.resize(K, (W, H), interpolation=cv2.INTER_AREA)
        gK = cv2.cvtColor(cv2.resize(K, (w, h), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
        Wm = np.eye(2, 3, dtype=np.float32)
        try:
            _, Wm = cv2.findTransformECC(gN, gK, Wm, cv2.MOTION_AFFINE,
                                         (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 80, 1e-6), reg, 5)
        except cv2.error:
            pass
        Wf = Wm.copy(); Wf[:, 2] /= s                          # to full resolution
        al = cv2.warpAffine(K, Wf, (W, H), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        off = (Nf[band] - al[band]).mean(0)                    # low-frequency colour match on the mask's outer band
        comp = Nf * (1 - m3) + np.clip(al + off, 0, 255) * m3
        crop = np.clip(comp[roiF], 0, 255).astype(np.uint8)
        cv2.imwrite(os.path.join(a.out, f'{name}.jpg'), crop, [cv2.IMWRITE_JPEG_QUALITY, a.jpeg])
        gKr = cv2.cvtColor(cv2.resize(crop, (rw, rh), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
        ent = {'key': f'{name}.jpg'}
        for tag, (src, dst) in (('nk', (gNr, gKr)), ('kn', (gKr, gNr))):
            f = dis.calc(src, dst, None)
            f = cv2.GaussianBlur(f, (0, 0), 2.0) * mask_w3      # zero outside the lower face and above the lock line
            f = cv2.resize(f, (fw_, fh_), interpolation=cv2.INTER_AREA) * to_size
            f[:lock_rows] = 0                                  # exact lock: no grid row above the subnasale line moves
            b = f.astype('<f2').tobytes()
            open(os.path.join(a.out, f'{name}.{tag}.f16'), 'wb').write(b)
            nbytes += len(b); ent[tag] = f'{name}.{tag}.f16'
        files[name] = ent
        diag[name] = {'shift': [round(float(Wf[0, 2]), 2), round(float(Wf[1, 2]), 2)],
                      'scale': round(float(np.sqrt(abs(np.linalg.det(Wm[:, :2])))), 4),
                      'colour': [round(float(v), 1) for v in off]}
    cv2.imwrite(os.path.join(a.out, 'mask.png'), np.clip(Mfull[roiF] * 255 + 0.5, 0, 255).astype(np.uint8))
    cv2.imwrite(os.path.join(a.out, 'neutral.jpg'), N[roiF], [cv2.IMWRITE_JPEG_QUALITY, a.jpeg])
    flow = {'version': 1, 'roi': [round(X1 / W, 5), round(Y1 / H, 5), round(X2 / W, 5), round(Y2 / H, 5)],
            'size': [int(RW), int(RH)], 'flowSize': [fw_, fh_], 'keys': list(files), 'files': files,
            'mask': 'mask.png', 'neutralRoi': 'neutral.jpg', 'lockY': round(lock_y, 5), 'lockSource': lock_src,
            'kind': a.kind, 'map': lip_map(a.kind)}
    json.dump(flow, open(os.path.join(a.out, 'flow.json'), 'w'), indent=1)
    print(json.dumps({'ok': True, 'ms': int((time.time() - t0) * 1000), 'flowBytes': nbytes, 'keys': len(files),
                      'lockY': flow['lockY'], 'lockSource': lock_src, 'diag': diag}))


if __name__ == '__main__':
    main()
