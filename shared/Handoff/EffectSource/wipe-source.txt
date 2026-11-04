import {
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  NoToneMapping,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  SRGBColorSpace,
  Scene,
  Texture,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three';

const FRAME_CORNER = 110 / 1878;

const QUAD_VERTEX = `
in vec2 uv;
in vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const COMPOSE_FRAGMENT = `
precision highp float;
uniform sampler2D backdropMap;
uniform sampler2D skyMap;
uniform sampler2D mountainMap;
uniform sampler2D timeMap;
uniform sampler2D chromeMap;
uniform vec4 backdropFrame;
uniform vec4 skyFrame;
uniform vec4 mountainFrame;
uniform vec4 duneFrame;
uniform float landscapeOpacity;
uniform float plateOpacity;
in vec2 vUv;
out vec4 fragColor;
vec3 over(vec3 under, vec4 layer) {
  return under * (1.0 - layer.a) + layer.rgb;
}
vec4 sheet(sampler2D map, vec4 frame) {
  return texture(map, frame.xy + vUv * frame.zw) * landscapeOpacity;
}
void main() {
  vec3 colour = texture(backdropMap, backdropFrame.xy + vUv * backdropFrame.zw).rgb;
  colour = over(colour, sheet(skyMap, skyFrame));
  colour = over(colour, texture(timeMap, vUv) * plateOpacity);
  colour = over(colour, sheet(mountainMap, mountainFrame));
  vec2 dune = duneFrame.xy + vUv * duneFrame.zw;
  float sand = (1.0 - max(texture(skyMap, dune).a, texture(mountainMap, dune).a)) * landscapeOpacity;
  colour = over(colour, vec4(texture(backdropMap, dune).rgb * sand, sand));
  colour = over(colour, texture(chromeMap, vUv) * plateOpacity);
  fragColor = vec4(colour, 1.0);
}
`;

const FRAME_FRAGMENT = `
precision highp float;
uniform sampler2D map;
uniform float cornerRadius;
in vec2 vUv;
out vec4 fragColor;
float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
void main() {
  vec2 uv = (vUv - 0.5) / 0.9 + 0.5;
  vec2 imgSize = vec2(textureSize(map, 0));
  vec2 aspect = vec2(imgSize.x / imgSize.y, 1.0);
  float maxBounds = min(imgSize.x, imgSize.y);
  float corners = cornerRadius / maxBounds;
  if (imgSize.x < imgSize.y && uv.x < 0.5) corners = 0.0;
  vec2 center = vec2(0.5) * aspect;
  float area = sdRoundedBox(uv * aspect - center, center, corners);
  fragColor = vec4(texture(map, uv).rgb * smoothstep(0.0, 2.0 / maxBounds, -area), 1.0);
}
`;

const BLUR_FRAGMENT = `
precision highp float;
uniform sampler2D map;
uniform float wipeAmount;
uniform float wipePosition;
uniform vec2 blurBounds;
in vec2 vUv;
out vec4 fragColor;
#define maxBlur 8.0
float w0(float a) { return (1.0/6.0)*(a*(a*(-a + 3.0) - 3.0) + 1.0); }
float w1(float a) { return (1.0/6.0)*(a*a*(3.0*a - 6.0) + 4.0); }
float w2(float a) { return (1.0/6.0)*(a*(a*(-3.0*a + 3.0) + 3.0) + 1.0); }
float w3(float a) { return (1.0/6.0)*(a*a*a); }
float g0(float a) { return w0(a) + w1(a); }
float g1(float a) { return w2(a) + w3(a); }
float h0(float a) { return -1.0 + w1(a) / (w0(a) + w1(a)); }
float h1(float a) { return 1.0 + w3(a) / (w2(a) + w3(a)); }
vec4 bicubic(sampler2D tex, vec2 uv, vec4 texelSize, float lod) {
  uv = uv * texelSize.zw + 0.5;
  vec2 iuv = floor(uv);
  vec2 fuv = fract(uv);
  float g0x = g0(fuv.x);
  float g1x = g1(fuv.x);
  float h0x = h0(fuv.x);
  float h1x = h1(fuv.x);
  float h0y = h0(fuv.y);
  float h1y = h1(fuv.y);
  vec2 p0 = (vec2(iuv.x + h0x, iuv.y + h0y) - 0.5) * texelSize.xy;
  vec2 p1 = (vec2(iuv.x + h1x, iuv.y + h0y) - 0.5) * texelSize.xy;
  vec2 p2 = (vec2(iuv.x + h0x, iuv.y + h1y) - 0.5) * texelSize.xy;
  vec2 p3 = (vec2(iuv.x + h1x, iuv.y + h1y) - 0.5) * texelSize.xy;
  return g0(fuv.y) * (g0x * textureLod(tex, p0, lod) + g1x * textureLod(tex, p1, lod))
       + g1(fuv.y) * (g0x * textureLod(tex, p2, lod) + g1x * textureLod(tex, p3, lod));
}
vec4 textureBicubic(sampler2D s, vec2 uv, float lod) {
  vec2 lodSizeFloor = vec2(textureSize(s, int(lod)));
  vec2 lodSizeCeil = vec2(textureSize(s, int(lod + 1.0)));
  vec4 floorSample = bicubic(s, uv, vec4(1.0 / lodSizeFloor.x, 1.0 / lodSizeFloor.y, lodSizeFloor.x, lodSizeFloor.y), floor(lod));
  vec4 ceilSample = bicubic(s, uv, vec4(1.0 / lodSizeCeil.x, 1.0 / lodSizeCeil.y, lodSizeCeil.x, lodSizeCeil.y), ceil(lod));
  return mix(floorSample, ceilSample, fract(lod));
}
float remap(float minValue, float maxValue, float value) {
  return (value - minValue) / (maxValue - minValue);
}
void main() {
  float distanceToWipe = distance(vUv.x, wipePosition);
  float blurArea = remap(0.0, 0.75, clamp(remap(blurBounds.x, blurBounds.y, distanceToWipe) * wipeAmount * 2.5, 0.0, 1.0));
  vec3 shade = vec3(smoothstep(1.3, 0.9, blurArea) * smoothstep(1.0, 0.9, distance(vUv.y, 0.5) * 2.0));
  fragColor = textureBicubic(map, vUv, blurArea * maxBlur) * vec4(shade, 1.0);
}
`;

export type WipePanel = 'inner' | 'outer';

export interface WipeLayers {
  readonly backdrop: Texture;
  readonly backdropFrame: Vector4;
  readonly landscape: {
    readonly sky: Texture;
    readonly skyFrame: Vector4;
    readonly mountain: Texture;
    readonly mountainFrame: Vector4;
    readonly duneFrame: Vector4;
  } | null;
  readonly clock: { readonly time: Texture; readonly chrome: Texture } | null;
}

function createTarget(width: number, height: number, anisotropy: number): WebGLRenderTarget {
  const target = new WebGLRenderTarget(width, height, {
    depthBuffer: false,
    generateMipmaps: true,
    minFilter: LinearMipmapLinearFilter,
    magFilter: LinearFilter,
  });
  target.texture.colorSpace = SRGBColorSpace;
  target.texture.anisotropy = anisotropy;
  return target;
}

interface Pass {
  readonly compose: WebGLRenderTarget;
  readonly frame: WebGLRenderTarget;
  readonly first: WebGLRenderTarget;
  readonly second: WebGLRenderTarget;
  readonly position: number;
  readonly bounds: Vector2;
}

export class ScreenWipe {
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  private readonly quad = new Mesh(new PlaneGeometry(1, 1));
  private readonly composeMaterial: RawShaderMaterial;
  private readonly frameMaterial: RawShaderMaterial;
  private readonly blurMaterial: RawShaderMaterial;
  private readonly passes: Record<WipePanel, Pass>;

  constructor(anisotropy: number, sizes: Record<WipePanel, Vector2>) {
    this.scene.add(this.quad);
    const shared = { glslVersion: '300 es' as const, depthTest: false, depthWrite: false };
    this.composeMaterial = new RawShaderMaterial({
      ...shared,
      vertexShader: QUAD_VERTEX,
      fragmentShader: COMPOSE_FRAGMENT,
      uniforms: {
        backdropMap: { value: null },
        skyMap: { value: null },
        mountainMap: { value: null },
        timeMap: { value: null },
        chromeMap: { value: null },
        backdropFrame: { value: new Vector4(0, 0, 1, 1) },
        skyFrame: { value: new Vector4(0, 0, 1, 1) },
        mountainFrame: { value: new Vector4(0, 0, 1, 1) },
        duneFrame: { value: new Vector4(0, 0, 1, 1) },
        landscapeOpacity: { value: 1 },
        plateOpacity: { value: 1 },
      },
    });
    this.frameMaterial = new RawShaderMaterial({
      ...shared,
      vertexShader: QUAD_VERTEX,
      fragmentShader: FRAME_FRAGMENT,
      uniforms: { map: { value: null }, cornerRadius: { value: 0 } },
    });
    this.blurMaterial = new RawShaderMaterial({
      ...shared,
      vertexShader: QUAD_VERTEX,
      fragmentShader: BLUR_FRAGMENT,
      uniforms: {
        map: { value: null },
        wipeAmount: { value: 0 },
        wipePosition: { value: 0 },
        blurBounds: { value: new Vector2(0.45, 1) },
      },
    });
    const build = (panel: WipePanel): Pass => {
      const { x, y } = sizes[panel];
      return {
        compose: createTarget(x, y, anisotropy),
        frame: createTarget(x, y, anisotropy),
        first: createTarget(x, y, anisotropy),
        second: createTarget(x, y, anisotropy),
        position: panel === 'inner' ? 1 : 0,
        bounds: panel === 'inner' ? new Vector2(0.45, 1) : new Vector2(0, 0.9),
      };
    };
    this.passes = { inner: build('inner'), outer: build('outer') };
  }

  texture(panel: WipePanel): Texture {
    return this.passes[panel].second.texture;
  }

  private draw(renderer: WebGLRenderer, material: RawShaderMaterial, target: WebGLRenderTarget): void {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }

  render(
    renderer: WebGLRenderer,
    panel: WipePanel,
    source: WipeLayers,
    amount: number,
  ): void {
    const pass = this.passes[panel];
    const previousTarget = renderer.getRenderTarget();
    const previousToneMapping = renderer.toneMapping;
    renderer.toneMapping = NoToneMapping;

    const compose = this.composeMaterial.uniforms;
    const landscape = source.landscape;
    compose.backdropMap!.value = source.backdrop;
    compose.skyMap!.value = landscape?.sky ?? source.backdrop;
    compose.mountainMap!.value = landscape?.mountain ?? source.backdrop;
    compose.landscapeOpacity!.value = landscape ? 1 : 0;
    compose.timeMap!.value = source.clock?.time ?? source.backdrop;
    compose.chromeMap!.value = source.clock?.chrome ?? source.backdrop;
    compose.plateOpacity!.value = source.clock ? 1 : 0;
    (compose.backdropFrame!.value as Vector4).copy(source.backdropFrame);
    if (landscape) {
      (compose.skyFrame!.value as Vector4).copy(landscape.skyFrame);
      (compose.mountainFrame!.value as Vector4).copy(landscape.mountainFrame);
      (compose.duneFrame!.value as Vector4).copy(landscape.duneFrame);
    }
    this.draw(renderer, this.composeMaterial, pass.compose);

    this.frameMaterial.uniforms.map!.value = pass.compose.texture;
    this.frameMaterial.uniforms.cornerRadius!.value = FRAME_CORNER * pass.compose.height;
    this.draw(renderer, this.frameMaterial, pass.frame);

    this.blurMaterial.uniforms.wipeAmount!.value = amount;
    this.blurMaterial.uniforms.wipePosition!.value = pass.position;
    (this.blurMaterial.uniforms.blurBounds!.value as Vector2).copy(pass.bounds);
    this.blurMaterial.uniforms.map!.value = pass.frame.texture;
    this.draw(renderer, this.blurMaterial, pass.first);
    this.blurMaterial.uniforms.map!.value = pass.first.texture;
    this.draw(renderer, this.blurMaterial, pass.second);

    renderer.setRenderTarget(previousTarget);
    renderer.toneMapping = previousToneMapping;
  }
}
