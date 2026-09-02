#!/usr/bin/env python3
import json,re,sys,os
from datetime import datetime, timezone
import requests
from bs4 import BeautifulSoup

URL="https://www.mbox888.com/_View/Result.aspx"
OUT=os.path.join(os.path.dirname(__file__),"..","data.json")
HEADERS={"User-Agent":"Mozilla/5.0 (compatible; JayasonaMBoxSync/3.0)"}

def clean(s):
    return re.sub(r"\s+"," ",str(s or "")).strip()

def parse_score(s):
    s=clean(s)
    if re.fullmatch(r"\d+\s*-\s*\d+",s):
        a,b=re.split(r"\s*-\s*",s); return a,b
    return "",""

def looks_like_match(text):
    return " -vs- " in text

def main():
    r=requests.get(URL,headers=HEADERS,timeout=30)
    r.raise_for_status()
    soup=BeautifulSoup(r.text,"html.parser")
    rows=[]
    current_league=""
    # The source is rendered as a result table. We intentionally require
    # match-shaped rows and keep only the primary match rows, not corners/etc.
    for tr in soup.find_all("tr"):
        cells=[clean(c.get_text(" ",strip=True)) for c in tr.find_all(["th","td"])]
        if not cells: continue
        joined=" | ".join(cells)
        upper=joined.upper()
        if len(cells)==1 and not looks_like_match(joined):
            if joined and len(joined)<120 and not any(x in upper for x in ["KICKOFF TIME","MATCH FIRST HALF","RESULTS"]):
                current_league=joined
            continue
        if not looks_like_match(joined): continue
        # Usually: kickoff, match, HT, FT, status. Locate the match cell robustly.
        mi=next((i for i,c in enumerate(cells) if " -vs- " in c),None)
        if mi is None: continue
        match=cells[mi]
        left,right=match.split(" -vs- ",1)
        home=clean(left); away=clean(right)
        # Strip market suffixes that identify non-primary markets.
        if any(x in home.upper()+" "+away.upper() for x in ["NO.OF CORNERS","1ST CORNER","TOTAL BOOKINGS","(PEN)","(ET)"]):
            continue
        kickoff=cells[mi-1] if mi>0 else ""
        ht_home=ht_away=final_home=final_away=""
        # Scores following match cell are generally HT and FT.
        after=cells[mi+1:]
        scores=[parse_score(x) for x in after]
        valid=[x for x in scores if x[0]!=""]
        if valid:
            ht_home,ht_away=valid[0]
        if len(valid)>1:
            final_home,final_away=valid[1]
        status=next((x for x in after if x in ["Completed","Running","Live"]), "")
        # If source has only FT in some rows, keep it as final.
        if not final_home and valid and status:
            # Primary pages commonly provide HT then FT; don't guess when only one score exists.
            pass
        date=""
        m=re.search(r"([A-Z][a-z]{2}\s+\d{1,2}\s+\d{4})",kickoff)
        if m: date=m.group(1)
        source_format="MATCH"
        mid=re.sub(r"[^a-z0-9]+","-",f"{kickoff}-{home}-{away}-{current_league}".lower()).strip("-")
        rows.append({
            "id":mid[:180],"league":current_league,"kickoff":kickoff,"date":date,
            "home":home,"away":away,"ht_home":ht_home,"ht_away":ht_away,
            "final_home":final_home,"final_away":final_away,"status":status or "",
            "source_format":source_format
        })
    # Deduplicate identical primary rows while preserving order.
    seen=set(); matches=[]
    for x in rows:
        if x["id"] in seen: continue
        seen.add(x["id"]); matches.append(x)
    if not matches:
        raise RuntimeError("Parser menghasilkan 0 pertandingan. Struktur MBox888 mungkin berubah; data.json tidak ditimpa.")
    payload={"updated_at":datetime.now(timezone.utc).isoformat(),"source":URL,"count":len(matches),"matches":matches}
    with open(OUT,"w",encoding="utf-8") as f: json.dump(payload,f,ensure_ascii=False,indent=2)
    print(f"Synced {len(matches)} matches to {OUT}")

if __name__=="__main__":
    main()
