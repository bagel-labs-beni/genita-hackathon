"""Export native XCTest render attachments and compare with unchanged Figma references.
Requires Pillow. This script only creates QA images; it does not modify application assets.
"""
from pathlib import Path
import sys, json, subprocess, io
from PIL import Image, ImageCms, ImageDraw, ImageChops, ImageStat
root = Path(__file__).resolve().parents[1]
bundle = root / sys.argv[1]
out = root / sys.argv[2]
raw = out / 'Attachments'; raw.mkdir(parents=True, exist_ok=True)
subprocess.run(['xcrun','xcresulttool','export','attachments','--path',str(bundle),'--output-path',str(raw)],check=True,capture_output=True)
manifest = json.loads((raw/'manifest.json').read_text())
srgb = ImageCms.createProfile('sRGB')
def normalized(path):
    im = Image.open(path)
    if 'icc_profile' in im.info:
        im = ImageCms.profileToProfile(im, ImageCms.ImageCmsProfile(io.BytesIO(im.info['icc_profile'])), srgb, outputMode='RGBA')
    else: im = im.convert('RGBA')
    bg = Image.new('RGBA',im.size,(253,253,253,255)); bg.alpha_composite(im)
    return bg.convert('RGB')
metrics = []
for test in manifest:
    for a in test['attachments']:
        name = a.get('suggestedHumanReadableName','')
        source = raw / a['exportedFileName']
        device = a.get('deviceName','unknown').replace(' ','-').replace('(','').replace(')','')
        if name.startswith('fidelity-'):
            stage = name.split('_')[0].removeprefix('fidelity-')
            reference = root/'DesignReference'/(stage+'.png')
            if not reference.exists(): continue
            native = normalized(source)
            figma = normalized(reference).crop((0,0,*native.size))
            for im in [figma,native]:
                d = ImageDraw.Draw(im); d.rectangle((0,0,im.width,43), fill=(253,253,253))
                if im.height > 804: d.rectangle((0,804,im.width,im.height),fill=(253,253,253))
            directory = out/device; directory.mkdir(exist_ok=True)
            native.save(directory/(stage+'-native.png'))
            compare = Image.new('RGB',(800,native.height+28),'white')
            draw=ImageDraw.Draw(compare);draw.text((8,8),'Figma',fill='black');draw.text((418,8),'iOS (390 pt)',fill='black')
            compare.paste(figma,(0,28));compare.paste(native,(410,28));compare.save(directory/(stage+'-comparison.png'))
            if stage=='name':
                detail=Image.new('RGB',(800,360),'white');dd=ImageDraw.Draw(detail);dd.text((8,8),'Figma',fill='black');dd.text((418,8),'iOS (390 pt)',fill='black')
                detail.paste(figma.crop((0,175,390,515)),(0,24));detail.paste(native.crop((0,175,390,515)),(410,24));detail.save(directory/'name-detail.png')
            diff=ImageChops.difference(figma,native); diff.save(directory/(stage+'-difference.png'))
            metrics.append({'stage':stage,'device':a.get('deviceName'),'meanAbsoluteChannelDifference':round(sum(ImageStat.Stat(diff).mean)/3,3),'note':'Includes rasterization and native-control differences; not a pass percentage.'})
        elif source.suffix=='.png' and name.startswith(('Corrected name screen','Sign in','iPhone conversation','AI reply input')):
            dest=out/'Actual-App';dest.mkdir(exist_ok=True);normalized(source).save(dest/(device+'-'+name.split('_')[0].replace(' ','-')+'.png'))
(out/'comparison-metrics.json').write_text(json.dumps(metrics,ensure_ascii=False,indent=2))
print(f'{len(metrics)} reference comparisons exported to {out}')
