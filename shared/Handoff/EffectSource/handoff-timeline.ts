import {DEFAULT_SETTINGS,type HandoffSettings} from './handoff-settings';
// One shared field drives both diffusion and coverage. Settings never change
// the call geometry. Its full travel adapts to the diffusion band's width.
export function handoffProgress(time:number,settings:HandoffSettings=DEFAULT_SETTINGS):number {
  const progress=Math.max(0,Math.min(1,time/settings.duration));
  const eased=progress-settings.easing/100*Math.sin(2*Math.PI*progress)/(2*Math.PI);
  return eased;
}
export function handoffFrame(time:number,outgoing:boolean,settings:HandoffSettings=DEFAULT_SETTINGS):{front:number;incoming:boolean;progress:number} {
  const eased=handoffProgress(time,settings);
  const receiverOffset=1+1.2*settings.blurWidth/100-settings.overlap/100;
  const travel=(receiverOffset+1)*eased;
  return {front:outgoing?travel:receiverOffset-travel,incoming:!outgoing,progress:eased};
}
