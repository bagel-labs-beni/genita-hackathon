import * as THREE from 'three';

// WebGL port of screen 6's local Airdrop.metal + TrailingRipples equations.
// The region is expressed in panel pixels; it is never the full Mac desktop.
export const contactShader = `
uniform vec4 contactRect;
uniform float contactTime;
uniform float contactDirection;
uniform float contactActive;
float contactMask(vec2 point){
  vec2 p=point-contactRect.xy;
  vec2 edge=min(p,contactRect.zw-p);
  return smoothstep(0.,16.*contactRect.z/205.,min(edge.x,edge.y));
}
vec4 contactMotion(vec2 point){
  vec2 screenUV=(point-contactRect.xy)/contactRect.zw;
  vec2 uv=vec2(screenUV.y,contactDirection>0.?screenUV.x:1.-screenUV.x);
  vec2 canonicalSize=contactRect.wz;
  vec2 aspect=vec2(canonicalSize.x/canonicalSize.y,1.);
  vec2 delta=(uv-vec2(.5,.005))*aspect;
  float dist=max(length(delta),.002);
  vec2 radialDirection=delta/dist;
  float t=contactTime;
  float gather=smoothstep(0.,.65,t)*(1.-smoothstep(.85,1.08,t));
  float top=exp(-uv.y*5.);
  vec2 displacement=vec2((uv.x-.5)*gather*top*.045,gather*top*uv.y*.055);
  float radius=max(t-.88,0.)*.83;
  float ring=exp(-pow((dist-radius)/.045,2.))*smoothstep(.88,.94,t)*(1.-smoothstep(1.8,2.2,t));
  float ring2=exp(-pow((dist-(radius-.06))/.028,2.))*smoothstep(.98,1.04,t)*(1.-smoothstep(1.8,2.2,t));
  displacement+=radialDirection/aspect*(ring*.014-ring2*.004);
  float total=0.;
  float scale=contactRect.z/205.;
  float travel=max(uv.y*205.,0.);
  for(int i=0;i<3;i++){
    float local=t-.95-float(i)*.17-travel/330.;
    if(local>0.)total+=12.*pow(.72,float(i))*sin(20.*local)*exp(-4.6*local);
  }
  vec2 offset=vec2(contactDirection*displacement.y*contactRect.z,displacement.x*contactRect.w);
  offset.x+=contactDirection*total*scale;
  float glow=exp(-pow((uv.x-.5)*2.7,2.)-uv.y*12.)*gather;
  float flash=exp(-pow((t-.92)/.1,2.))*exp(-dist*5.);
  return vec4(offset,glow*.65+flash*.5+ring*.22+.12*total/12.,gather*top*5.+ring*2.);
}`;

export class ContactOverlay {
 readonly material:THREE.ShaderMaterial;
 readonly mesh:THREE.Mesh<THREE.PlaneGeometry,THREE.ShaderMaterial>;
 constructor(width:number,height:number){
  this.material=new THREE.ShaderMaterial({transparent:true,depthTest:false,depthWrite:false,toneMapped:false,
   uniforms:{contactRect:{value:new THREE.Vector4()},contactTime:{value:0},contactDirection:{value:1},contactActive:{value:0},panelSize:{value:new THREE.Vector2(width,height)},callRect:{value:new THREE.Vector4()},sourceOutline:{value:0}},
   vertexShader:'varying vec2 point;uniform vec2 panelSize;void main(){point=vec2(uv.x,1.-uv.y)*panelSize;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}',
   fragmentShader:contactShader+`
    varying vec2 point;uniform vec4 callRect;uniform float sourceOutline;
    void main(){
      float mask=contactMask(point)*contactActive;
      if(mask<=0.)discard;
      vec2 p=(point-contactRect.xy)*205./contactRect.z;
      vec2 size=contactRect.zw*205./contactRect.z;
      float t=contactTime;
      float envelope=max(0.,sin(clamp(t/3.6,0.,1.)*3.14159265));
      float along=contactDirection>0.?p.x:size.x-p.x;
      float edgeGlow=exp(-along/32.-pow((p.y-size.y*.5)/130.,2.))*envelope*.12;
      float rings=0.;float shadows=0.;
      for(int i=0;i<3;i++){
        float q=clamp((t-.95-float(i)*.17)/1.45,0.,1.);
        float r=20.+q*460.;
        float x=contactDirection>0.?-r*.7:size.x+r*.7;
        float distanceToRing=length(p-vec2(x,size.y*.5))-r;
        float strength=sin(q*3.14159265)*pow(.78,float(i));
        rings+=exp(-pow(distanceToRing/3.,2.))*strength*.2;
        shadows+=exp(-pow((distanceToRing-4.)/4.,2.))*strength*.07;
      }
      // A short neutral pulse belongs only to the sending call. Inset the
      // phone outline so its stroke is visible inside the screen's clipping.
      float scale=contactRect.z/205.;
      float radius=callRect.z*.065;
      vec2 c=point-(callRect.xy+callRect.zw*.5);
      vec2 q=abs(c)-(callRect.zw*.5-vec2(radius+3.*scale));
      float roundedDistance=length(max(q,0.))+min(max(q.x,q.y),0.)-radius;
      float glowEnvelope=smoothstep(.03,.2,t)*(1.-smoothstep(.65,1.15,t));
      float outline=exp(-pow(roundedDistance/(2.5*scale),2.))*glowEnvelope*.5*sourceOutline;
      vec2 regionPoint=point-contactRect.xy;
      vec2 regionEdge=min(regionPoint,contactRect.zw-regionPoint);
      float outlineMask=smoothstep(0.,3.*scale,min(regionEdge.x,regionEdge.y))*contactActive;
      float light=(edgeGlow+rings)*mask+outline*outlineMask;
      float shade=shadows*mask;
      float alpha=clamp(light+shade,0.,.65);
      vec3 color=vec3((.94*light+.22*shade)/max(light+shade,.00001));
      gl_FragColor=vec4(color,alpha);
    }`,
  });
  this.mesh=new THREE.Mesh(new THREE.PlaneGeometry(width,height),this.material);this.mesh.renderOrder=2;this.mesh.visible=false;
 }
 update(active:boolean,rect:THREE.Vector4,time:number,reverse:boolean,callRect:THREE.Vector4,outgoing:boolean){
  this.mesh.visible=active;const u=this.material.uniforms;
  u.sourceOutline!.value=outgoing?1:0;
  u.contactRect!.value.copy(rect);u.contactTime!.value=time;u.contactDirection!.value=reverse?-1:1;u.contactActive!.value=active?1:0;u.callRect!.value.copy(callRect);
 }
}
