#!/usr/bin/env python3
import hashlib,json,os,re,sys,time
from datetime import datetime,timezone
import requests
from bs4 import BeautifulSoup

URL='https://www.mbox888.com/_View/Result.aspx'
OUT=os.path.join(os.path.dirname(__file__),'data.json')
DATE=r'[A-Z][a-z]{2}\s+\d{1,2}\s+\d{4}'
TIME=r'\d{1,2}:\d{2}\s*(?:AM|PM)'
MATCH_RE=re.compile(rf'^(?P<date>{DATE})\s+(?P<time>{TIME})\s+(?P<home>.+?)\s+-vs-\s+(?P<away>.+?)(?:\s+(?P<tail>.*))?$',re.I)
SCORE_RE=re.compile(r'(?<!\d)(\d+)\s*-\s*(\d+)(?!\d)')
STATUS_RE=re.compile(r'\b(Running|Live|Completed)\b',re.I)
NOISE=('no.of corners','no. of corners','1st corner','first corner','corner handicap','total corners','bookings','cards','correct score','double chance')

def clean(x): return re.sub(r'\s+',' ',str(x or '')).strip()
def ident(league,date,t,home,away): return hashlib.sha1('|'.join([league,date,t,home,away]).encode()).hexdigest()
def fetch():
    h={'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36','Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'en-US,en;q=0.9','Cache-Control':'no-cache'}
    last=None
    for n in range(3):
        try:
            r=requests.get(URL,headers=h,timeout=45); r.raise_for_status()
            if len(r.text)<1000: raise RuntimeError('Halaman MBox888 terlalu pendek')
            return r.text
        except Exception as e: last=e; time.sleep(2*(n+1))
    raise RuntimeError(f'Gagal mengambil MBox888: {last}')

def parse(html):
    s=BeautifulSoup(html,'html.parser')
    for tag in s(['script','style','noscript','svg']): tag.decompose()
    lines=[clean(x) for x in s.get_text('\n',strip=True).splitlines() if clean(x)]
    league=''; out=[]
    for line in lines:
        if line.lower() in {'results','date','sort by','sport','league','submit','kickoff time','match first half score final score status'}: continue
        m=MATCH_RE.match(line)
        if not m:
            if len(line)<=140 and not any(x in line.lower() for x in ('select','submit','kickoff','result','sort by')): league=line
            continue
        date,t,home,away,tail=[clean(m.group(k)) for k in ('date','time','home','away','tail')]
        if any(x in f'{league} {home} {away}'.lower() for x in NOISE): continue
        sm=STATUS_RE.search(tail); status=sm.group(1).title() if sm else ''
        score_text=tail[:sm.start()].strip() if sm else tail
        scores=SCORE_RE.findall(score_text)
        ht_h=ht_a=ft_h=ft_a=''
        if len(scores)>=1: ht_h,ht_a=scores[0]
        if len(scores)>=2: ft_h,ft_a=scores[1]
        if status=='Completed' and len(scores)==1: ft_h,ft_a=scores[0]; ht_h=ht_a=''
        out.append({'id':ident(league,date,t,home,away),'league':league,'date':date,'time':t,'kickoff':f'{date} {t}','home':home,'away':away,'ht_home':ht_h,'ht_away':ht_a,'final_home':ft_h,'final_away':ft_a,'status':status,'source_format':'MBox888 Result'})
    seen=set(); unique=[]
    for x in out:
        if x['id'] not in seen: seen.add(x['id']); unique.append(x)
    return unique

def main():
    matches=parse(fetch())
    if not matches:
        print('ERROR: 0 pertandingan ditemukan; data.json lama dipertahankan.',file=sys.stderr); return 2
    payload={'updated_at':datetime.now(timezone.utc).isoformat(),'source':URL,'count':len(matches),'matches':matches}
    tmp=OUT+'.tmp'
    with open(tmp,'w',encoding='utf-8') as f: json.dump(payload,f,ensure_ascii=False,indent=2)
    os.replace(tmp,OUT)
    print(f'Synced {len(matches)} matches')
    return 0
if __name__=='__main__': raise SystemExit(main())
