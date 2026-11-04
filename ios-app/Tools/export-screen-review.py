"""Export unmodified full iOS Simulator screenshots attached by the review UI test."""
from pathlib import Path
import json, subprocess, shutil, sys
from PIL import Image, ImageDraw
root=Path(__file__).resolve().parents[1]
out=root/'iOS-Screen-Review'
itemsByName={}
for bundleName in (sys.argv[1:] or ['iOS-Screen-Review.xcresult']):
 raw=out/('Attachments' if bundleName=='iOS-Screen-Review.xcresult' else 'Transient-Attachments')
 raw.mkdir(parents=True,exist_ok=True)
 if not (raw/'manifest.json').exists():
  subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(root/bundleName),'--output-path',str(raw)],check=True,capture_output=True)
 for test in json.loads((raw/'manifest.json').read_text()):
     for a in test['attachments']:
         name=a.get('suggestedHumanReadableName','').split('_')[0]
         if not name.startswith('ios-review-'): continue
         name=name.removeprefix('ios-review-')
         dest=out/(name+'.png'); shutil.copyfile(raw/a['exportedFileName'],dest)
         im=Image.open(dest)
         itemsByName[name] = {'name':name,'path':str(dest),'pixelWidth':im.width,'pixelHeight':im.height,'displayWidth':im.width/3,'displayHeight':im.height/3,'device':a.get('deviceName'),'timestamp':a.get('timestamp')}
items=list(itemsByName.values())
items.sort(key=lambda x:x['name'])
(out/'manifest.json').write_text(json.dumps(items,ensure_ascii=False,indent=2))
w=160; h=348; cols=8; step=178; rowh=378
sheet=Image.new('RGB',(cols*step,((len(items)+cols-1)//cols)*rowh),'#dedede'); d=ImageDraw.Draw(sheet)
for i,a in enumerate(items):
    x=(i%cols)*step;y=(i//cols)*rowh
    im=Image.open(a['path']).convert('RGB');im.thumbnail((w,h));sheet.paste(im,(x,y+22));d.text((x,y+4),a['name'].split('-')[0],fill='black')
sheet.save(out/'contact-sheet.jpg')
print(json.dumps({'count':len(items),'sizes':list(set((x['pixelWidth'],x['pixelHeight']) for x in items))}))
