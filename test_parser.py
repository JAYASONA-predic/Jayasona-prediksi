from sync_mbox import parse_html
html = """
<table>
<tr><th>JAPAN J-LEAGUE DIVISION 1</th></tr>
<tr><td>Sep 2 2026 6:00PM</td><td>Avispa Fukuoka -vs- Urawa Red Diamonds</td><td>2 - 1</td><td>2 - 3</td><td>Completed</td></tr>
<tr><td>Sep 2 2026 6:00PM</td><td>Avispa Fukuoka No.of Corners -vs- Urawa Red Diamonds No.of Corners</td><td>2 - 0</td><td>5 - 1</td><td>Completed</td></tr>
<tr><td>Sep 3 2026 2:45AM</td><td>Millwall -vs- Wrexham</td><td>-</td><td>-</td><td>Running</td></tr>
</table>
"""
m = parse_html(html)
assert len(m) == 2, m
assert m[0]["home"] == "Avispa Fukuoka"
assert m[0]["away"] == "Urawa Red Diamonds"
assert m[0]["ht"] == [2, 1]
assert m[0]["ft"] == [2, 3]
assert m[1]["status"] == "Running"
print("PASS", len(m), "matches")
