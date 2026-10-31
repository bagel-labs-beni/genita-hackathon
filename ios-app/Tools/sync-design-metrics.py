import json,pathlib
root=pathlib.Path(__file__).resolve().parents[1]
result={}
for f in (root/'DesignReference').glob('*.json'):
 d=json.load(open(f)); arr=[]
 def walk(nodes,ox=0,oy=0,skip=False):
  for n in nodes:
   x=ox+n.get('x',0);y=oy+n.get('y',0)
   ignore=skip or n.get('name')=='Status bar'
   if not ignore:
    v={k:n[k] for k in ['type','name','figmaId','figmaType','w','h','characters','fontFamily','fontStyle','weight','fontSize','lineHeight','letterSpacing','align','color','fill','stroke','strokeWidth','radius','radii','imageFill','paintsRaw','runs'] if k in n}
    v['x']=x;v['y']=y;arr.append(v)
   walk(n.get('children',[]),x,y,ignore)
 walk(d['nodes']);result[f.stem]=arr
(root/'Genita/Resources/FigmaScreens.json').write_text(json.dumps(result,ensure_ascii=False))
