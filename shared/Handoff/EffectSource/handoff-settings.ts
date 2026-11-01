export const DEFAULT_SETTINGS = {duration:3.2,easing:75,blurWidth:90,overlap:0};
export type HandoffSettings = typeof DEFAULT_SETTINGS;
export type SettingKey = keyof HandoffSettings;
export const SETTING_LIMITS:Record<SettingKey,{min:number;max:number;step:number}> = {
  duration:{min:1,max:8,step:.1}, easing:{min:0,max:95,step:1},
  blurWidth:{min:45,max:135,step:1}, overlap:{min:-30,max:30,step:1},
};
export const SETTINGS_KEY='genita-duo-handoff-settings-v1';
export function normalizeSettings(raw:unknown):HandoffSettings {
  const input=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
  const next={...DEFAULT_SETTINGS};
  for(const key of Object.keys(next) as SettingKey[]){
    const value=input[key],limit=SETTING_LIMITS[key];
    if(typeof value==='number'&&Number.isFinite(value)){
      next[key]=Number((Math.round(Math.max(limit.min,Math.min(limit.max,value))/limit.step)*limit.step).toFixed(2));
    }
  }
  return next;
}
export function loadSettings():HandoffSettings {
  try{return normalizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY)||'null'));}
  catch{return {...DEFAULT_SETTINGS};}
}
