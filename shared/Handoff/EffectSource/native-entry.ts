import * as THREE from 'three';
import {DuoPayloadWipe} from './duo-payload-wipe';
import {handoffFrame} from './handoff-timeline';
const renderer=new THREE.WebGLRenderer({alpha:true,antialias:true,premultipliedAlpha:true});
renderer.setClearColor(0,0);renderer.setPixelRatio(Math.min(devicePixelRatio,2));document.body.appendChild(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-.5,.5,.5,-.5,0,10);camera.position.z=1;
let effect:DuoPayloadWipe|undefined, mesh:THREE.Mesh|undefined;
let start=0,outgoing=true,reverse=false,readyID="",announced=false;
(window as any).configure=(base64:string,at:number,send:boolean,rev:boolean,id:string="")=>{
 const image=new Image();image.onload=()=>{
  const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d')!.drawImage(image,0,0);
  if(mesh){scene.remove(mesh);mesh.geometry.dispose();}effect?.dispose();effect=new DuoPayloadWipe(canvas,false);
  effect.material.uniforms.payloadExtent.value.set(canvas.width+256,canvas.height+256);
  effect.material.uniforms.panelSize.value.set(1,1);effect.material.uniforms.contactRect.value.set(0,0,1,1);
  mesh=new THREE.Mesh(new THREE.PlaneGeometry(effect.expansion.x,effect.expansion.y),effect.material);scene.add(mesh);
  start=at;outgoing=send;reverse=rev;readyID=id;announced=false;
 };image.src='data:image/png;base64,'+base64;
};
function draw(){requestAnimationFrame(draw);renderer.setSize(innerWidth,innerHeight,false);
 if(effect){const t=(Date.now()-start)/1000;const frame=handoffFrame(Math.max(0,Math.min(3.2,t)),outgoing);effect.render(renderer,frame.front,reverse,frame.incoming);}
 renderer.setRenderTarget(null);renderer.clear();renderer.render(scene,camera);
 if(effect&&!announced){announced=true;const id=readyID;requestAnimationFrame(()=>{
  if(id===readyID)(window as any).webkit?.messageHandlers?.duoFrame?.postMessage(id);
 });}
}draw();
// Native integration smoke-test hook: sample the rendered framebuffer, not the
// completion timer, so a transparent/invalid shader cannot pass the check.
(window as any).inspectEffect=()=>{
 if(!effect)return {ready:false};
 const frame=handoffFrame(Math.max(0,Math.min(3.2,(Date.now()-start)/1000)),outgoing);
 effect.render(renderer,frame.front,reverse,frame.incoming);renderer.setRenderTarget(null);renderer.clear();renderer.render(scene,camera);
 const gl=renderer.getContext(),pixels=new Uint8Array(64*4);
 gl.readPixels(Math.floor(gl.drawingBufferWidth/2)-32,Math.floor(gl.drawingBufferHeight/2),64,1,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
 return {ready:true,alpha:Math.max(...Array.from(pixels).filter((_,i)=>i%4===3)),error:gl.getError(),progress:frame.progress};
};
