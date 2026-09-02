#!/usr/bin/env python3
"""
JAYASONA PREDIKSI V3.1.1
Synchronize football results from MBox888 Result.aspx.

Important:
- Only standard match rows are imported.
- Corners, bookings, ET/PEN market variants and similar market rows are ignored.
- If the source cannot be fetched or parsing returns zero valid matches, the existing
  data.json is preserved and the script exits non-zero so GitHub Actions exposes the problem.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import requests
from bs4 import BeautifulSoup

SOURCE_URL = "https://www.mbox888.com/_View/Result.aspx"
DATA_FILE = Path(__file__).with_name("data.json")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
}

DATE_RE = re.compile(
    r"\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)"
    r"\s+\d{1,2}\s+\d{4}\s+\d{1,2}:\d{2}(?:AM|PM)\b",
    re.I,
)
VS_RE = re.compile(r"\s+-vs-\s+", re.I)
SCORE_RE = re.compile(r"^\s*(\d+)\s*-\s*(\d+)\s*$")
STATUS_RE = re.compile(r"\b(Completed|Running)\b", re.I)

# Rows containing these terms are markets rather than the base match.
EXCLUDE_MARKET = re.compile(
    r"\b(?:No\.?\s*of\s+Corners|1st\s+Corner|Total\s+Bookings|"
    r"Cards?|Bookings?|Corner)\b",
    re.I,
)
EXCLUDE_VARIANT = re.compile(r"\((?:ET|PEN)\)", re.I)


def clean(s: str) -> str:
    s = s.replace("\xa0", " ")
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def parse_score(s: str):
    m = SCORE_RE.match(clean(s))
    return [int(m.group(1)), int(m.group(2))] if m else None


def is_valid_team(name: str) -> bool:
    name = clean(name)
    if not name or len(name) < 2:
        return False
    if EXCLUDE_MARKET.search(name) or EXCLUDE_VARIANT.search(name):
        return False
    return True


def stable_id(league: str, kickoff: str, home: str, away: str) -> str:
    raw = "|".join([league.lower(), kickoff.lower(), home.lower(), away.lower()])
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def parse_row_cells(cells: list[str], league: str):
    """Parse a table row even when the site changes td nesting/classes."""
    cells = [clean(c) for c in cells if clean(c)]
    if not cells:
        return None

    joined = clean(" ".join(cells))
    dm = DATE_RE.search(joined)
    if not dm or "-vs-" not in joined.lower():
        return None

    if EXCLUDE_MARKET.search(joined) or EXCLUDE_VARIANT.search(joined):
        return None

    kickoff = dm.group(0)
    after_date = joined[dm.end():].strip()

    vm = VS_RE.search(after_date)
    if not vm:
        return None

    home = clean(after_date[:vm.start()])
    right = clean(after_date[vm.end():])

    # Remove status from the end, then find score tokens.
    status_m = STATUS_RE.search(right)
    status = status_m.group(1).title() if status_m else ""
    if status_m:
        right = clean(right[:status_m.start()])

    # Prefer score-like cells after splitting table cells.
    scores = []
    for c in cells:
        sc = parse_score(c)
        if sc is not None:
            scores.append(sc)

    # Fallback: score tokens in the joined right side.
    if not scores:
        for m in re.finditer(r"(?<!\d)(\d+)\s*-\s*(\d+)(?!\d)", right):
            scores.append([int(m.group(1)), int(m.group(2))])

    # The away team ends before the first score token, if present.
    first_score = re.search(r"(?<!\d)\d+\s*-\s*\d+(?!\d)", right)
    if first_score:
        away = clean(right[:first_score.start()])
    else:
        away = clean(right)

    # If cells provide a cleaner home/away split, use it.
    if len(cells) >= 2:
        vs_cell = next((c for c in cells if "-vs-" in c.lower()), None)
        if vs_cell:
            vm2 = VS_RE.search(vs_cell)
            if vm2:
                home2 = clean(vs_cell[:vm2.start()])
                away2 = clean(vs_cell[vm2.end():])
                if is_valid_team(home2) and is_valid_team(away2):
                    home, away = home2, away2

    if not is_valid_team(home) or not is_valid_team(away):
        return None

    ht = scores[0] if len(scores) >= 1 else None
    ft = scores[1] if len(scores) >= 2 else None

    # Running rows normally have "-" placeholders, while completed rows have HT/FT.
    if len(scores) == 1 and status == "Completed":
        ft = scores[0]
        ht = None

    return {
        "id": stable_id(league, kickoff, home, away),
        "league": league,
        "kickoff": kickoff,
        "home": home,
        "away": away,
        "ht": ht,
        "ft": ft,
        "status": status or ("Completed" if ft else "Running"),
        "source": SOURCE_URL,
    }


def parse_html(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    matches: list[dict] = []

    # Best path: actual table rows. MBox888 currently renders league headings
    # followed by rows with date/time, match, scores and status.
    for tr in soup.find_all("tr"):
        cells = [clean(x.get_text(" ", strip=True)) for x in tr.find_all(["td", "th"])]
        if not cells:
            continue
        text = clean(" ".join(cells))
        # A league heading has no kickoff date, so remember it separately below.
        matches.append(("row", cells, text))

    current_league = ""
    parsed: list[dict] = []

    for _, cells, text in matches:
        if DATE_RE.search(text) and "-vs-" in text.lower():
            item = parse_row_cells(cells, current_league)
            if item:
                parsed.append(item)
        elif text and not DATE_RE.search(text):
            # Heading rows commonly contain only the league name.
            if (
                len(text) < 140
                and not EXCLUDE_MARKET.search(text)
                and text.lower() not in {"kickoff time match first half score final score status"}
            ):
                current_league = text

    # Fallback: parse visible text line-by-line if table parsing found nothing.
    if not parsed:
        lines = [clean(x) for x in soup.get_text("\n").splitlines() if clean(x)]
        current_league = ""
        for line in lines:
            if DATE_RE.search(line) and "-vs-" in line.lower():
                item = parse_row_cells([line], current_league)
                if item:
                    parsed.append(item)
            elif (
                len(line) < 140
                and not DATE_RE.search(line)
                and not EXCLUDE_MARKET.search(line)
                and line.lower() not in {"results", "kickoff time match first half score final score status"}
            ):
                current_league = line

    # Deduplicate by stable ID while retaining order.
    out, seen = [], set()
    for item in parsed:
        if item["id"] not in seen:
            seen.add(item["id"])
            out.append(item)
    return out


def fetch() -> str:
    last = None
    for attempt in range(1, 4):
        try:
            r = requests.get(SOURCE_URL, headers=HEADERS, timeout=(15, 45))
            r.raise_for_status()
            if len(r.text) < 1000:
                raise RuntimeError(f"response terlalu pendek ({len(r.text)} bytes)")
            return r.text
        except Exception as exc:
            last = exc
            print(f"WARNING: fetch attempt {attempt}/3 gagal: {exc}", file=sys.stderr)
            if attempt < 3:
                time.sleep(3 * attempt)
    raise RuntimeError(f"Gagal mengambil MBox888: {last}")


def load_existing() -> dict:
    if not DATA_FILE.exists():
        return {}
    try:
        return json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_data(matches: list[dict], existing: dict):
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    payload = {
        "version": "3.1.1",
        "updated_at": now,
        "source": SOURCE_URL,
        "count": len(matches),
        "matches": matches,
    }
    # Keep useful metadata if it exists.
    if isinstance(existing, dict) and existing.get("version"):
        payload["previous_version"] = existing.get("version")
    DATA_FILE.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    existing = load_existing()
    try:
        html = fetch()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print("data.json lama dipertahankan.")
        return 2

    matches = parse_html(html)
    print(f"Parsed valid base matches: {len(matches)}")

    if not matches:
        print("ERROR: 0 pertandingan ditemukan; data.json lama dipertahankan.", file=sys.stderr)
        return 2

    save_data(matches, existing)
    print(f"OK: data.json diperbarui dengan {len(matches)} pertandingan.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
