import * as THREE from 'three';
import wipeSource from './wipe-source.txt';
import {contactShader} from './contact-effect';

// Import Duo's actual cubic B-spline sampler, LOD interpolation, blur-strength
// equation. Coverage now follows that same spatial field, never a layer fade.
// Keep the reference implementation untouched.
function originalShader(name: string): string {
  const source = wipeSource.match(new RegExp(`const ${name} = \u0060([\\s\\S]*?)\u0060;`))?.[1];
  if (!source) throw new Error(`Duo shader ${name} not found`);
  return source;
}
const vertexShader = originalShader('QUAD_VERTEX');
const fragmentShader = originalShader('BLUR_FRAGMENT')
  // A finite mip chain must never be queried past its last level. The original
  // source assumes its own screen target sizes; the call has a different size.
  .replace('vec2 lodSizeFloor =', 'lod = clamp(lod, 0.0, floor(log2(float(max(textureSize(s, 0).x, textureSize(s, 0).y)))) - 0.001);\n  vec2 lodSizeFloor =')
  .replace('uniform vec2 blurBounds;', `uniform vec2 blurBounds;
    uniform vec2 payloadScale;
    uniform float reverse;
    uniform float incoming;`)
  .replace('float distanceToWipe = distance(vUv.x, wipePosition);', `
    vec2 payloadUv = (vUv - 0.5) * payloadScale + 0.5;
    float along = mix(payloadUv.x, 1.0 - payloadUv.x, reverse);
    float distanceToWipe = wipePosition + mix(-along, along, incoming);`)
  // The reference dims into opaque hardware. Keep its blur unattenuated here;
  // the final compositor uses the same shade curve for local coverage instead.
  .replace('vec3 shade = vec3(smoothstep(1.3, 0.9, blurArea) * smoothstep(1.0, 0.9, distance(vUv.y, 0.5) * 2.0));', 'vec3 shade = vec3(1.0);');

function target(width: number, height: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: false, generateMipmaps: true,
    minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    type: THREE.HalfFloatType,
  });
}

export class DuoPayloadWipe {
  readonly expansion: THREE.Vector2;
  readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-.5,.5,.5,-.5,0,1);
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(1,1));
  private readonly source: THREE.CanvasTexture;
  private readonly first: THREE.WebGLRenderTarget;
  private readonly second: THREE.WebGLRenderTarget;
  private readonly blur: THREE.RawShaderMaterial;

  constructor(payload: HTMLCanvasElement, rounded: boolean) {
    // Transparent sampling overscan avoids edge-colour clamping in the blur.
    // The final alpha remains the original stationary call-window silhouette.
    const pad=128;
    const c=document.createElement('canvas');c.width=payload.width+pad*2;c.height=payload.height+pad*2;
    const ctx=c.getContext('2d')!;
    if(rounded){ctx.beginPath();ctx.roundRect(pad,pad,payload.width,payload.height,24);ctx.clip();}
    ctx.drawImage(payload,pad,pad);
    this.expansion=new THREE.Vector2(c.width/payload.width,c.height/payload.height);
    this.source=new THREE.CanvasTexture(c);
    this.source.colorSpace=THREE.SRGBColorSpace;
    this.source.premultiplyAlpha=true;
    this.first=target(c.width,c.height);this.second=target(c.width,c.height);
    this.blur=new THREE.RawShaderMaterial({
      glslVersion:THREE.GLSL3,vertexShader,fragmentShader,
      depthTest:false,depthWrite:false,blending:THREE.NoBlending,
      uniforms:{map:{value:this.source},wipeAmount:{value:0},wipePosition:{value:1},
        blurBounds:{value:new THREE.Vector2(0,.9)},payloadScale:{value:this.expansion},reverse:{value:0},incoming:{value:0}},
    });
    this.scene.add(this.quad);this.quad.material=this.blur;
    this.material=new THREE.ShaderMaterial({
      transparent:true,premultipliedAlpha:true,depthTest:false,depthWrite:false,toneMapped:false,
      uniforms:{map:{value:this.source},sourceMap:{value:this.source},front:{value:0},reverse:{value:0},incoming:{value:0},blurWidth:{value:.9},payloadScale:{value:this.expansion},panelSize:{value:new THREE.Vector2()},payloadExtent:{value:new THREE.Vector2()},contactRect:{value:new THREE.Vector4()},contactTime:{value:0},contactDirection:{value:1},contactActive:{value:0},outsideVisibility:{value:1},contactLimit:{value:0},contactWarp:{value:1}},
      vertexShader:'varying vec2 vUv;varying vec2 panelPoint;uniform vec2 panelSize;void main(){vUv=uv;vec4 world=modelMatrix*vec4(position,1.);panelPoint=vec2(world.x+panelSize.x*.5,panelSize.y*.5-world.y);gl_Position=projectionMatrix*viewMatrix*world;}',
      fragmentShader:contactShader+`uniform sampler2D map;uniform sampler2D sourceMap;
        uniform float front;uniform float reverse;uniform float incoming;uniform float blurWidth;
        uniform vec2 payloadScale;uniform vec2 payloadExtent;uniform float outsideVisibility;uniform float contactLimit;uniform float contactWarp;
        varying vec2 vUv;varying vec2 panelPoint;
        void main(){
          float local=contactMask(panelPoint)*contactActive;
          vec4 motion=vec4(0.);
          // Never evaluate the contact field outside its patch or at rest:
          // its exponential terms can overflow there (Infinity * 0 is NaN).
          if(local>0.) motion=contactMotion(panelPoint)*local;
          motion.xy*=contactWarp;
          vec2 warped=vUv+vec2(motion.x,-motion.y)/payloadExtent;
          vec4 c=texture2D(map,warped);
          // The 6th demo's gathering blur, restricted to the contact patch.
          float weight=1.;
          if(motion.w>.02){for(int j=0;j<8;j++){
            float a=float(j)*.785398163;
            vec2 offset=vec2(cos(a),sin(a))*motion.w/payloadExtent;
            c+=texture2D(map,warped+offset)*.65;weight+=.65;
            c+=texture2D(map,warped+offset*.45)*.35;weight+=.35;
          }}
          c/=weight;
          vec2 payloadUv=(vUv-.5)*payloadScale+.5;
          float along=mix(payloadUv.x,1.-payloadUv.x,reverse);
          float distanceToWipe=front+mix(-along,along,incoming);
          // Exact outer-screen blur equation and shade thresholds from Duo.
          // A pixel stays opaque until its LOD is already >= 7.2. Recognizable
          // detail therefore never crossfades with icons or desktop underneath.
          float blurArea=clamp(distanceToWipe/blurWidth*(1./3.)*2.5,0.,1.)/.75;
          float coverage=texture2D(sourceMap,vUv).a*(1.-smoothstep(.9,1.3,blurArea));
          vec3 color=c.a>0.00001?c.rgb/c.a:vec3(0.);
          color=clamp(color+vec3(.92)*motion.z,0.,1.);
          vec4 original=texture2D(sourceMap,vUv);
          vec3 originalColor=original.a>.00001?original.rgb/original.a:vec3(0.);
          // Outside the phone-sized patch, only the call payload fades. The
          // separately rendered home/desktop is never displaced or faded.
          float region=mix(1.,local,contactActive*contactLimit);
          float alpha=mix(original.a*outsideVisibility,coverage,region);
          vec3 premultiplied=mix(originalColor*original.a*outsideVisibility,color*coverage,region);
          gl_FragColor=vec4(alpha>.00001?premultiplied/alpha:vec3(0.),alpha);
          #include <colorspace_fragment>
          gl_FragColor.rgb*=gl_FragColor.a;
        }`,
    });
  }

  dispose(){this.source.dispose();this.first.dispose();this.second.dispose();this.blur.dispose();this.material.dispose();this.quad.geometry.dispose();}

  render(renderer:THREE.WebGLRenderer,front:number,reverse:boolean,incoming=false,blurWidth=.9):void {
    this.material.uniforms.blurWidth!.value=blurWidth;
    this.blur.uniforms.blurBounds!.value.set(0,blurWidth);
    this.material.uniforms.front!.value=front;
    this.material.uniforms.reverse!.value=reverse?1:0;
    this.material.uniforms.incoming!.value=incoming?1:0;
    if(!incoming&&front<=0){this.material.uniforms.map!.value=this.source;return;}
    const previous=renderer.getRenderTarget();
    const tone=renderer.toneMapping;
    renderer.toneMapping=THREE.NoToneMapping;
    const u=this.blur.uniforms;
    u.wipeAmount!.value=1/3;
    // One moving field crosses the sender then resolves on the receiver.
    // Mirroring changes the field direction only, never image coordinates.
    u.wipePosition!.value=front;
    u.reverse!.value=reverse?1:0;
    u.incoming!.value=incoming?1:0;
    u.map!.value=this.source;
    renderer.setRenderTarget(this.first);renderer.clear();renderer.render(this.scene,this.camera);
    u.map!.value=this.first.texture;
    renderer.setRenderTarget(this.second);renderer.clear();renderer.render(this.scene,this.camera);
    this.material.uniforms.map!.value=this.second.texture;
    renderer.setRenderTarget(previous);renderer.toneMapping=tone;
  }
}
