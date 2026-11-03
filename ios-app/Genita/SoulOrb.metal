// Native port of Dyno's soul orb (bagel-labs-beni/genita 25afbe03, src/orb/entry.js, default "dots" template):
// 9,900 round points whose positions come from a shared simplex curl field, a resting sphere with slowly evolving
// lobes, and the eight orb-motion.mjs deformation profiles. The maths below follows the GLSL line for line; the
// composite pass reproduces three.js OutputPass (ACES Filmic, exposure 1.2, sRGB) + Dyno's straight-alpha pass.
#include <metal_stdlib>
using namespace metal;

// Field order and types mirror SoulOrbUniforms in SoulOrb.swift (vectors first, then scalars).
struct SoulOrbUniforms {
    float4 motionShape;
    float4 motionScale;   // xyz
    float4 fieldOffset;   // xyz
    float4 tint;          // linear rgb
    float4 accent;        // linear rgb
    float2 projection;    // clip.xy = view.xy * projection, clip.w = -view.z
    float2 depth;         // clip.z = view.z * depth.x + depth.y
    float time;
    float idleClock;
    float activity;
    float failure;
    float spread;
    float swirl;
    float organic;
    float dotSize;
    float pixelRatio;
    float densityGain;
    float scaleX;
    float cameraZ;
    float softness;
    float roundDot;
};

// ---- Ashima / stegu webgl-noise simplex 3D (MIT), as in Dyno's shader ----
inline float3 mod289(float3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
inline float4 mod289(float4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
inline float4 permute(float4 x) { return mod289(((x * 34.0) + 10.0) * x); }
inline float4 taylorInvSqrt(float4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

inline float snoise(float3 v) {
    const float2 C = float2(1.0 / 6.0, 1.0 / 3.0);
    const float4 D = float4(0.0, 0.5, 1.0, 2.0);
    float3 i = floor(v + dot(v, C.yyy));
    float3 x0 = v - i + dot(i, C.xxx);
    float3 g = step(x0.yzx, x0.xyz);
    float3 l = 1.0 - g;
    float3 i1 = min(g.xyz, l.zxy);
    float3 i2 = max(g.xyz, l.zxy);
    float3 x1 = x0 - i1 + C.xxx;
    float3 x2 = x0 - i2 + C.yyy;
    float3 x3 = x0 - D.yyy;
    i = mod289(i);
    float4 p = permute(permute(permute(i.z + float4(0.0, i1.z, i2.z, 1.0)) + i.y + float4(0.0, i1.y, i2.y, 1.0)) + i.x + float4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    float3 ns = n_ * D.wyz - D.xzx;
    float4 j = p - 49.0 * floor(p * ns.z * ns.z);
    float4 x_ = floor(j * ns.z);
    float4 y_ = floor(j - 7.0 * x_);
    float4 x = x_ * ns.x + ns.yyyy;
    float4 y = y_ * ns.x + ns.yyyy;
    float4 h = 1.0 - abs(x) - abs(y);
    float4 b0 = float4(x.xy, y.xy);
    float4 b1 = float4(x.zw, y.zw);
    float4 s0 = floor(b0) * 2.0 + 1.0;
    float4 s1 = floor(b1) * 2.0 + 1.0;
    float4 sh = -step(h, float4(0.0));
    float4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    float4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    float3 p0 = float3(a0.xy, h.x);
    float3 p1 = float3(a0.zw, h.y);
    float3 p2 = float3(a1.xy, h.z);
    float3 p3 = float3(a1.zw, h.w);
    float4 norm = taylorInvSqrt(float4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    float4 m = max(0.5 - float4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), float4(0.0));
    m = m * m;
    return 105.0 * dot(m * m, float4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// A shared curl field folds seed positions into coherent dense surfaces.
inline float3 field(float3 p) { return float3(snoise(p), snoise(p + float3(31.4, 17.1, 47.2)), snoise(p + float3(73.2, 29.7, 13.8))); }
inline float3 curl(float3 p) {
    const float e = 0.09;
    float3 dx = float3(e, 0.0, 0.0), dy = float3(0.0, e, 0.0), dz = float3(0.0, 0.0, e);
    float3 x = field(p + dx) - field(p - dx), y = field(p + dy) - field(p - dy), z = field(p + dz) - field(p - dz);
    float3 c = float3(y.z - z.y, z.x - x.z, x.y - y.x);
    return c / max(length(c), 0.0001);
}
// GLSL mat2(cos,-sin,sin,cos) * v (column-major)
inline float2 rotate2(float a, float2 v) { return float2(cos(a) * v.x + sin(a) * v.y, -sin(a) * v.x + cos(a) * v.y); }

struct PointOut {
    float4 position [[position]];
    float size [[point_size]];
    float3 color;
    float opacity;
};

vertex PointOut soul_orb_points(uint vid [[vertex_id]],
                                constant float4 *seeds [[buffer(0)]],
                                constant SoulOrbUniforms &u [[buffer(1)]]) {
    float4 seed = seeds[vid];
    float az = seed.x * 6.283185, el = seed.y * 6.283185;
    float3 source = 2.0 * sqrt(seed.z) * float3(sin(el) * cos(az), cos(el), sin(el) * sin(az));
    float clock = u.time * 0.17 * u.organic;
    float frequency = (0.23 + u.swirl * 0.055) * u.motionShape.x;
    float twist = source.y * u.motionShape.y;
    source.xz = rotate2(twist, source.xz);
    source += u.motionShape.w * float3(sin(source.y * 2.0 + clock * 0.3), sin(source.z * 2.3 - clock * 0.2), sin(source.x * 1.8 + clock * 0.4));
    float3 fieldOffset = u.fieldOffset.xyz, motionScale = u.motionScale.xyz;
    float3 fold = curl(source * frequency + fieldOffset + float3(clock * 0.11, clock * 0.083, clock * 0.097));
    float3 secondary = curl(fold * frequency * 2.0 + float3(0.2, 0.0, 0.1) + fieldOffset * 0.21);
    float morph = u.motionShape.z;
    float3 reactiveShape = (fold + secondary * morph) * motionScale;
    // Rest keeps the curl clusters but confines the silhouette to a quiet sphere.
    float idle = u.idleClock;
    float breath = 1.0 + 0.018 * sin(idle * 0.85);
    float3 sphereDirection = normalize(fold + secondary * 0.035);
    // Low-frequency asymmetric lobes preserve the round body while its contour evolves.
    float contour = snoise(sphereDirection * 1.35 + fieldOffset * 0.22 + float3(idle * 0.24, sin(idle * 0.35) * 0.25, -idle * 0.18));
    float variation = 0.105 + 0.025 * sin(idle * 0.65 + fieldOffset.y);
    float3 resting = sphereDirection * (breath + contour * variation + 0.025 * sin(sphereDirection.y * 3.5 + idle * 0.8));
    resting *= mix(float3(1.0), motionScale, float3(0.24));
    resting += secondary * 0.035;
    float3 p = mix(resting, reactiveShape, float3(u.activity));
    p *= 0.76 + u.spread * 0.55;
    // Spread progressively opens the folds while keeping most grains connected.
    p += source * u.spread * 0.22;
    // modelView: points.scale.x, camera at (0, 0, cameraZ) looking at the origin
    float3 mv = float3(p.x * u.scaleX, p.y, p.z - u.cameraZ);
    // Two volumetric diagonal bars, aligned to the viewer for a legible failure mark.
    float branch = seed.x < 0.5 ? 1.0 : -1.0;
    float phase = seed.w * 6.283185;
    float along = (seed.y * 2.0 - 1.0) * 1.01 + 0.075 * sin(idle * 2.2 + phase + seed.z * 4.0);
    float angle = phase + idle * (0.75 + seed.z * 0.65) * branch;
    float thickness = sqrt(seed.z) * (0.13 + 0.018 * sin(along * 5.0 - idle * 1.8 + branch));
    float ripple = 0.018 * sin(along * 6.0 + idle * 1.6 + branch);
    float3 crossPoint = float3(along + cos(angle) * thickness + ripple, branch * along - branch * (cos(angle) * thickness + ripple), sin(angle) * thickness + 0.025 * sin(idle * 1.3 + phase));
    float3 center = float3(0.0, 0.0, -u.cameraZ);
    mv = mix(mv, center + crossPoint, float3(u.failure));

    PointOut out;
    out.position = float4(mv.x * u.projection.x, mv.y * u.projection.y, mv.z * u.depth.x + u.depth.y, -mv.z);
    // three.js clip z is -w…w; Metal wants 0…w
    out.position.z = 0.5 * (out.position.z + out.position.w);
    out.size = clamp(u.dotSize * u.pixelRatio * (0.4 + seed.w), 0.7, 18.0);
    float hue = smoothstep(-1.0, 1.0, p.y * 0.5 + secondary.x * 0.6);
    float3 color = mix(mix(u.accent.rgb, u.tint.rgb, float3(hue)), float3(0.88, 0.018, 0.035), float3(u.failure));
    out.color = color * (0.6 + seed.w * 0.65);
    out.opacity = mix(clamp((0.35 + seed.w * 0.6) * u.densityGain, 0.0, 1.0), 0.65 + seed.w * 0.3, u.failure);
    return out;
}

fragment float4 soul_orb_point_fragment(PointOut in [[stage_in]],
                                        float2 pc [[point_coord]],
                                        constant SoulOrbUniforms &u [[buffer(1)]]) {
    float2 v = abs(pc - 0.5) * 2.0;
    float d = mix(max(v.x, v.y), length(v), u.roundDot);
    float alpha = (1.0 - smoothstep(max(0.02, 1.0 - u.softness * 0.98), 1.0, d)) * in.opacity;
    if (alpha < 0.01) discard_fragment();
    return float4(in.color, alpha);
}

// ---- composite: OutputPass (ACES Filmic × exposure, sRGB OETF) then Dyno's straight-alpha background pass ----
struct FullOut { float4 position [[position]]; };

vertex FullOut soul_orb_full(uint vid [[vertex_id]]) {
    float2 p = float2(float((vid << 1) & 2), float(vid & 2));
    FullOut out;
    out.position = float4(p * 2.0 - 1.0, 0.0, 1.0);
    return out;
}

inline float3 rrtAndOdtFit(float3 v) {
    float3 a = v * (v + 0.0245786) - 0.000090537;
    float3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
}
inline float3 acesFilmic(float3 color, float exposure) {
    const float3x3 inputMat = float3x3(float3(0.59719, 0.07600, 0.02840), float3(0.35458, 0.90834, 0.13383), float3(0.04823, 0.01566, 0.83777));
    const float3x3 outputMat = float3x3(float3(1.60475, -0.10208, -0.00327), float3(-0.53108, 1.10813, -0.07276), float3(-0.07367, -0.00605, 1.07602));
    color *= exposure / 0.6;
    color = inputMat * color;
    color = rrtAndOdtFit(color);
    color = outputMat * color;
    return saturate(color);
}
inline float3 srgbOETF(float3 c) {
    float3 hi = pow(max(c, float3(0.0)), float3(0.41666)) * 1.055 - 0.055;
    float3 lo = c * 12.92;
    return select(hi, lo, c <= 0.0031308);
}

fragment float4 soul_orb_composite(FullOut in [[stage_in]], texture2d<float, access::read> scene [[texture(0)]]) {
    uint2 xy = uint2(in.position.xy);
    float4 c = scene.read(xy);
    float3 rgb = srgbOETF(acesFilmic(c.rgb, 1.2));
    float light = max(rgb.r, max(rgb.g, rgb.b));
    float a = clamp(max(c.a, light), 0.0, 1.0);
    float3 straight = saturate(rgb / max(a, 0.00001));
    // CAMetalLayer composites premultiplied colour
    return float4(straight * a, a);
}
