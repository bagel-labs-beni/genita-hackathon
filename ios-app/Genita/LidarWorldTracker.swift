import SwiftUI
import ARKit
import Vision
import SceneKit
import CoreImage
import AVFoundation

final class LidarWorldTracker:NSObject,ObservableObject,ARSessionDelegate {
 @Published var centerDownMM:Double=(UserDefaults.standard.object(forKey:"lidar.centerDownMM") as? Double) ?? 55 { didSet { UserDefaults.standard.set(centerDownMM,forKey:"lidar.centerDownMM") } }
 @Published var centerRightMM:Double=(UserDefaults.standard.object(forKey:"lidar.centerRightMM") as? Double) ?? 0 { didSet { UserDefaults.standard.set(centerRightMM,forKey:"lidar.centerRightMM") } }
 @Published var running=false
 @Published var canLock=false
 @Published var status="맥에서 LiDAR 기준 화면을 전체 화면으로 연 뒤 시작하세요."
 let session=ARSession()
 private let queue=DispatchQueue(label:"genita.lidar.world")
 private let imageContext=CIContext(options:[.workingColorSpace:NSNull()])
 var onReading: (([String:Any])->Void)?
 private var active=false,last=0.0,generation=0
 private var candidate:Screen?,locked:Screen?,stable=0
 private var registrationFrames=[Screen]()
 private var restoring:(Float,Float)?,saving=false,lastSave=0.0,restoreStarted=0.0
 private var originalURL:URL?
 private struct SavedSpace:Codable {let geometryVersion:Int;let map:Data;let width:Float;let height:Float;let host:String}
 private var mapURL:URL {FileManager.default.urls(for:.applicationSupportDirectory,in:.userDomainMask)[0].appendingPathComponent("GenitaLidar/space.json")}
 private func configuration()->ARWorldTrackingConfiguration {let c=ARWorldTrackingConfiguration();c.worldAlignment = .gravity;c.frameSemantics = [.sceneDepth];c.planeDetection = [.vertical,.horizontal];return c}
 func resetScreen(){queue.async {
  self.generation+=1;self.locked=nil;self.restoring=nil;self.candidate=nil;self.stable=0;self.registrationFrames=[];self.lastSave=0
  try? FileManager.default.removeItem(at:self.mapURL)
  if self.active {self.session.run(self.configuration(),options:[.resetTracking,.removeExistingAnchors])}
  self.send(["state":"searching"]);self.publish("청록색 화면 자동 탐색 중")
  DispatchQueue.main.async{self.canLock=false}
 }}
 private func saveSpace(_ frame:ARFrame){
  guard !saving,frame.timestamp-lastSave>3,case .mapped=frame.worldMappingStatus,let screen=locked else{return}
  saving=true;lastSave=frame.timestamp;let epoch=generation
  session.getCurrentWorldMap{map,error in self.queue.async{
   defer{self.saving=false}
   guard self.active,self.generation==epoch,let map,map.anchors.contains(where:{$0.name=="genita-lidar-screen"}) else{return}
   do {
    let data=try NSKeyedArchiver.archivedData(withRootObject:map,requiringSecureCoding:true)
    let saved=SavedSpace(geometryVersion:2,map:data,width:screen.width,height:screen.height,host:self.originalURL?.host ?? "")
    try FileManager.default.createDirectory(at:self.mapURL.deletingLastPathComponent(),withIntermediateDirectories:true)
    try JSONEncoder().encode(saved).write(to:self.mapURL,options:.atomic)

   }catch{self.publish("공간 저장 실패 · 현재 추적은 유지됩니다")}
  }}
 }
 private struct Screen {var pose:simd_float4x4;var width:Float;var height:Float}
 override init(){super.init();session.delegate=self;session.delegateQueue=queue
  let args=ProcessInfo.processInfo.arguments
  if let i=args.firstIndex(of:"--lidar-center-down"),args.indices.contains(i+1),let v=Double(args[i+1]),(0...90).contains(v){centerDownMM=v;UserDefaults.standard.set(v,forKey:"lidar.centerDownMM")}
  if let i=args.firstIndex(of:"--lidar-center-right"),args.indices.contains(i+1),let v=Double(args[i+1]),(-35...35).contains(v){centerRightMM=v;UserDefaults.standard.set(v,forKey:"lidar.centerRightMM")}
 }
 func start(_ original:URL){
  guard !running else{return}
  guard ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else{status="이 기기는 LiDAR 깊이 측정을 지원하지 않습니다";return}

  AVCaptureDevice.requestAccess(for:.video){ok in guard ok else{self.publish("카메라 권한이 필요합니다");return};self.queue.async{
   self.generation+=1;self.active=true;self.locked=nil;self.candidate=nil;self.stable=0;self.registrationFrames=[];self.last=0;self.lastSave=0;self.originalURL=original;self.restoring=nil;self.restoreStarted=0
   let config=self.configuration()
   if let data=try? Data(contentsOf:self.mapURL),let saved=try? JSONDecoder().decode(SavedSpace.self,from:data),saved.geometryVersion==2,saved.host==original.host,saved.width>0,saved.height>0,
      let map=try? NSKeyedUnarchiver.unarchivedObject(ofClass:ARWorldMap.self,from:saved.map),map.anchors.contains(where:{$0.name=="genita-lidar-screen"}) {
    config.initialWorldMap=map;self.restoring=(saved.width,saved.height)
   }
   self.session.run(config,options:[.resetTracking,.removeExistingAnchors]);DispatchQueue.main.async{self.running=true;self.canLock=false};self.publish(self.restoring == nil ? "청록색 테스트 화면 자동 탐색 중" : "저장된 공간 복구 중 · 이전에 본 주변을 비춰 주세요")
  }}
 }
 private func registerScreen(_ c:Screen){
  guard active else{return};restoring=nil;locked=c
  for a in session.currentFrame?.anchors ?? [] where a.name=="genita-lidar-screen" {session.remove(anchor:a)}
  session.add(anchor:ARAnchor(name:"genita-lidar-screen",transform:c.pose))
  publish("화면 자동 등록됨 · 이제 맥 옆으로 이동하세요")
  DispatchQueue.main.async{self.canLock=false}
 }
 func stop(){queue.async{self.active=false;self.generation+=1;self.session.pause();self.locked=nil;self.send(["state":"stopped"]);DispatchQueue.main.async{self.running=false;self.canLock=false;self.status="중지됨"}}}
 private func publish(_ s:String){DispatchQueue.main.async{self.status=s}}
 func sessionWasInterrupted(_ session:ARSession){queue.async{self.send(["state":"limited","reason":"카메라 중단 · 공간 복구 대기"]);self.publish("카메라 중단 · 공간 복구 대기")}}
 func session(_ session:ARSession,didFailWithError error:Error){publish(error.localizedDescription);stop()}
 func session(_ session:ARSession,didUpdate anchors:[ARAnchor]){guard let a=anchors.first(where:{$0.name=="genita-lidar-screen"}),var s=locked else{return};s.pose=a.transform;locked=s}
 func session(_ session:ARSession,didUpdate frame:ARFrame){
  guard active,frame.timestamp - last > 0.15 else{return};last=frame.timestamp
  if restoring != nil {
   if restoreStarted==0{restoreStarted=frame.timestamp}
   if frame.timestamp-restoreStarted>12 {
    restoring=nil;locked=nil;candidate=nil;stable=0;generation+=1
    session.run(configuration(),options:[.resetTracking,.removeExistingAnchors])
    send(["state":"searching","reason":"공간 복구 대기 종료 · 화면 자동 탐색으로 전환"])
    publish("공간 복구 대기 종료 · 청록색 화면 자동 탐색 중");return
   }
  }
  guard case .normal=frame.camera.trackingState else{
   let reason:String
   switch frame.camera.trackingState {
   case .limited(.excessiveMotion):reason="빠른 움직임 · 천천히 움직여 주세요"
   case .limited(.insufficientFeatures):reason="주변 특징 부족 · 후면 카메라를 방 쪽으로 향해 주세요"
   case .limited(.relocalizing):reason="기존 공간 좌표 복구 중"
   default:reason="공간 추적 초기화 중"
   }
   send(["state":"limited","reason":reason]);publish(reason);return
  }
  if let dims=restoring {
   guard let anchor=frame.anchors.first(where:{$0.name=="genita-lidar-screen"}) else {
    send(["state":"limited","reason":"저장된 화면 기준 복구 대기"]);return
   }
   locked=Screen(pose:anchor.transform,width:dims.0,height:dims.1);restoring=nil
  }
  if let s=locked{
   saveSpace(frame)
   // Portrait view basis rotates the camera-to-body offset with the handset.
   // Defaults are adjustable estimates, not measured optical-center geometry.
   let body=simd_inverse(frame.camera.viewMatrix(for:.portrait))
   var offsets=(0.0,0.0)
   DispatchQueue.main.sync { offsets=(self.centerRightMM,self.centerDownMM) }
   let world=body * SIMD4<Float>(Float(offsets.0/1000),Float(-offsets.1/1000),0,1)
   let p=simd_inverse(s.pose)*world
   guard p.x.isFinite,p.y.isFinite,p.z.isFinite else{return}
   // Match physical vertical height, rather than orthogonally projecting onto
   // a tilted screen: the latter mixes front/back distance into screen Y.
   let vertical=s.pose.columns.1.y
   guard abs(vertical)>0.5 else{send(["state":"limited","reason":"화면 수직 기준 불안정 · 재등록 필요"]);return}
   let depthHeightCorrection=p.z*s.pose.columns.2.y/vertical
   let alignedY=p.y+depthHeightCorrection
   send(["state":"tracking","x":p.x,"y":alignedY,"z":p.z,"rawPlaneY":p.y,"depthHeightCorrection":depthHeightCorrection,"screenNormalY":s.pose.columns.2.y,"widthM":s.width,"heightM":s.height,"reference":"phone-center-estimate","centerDownMM":offsets.1,"centerRightMM":offsets.0,"spaceSaved":FileManager.default.fileExists(atPath:mapURL.path),"lidarAvailable":frame.sceneDepth != nil])
   publish(String(format:"공간 추적 중 · 좌우 %+.0f / 높이 %+.0f / 앞뒤 %+.0f cm",p.x*100,alignedY*100,p.z*100));return
  }
  let request=VNDetectRectanglesRequest();request.maximumObservations=6;request.minimumConfidence=0.8;request.minimumSize=0.2;request.minimumAspectRatio=0.2;request.maximumAspectRatio=1.0
  do{try VNImageRequestHandler(cvPixelBuffer:frame.capturedImage,orientation:.up).perform([request])}catch{return}
  let screens=(request.results ?? []).filter{isTestScreen($0,frame)}.compactMap{screen($0,frame)}.sorted{$0.width*$0.height>$1.width*$1.height}
  guard let next=screens.first else{stable=0;registrationFrames=[];candidate=nil;DispatchQueue.main.async{self.canLock=false};send(["state":"searching"]);publish("청록색 화면 탐색 중 · 색상·깊이·테두리 확인");return}
  if let old=candidate,simd_distance(old.pose.columns.3,next.pose.columns.3)<0.03,abs(old.width-next.width)<0.04,abs(old.height-next.height)<0.04,simd_dot(old.pose.columns.2,next.pose.columns.2)>0.995{stable+=1}else{stable=1}
  candidate=next;if stable==1{registrationFrames=[]};registrationFrames.append(next);if registrationFrames.count>8{registrationFrames.removeFirst()};let ok=registrationFrames.count>=8;DispatchQueue.main.async{self.canLock=ok}
  if ok {
   let origin=registrationFrames.map{$0.pose.columns.3}.reduce(SIMD4<Float>.zero,+)/Float(registrationFrames.count)
   guard registrationFrames.allSatisfy({simd_distance($0.pose.columns.3,origin)<0.015}) else{stable=0;registrationFrames=[];return}
   let normal4=registrationFrames.map{$0.pose.columns.2}.reduce(SIMD4<Float>.zero,+)
   let normal=simd_normalize(SIMD3<Float>(normal4.x,normal4.y,normal4.z))
   let right=simd_normalize(simd_cross(SIMD3<Float>(0,1,0),normal)),up=simd_normalize(simd_cross(normal,right))
   let screen=Screen(pose:simd_float4x4(SIMD4<Float>(right,0),SIMD4<Float>(up,0),SIMD4<Float>(normal,0),origin),width:registrationFrames.map{$0.width}.reduce(0,+)/8,height:registrationFrames.map{$0.height}.reduce(0,+)/8)
   registerScreen(screen);return
  }
  send(["state":"candidate","widthM":next.width,"heightM":next.height,"stable":ok])
  publish(String(format:"화면 후보 %.0f × %.0f cm · %@",next.width*100,next.height*100,"자동 등록 확인 중 \(stable)/8"))
 }
 // Temporary test-screen signature, not a general Mac identity detector.
 private func isTestScreen(_ rect:VNRectangleObservation,_ frame:ARFrame)->Bool {
  let source=CIImage(cvPixelBuffer:frame.capturedImage)
  let middle=CGPoint(x:(rect.topLeft.x+rect.topRight.x+rect.bottomLeft.x+rect.bottomRight.x)/4,y:(rect.topLeft.y+rect.topRight.y+rect.bottomLeft.y+rect.bottomRight.y)/4)
  var matches=0
  for corner in [rect.bottomLeft,rect.bottomRight,rect.topRight] {
   let x=(middle.x+(corner.x-middle.x)*0.45)*source.extent.width
   let y=(middle.y+(corner.y-middle.y)*0.45)*source.extent.height
   let area=CGRect(x:x-4,y:y-4,width:8,height:8).intersection(source.extent)
   guard !area.isEmpty,let mean=CIFilter(name:"CIAreaAverage",parameters:[kCIInputImageKey:source,kCIInputExtentKey:CIVector(cgRect:area)])?.outputImage else{continue}
   var rgba=[UInt8](repeating:0,count:4)
   imageContext.render(mean,toBitmap:&rgba,rowBytes:4,bounds:CGRect(x:0,y:0,width:1,height:1),format:.RGBA8,colorSpace:CGColorSpaceCreateDeviceRGB())
   let r=Float(rgba[0])/255,g=Float(rgba[1])/255,b=Float(rgba[2])/255
   if g>0.12,b>0.12,g>r*1.35,b>r*1.35,abs(g-b)<0.25{matches+=1}
  }
  return matches==3
 }
 private func screen(_ rect:VNRectangleObservation,_ frame:ARFrame)->Screen?{
  // Vision points are bottom-left normalized in the raw camera image.
  let corners=[rect.topLeft,rect.topRight,rect.bottomRight,rect.bottomLeft]
  let centre=corners.reduce(CGPoint.zero){CGPoint(x:$0.x+$1.x/4,y:$0.y+$1.y/4)}
  let points=corners.map{CGPoint(x:centre.x+($0.x-centre.x)*0.8,y:centre.y+($0.y-centre.y)*0.8)}
  let world=points.compactMap{unproject($0,frame)};guard world.count==4 else{return nil}
  var origin=world.reduce(SIMD3<Float>.zero,+)/4
  var normal=simd_normalize(simd_cross(world[1]-world[0],world[3]-world[0]));guard normal.x.isFinite,abs(normal.y)<0.4 else{return nil}
  let cam=SIMD3<Float>(frame.camera.transform.columns.3.x,frame.camera.transform.columns.3.y,frame.camera.transform.columns.3.z)
  if simd_dot(normal,cam-origin)<0{normal = -normal}
  let right=simd_normalize(simd_cross(SIMD3<Float>(0,1,0),normal)),up=simd_normalize(simd_cross(normal,right))
  // Intersect full-corner rays with the depth plane. Scaling image insets by
  // 1/0.8 in world space is incorrect under perspective and biases the centre.
  let k=frame.camera.intrinsics,res=frame.camera.imageResolution
  let full=corners.compactMap{point -> SIMD3<Float>? in
   let local=SIMD4<Float>((Float(point.x*res.width)-k[2,0])/k[0,0],-(Float((1-point.y)*res.height)-k[2,1])/k[1,1],-1,0)
   let ray4=frame.camera.transform*local,ray=SIMD3<Float>(ray4.x,ray4.y,ray4.z)
   let denominator=simd_dot(ray,normal)
   guard abs(denominator)>0.1 else{return nil}
   let t=simd_dot(origin-cam,normal)/denominator
   guard t>0,t<4 else{return nil};return cam+ray*t
  }
  guard full.count==4 else{return nil}
  origin=full.reduce(SIMD3<Float>.zero,+)/4
  let xs=full.map{simd_dot($0-origin,right)},ys=full.map{simd_dot($0-origin,up)}
  let width=xs.max()!-xs.min()!,height=ys.max()!-ys.min()!
  guard width>0.25,width<1.8,height>0.15,height<1.2,width/height>1.2,width/height<2.6,world.allSatisfy({abs(simd_dot($0-origin,normal))<0.025}) else{return nil}
  return Screen(pose:simd_float4x4(SIMD4<Float>(right,0),SIMD4<Float>(up,0),SIMD4<Float>(normal,0),SIMD4<Float>(origin,1)),width:width,height:height)
 }
 private func unproject(_ point:CGPoint,_ frame:ARFrame)->SIMD3<Float>?{
  guard let depth=frame.sceneDepth else{return nil};let b=depth.depthMap
  CVPixelBufferLockBaseAddress(b,.readOnly);defer{CVPixelBufferUnlockBaseAddress(b,.readOnly)}
  let w=CVPixelBufferGetWidth(b),h=CVPixelBufferGetHeight(b),stride=CVPixelBufferGetBytesPerRow(b)/4
  guard let data=CVPixelBufferGetBaseAddress(b)?.assumingMemoryBound(to:Float.self) else{return nil}
  let px=Int(point.x*Double(w)),py=Int((1-point.y)*Double(h));var values=[Float]()
  for y in max(0,py-2)...min(h-1,py+2){for x in max(0,px-2)...min(w-1,px+2){let d=data[y*stride+x];if d.isFinite,d>0.15,d<3{values.append(d)}}}
  guard values.count>=12 else{return nil};values.sort();let d=values[values.count/2];guard values[values.count*3/4]-values[values.count/4]<0.04 else{return nil}
  let k=frame.camera.intrinsics,res=frame.camera.imageResolution
  let u=Float(point.x*res.width),v=Float((1-point.y)*res.height)
  let p=frame.camera.transform*SIMD4<Float>((u-k[2,0])/k[0,0]*d,-(v-k[2,1])/k[1,1]*d,-d,1)
  return SIMD3<Float>(p.x,p.y,p.z)
 }
 private func send(_ obj:[String:Any]) {
  DispatchQueue.main.async { self.onReading?(obj) }
 }
}
